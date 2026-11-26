import * as THREE from 'three';
import { GRID_HEIGHT, ledPlacement } from '../data/stageEquipment';
import { isCustomMainWall, resolveWallFrame } from '../data/studioGeometry';
import type { RigConfig, StagePlatform } from '../types/show';
import type { StageScreen } from './StageScreens';
import type { RenderTier } from './hardwareMaterials';

export const NEON_FRAME_CAPACITY = Object.freeze({ low: 128, high: 512 });
export const NEON_FRAME_MAX_GPU_BYTES = 0.10 * 1024 * 1024;

export type NeonFrameFamily = 'deck' | 'wing' | 'screen';

export interface NeonFrameSegment {
  family: NeonFrameFamily;
  sourceId: string;
  paletteIndex: 0 | 1;
  start: [number, number, number];
  end: [number, number, number];
}

export interface NeonFrameStats {
  requested: boolean;
  allocated: boolean;
  active: boolean;
  suppressedReason: 'disabled' | 'true-colour' | 'blackout' | 'master-dimmer' | 'empty' | null;
  instanceCount: number;
  capacity: number;
  deckInstances: number;
  wingInstances: number;
  screenInstances: number;
  addedDraws: 0 | 1;
  extraBufferBytes: number;
  instanceBufferBytes: number;
  geometryBufferBytes: number;
}

const EPSILON = 1e-4;

function point(x: number, y: number, z: number): [number, number, number] {
  return [Number(x.toFixed(4)), Number(y.toFixed(4)), Number(z.toFixed(4))];
}

function segment(
  family: NeonFrameFamily,
  sourceId: string,
  paletteIndex: 0 | 1,
  start: [number, number, number],
  end: [number, number, number],
): NeonFrameSegment | null {
  const dx = end[0] - start[0], dy = end[1] - start[1], dz = end[2] - start[2];
  return dx * dx + dy * dy + dz * dz >= 0.12 * 0.12
    ? { family, sourceId, paletteIndex, start, end }
    : null;
}

function platformFrontEdges(platforms: readonly StagePlatform[]): NeonFrameSegment[] {
  if (!platforms.length) return [];
  const xs = [...new Set(platforms.flatMap((p) => [p.x - p.width / 2, p.x + p.width / 2]))].sort((a, b) => a - b);
  const candidates: NeonFrameSegment[] = [];
  for (const p of platforms) {
    const left = p.x - p.width / 2, right = p.x + p.width / 2;
    const front = p.z + p.depth / 2;
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i], x1 = xs[i + 1];
      if (x0 < left - EPSILON || x1 > right + EPSILON) continue;
      const x = (x0 + x1) / 2;
      const covered = platforms.some((other) => {
        if (other === p || other.height < p.height - EPSILON) return false;
        return x > other.x - other.width / 2 + EPSILON && x < other.x + other.width / 2 - EPSILON &&
          front + 0.002 > other.z - other.depth / 2 + EPSILON &&
          front + 0.002 < other.z + other.depth / 2 - EPSILON;
      });
      if (covered) continue;
      const s = segment('deck', `platform:${p.id}`, 0,
        point(x0, p.height + 0.025, front + 0.025), point(x1, p.height + 0.025, front + 0.025));
      if (s) candidates.push(s);
    }
  }
  candidates.sort((a, b) =>
    b.start[2] - a.start[2] ||
    (b.end[0] - b.start[0]) - (a.end[0] - a.start[0]) ||
    b.start[1] - a.start[1] ||
    a.sourceId.localeCompare(b.sourceId));
  return candidates;
}

