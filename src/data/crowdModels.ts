export type CrowdPose = 'standing' | 'seated';
export type CrowdRenderTier = 'high' | 'low' | 'xr';

export interface CrowdHandsetSocket {
  translation: readonly [number, number, number];
  rotation: readonly [number, number, number];
}

export interface CrowdModelSpec {
  id: 'stageforge-human-v1';
  family: 'human';
  label: string;
  provenance: {
    creator: string;
    source: string;
    license: 'StageForge original';
  };
  poses: Readonly<Record<CrowdPose, {
    maxHeightM: number;
    clearanceRadiusM: number;
    pivot: readonly [number, number, number];
    handset: CrowdHandsetSocket | null;
  }>>;
  budgets: Readonly<Record<CrowdRenderTier, {
    trianglesPerInstance: number;
    materials: number;
    textures: number;
    figureBatches: number;
  }>>;
  /** This first-slice renderer must reuse the exact legacy instanced crowd resources. */
  legacyCompatible: true;
}

export const CROWD_MAX_AUTHORED_OCCUPANTS = 680;
export const CROWD_XR_AGGREGATE_BUDGET = Object.freeze({
  ceiling: { draws: 270, triangles: 760_000, textures: 26 },
  measuredArena: { draws: 262, triangles: 745_712, textures: 25 },
  remaining: { draws: 8, triangles: 14_288, textures: 1 },
});

/**
 * Measured from geometryBuilders.ts at the 6B pickup: 264 triangles, base foot at y=0,
 * raised-arm maximum y=1.918 scaled by the legacy 1.12 maximum, and no texture.
 * Seated is compatibility placement of the legacy mesh, not a claim of a true seated pose.
 */
export const STAGEFORGE_HUMAN_V1: CrowdModelSpec = Object.freeze({
  id: 'stageforge-human-v1',
  family: 'human',
  label: 'StageForge human',
  provenance: {
    creator: 'StageForge',
    source: 'Built-in procedural legacy instanced human',
    license: 'StageForge original' as const,
  },
  poses: {
    standing: {
      maxHeightM: 2.15,
      clearanceRadiusM: 0.47,
      pivot: [0, 0, 0],
      handset: { translation: [0.37, 1.90, 0.145], rotation: [0, Math.PI, 0] },
    },
    seated: {
      maxHeightM: 1.42,
      clearanceRadiusM: 0.26,
      pivot: [0, 0, 0],
      handset: null,
    },
  },
  budgets: {
    high: { trianglesPerInstance: 264, materials: 1, textures: 0, figureBatches: 1 },
    low: { trianglesPerInstance: 264, materials: 1, textures: 0, figureBatches: 1 },
    xr: { trianglesPerInstance: 264, materials: 1, textures: 0, figureBatches: 1 },
  },
  legacyCompatible: true,
} as CrowdModelSpec);

export const CROWD_MODEL_REGISTRY = Object.freeze({
  [STAGEFORGE_HUMAN_V1.id]: STAGEFORGE_HUMAN_V1,
});

export type CrowdModelId = keyof typeof CROWD_MODEL_REGISTRY;

export function crowdModel(modelId: string): CrowdModelSpec {
  const model = CROWD_MODEL_REGISTRY[modelId as CrowdModelId];
  if (!model) throw new Error(`crowd model "${modelId}" is not available in this build.`);
  return model;
}
