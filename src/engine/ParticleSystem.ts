import * as THREE from 'three';
import type { RenderTier } from './hardwareMaterials';
import { mulberry32 } from './prng';
import {
  beamsPerPuffForTier,
  canAdmitLitPuffsBuffers,
  candidateCapForTier,
  computePoolCloudSphere,
  evaluateSinglePuffLighting,
  LIT_PUFFS_BYTES_PER_INSTANCE,
  LIT_PUFFS_CRYO_AMBIENT_SCALE,
  LIT_PUFFS_SMOKE_AMBIENT_SCALE,
  LitCandidateSet,
  LitPuffPoolState,
  litPuffsExtraBufferBytes,
  resolveSmokeCryoRenderOrder,
  sortPuffsBackToFront,
  VAPOR_FRAG_BASE,
  VAPOR_FRAG_LIT,
  VAPOR_VERT_BASE,
  VAPOR_VERT_LIT,
  type CloudSphereRegion,
  type LitBeamSource,
  type LitPuffsFrameContext,
  type LitPuffsStats,
} from './litPuffs';

export const DEFAULT_PARTICLE_SEED = 0x51a9e015;
export const PARTICLE_FIXED_STEP_S = 1 / 60;
export const PARTICLE_MAX_SUBSTEPS = 6;

export interface ParticleTierCapacities {
  readonly smoke: number;
  readonly cryo: number;
  readonly haze: number;
}

export const PARTICLE_CAPACITIES: Readonly<Record<RenderTier, ParticleTierCapacities>> = Object.freeze({
  high: Object.freeze({ smoke: 260, cryo: 420, haze: 36 }),
  low: Object.freeze({ smoke: 120, cryo: 180, haze: 18 }),
});

export interface ParticleStats {
  smoke: { alive: number; capacity: number };
  cryo: { alive: number; capacity: number };
  haze: { alive: number; capacity: number };
  droppedSpawns: number;
  droppedSimulationMs: number;
  uploadBytes: number;
}

export interface ParticleLightingUpdate {
  beams: readonly LitBeamSource[];
  blackout: boolean;
  master: number;
  roomGain: number;
  camPosX: number;
  camPosY: number;
  camPosZ: number;
  camFwdX: number;
  camFwdY: number;
  camFwdZ: number;
}

/**
 * Struct-of-arrays particle pool with zero per-spawn allocations.
 * Stores previous and current positions for smooth sub-frame interpolation on >60 Hz displays.
 */
class PuffPool {
  readonly capacity: number;
  alive = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Secondary vertical velocity component for falling CO2 cold-cloud sink (m/s). */
  readonly vc: Float32Array;
  /** Initial upward jet speed (m/s) for falling CO2 spread interpolation. */
  readonly v0: Float32Array;
  /** Spawn radial direction (cos, sin) for floor outward roll. */
  readonly dirX: Float32Array;
  readonly dirZ: Float32Array;
  readonly age: Float32Array;
  readonly lifetime: Float32Array;
  readonly size: Float32Array;
  readonly growth: Float32Array;
  readonly rotation: Float32Array;
  readonly spin: Float32Array;
  readonly floorY: Float32Array;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.z = new Float32Array(this.capacity);
    this.px = new Float32Array(this.capacity);
    this.py = new Float32Array(this.capacity);
    this.pz = new Float32Array(this.capacity);
    this.vx = new Float32Array(this.capacity);
    this.vy = new Float32Array(this.capacity);
    this.vz = new Float32Array(this.capacity);
    this.vc = new Float32Array(this.capacity);
    this.v0 = new Float32Array(this.capacity);
    this.dirX = new Float32Array(this.capacity);
    this.dirZ = new Float32Array(this.capacity);
    this.age = new Float32Array(this.capacity);
    this.lifetime = new Float32Array(this.capacity);
    this.size = new Float32Array(this.capacity);
    this.growth = new Float32Array(this.capacity);
    this.rotation = new Float32Array(this.capacity);
    this.spin = new Float32Array(this.capacity);
    this.floorY = new Float32Array(this.capacity);
  }

  clear() {
    this.alive = 0;
  }

  /** Allocate a slot; if full and overwriteOldest is true, evict the oldest puff so jet cores never starve. */
  allocateSlot(overwriteOldest: boolean): number {
    if (this.alive < this.capacity) {
      return this.alive++;
    }
    if (!overwriteOldest) return -1;
    let oldestIdx = 0;
    let maxNormAge = -1;
    for (let i = 0; i < this.alive; i++) {
      const na = this.age[i] / Math.max(1e-4, this.lifetime[i]);
      if (na > maxNormAge) {
        maxNormAge = na;
        oldestIdx = i;
      }
    }
    return oldestIdx;
  }

  copySlot(dst: number, src: number) {
    if (dst === src) return;
    this.x[dst] = this.x[src];
    this.y[dst] = this.y[src];
    this.z[dst] = this.z[src];
    this.px[dst] = this.px[src];
    this.py[dst] = this.py[src];
    this.pz[dst] = this.pz[src];
    this.vx[dst] = this.vx[src];
    this.vy[dst] = this.vy[src];
    this.vz[dst] = this.vz[src];
    this.vc[dst] = this.vc[src];
    this.v0[dst] = this.v0[src];
    this.dirX[dst] = this.dirX[src];
    this.dirZ[dst] = this.dirZ[src];
    this.age[dst] = this.age[src];
    this.lifetime[dst] = this.lifetime[src];
    this.size[dst] = this.size[src];
    this.growth[dst] = this.growth[src];
    this.rotation[dst] = this.rotation[src];
    this.spin[dst] = this.spin[src];
    this.floorY[dst] = this.floorY[src];
  }
}

// Falling CO2 two-component exact exponential integrator constants (stylised dense-vapour approximation).
const CO2_KJ = 4.0;
const CO2_KC = 2.2;
const CO2_GC = -3.5;
const CO2_VT = CO2_GC / CO2_KC; // ~ -1.5909 m/s
const CO2_EJ = Math.exp(-CO2_KJ * PARTICLE_FIXED_STEP_S);
const CO2_EC = Math.exp(-CO2_KC * PARTICLE_FIXED_STEP_S);
const CO2_JET_STEP_GAIN = (1 - CO2_EJ) / CO2_KJ;
const CO2_LAT_RELAX = Math.exp(-2.0 * PARTICLE_FIXED_STEP_S);
const CO2_FLOOR_RELAX = Math.exp(-4.0 * PARTICLE_FIXED_STEP_S);