function frameSegments(
  id: string,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  yaw: number,
  paletteOffset: 0 | 1,
): NeonFrameSegment[] {
  if (width <= 0 || height <= 0) return [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const ux: [number, number, number] = [c, 0, -s];
  const normal: [number, number, number] = [s, 0, c];
  const cx = x + normal[0] * 0.035, cz = z + normal[2] * 0.035;
  const corner = (sx: number, sy: number) => point(
    cx + ux[0] * width * 0.5 * sx,
    y + height * 0.5 * sy,
    cz + ux[2] * width * 0.5 * sx,
  );
  const bl = corner(-1, -1), br = corner(1, -1), tl = corner(-1, 1), tr = corner(1, 1);
  return [
    segment('screen', `${id}:bottom`, paletteOffset, bl, br),
    segment('screen', `${id}:top`, paletteOffset ? 0 : 1, tl, tr),
    segment('screen', `${id}:left`, paletteOffset, bl, tl),
    segment('screen', `${id}:right`, paletteOffset ? 0 : 1, br, tr),
  ].filter((value): value is NeonFrameSegment => value !== null);
}

/** Pure, deterministic layout used by both the renderer and unit tests. */
export function buildNeonFrameSegments(
  rig: RigConfig,
  screens: readonly StageScreen[] = [],
  tier: RenderTier = 'high',
): NeonFrameSegment[] {
  const deck: NeonFrameSegment[] = [];
  const platforms = rig.platforms;
  if (platforms === undefined) {
    const lip = segment('deck', 'legacy:stage-lip', 0,
      point(-rig.stageWidth / 2 + 0.3, rig.stageHeight - 0.10, rig.stageDepth / 2 + 0.07),
      point(rig.stageWidth / 2 - 0.3, rig.stageHeight - 0.10, rig.stageDepth / 2 + 0.07));
    if (lip) deck.push(lip);
  } else {
    deck.push(...platformFrontEdges(platforms));
  }

  const footprint = platforms === undefined
    ? { left: -rig.stageWidth / 2, right: rig.stageWidth / 2, front: rig.stageDepth / 2, baseY: rig.stageHeight }
    : platforms.length
      ? {
          left: Math.min(...platforms.map((p) => p.x - p.width / 2)),
          right: Math.max(...platforms.map((p) => p.x + p.width / 2)),
          front: Math.max(...platforms.map((p) => p.z + p.depth / 2)),
          baseY: Math.max(...platforms.map((p) => p.height)),
        }
      : null;

  const wings: NeonFrameSegment[] = [];
  if (footprint) {
    const topY = Math.min(GRID_HEIGHT[rig.venue] - 0.55, footprint.baseY + 5.2);
    if (topY > footprint.baseY + 1.5) {
      for (const [index, side] of ([-1, 1] as const).entries()) {
        const x = side < 0 ? footprint.left - 0.12 : footprint.right + 0.12;
        const bottom = point(x, footprint.baseY + 0.04, footprint.front + 0.02);
        const top = point(x, topY, footprint.front - 0.75);
        const inner = point(x * 0.72, topY - 1.25, footprint.front - 1.0);
        const upright = segment('wing', `architecture:${side < 0 ? 'left' : 'right'}:upright`, index as 0 | 1, bottom, top);
        const diagonal = segment('wing', `architecture:${side < 0 ? 'left' : 'right'}:diagonal`, index ? 0 : 1, top, inner);
        if (upright) wings.push(upright);
        if (diagonal) wings.push(diagonal);
      }
    }
  }

  const screenFrames: NeonFrameSegment[] = [];
  const authoredMain = screens.find((screen) => screen.id === 'main-led');
  const customMain = isCustomMainWall(authoredMain);
  if (customMain && authoredMain) {
    const f = resolveWallFrame(rig, authoredMain);
    screenFrames.push(...frameSegments(`screen:${f.id}`, f.x, f.y, f.z, f.width, f.height,
      THREE.MathUtils.degToRad(f.yaw), 0));
  } else if (rig.ledWall.enabled) {
    const wall = ledPlacement(rig);
    screenFrames.push(...frameSegments('screen:main-led', wall.x, wall.y, wall.z, wall.width, wall.height, 0, 0));
    if (wall.wing.width > 0) {
      for (const side of [-1, 1] as const) {
        screenFrames.push(...frameSegments(
          `screen:stock-wing:${side < 0 ? 'left' : 'right'}`,
          wall.x + side * (wall.width / 2 + wall.wing.width / 2 + wall.wingGap),
          wall.y,
          wall.z + 2.2,
          wall.wing.width,
          wall.wing.height,
          side * -0.32,
          side < 0 ? 1 : 0,
        ));
      }
    }
  }
  for (const [index, screen] of screens.filter((value) => value.id !== 'main-led').sort((a, b) => a.id.localeCompare(b.id)).entries()) {
    const f = resolveWallFrame(rig, screen);
    screenFrames.push(...frameSegments(`screen:${f.id}`, f.x, f.y, f.z, f.width, f.height,
      THREE.MathUtils.degToRad(f.yaw), index % 2 as 0 | 1));
  }

  const multiplier = tier === 'low' ? 1 : 4;
  const selected = [
    ...deck.slice(0, 48 * multiplier),
    ...wings.slice(0, 16 * multiplier),
    ...screenFrames.slice(0, 64 * multiplier),
  ];
  return selected.slice(0, NEON_FRAME_CAPACITY[tier]);
}

const NEON_FRAME_VERTEX = /* glsl */`
  varying vec3 vColor;
  varying float vFade;
  uniform float uViewportHeight;
  void main() {
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    float eyeDistance = length(mvPosition.xyz);
    float radius = length(instanceMatrix[0].xyz);
    float pixelDiameter = radius * uViewportHeight * projectionMatrix[1][1] / max(0.18, -mvPosition.z);
    vFade = smoothstep(0.40, 1.35, eyeDistance) * smoothstep(0.55, 1.35, pixelDiameter);
    vColor = instanceColor;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const NEON_FRAME_FRAGMENT = /* glsl */`
  precision highp float;
  varying vec3 vColor;
  varying float vFade;
  uniform float uOpacity;
  uniform float uRadiance;
  void main() {
    float alpha = uOpacity * vFade;
    if (alpha < 0.003) discard;
    vec3 linearColor = min(vColor * uRadiance, vec3(1.0));
    gl_FragColor = vec4(linearColor * alpha, alpha);
  }
`;

function bufferBytes(geometry: THREE.BufferGeometry, instanceMatrix: THREE.InstancedBufferAttribute, instanceColor?: THREE.InstancedBufferAttribute | null) {
  const arrays = new Set<ArrayBufferLike>();
  for (const attribute of Object.values(geometry.attributes)) arrays.add((attribute.array as ArrayBufferView).buffer);
  if (geometry.index) arrays.add((geometry.index.array as ArrayBufferView).buffer);
  const geometryBufferBytes = [...arrays].reduce((sum, array) => sum + array.byteLength, 0);
  const instanceBufferBytes = instanceMatrix.array.byteLength + (instanceColor?.array.byteLength ?? 0);
  return { geometryBufferBytes, instanceBufferBytes, extraBufferBytes: geometryBufferBytes + instanceBufferBytes };
}

/** Owns the single optional renderer-only neon architecture draw. */
export class NeonFrameController {
  private requested = false;
  private trueColour = false;
  private blackout = false;
  private masterDimmer = 1;
  private rig?: RigConfig;
  private screens: readonly StageScreen[] = [];
  private segments: NeonFrameSegment[] = [];
  private primary = '#00d9ff';
  private accent = '#ff2d86';
  private mesh: THREE.InstancedMesh | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private viewportHeight: number;

  constructor(private scene: THREE.Scene, private tier: RenderTier, viewportHeight: number) {
    this.viewportHeight = Math.max(1, viewportHeight);
  }

  setLayout(rig: RigConfig, screens: readonly StageScreen[] = []) {
    this.rig = rig;
    this.screens = screens;
    this.segments = buildNeonFrameSegments(rig, screens, this.tier);
    if (this.requested && !this.trueColour) this.rebuildResources();
  }

  setPalette(primary: string, accent: string) {
    if (primary === this.primary && accent === this.accent) return;
    this.primary = primary;
    this.accent = accent;
    this.uploadColours();
  }

  setPolicy(requested: boolean, trueColour: boolean) {
    const changed = this.requested !== requested || this.trueColour !== trueColour;
    this.requested = requested;
    this.trueColour = trueColour;
    if (!requested || trueColour) this.releaseResources();
    else if (changed || !this.mesh) this.rebuildResources();
    this.syncVisibility();
  }

  setBlackout(blackout: boolean) {
    if (this.blackout === blackout) return;
    this.blackout = blackout;
    this.syncVisibility();
  }

  setMasterDimmer(level: number) {
    const next = THREE.MathUtils.clamp(Number.isFinite(level) ? level : 0, 0, 1);
    if (this.masterDimmer === next) return;
    this.masterDimmer = next;
    if (this.material) this.material.uniforms.uOpacity.value = 0.82 * next;
    this.syncVisibility();
  }

  setViewportHeight(height: number) {
    this.viewportHeight = Math.max(1, height);
    if (this.material) this.material.uniforms.uViewportHeight.value = this.viewportHeight;
  }

  onContextRestored() {
    if (!this.mesh || !this.material) return;
    for (const attribute of Object.values(this.mesh.geometry.attributes)) attribute.needsUpdate = true;
    if (this.mesh.geometry.index) this.mesh.geometry.index.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.material.needsUpdate = true;
    this.syncVisibility();
  }

  getStats(): NeonFrameStats {
    const allocated = this.mesh !== null;
    const counts = { deck: 0, wing: 0, screen: 0 };
    for (const descriptor of this.segments) counts[descriptor.family]++;
    const bytes = this.mesh
      ? bufferBytes(this.mesh.geometry, this.mesh.instanceMatrix, this.mesh.instanceColor)
      : { geometryBufferBytes: 0, instanceBufferBytes: 0, extraBufferBytes: 0 };
    const active = Boolean(this.mesh?.visible && this.mesh.count > 0);
    return {
      requested: this.requested,
      allocated,
      active,
      suppressedReason: !this.requested ? 'disabled' : this.trueColour ? 'true-colour' : this.blackout ? 'blackout' : this.masterDimmer <= 0.001 ? 'master-dimmer' : !this.segments.length ? 'empty' : null,
      instanceCount: this.mesh?.count ?? 0,
      capacity: NEON_FRAME_CAPACITY[this.tier],
      deckInstances: counts.deck,
      wingInstances: counts.wing,
      screenInstances: counts.screen,
      addedDraws: active ? 1 : 0,
      ...bytes,
    };
  }

  dispose() {
    this.releaseResources();
    this.rig = undefined;
    this.screens = [];
    this.segments = [];
  }

  private rebuildResources() {
    this.releaseResources();
    if (!this.rig || !this.segments.length) return;
    const capacity = NEON_FRAME_CAPACITY[this.tier];
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
    const material = new THREE.ShaderMaterial({
      vertexShader: NEON_FRAME_VERTEX,
      fragmentShader: NEON_FRAME_FRAGMENT,
      uniforms: {
        uViewportHeight: { value: this.viewportHeight },
        uOpacity: { value: 0.82 * this.masterDimmer },
        uRadiance: { value: 1.08 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      toneMapped: false,
    });
    material.name = 'Neon architectural framing';
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = 'Neon architecture batch';
    mesh.userData.cosmeticLook = 'neonFrame';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.count = Math.min(this.segments.length, capacity);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.StaticDrawUsage);

    const start = new THREE.Vector3(), end = new THREE.Vector3(), midpoint = new THREE.Vector3();
    const direction = new THREE.Vector3(), scale = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    const matrix = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < mesh.count; i++) {
      const descriptor = this.segments[i];
      start.fromArray(descriptor.start);
      end.fromArray(descriptor.end);
      direction.subVectors(end, start);
      const length = direction.length();
      midpoint.addVectors(start, end).multiplyScalar(0.5);
      quaternion.setFromUnitVectors(up, direction.multiplyScalar(1 / length));
      const radius = descriptor.family === 'deck' ? 0.028 : descriptor.family === 'screen' ? 0.024 : 0.026;
      scale.set(radius, length, radius);
      matrix.compose(midpoint, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.mesh = mesh;
    this.material = material;
    this.uploadColours();
    this.scene.add(mesh);
    this.syncVisibility();
  }

  private uploadColours() {
    if (!this.mesh?.instanceColor) return;
    const colours = [new THREE.Color(this.primary), new THREE.Color(this.accent)];
    for (let i = 0; i < this.mesh.count; i++) this.mesh.setColorAt(i, colours[this.segments[i].paletteIndex]);
    this.mesh.instanceColor.needsUpdate = true;
  }

  private syncVisibility() {
    if (this.mesh) this.mesh.visible = this.requested && !this.trueColour && !this.blackout && this.masterDimmer > 0.001 && this.mesh.count > 0;
  }

  private releaseResources() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
    this.mesh = null;
    this.material = null;
  }
}
