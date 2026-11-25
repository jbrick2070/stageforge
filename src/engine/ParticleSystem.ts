import * as THREE from 'three';
import type { RenderTier } from './hardwareMaterials';
import { mulberry32 } from './prng';

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
  readonly centers: THREE.InstancedBufferAttribute;
  readonly shapes: THREE.InstancedBufferAttribute;
  readonly capacity: number;
  lastCount = 0;
  lastUploadBytes = 0;

  constructor(capacity: number, texture: THREE.Texture, aspect: number) {
    this.capacity = Math.max(1, capacity);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ], 3));
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('center', this.centers);
    geometry.setAttribute('shape', this.shapes);
    geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
      uniforms: { vapor: { value: texture }, tint: { value: this.color }, aspect: { value: aspect } },
      vertexShader: `
        attribute vec3 center, shape;
        uniform float aspect;
        varying vec2 texUv;
        varying float density;
        void main() {
          texUv = position.xy + 0.5;
          density = shape.z;
          vec2 offset = position.xy * vec2(aspect, 1.0) * shape.x;
          float c = cos(shape.y), s = sin(shape.y);
          vec4 eye = modelViewMatrix * vec4(center, 1.0);
          eye.xy += mat2(c, s, -s, c) * offset;
          gl_Position = projectionMatrix * eye;
        }
      `,
      fragmentShader: `
        uniform sampler2D vapor;
        uniform vec3 tint;
        varying vec2 texUv;
        varying float density;
        void main() {
          vec4 cloud = texture2D(vapor, texUv);
          float alpha = density * cloud.a;
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(tint * cloud.r, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  write(i: number, x: number, y: number, z: number, size: number, rotation: number, opacity: number) {
    this.centers.setXYZ(i, x, y, z);
    this.shapes.setXYZ(i, size, rotation, opacity);
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
    this.lastUploadBytes = count * 6 * 4;
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

  constructor(tier: RenderTier = 'high', seed = DEFAULT_PARTICLE_SEED) {
    this.tier = tier;
    this.caps = PARTICLE_CAPACITIES[tier];
    this.baseSeed = seed >>> 0;
    this.smoke = new VaporBatch(this.caps.smoke, this.texture, 1.18);
    this.cryo = new VaporBatch(this.caps.cryo, this.texture, 0.88);
    this.haze = new VaporBatch(this.caps.haze, this.texture, 1.7);
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
    this.cryoRemainder = 0;
    this.cryo.finish(0);
    this.lastCryoCount = 0;
  }

  public isFallingCo2(): boolean {
    return this.fallingCo2;
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

  public update(
    dt: number,
    _time: number,
    hazeLevel: number,
    smokeOutput: number,
    co2Active: boolean,
    tint: THREE.Color,
    stageLightIntensity: number,
  ) {
    const power = THREE.MathUtils.clamp(stageLightIntensity, 0, 1.5);
    this.smoke.color.setHex(0x617183).lerp(tint, 0.22).multiplyScalar(0.025 + power * 0.88);
    this.cryo.color.setHex(0xcadbec).lerp(tint, 0.15).multiplyScalar(0.018 + power * 0.68);
    this.haze.color.setHex(0x425162).lerp(tint, 0.16).multiplyScalar(power);

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
    this.uploadPool(this.smokePool, this.smoke, alpha, false);
    this.uploadPool(this.cryoPool, this.cryo, alpha, true);
    this.lastSmokeCount = this.smokePool.alive;
    this.lastCryoCount = this.cryoPool.alive;
  }

  private stepSimulation(h: number, smokeOutput: number, co2Active: boolean) {
    this.simTime += h;

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
      }
    }

    this.advancePool(this.smokePool, h, false);
    this.advancePool(this.cryoPool, h, true);
  }

  private advancePool(pool: PuffPool, h: number, cryo: boolean) {
    const drag = Math.exp(-h * (cryo ? 1.65 : 0.46));
    let live = 0;
    for (let i = 0; i < pool.alive; i++) {
      const nextAge = pool.age[i] + h;
      const lifetime = pool.lifetime[i];
      if (nextAge >= lifetime) continue;

      if (live !== i) pool.copySlot(live, i);
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

  private uploadPool(pool: PuffPool, batch: VaporBatch, alpha: number, cryo: boolean) {
    for (let i = 0; i < pool.alive; i++) {
      const age = pool.age[i];
      const ageNorm = age / Math.max(1e-4, pool.lifetime[i]);
      const x = THREE.MathUtils.lerp(pool.px[i], pool.x[i], alpha);
      const y = THREE.MathUtils.lerp(pool.py[i], pool.y[i], alpha);
      const z = THREE.MathUtils.lerp(pool.pz[i], pool.z[i], alpha);

      let diameter: number;
      let opacity: number;
      if (cryo && this.fallingCo2) {
        diameter = pool.size[i] + 1.9 * (1 - Math.exp(-1.4 * age));
        const envelope =
          THREE.MathUtils.smoothstep(ageNorm, 0, 0.04) *
          (1 - THREE.MathUtils.smoothstep(ageNorm, 0.42, 1)) *
          (1 - 0.35 * THREE.MathUtils.smoothstep(ageNorm, 0.2, 0.5));
        opacity = 0.72 * envelope;
      } else {
        diameter = pool.size[i] + age * pool.growth[i];
        const envelope =
          THREE.MathUtils.smoothstep(ageNorm, 0, 0.05) *
          (1 - THREE.MathUtils.smoothstep(ageNorm, 0.19, 1));
        opacity = (cryo ? 0.72 : 0.29) * envelope;
      }
      batch.write(i, x, y, z, diameter, pool.rotation[i] + pool.spin[i] * age, opacity);
    }
    batch.finish(pool.alive);
  }

  public dispose() {
    this.texture.dispose();
    this.haze.dispose();
    this.smoke.dispose();
    this.cryo.dispose();
  }
}