// Bake a density field once. Each puff rotates, expands and fades independently.
function makeVaporTexture(): THREE.DataTexture {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  const lattice = new Float32Array(64 * 64);
  let seed = 721526;
  for (let i = 0; i < lattice.length; i++) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    lattice[i] = seed / 4294967296;
  }
  const sample = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = THREE.MathUtils.smoothstep(x - ix, 0, 1);
    const fy = THREE.MathUtils.smoothstep(y - iy, 0, 1);
    const a = (iy & 63) * 64, b = ((iy + 1) & 63) * 64;
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(lattice[a + (ix & 63)], lattice[a + ((ix + 1) & 63)], fx),
      THREE.MathUtils.lerp(lattice[b + (ix & 63)], lattice[b + ((ix + 1) & 63)], fx), fy
    );
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size, ny = (y + 0.5) / size;
      const r = Math.hypot(2 * nx - 1, 2 * ny - 1);
      const broad = sample(12 + 4 * nx, 5 + 4 * ny);
      const mid = sample(9 * nx + broad, 9 * ny + 2 * broad);
      const fine = sample(23 * nx, 23 * ny);
      const turbulence = 0.54 * broad + 0.33 * mid + 0.13 * fine;
      const falloff = THREE.MathUtils.smoothstep(1 - r + (turbulence - 0.5) * 0.64, 0.14, 0.65);
      const shade = Math.round(255 * (0.62 + 0.38 * turbulence));
      const i = (y * size + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = shade;
      pixels[i + 3] = Math.round(255 * falloff * (0.13 + 0.84 * turbulence));
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Camera-facing quads keep a world-space diameter even at close camera presets,
// where hardware point-size limits would otherwise shrink the immediate plume.
class VaporBatch {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly color = new THREE.Color();
  readonly capacity: number;
  readonly aspect: number;
  private readonly texture: THREE.Texture;
  private litMode = false;
  centers!: THREE.InstancedBufferAttribute;
  shapes!: THREE.InstancedBufferAttribute;
  broadLights: THREE.InstancedBufferAttribute | null = null;
  lobeLights: THREE.InstancedBufferAttribute | null = null;
  lobeOffsets: THREE.InstancedBufferAttribute | null = null;
  lastCount = 0;
  lastUploadBytes = 0;

  constructor(capacity: number, texture: THREE.Texture, aspect: number, lit = false) {
    this.capacity = Math.max(1, capacity);
    this.texture = texture;
    this.aspect = aspect;
    const { geometry, material } = this.createResources(lit);
    this.litMode = lit;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    // Never admit transparent per-frame billboard batches into RenderBatcher.
    this.mesh.userData.noBatch = true;
  }

  private createResources(lit: boolean): {
    geometry: THREE.InstancedBufferGeometry;
    material: THREE.ShaderMaterial;
  } {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3));
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('center', this.centers);
    geometry.setAttribute('shape', this.shapes);
    if (lit) {
      this.broadLights = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.lobeLights = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.lobeOffsets = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('broadLight', this.broadLights);
      geometry.setAttribute('lobeLight', this.lobeLights);
      geometry.setAttribute('lobeOffset', this.lobeOffsets);
    } else {
      this.broadLights = null;
      this.lobeLights = null;
      this.lobeOffsets = null;
    }
    geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      uniforms: { vapor: { value: this.texture }, tint: { value: this.color }, aspect: { value: this.aspect } },
      vertexShader: lit ? VAPOR_VERT_LIT : VAPOR_VERT_BASE,
      fragmentShader: lit ? VAPOR_FRAG_LIT : VAPOR_FRAG_BASE,
      transparent: true,
      depthWrite: false,
    });
    return { geometry, material };
  }

  setLitMode(lit: boolean): void {
    const next = Boolean(lit);
    if (this.litMode === next) return;
    const oldGeo = this.mesh.geometry;
    const oldMat = this.mesh.material;
    const { geometry, material } = this.createResources(next);
    this.litMode = next;
    this.mesh.geometry = geometry;
    this.mesh.material = material;
    this.mesh.visible = false;
    this.lastCount = 0;
    this.lastUploadBytes = 0;
    oldGeo.dispose();
    oldMat.dispose();
  }

  isLitMode(): boolean {
    return this.litMode;
  }

  extraBufferBytes(): number {
    return this.litMode ? this.capacity * LIT_PUFFS_BYTES_PER_INSTANCE : 0;
  }

  write(i: number, x: number, y: number, z: number, size: number, rotation: number, opacity: number) {
    this.centers.setXYZ(i, x, y, z);
    this.shapes.setXYZ(i, size, rotation, opacity);
  }

  writeLit(
    i: number,
    broadR: number,
    broadG: number,
    broadB: number,
    lobeR: number,
    lobeG: number,
    lobeB: number,
    offX: number,
    offY: number,
    offZ: number,
    conc: number,
  ) {
    if (!this.broadLights || !this.lobeLights || !this.lobeOffsets) return;
    this.broadLights.setXYZ(i, broadR, broadG, broadB);
    this.lobeLights.setXYZ(i, lobeR, lobeG, lobeB);
    this.lobeOffsets.setXYZW(i, offX, offY, offZ, conc);
  }

  finish(count: number) {
    this.lastCount = count;
    this.mesh.geometry.instanceCount = count;
    this.mesh.visible = count > 0;
    if (!count) {
      this.lastUploadBytes = 0;
      return;
    }
    this.centers.addUpdateRange(0, count * 3);
    this.shapes.addUpdateRange(0, count * 3);
    this.centers.needsUpdate = true;
    this.shapes.needsUpdate = true;
    if (this.litMode && this.broadLights && this.lobeLights && this.lobeOffsets) {
      this.broadLights.addUpdateRange(0, count * 3);
      this.lobeLights.addUpdateRange(0, count * 3);
      this.lobeOffsets.addUpdateRange(0, count * 4);
      this.broadLights.needsUpdate = true;
      this.lobeLights.needsUpdate = true;
      this.lobeOffsets.needsUpdate = true;
      this.lastUploadBytes = count * 16 * 4;
    } else {
      this.lastUploadBytes = count * 6 * 4;
    }
  }

  onContextRestored() {
    this.mesh.material.needsUpdate = true;
    if (this.lastCount > 0) {
      this.centers.needsUpdate = true;
      this.shapes.needsUpdate = true;
      if (this.litMode && this.broadLights && this.lobeLights && this.lobeOffsets) {
        this.broadLights.needsUpdate = true;
        this.lobeLights.needsUpdate = true;
        this.lobeOffsets.needsUpdate = true;
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

interface HazeOrigin {
  x: number;
  y: number;
  z: number;
  seed: number;
}

/**
 * Lazy runtime allocated exclusively while `litPuffs` is enabled (`null` / `0 B` when disabled).
 */
interface LitPuffsRuntime {
  readonly candidateCap: number;
  readonly beamsPerPuffCap: number;
  readonly candidates: LitCandidateSet;
  readonly smokeState: LitPuffPoolState;
  readonly cryoState: LitPuffPoolState;
  readonly smokeRegion: CloudSphereRegion;
  readonly cryoRegion: CloudSphereRegion;
  readonly frameCtx: LitPuffsFrameContext;
  nextSpawnSeq: number;
  smokeFirstOrder: boolean;
  lastLitSmokePuffs: number;
  lastLitCryoPuffs: number;
}

export class AtmosphericParticles {
  readonly group = new THREE.Group();
  readonly tier: RenderTier;
  private readonly caps: ParticleTierCapacities;
  private texture = makeVaporTexture();
  private smoke: VaporBatch;
  private cryo: VaporBatch;
  private haze: VaporBatch;
  private smokePool: PuffPool;
  private cryoPool: PuffPool;
  private smokeEmitters: THREE.Vector3[] = [];
  private co2Emitters: THREE.Vector3[] = [];
  private deckY = 0;
  private fallingCo2 = false;
  private litPuffsRequested = false;
  private litRuntime: LitPuffsRuntime | null = null;
  private baseSeed: number;
  private smokeRng: () => number = mulberry32(DEFAULT_PARTICLE_SEED);
  private cryoRng: () => number = mulberry32(DEFAULT_PARTICLE_SEED ^ 0x9e3779b9);
  private hazeRng: () => number = mulberry32(DEFAULT_PARTICLE_SEED ^ 0x85ebca6b);
  private hazeOrigins: HazeOrigin[] = [];
  private smokeRemainder = 0;
  private cryoRemainder = 0;
  private smokeEmitterCursor = 0;
  private cryoEmitterCursor = 0;
  private simTime = 0;
  private accumulator = 0;
  private droppedSpawns = 0;
  private droppedSimulationMs = 0;
  private lastSmokeCount = 0;
  private lastCryoCount = 0;
  private lastHazeCount = 0;
  // Cached upload context so live `litPuffs` or camera changes at a frozen frame re-upload without stepping physics.
  private lastAlpha = 0;
  private lastHasFrame = false;
  private lastStageTint = new THREE.Color(0x00f0ff);
  private lastStagePower = 0;
  private lastBlackout = false;
  private lastMaster = 1;
  private lastRoomGain = 1;
  private lastCamPosX = 0;
  private lastCamPosY = 4.5;
  private lastCamPosZ = 26;
  private lastCamFwdX = 0;
  private lastCamFwdY = -0.1;
  private lastCamFwdZ = -0.995;

  constructor(tier: RenderTier = 'high', seed = DEFAULT_PARTICLE_SEED) {
    this.tier = tier;
    this.caps = PARTICLE_CAPACITIES[tier];
    this.baseSeed = seed >>> 0;
    this.smoke = new VaporBatch(this.caps.smoke, this.texture, 1.18, false);
    this.cryo = new VaporBatch(this.caps.cryo, this.texture, 0.88, false);
    this.haze = new VaporBatch(this.caps.haze, this.texture, 1.7, false);
    this.smokePool = new PuffPool(this.caps.smoke);
    this.cryoPool = new PuffPool(this.caps.cryo);
    this.haze.mesh.renderOrder = -1;
    this.group.add(this.haze.mesh, this.smoke.mesh, this.cryo.mesh);
    this.reset(this.baseSeed);
  }

  public setFallingCo2(enabled: boolean) {
    const next = Boolean(enabled);
    if (this.fallingCo2 === next) return;
    this.fallingCo2 = next;
    // Clear active cryo puffs so old ascending velocities don't mix with dense-vapour physics.
    this.cryoPool.clear();
    this.litRuntime?.cryoState.zeroLighting(this.caps.cryo);
    this.cryoRemainder = 0;
    this.cryo.finish(0);
    this.lastCryoCount = 0;
    if (this.litRuntime) this.litRuntime.lastLitCryoPuffs = 0;
  }

  public isFallingCo2(): boolean {
    return this.fallingCo2;
  }

  /**
   * Enable or disable locally beam-lit smoke & CO2 puffs (Sprint 20).
   * When disabled (default), zero optional CPU state arrays or GPU buffers exist, and
   * `smoke`/`cryo` restore their exact base shaders, slot order, and `renderOrder = 0`.
   * When `lighting` is provided, immediately re-uploads active puffs at `dt = 0` without
   * advancing simulation time, RNG streams, or flash governors.
   */
  public setLitPuffs(enabled: boolean, lighting?: ParticleLightingUpdate) {
    const requested = Boolean(enabled);
    this.litPuffsRequested = requested;
    const shouldAllocate = requested && canAdmitLitPuffsBuffers(this.caps.smoke, this.caps.cryo);

    if (shouldAllocate) {
      if (!this.litRuntime) {
        const candidateCap = candidateCapForTier(this.tier);
        const beamsPerPuffCap = beamsPerPuffForTier(this.tier);
        const smokeState = new LitPuffPoolState(this.caps.smoke);
        const cryoState = new LitPuffPoolState(this.caps.cryo);
        let seq = smokeState.seedAliveSequential(this.smokePool.alive, 0);
        seq = cryoState.seedAliveSequential(this.cryoPool.alive, seq);
        this.litRuntime = {
          candidateCap,
          beamsPerPuffCap,
          candidates: new LitCandidateSet(candidateCap),
          smokeState,
          cryoState,
          smokeRegion: { active: false, cx: 0, cy: 2, cz: 0, radius: 2.5 },
          cryoRegion: { active: false, cx: 0, cy: 2, cz: 0, radius: 2.5 },
          frameCtx: {
            blackout: this.lastBlackout,
            master: this.lastMaster,
            roomGain: this.lastRoomGain,
            camPosX: this.lastCamPosX,
            camPosY: this.lastCamPosY,
            camPosZ: this.lastCamPosZ,
            camFwdX: this.lastCamFwdX,
            camFwdY: this.lastCamFwdY,
            camFwdZ: this.lastCamFwdZ,
          },
          nextSpawnSeq: seq,
          smokeFirstOrder: true,
          lastLitSmokePuffs: 0,
          lastLitCryoPuffs: 0,
        };
      }
      this.smoke.setLitMode(true);
      this.cryo.setLitMode(true);
    } else {
      this.litRuntime = null;
      this.smoke.setLitMode(false);
      this.cryo.setLitMode(false);
      this.smoke.mesh.renderOrder = 0;
      this.cryo.mesh.renderOrder = 0;
    }

    if (lighting) {
      this.cacheLightingContext(lighting);
    }
    if (this.lastHasFrame) {
      this.applyBatchTintColors();
    }
    if (this.lastHasFrame || this.smokePool.alive > 0 || this.cryoPool.alive > 0) {
      this.uploadSmokeAndCryo(0, lighting?.beams);
    }
  }

  private applyBatchTintColors() {
    const power = this.lastStagePower;
    const tint = this.lastStageTint;
    const smokeAmb = this.litRuntime ? LIT_PUFFS_SMOKE_AMBIENT_SCALE : 1.0;
    const cryoAmb = this.litRuntime ? LIT_PUFFS_CRYO_AMBIENT_SCALE : 1.0;
    this.smoke.color.setHex(0x617183).lerp(tint, 0.22).multiplyScalar(0.025 + power * 0.88 * smokeAmb);
    this.cryo.color.setHex(0xcadbec).lerp(tint, 0.15).multiplyScalar(0.018 + power * 0.68 * cryoAmb);
    this.haze.color.setHex(0x425162).lerp(tint, 0.16).multiplyScalar(power);
  }

  public isLitPuffsEnabled(): boolean {
    return this.litRuntime !== null;
  }

  /**
   * Re-evaluate and re-upload active lit puffs at `dt = 0` from committed fixture & camera state
   * (used for frozen-frame camera pose changes and toggles).
   */
  public syncLitFromCommittedState(lighting: ParticleLightingUpdate) {
    this.cacheLightingContext(lighting);
    if (!this.litRuntime) return;
    this.uploadSmokeAndCryo(0, lighting.beams);
  }

  private cacheLightingContext(lighting: ParticleLightingUpdate) {
    this.lastBlackout = Boolean(lighting.blackout);
    this.lastMaster = Number.isFinite(lighting.master) ? lighting.master : 1;
    this.lastRoomGain = Number.isFinite(lighting.roomGain) ? lighting.roomGain : 1;
    if (Number.isFinite(lighting.camPosX) && Number.isFinite(lighting.camPosY) && Number.isFinite(lighting.camPosZ)) {
      this.lastCamPosX = lighting.camPosX;
      this.lastCamPosY = lighting.camPosY;
      this.lastCamPosZ = lighting.camPosZ;
    }
    const fLen = Math.hypot(lighting.camFwdX, lighting.camFwdY, lighting.camFwdZ);
    if (Number.isFinite(fLen) && fLen > 1e-6) {
      this.lastCamFwdX = lighting.camFwdX / fLen;
      this.lastCamFwdY = lighting.camFwdY / fLen;
      this.lastCamFwdZ = lighting.camFwdZ / fLen;
    }
  }

  public getLitPuffsStats(): LitPuffsStats {
    const rt = this.litRuntime;
    const allocated = rt !== null && this.smoke.isLitMode() && this.cryo.isLitMode();
    return {
      requested: this.litPuffsRequested,
      allocated,
      active: allocated,
      suppressedReason: !this.litPuffsRequested
        ? 'disabled'
        : allocated
          ? null
          : 'memory-budget',
      tier: this.tier,
      candidateCap: candidateCapForTier(this.tier),
      selectedCandidateCount: rt ? rt.candidates.count : 0,
      beamsPerPuffCap: beamsPerPuffForTier(this.tier),
      litSmokePuffs: rt ? rt.lastLitSmokePuffs : 0,
      litCryoPuffs: rt ? rt.lastLitCryoPuffs : 0,
      smokeRenderOrder: this.smoke.mesh.renderOrder,
      cryoRenderOrder: this.cryo.mesh.renderOrder,
      extraBufferBytes: allocated
        ? litPuffsExtraBufferBytes(this.caps.smoke, this.caps.cryo)
        : 0,
    };
  }

  public onContextRestored() {
    this.texture.needsUpdate = true;
    this.haze.onContextRestored();
    this.smoke.onContextRestored();
    this.cryo.onContextRestored();
  }

  /** Reset RNG streams, fixed-step accumulator, remainders, puff pools, and visible instances. */
  public reset(seed = this.baseSeed) {
    this.baseSeed = seed >>> 0;
    this.smokeRng = mulberry32((this.baseSeed ^ 0x13579bdf) >>> 0);
    this.cryoRng = mulberry32((this.baseSeed ^ 0x9e3779b9) >>> 0);
    this.hazeRng = mulberry32((this.baseSeed ^ 0x85ebca6b) >>> 0);
    this.hazeOrigins = Array.from({ length: this.caps.haze }, () => ({
      x: (this.hazeRng() - 0.5) * 32,
      y: 1.8 + this.hazeRng() * 10,
      z: -6 + this.hazeRng() * 22,
      seed: this.hazeRng() * Math.PI * 2,
    }));
    this.smokePool.clear();
    this.cryoPool.clear();
    if (this.litRuntime) {
      this.litRuntime.candidates.clear();
      this.litRuntime.smokeState.zeroLighting(this.caps.smoke);
      this.litRuntime.cryoState.zeroLighting(this.caps.cryo);
      this.litRuntime.nextSpawnSeq = 0;
      this.litRuntime.smokeFirstOrder = true;
      this.litRuntime.lastLitSmokePuffs = 0;
      this.litRuntime.lastLitCryoPuffs = 0;
      this.smoke.mesh.renderOrder = 1;
      this.cryo.mesh.renderOrder = 2;
    }
    this.smokeRemainder = 0;
    this.cryoRemainder = 0;
    this.smokeEmitterCursor = 0;
    this.cryoEmitterCursor = 0;
    this.simTime = 0;
    this.accumulator = 0;
    this.droppedSpawns = 0;
    this.droppedSimulationMs = 0;
    this.lastSmokeCount = 0;
    this.lastCryoCount = 0;
    this.lastHazeCount = 0;
    this.lastAlpha = 0;
    this.smoke.finish(0);
    this.cryo.finish(0);
    this.haze.finish(0);
  }

  public setEmitters(smokeEmitters: THREE.Vector3[], co2Emitters: THREE.Vector3[], deckY = 0) {
    this.smokeEmitters = smokeEmitters;
    this.co2Emitters = co2Emitters;
    this.deckY = Number.isFinite(deckY) ? deckY : 0;
    this.smokePool.clear();
    this.cryoPool.clear();
    if (this.litRuntime) {
      this.litRuntime.candidates.clear();
      this.litRuntime.smokeState.zeroLighting(this.caps.smoke);
      this.litRuntime.cryoState.zeroLighting(this.caps.cryo);
      this.litRuntime.nextSpawnSeq = 0;
      this.litRuntime.smokeFirstOrder = true;
      this.litRuntime.lastLitSmokePuffs = 0;
      this.litRuntime.lastLitCryoPuffs = 0;
      this.smoke.mesh.renderOrder = 1;
      this.cryo.mesh.renderOrder = 2;
    }
    this.smokeRemainder = 0;
    this.cryoRemainder = 0;
    this.smokeEmitterCursor = 0;
    this.cryoEmitterCursor = 0;
    this.smoke.finish(0);
    this.cryo.finish(0);
    this.lastSmokeCount = 0;
    this.lastCryoCount = 0;
  }

  public getStats(): ParticleStats {
    return {
      smoke: { alive: this.lastSmokeCount, capacity: this.caps.smoke },
      cryo: { alive: this.lastCryoCount, capacity: this.caps.cryo },
      haze: { alive: this.lastHazeCount, capacity: this.caps.haze },
      droppedSpawns: this.droppedSpawns,
      droppedSimulationMs: this.droppedSimulationMs,
      uploadBytes: this.smoke.lastUploadBytes + this.cryo.lastUploadBytes + this.haze.lastUploadBytes,
    };
  }

  /** Inspect raw particle arrays for unit tests (read-only snapshot of live cryo/smoke positions & velocities). */
  public debugSnapshot() {
    const readPool = (pool: PuffPool) => {
      const out = [];
      for (let i = 0; i < pool.alive; i++) {
        out.push({
          x: pool.x[i],
          y: pool.y[i],
          z: pool.z[i],
          vx: pool.vx[i],
          vy: pool.vy[i],
          vc: pool.vc[i],
          vz: pool.vz[i],
          age: pool.age[i],
          lifetime: pool.lifetime[i],
        });
      }
      return out;
    };
    return {
      simTime: this.simTime,
      smoke: readPool(this.smokePool),
      cryo: readPool(this.cryoPool),
      hazeOrigins: this.hazeOrigins.map((o) => ({ ...o })),
    };
  }

  /** Inspect uploaded batch attributes & draw order for unit tests (read-only). */
  public debugUploadedBatches() {
    const readBatch = (batch: VaporBatch) => {
      const count = batch.lastCount;
      const centers: Array<[number, number, number]> = [];
      const shapes: Array<[number, number, number]> = [];
      const broadLights: Array<[number, number, number]> = [];
      const lobeLights: Array<[number, number, number]> = [];
      const lobeOffsets: Array<[number, number, number, number]> = [];
      for (let i = 0; i < count; i++) {
        centers.push([batch.centers.getX(i), batch.centers.getY(i), batch.centers.getZ(i)]);
        shapes.push([batch.shapes.getX(i), batch.shapes.getY(i), batch.shapes.getZ(i)]);
        if (batch.isLitMode() && batch.broadLights && batch.lobeLights && batch.lobeOffsets) {
          broadLights.push([batch.broadLights.getX(i), batch.broadLights.getY(i), batch.broadLights.getZ(i)]);
          lobeLights.push([batch.lobeLights.getX(i), batch.lobeLights.getY(i), batch.lobeLights.getZ(i)]);
          lobeOffsets.push([
            batch.lobeOffsets.getX(i),
            batch.lobeOffsets.getY(i),
            batch.lobeOffsets.getZ(i),
            batch.lobeOffsets.getW(i),
          ]);
        }
      }
      return {
        litMode: batch.isLitMode(),
        renderOrder: batch.mesh.renderOrder,
        count,
        centers,
        shapes,
        broadLights,
        lobeLights,
        lobeOffsets,
      };
    };
    return {
      smoke: readBatch(this.smoke),
      cryo: readBatch(this.cryo),
      haze: {
        litMode: this.haze.isLitMode(),
        renderOrder: this.haze.mesh.renderOrder,
        count: this.haze.lastCount,
      },
    };
  }

  public update(
    dt: number,
    _time: number,
    hazeLevel: number,
    smokeOutput: number,
    co2Active: boolean,
    tint: THREE.Color,
    stageLightIntensity: number,
    lighting?: ParticleLightingUpdate,
  ) {
    const power = THREE.MathUtils.clamp(stageLightIntensity, 0, 1.5);
    this.lastStageTint.copy(tint);
    this.lastStagePower = power;
    this.applyBatchTintColors();

    // Fixed-step simulation with bounded catch-up so tab resumes never burst.
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const maxCatchup = PARTICLE_FIXED_STEP_S * PARTICLE_MAX_SUBSTEPS;
    if (safeDt > maxCatchup) {
      this.droppedSimulationMs += (safeDt - maxCatchup) * 1000;
    }
    this.accumulator += Math.min(safeDt, maxCatchup);

    let substeps = 0;
    while (this.accumulator >= PARTICLE_FIXED_STEP_S - 1e-9 && substeps < PARTICLE_MAX_SUBSTEPS) {
      this.accumulator = Math.max(0, this.accumulator - PARTICLE_FIXED_STEP_S);
      this.stepSimulation(PARTICLE_FIXED_STEP_S, smokeOutput, co2Active);
      substeps++;
    }
    if (this.accumulator > maxCatchup) {
      this.droppedSimulationMs += (this.accumulator - maxCatchup) * 1000;
      this.accumulator = maxCatchup;
    }

    const alpha = THREE.MathUtils.clamp(this.accumulator / PARTICLE_FIXED_STEP_S, 0, 1);
    this.lastAlpha = alpha;
    this.lastHasFrame = true;
    if (lighting) {
      this.cacheLightingContext(lighting);
    }
    const renderTime = this.simTime + this.accumulator;

    // 1. Haze ambient drift (deterministic from simTime + seeded origins).
    if (hazeLevel > 0.001 && power > 0.001) {
      for (let i = 0; i < this.hazeOrigins.length; i++) {
        const origin = this.hazeOrigins[i];
        const phase = renderTime * 0.095 + origin.seed;
        this.haze.write(
          i,
          origin.x + 1.6 * Math.sin(phase),
          origin.y + 0.45 * Math.cos(phase),
          origin.z + 0.8 * Math.sin(phase + 0.9),
          6.4 + origin.seed * 0.6,
          0.15 * Math.sin(phase * 0.6),
          0.044 * hazeLevel,
        );
      }
      this.haze.finish(this.hazeOrigins.length);
      this.lastHazeCount = this.hazeOrigins.length;
    } else {
      this.haze.finish(0);
      this.lastHazeCount = 0;
    }

    // 2. Upload interpolated smoke & cryo batches once per displayed frame.
    this.uploadSmokeAndCryo(safeDt, lighting?.beams);
    this.lastSmokeCount = this.smokePool.alive;
    this.lastCryoCount = this.cryoPool.alive;
  }

  private uploadSmokeAndCryo(dt: number, beams?: readonly LitBeamSource[]) {
    const alpha = this.lastAlpha;
    const rt = this.litRuntime;
    if (!rt) {
      this.uploadPoolUnlit(this.smokePool, this.smoke, alpha, false);
      this.uploadPoolUnlit(this.cryoPool, this.cryo, alpha, true);
      return;
    }

    const fCtx = rt.frameCtx;
    fCtx.blackout = this.lastBlackout;
    fCtx.master = this.lastMaster;
    fCtx.roomGain = this.lastRoomGain;
    fCtx.camPosX = this.lastCamPosX;
    fCtx.camPosY = this.lastCamPosY;
    fCtx.camPosZ = this.lastCamPosZ;
    fCtx.camFwdX = this.lastCamFwdX;
    fCtx.camFwdY = this.lastCamFwdY;
    fCtx.camFwdZ = this.lastCamFwdZ;

    computePoolCloudSphere(
      this.smokePool.alive,
      this.smokePool.px, this.smokePool.py, this.smokePool.pz,
      this.smokePool.x, this.smokePool.y, this.smokePool.z,
      this.smokePool.size, alpha, rt.smokeRegion,
    );
    computePoolCloudSphere(
      this.cryoPool.alive,
      this.cryoPool.px, this.cryoPool.py, this.cryoPool.pz,
      this.cryoPool.x, this.cryoPool.y, this.cryoPool.z,
      this.cryoPool.size, alpha, rt.cryoRegion,
    );

    if (beams !== undefined) {
      rt.candidates.select(
        beams,
        fCtx,
        rt.smokeRegion,
        rt.cryoRegion,
        this.smokeEmitters,
        this.co2Emitters,
      );
    } else if (fCtx.blackout || fCtx.master <= 0.001 || fCtx.roomGain <= 0.001) {
      rt.candidates.clear();
    }

    const smokeSummary = this.uploadPoolLit(this.smokePool, rt.smokeState, this.smoke, alpha, false, dt, rt);
    const cryoSummary = this.uploadPoolLit(this.cryoPool, rt.cryoState, this.cryo, alpha, true, dt, rt);
    rt.lastLitSmokePuffs = smokeSummary.litCount;
    rt.lastLitCryoPuffs = cryoSummary.litCount;

    const order = resolveSmokeCryoRenderOrder(
      this.smokePool.alive,
      smokeSummary.meanDepth,
      this.cryoPool.alive,
      cryoSummary.meanDepth,
      rt.smokeFirstOrder,
    );
    rt.smokeFirstOrder = order.smokeFirst;
    this.smoke.mesh.renderOrder = order.smokeOrder;
    this.cryo.mesh.renderOrder = order.cryoOrder;
  }

  private stepSimulation(h: number, smokeOutput: number, co2Active: boolean) {
    this.simTime += h;
    const rt = this.litRuntime;

    // Spawn smoke puffs fairly across emitters.
    const smokeEmitterCount = this.smokeEmitters.length;
    if (smokeEmitterCount > 0 && smokeOutput > 0) {
      const tierRateCap = this.tier === 'low' ? 46 : 92;
      const rate = Math.min(tierRateCap, 23 * smokeOutput * Math.min(4, smokeEmitterCount));
      this.smokeRemainder += h * rate;
      const smokeCount = Math.floor(this.smokeRemainder);
      this.smokeRemainder -= smokeCount;
      for (let i = 0; i < smokeCount; i++) {
        const slot = this.smokePool.allocateSlot(false);
        if (slot < 0) {
          this.droppedSpawns += smokeCount - i;
          break;
        }
        const em = this.smokeEmitters[this.smokeEmitterCursor % smokeEmitterCount];
        this.smokeEmitterCursor = (this.smokeEmitterCursor + 1) % smokeEmitterCount;
        const rng = this.smokeRng;
        const angle = rng() * Math.PI * 2;
        const x = em.x + 0.09 * Math.sin(angle);
        const y = em.y + 0.25;
        const z = em.z + 0.09 * Math.cos(angle);
        const p = this.smokePool;
        p.x[slot] = p.px[slot] = x;
        p.y[slot] = p.py[slot] = y;
        p.z[slot] = p.pz[slot] = z;
        p.vx[slot] = (rng() - 0.5) * 0.85;
        p.vy[slot] = 0.6 + rng() * 0.7;
        p.vz[slot] = 1.15 + rng() * 1.1;
        p.vc[slot] = 0;
        p.v0[slot] = 0;
        p.dirX[slot] = Math.sin(angle);
        p.dirZ[slot] = Math.cos(angle);
        p.age[slot] = 0;
        p.lifetime[slot] = 2.7 + rng() * 2.0;
        p.size[slot] = 0.42 + rng() * 0.18;
        p.growth[slot] = 0.93 + rng() * 0.46;
        p.rotation[slot] = angle;
        p.spin[slot] = (rng() - 0.5) * 0.48;
        p.floorY[slot] = this.deckY;
        if (rt) {
          rt.nextSpawnSeq = (rt.nextSpawnSeq + 1) >>> 0;
          rt.smokeState.initSlot(slot, rt.nextSpawnSeq);
        }
      }
    }

    // Spawn CO2 cryo puffs fairly across emitters.
    const co2EmitterCount = this.co2Emitters.length;
    if (co2Active && co2EmitterCount > 0) {
      let totalRate: number;
      let sizeScale = 1.0;
      if (this.fallingCo2) {
        // Cap-aware emission rate so longer falling-plume lifetimes stay within pool capacity.
        const maxTotal = this.tier === 'low' ? 70 : 160;
        const perEmitterCap = this.tier === 'low' ? 32 : 72;
        totalRate = Math.min(perEmitterCap * co2EmitterCount, maxTotal);
        const perEmitter = totalRate / co2EmitterCount;
        sizeScale = Math.min(1.5, Math.sqrt(72 / Math.max(8, perEmitter)));
      } else {
        const tierRateCap = this.tier === 'low' ? 180 : 432;
        totalRate = Math.min(tierRateCap, 72 * Math.min(6, co2EmitterCount));
      }
      this.cryoRemainder += h * totalRate;
      const cryoCount = Math.floor(this.cryoRemainder);
      this.cryoRemainder -= cryoCount;
      for (let i = 0; i < cryoCount; i++) {
        const slot = this.cryoPool.allocateSlot(this.fallingCo2);
        if (slot < 0) {
          this.droppedSpawns += cryoCount - i;
          break;
        }
        const em = this.co2Emitters[this.cryoEmitterCursor % co2EmitterCount];
        this.cryoEmitterCursor = (this.cryoEmitterCursor + 1) % co2EmitterCount;
        const rng = this.cryoRng;
        const angle = rng() * Math.PI * 2;
        const dirX = Math.sin(angle);
        const dirZ = Math.cos(angle);
        const spread = 0.22 + rng() * 0.72;
        const x = em.x + 0.055 * dirX;
        const y = em.y + 0.12;
        const z = em.z + 0.055 * dirZ;
        const p = this.cryoPool;
        p.x[slot] = p.px[slot] = x;
        p.y[slot] = p.py[slot] = y;
        p.z[slot] = p.pz[slot] = z;
        p.vx[slot] = dirX * spread;
        const v0 = 11.0 + rng() * 4.6;
        p.vy[slot] = v0;
        p.vz[slot] = dirZ * spread + 0.22;
        p.vc[slot] = 0;
        p.v0[slot] = v0;
        p.dirX[slot] = dirX;
        p.dirZ[slot] = dirZ;
        p.age[slot] = 0;
        p.lifetime[slot] = this.fallingCo2 ? (1.6 + rng() * 0.8) : (0.78 + rng() * 0.52);
        p.size[slot] = (0.25 + rng() * 0.16) * sizeScale;
        p.growth[slot] = 1.3 + rng() * 1.25;
        p.rotation[slot] = angle;
        p.spin[slot] = (rng() - 0.5) * 1.0;
        p.floorY[slot] = Math.min(this.deckY, em.y);
        if (rt) {
          rt.nextSpawnSeq = (rt.nextSpawnSeq + 1) >>> 0;
          rt.cryoState.initSlot(slot, rt.nextSpawnSeq);
        }
      }
    }

    this.advancePool(this.smokePool, rt?.smokeState ?? null, h, false);
    this.advancePool(this.cryoPool, rt?.cryoState ?? null, h, true);
  }

  private advancePool(pool: PuffPool, litState: LitPuffPoolState | null, h: number, cryo: boolean) {
    const drag = Math.exp(-h * (cryo ? 1.65 : 0.46));
    let live = 0;
    for (let i = 0; i < pool.alive; i++) {
      const nextAge = pool.age[i] + h;
      const lifetime = pool.lifetime[i];
      if (nextAge >= lifetime) continue;

      if (live !== i) {
        pool.copySlot(live, i);
        litState?.copySlot(live, i);
      }
      pool.age[live] = nextAge;
      const ageNorm = nextAge / lifetime;

      pool.px[live] = pool.x[live];
      pool.py[live] = pool.y[live];
      pool.pz[live] = pool.z[live];

      if (cryo && this.fallingCo2) {
        // Two-component exact exponential integrator:
        // 1. Upward jet momentum decays rapidly (kj = 4.0) -> apex ~2.1–3.1 m at ~0.6 s.
        // 2. Dense cold vapour sinks toward vt(age) ~ -1.59 m/s and rolls outward along the deck.
        const vJet = pool.vy[live];
        const v0 = Math.max(1e-3, pool.v0[live]);
        const vt = CO2_VT * (1 - 0.45 * THREE.MathUtils.smoothstep(ageNorm, 0.6, 1));
        const vcNext = vt + (pool.vc[live] - vt) * CO2_EC;
        const dy = vJet * CO2_JET_STEP_GAIN + vcNext * h;
        const vJetNext = vJet * CO2_EJ;
        pool.vy[live] = vJetNext;
        pool.vc[live] = vcNext;

        const stallFrac = THREE.MathUtils.clamp(1 - vJetNext / v0, 0, 1);
        const lateralTargetSpeed = 0.25 + 0.75 * stallFrac;
        const curl = Math.sin(pool.y[live] * 0.95 + pool.rotation[live] + this.simTime * 0.62) * ageNorm * 0.35;

        let nextY = pool.y[live] + dy;
        const floorClampY = pool.floorY[live] + 0.15;
        if (nextY <= floorClampY && (vJetNext + vcNext) <= 0) {
          nextY = floorClampY;
          pool.vc[live] = 0;
          pool.vy[live] = 0;
          const floorRollSpeed = 0.85;
          pool.vx[live] = pool.dirX[live] * floorRollSpeed + (pool.vx[live] - pool.dirX[live] * floorRollSpeed) * CO2_FLOOR_RELAX;
          pool.vz[live] = pool.dirZ[live] * floorRollSpeed + (pool.vz[live] - pool.dirZ[live] * floorRollSpeed) * CO2_FLOOR_RELAX;
        } else {
          const tx = pool.dirX[live] * lateralTargetSpeed;
          const tz = pool.dirZ[live] * lateralTargetSpeed;
          pool.vx[live] = tx + (pool.vx[live] - tx) * CO2_LAT_RELAX;
          pool.vz[live] = tz + (pool.vz[live] - tz) * CO2_LAT_RELAX;
        }
        pool.x[live] += (pool.vx[live] + curl) * h;
        pool.y[live] = nextY;
        pool.z[live] += pool.vz[live] * h;
      } else {
        pool.vy[live] *= drag;
        pool.vz[live] *= cryo ? 1 : drag;
        const curl = Math.sin(pool.y[live] * 0.95 + pool.rotation[live] + this.simTime * 0.62) * ageNorm;
        pool.x[live] += (pool.vx[live] + curl * (cryo ? 0.68 : 0.45)) * h;
        pool.y[live] += (pool.vy[live] + (cryo ? -0.28 : 0.45) * ageNorm) * h;
        pool.z[live] += pool.vz[live] * h;
      }

      live++;
    }
    pool.alive = live;
  }

  private computePuffShape(pool: PuffPool, i: number, cryo: boolean): { diameter: number; opacity: number } {
    const age = pool.age[i];
    const ageNorm = age / Math.max(1e-4, pool.lifetime[i]);
    if (cryo && this.fallingCo2) {
      const diameter = pool.size[i] + 1.9 * (1 - Math.exp(-1.4 * age));
      const envelope =
        THREE.MathUtils.smoothstep(ageNorm, 0, 0.04) *
        (1 - THREE.MathUtils.smoothstep(ageNorm, 0.42, 1)) *
        (1 - 0.35 * THREE.MathUtils.smoothstep(ageNorm, 0.2, 0.5));
      return { diameter, opacity: 0.72 * envelope };
    }
    const diameter = pool.size[i] + age * pool.growth[i];
    const envelope =
      THREE.MathUtils.smoothstep(ageNorm, 0, 0.05) *
      (1 - THREE.MathUtils.smoothstep(ageNorm, 0.19, 1));
    return { diameter, opacity: (cryo ? 0.72 : 0.29) * envelope };
  }

  private uploadPoolUnlit(pool: PuffPool, batch: VaporBatch, alpha: number, cryo: boolean) {
    for (let i = 0; i < pool.alive; i++) {
      const age = pool.age[i];
      const x = THREE.MathUtils.lerp(pool.px[i], pool.x[i], alpha);
      const y = THREE.MathUtils.lerp(pool.py[i], pool.y[i], alpha);
      const z = THREE.MathUtils.lerp(pool.pz[i], pool.z[i], alpha);
      const { diameter, opacity } = this.computePuffShape(pool, i, cryo);
      batch.write(i, x, y, z, diameter, pool.rotation[i] + pool.spin[i] * age, opacity);
    }
    batch.finish(pool.alive);
  }

  private uploadPoolLit(
    pool: PuffPool,
    litState: LitPuffPoolState,
    batch: VaporBatch,
    alpha: number,
    cryo: boolean,
    dt: number,
    rt: LitPuffsRuntime,
  ): { litCount: number; meanDepth: number } {
    const alive = pool.alive;
    if (alive <= 0) {
      batch.finish(0);
      return { litCount: 0, meanDepth: 0 };
    }

    const fCtx = rt.frameCtx;
    let litCount = 0;
    let depthWeightSum = 0;
    let weightedDepthSum = 0;

    const sX = litState.scratchX;
    const sY = litState.scratchY;
    const sZ = litState.scratchZ;
    const sDiam = litState.scratchDiam;
    const sOpac = litState.scratchOpac;

    for (let i = 0; i < alive; i++) {
      const x = pool.px[i] + (pool.x[i] - pool.px[i]) * alpha;
      const y = pool.py[i] + (pool.y[i] - pool.py[i]) * alpha;
      const z = pool.pz[i] + (pool.z[i] - pool.pz[i]) * alpha;
      const { diameter, opacity } = this.computePuffShape(pool, i, cryo);
      sX[i] = x;
      sY[i] = y;
      sZ[i] = z;
      sDiam[i] = diameter;
      sOpac[i] = opacity;
      const depth =
        (x - fCtx.camPosX) * fCtx.camFwdX +
        (y - fCtx.camPosY) * fCtx.camFwdY +
        (z - fCtx.camPosZ) * fCtx.camFwdZ;
      litState.sortDepth[i] = depth;
      const w = opacity > 0.01 ? opacity : 0.01;
      weightedDepthSum += depth * w;
      depthWeightSum += w;

      const isLit = evaluateSinglePuffLighting(
        i,
        x,
        y,
        z,
        diameter,
        cryo,
        dt,
        rt.beamsPerPuffCap,
        rt.candidates,
        fCtx,
        litState,
      );
      if (isLit) litCount++;
    }

    sortPuffsBackToFront(alive, litState.sortDepth, litState.spawnSeq, litState.sortOrder);

    for (let outIdx = 0; outIdx < alive; outIdx++) {
      const src = litState.sortOrder[outIdx];
      batch.write(outIdx, sX[src], sY[src], sZ[src], sDiam[src], pool.rotation[src] + pool.spin[src] * pool.age[src], sOpac[src]);
      batch.writeLit(
        outIdx,
        litState.broadR[src],
        litState.broadG[src],
        litState.broadB[src],
        litState.lobeR[src],
        litState.lobeG[src],
        litState.lobeB[src],
        litState.offX[src],
        litState.offY[src],
        litState.offZ[src],
        litState.conc[src],
      );
    }

    batch.finish(alive);
    return {
      litCount,
      meanDepth: depthWeightSum > 1e-6 ? weightedDepthSum / depthWeightSum : 0,
    };
  }

  public dispose() {
    this.litRuntime = null;
    this.texture.dispose();
    this.haze.dispose();
    this.smoke.dispose();
    this.cryo.dispose();
  }
}
