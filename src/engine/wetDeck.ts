import * as THREE from 'three';

export type StageEnvironmentComposition = 'legacy' | 'wet-neutral';

export interface EnvironmentPanelPlan {
  size: readonly [number, number];
  position: readonly [number, number, number];
  lookAt: readonly [number, number, number];
  radiance: readonly [number, number, number];
}

export interface StageEnvironmentPlan {
  composition: StageEnvironmentComposition;
  background: number;
  blur: number;
  panels: readonly EnvironmentPanelPlan[];
}

export interface WetDeckEnvironmentStats {
  requested: boolean;
  active: boolean;
  composition: StageEnvironmentComposition;
  targetId: number;
  targetUuid: string;
  targetWidth: number;
  targetHeight: number;
  buildCount: number;
  persistentTargetCount: 0 | 1;
  narrowStripCount: number;
  extraGpuBytes: 0;
  sceneOwnsTargetTexture: boolean;
}

let nextEnvironmentTargetId = 1;

/**
 * Deterministic source scene for the one StageEngine PMREM target. The wet plan replaces the
 * legacy blue/purple cards with restrained, near-neutral strips. It is distant lighting only:
 * no fixture position, LED media, show colour, clock, audio, or camera value enters this plan.
 */
export function stageEnvironmentPlan(wetDeck: boolean): StageEnvironmentPlan {
  if (!wetDeck) {
    return {
      composition: 'legacy',
      background: 0x090c14,
      blur: 0.04,
      panels: [
        { size: [20, 6], position: [0, 10, -10], lookAt: [0, 10, 0], radiance: [0.04373502925049377, 0.13286832154414627, 0.31854677811435356] },
        { size: [20, 4], position: [12, 6, 8], lookAt: [0, 6, 8], radiance: [0.09084171117479915, 0.015996293361446288, 0.13286832154414627] },
        { size: [16, 8], position: [-4, 12, 7], lookAt: [0, 3, 0], radiance: [1.8, 1.7, 1.55] },
      ],
    };
  }

  return {
    composition: 'wet-neutral',
    background: 0x06080c,
    blur: 0.04,
    panels: [
      { size: [25, 0.72], position: [-3, 11, -12], lookAt: [0, 1.2, 0], radiance: [1.32, 1.30, 1.27] },
      { size: [18, 0.48], position: [11, 7.2, -5], lookAt: [0, 1.0, 0], radiance: [0.76, 0.80, 0.84] },
      { size: [15, 0.42], position: [-12, 5.5, 3], lookAt: [0, 1.0, 0], radiance: [0.67, 0.65, 0.61] },
      { size: [20, 0.58], position: [4, 10.5, 10], lookAt: [0, 1.0, 0], radiance: [1.02, 1.04, 1.03] },
      { size: [11, 0.34], position: [-2, 3.8, 14], lookAt: [0, 0.8, 0], radiance: [0.46, 0.49, 0.52] },
    ],
  };
}

export function buildStageEnvironment(
  renderer: THREE.WebGLRenderer,
  wetDeck: boolean,
): { target: THREE.WebGLRenderTarget; stats: Omit<WetDeckEnvironmentStats, 'sceneOwnsTargetTexture'> } {
  const plan = stageEnvironmentPlan(wetDeck);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(plan.background);
  const panels: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    for (const panel of plan.panels) {
      const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      material.color.setRGB(panel.radiance[0], panel.radiance[1], panel.radiance[2]);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panel.size[0], panel.size[1]), material);
      mesh.position.set(panel.position[0], panel.position[1], panel.position[2]);
      mesh.lookAt(panel.lookAt[0], panel.lookAt[1], panel.lookAt[2]);
      panels.push(mesh);
      envScene.add(mesh);
    }
    const target = pmrem.fromScene(envScene, plan.blur);
    return {
      target,
      stats: {
        requested: wetDeck,
        active: wetDeck,
        composition: plan.composition,
        targetId: nextEnvironmentTargetId++,
        targetUuid: target.texture.uuid,
        targetWidth: target.width,
        targetHeight: target.height,
        buildCount: 1,
        persistentTargetCount: 1,
        narrowStripCount: wetDeck ? plan.panels.length : 0,
        extraGpuBytes: 0,
      },
    };
  } finally {
    for (const panel of panels) {
      panel.geometry.dispose();
      panel.material.dispose();
    }
    pmrem.dispose();
  }
}

const WET_DECK_CACHE_KEY = '|stageforge-wet-deck-v1';
const wetDeckMaterialState = new WeakMap<THREE.MeshStandardMaterial, {
  baseBeforeCompile: THREE.MeshStandardMaterial['onBeforeCompile'];
  baseCacheKey: THREE.MeshStandardMaterial['customProgramCacheKey'];
}>();

/**
 * Add spatial roughness breakup without allocating another texture. The seeded Marley albedo
 * already contains seams, grain and scuffs; its decoded sample plus the same repeated UVs drive a
 * conservative roughness response. Sprint 18's explicit roughness map remains authoritative.
 */
export function setWetDeckMaterial(material: THREE.MeshStandardMaterial, enabled: boolean): void {
  const active = wetDeckMaterialState.has(material);
  if (active === enabled) return;
  if (enabled) {
    const baseBeforeCompile = material.onBeforeCompile;
    const baseCacheKey = material.customProgramCacheKey;
    wetDeckMaterialState.set(material, { baseBeforeCompile, baseCacheKey });
    material.onBeforeCompile = (shader, renderer) => {
      baseBeforeCompile.call(material, shader, renderer);
      const marker = '#include <roughnessmap_fragment>';
      if (!shader.fragmentShader.includes(marker)) return;
      shader.fragmentShader = shader.fragmentShader.replace(marker, `${marker}
#if defined( USE_MAP ) && !defined( USE_ROUGHNESSMAP )
  // Reuse the existing seeded Marley sample: darker seams stay rough while brighter
  // scuffs break the neutral grazing strips without another texture allocation or lookup.
  roughnessFactor = 0.69 - sampledDiffuseColor.g * 3.5;
#endif`);
    };
    material.customProgramCacheKey = () => `${baseCacheKey.call(material)}${WET_DECK_CACHE_KEY}`;
  } else {
    const state = wetDeckMaterialState.get(material);
    if (state) {
      material.onBeforeCompile = state.baseBeforeCompile;
      material.customProgramCacheKey = state.baseCacheKey;
      wetDeckMaterialState.delete(material);
    }
  }
  material.needsUpdate = true;
}
