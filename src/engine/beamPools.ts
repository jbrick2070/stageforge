import * as THREE from 'three';

import type { CalibratedFrustum, fixtureOptics } from '../data/fixtureOptics';
import type { RenderTier } from './hardwareMaterials';
import {
  canAdmitPrismBuffers,
  CIRCULAR_PRISM,
  encodePrismMix,
  extractPrismFrame,
  PRISM_POOL_EVAL_GLSL,
  prismExtraBufferBytes,
  stepPrismOverlapGuard,
  type PrismTopology,
} from './prismPattern';

/**
 * Original beam-pool vertex shader (unchanged when `prism` is off for exact default parity).
 */
export const POOL_VERTEX_BASE = /* glsl */ `
  attribute vec4 bounds;    // min XZ, max XZ on this receiver
  attribute vec3 lens, axis, tint;
  attribute vec4 optics;    // near radius, radial slope, throw, wash softness
  uniform float surfaceY;
  varying vec3 vWorld, vLens, vAxis, vTint;
  varying vec4 vOptics;
  void main() {
    vec2 horizontal = mix(bounds.xy, bounds.zw, position.xy);
    vWorld = vec3(horizontal.x, surfaceY, horizontal.y);
    vLens = lens;
    vAxis = axis;
    vOptics = optics;
    vTint = tint;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

/**
 * Original beam-pool fragment shader (unchanged when `prism` is off for exact default parity).
 */
export const POOL_FRAGMENT_BASE = /* glsl */ `
  #if MAX_BLOCKERS > 0
    uniform int blockerCount;
    uniform vec4 blockerRects[MAX_BLOCKERS]; // center XZ, half width and depth
    uniform float blockerTops[MAX_BLOCKERS];
  #endif
  varying vec3 vWorld, vLens, vAxis, vTint;
  varying vec4 vOptics;

  bool blocksRay(vec4 rect, float top, vec3 toLens) {
    // Project just the part below the box top. The two rectangle axes and
    // the segment normal separate a miss, including a vertical light ray.
    vec2 segment = toLens.xz * (0.5 * clamp((top - vWorld.y) / toLens.y, 0.0, 1.0));
    vec2 center = vWorld.xz + segment - rect.xy;
    if (any(greaterThan(abs(center), rect.zw + abs(segment)))) return false;
    return abs(center.x * segment.y - center.y * segment.x) <= dot(rect.zw, abs(segment.yx));
  }

  void main() {
    vec3 delta = vWorld - vLens;
    float throwDist = dot(delta, vAxis);
    if (throwDist <= 0.0 || throwDist >= vOptics.z) discard;
    float radius = vOptics.x + vOptics.y * throwDist;
    vec3 radial = delta - throwDist * vAxis;
    float r = length(radial) / radius;
    if (r >= 1.0) discard;
    #if MAX_BLOCKERS > 0
      for (int i = 0; i < MAX_BLOCKERS; i++) {
        if (i >= blockerCount) break;
        if (blocksRay(blockerRects[i], blockerTops[i], -delta)) discard;
      }
    #endif
    float wash = vOptics.w;
    float edge = 1.0 - smoothstep(mix(0.50, 0.03, wash), 1.0, r);
    float profile = edge * mix(1.0 - 0.32 * r * r, exp2(-2.5 * r * r), wash);
    // Flux spreads over the beam cross-section. Matte flooring returns a
    // smaller share at grazing incidence, even when the aerial beam is bright.
    float incidence = clamp((vLens.y - vWorld.y) / max(length(delta), 0.01), 0.0, 1.0);
    float attenuation = 1.0 / (1.0 + 0.95 * radius * radius);
    float reachFade = 1.0 - smoothstep(vOptics.z * 0.87, vOptics.z, throwDist);
    float bounce = profile * incidence * attenuation * reachFade;
    gl_FragColor = vec4(vTint * mix(0.85, 1.30, wash), bounce);
  }
`;

/**
 * Prism-enabled beam-pool vertex shader (compiled only when `prismPools` is on and admitted).
 * Precomputes shaft-0 unit direction `dir0 = (sin(phase), -cos(phase))` once per quad vertex
 * so the fragment shader runs zero trigonometry.
 */
export const POOL_VERTEX_PRISM = /* glsl */ `
  attribute vec4 bounds;    // min XZ, max XZ on this receiver
  attribute vec3 lens, axis, tint;
  attribute vec4 optics;    // near radius, radial slope, throw, wash softness
  attribute vec4 prismU;    // transverse Tx (xyz), phase (w)
  attribute vec4 prismV;    // transverse Tz (xyz), signed prism mix (w)
  uniform float surfaceY;
  varying vec3 vWorld, vLens, vAxis, vTint;
  varying vec4 vOptics;
  varying vec3 vPrismU, vPrismV;
  varying vec3 vPrismDirAndMix; // dir0.xy, signed mix (negative for six-facet linear)
  void main() {
    vec2 horizontal = mix(bounds.xy, bounds.zw, position.xy);
    vWorld = vec3(horizontal.x, surfaceY, horizontal.y);
    vLens = lens;
    vAxis = axis;
    vOptics = optics;
    vTint = tint;
    vPrismU = prismU.xyz;
    vPrismV = prismV.xyz;
    vPrismDirAndMix = vec3(sin(prismU.w), -cos(prismU.w), prismV.w);
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }
`;

/**
 * Prism-enabled beam-pool fragment shader.
 * Evaluates screen-space world derivatives BEFORE any discard or divergent branch (GLSL ES 3.0),
 * computes the analytic 2×2 Jacobian of normalized beam coordinates `(u, v)`, and evaluates
 * the shared derivative-filtered prism pattern.
 */
export const POOL_FRAGMENT_PRISM = /* glsl */ `
  #if MAX_BLOCKERS > 0
    uniform int blockerCount;
    uniform vec4 blockerRects[MAX_BLOCKERS]; // center XZ, half width and depth
    uniform float blockerTops[MAX_BLOCKERS];
  #endif
  uniform float uPrismSuppressed;
  varying vec3 vWorld, vLens, vAxis, vTint;
  varying vec4 vOptics;
  varying vec3 vPrismU, vPrismV;
  varying vec3 vPrismDirAndMix;

  bool blocksRay(vec4 rect, float top, vec3 toLens) {
    // Project just the part below the box top. The two rectangle axes and
    // the segment normal separate a miss, including a vertical light ray.
    vec2 segment = toLens.xz * (0.5 * clamp((top - vWorld.y) / toLens.y, 0.0, 1.0));
    vec2 center = vWorld.xz + segment - rect.xy;
    if (any(greaterThan(abs(center), rect.zw + abs(segment)))) return false;
    return abs(center.x * segment.y - center.y * segment.x) <= dot(rect.zw, abs(segment.yx));
  }

  ${PRISM_POOL_EVAL_GLSL}

  void main() {
    // Compute screen-space derivatives BEFORE any early discard so helper lanes stay defined.
    vec3 dWx = dFdx(vWorld);
    vec3 dWy = dFdy(vWorld);

    vec3 delta = vWorld - vLens;
    float throwDist = dot(delta, vAxis);
    if (throwDist <= 0.0 || throwDist >= vOptics.z) discard;
    float radius = vOptics.x + vOptics.y * throwDist;
    if (radius <= 0.0001) discard;
    vec3 radial = delta - throwDist * vAxis;
    float r = length(radial) / radius;
    if (r >= 1.0) discard;
    #if MAX_BLOCKERS > 0
      for (int i = 0; i < MAX_BLOCKERS; i++) {
        if (i >= blockerCount) break;
        if (blocksRay(blockerRects[i], blockerTops[i], -delta)) discard;
      }
    #endif
    float wash = vOptics.w;
    float edge = 1.0 - smoothstep(mix(0.50, 0.03, wash), 1.0, r);
    float profile = edge * mix(1.0 - 0.32 * r * r, exp2(-2.5 * r * r), wash);
    float prismMix = abs(vPrismDirAndMix.z);
    if (prismMix > 0.001 && uPrismSuppressed < 0.5 && wash < 0.5) {
      float invR = 1.0 / radius;
      vec2 q = vec2(dot(radial, vPrismU), dot(radial, vPrismV)) * invR;
      float drx = vOptics.y * dot(dWx, vAxis);
      float dry = vOptics.y * dot(dWy, vAxis);
      vec2 jx = (vec2(dot(dWx, vPrismU), dot(dWx, vPrismV)) - q * drx) * invR;
      vec2 jy = (vec2(dot(dWy, vPrismU), dot(dWy, vPrismV)) - q * dry) * invR;
      float reach = clamp(throwDist / max(vOptics.z, 0.0001), 0.0, 1.0);
      profile = evalPrismPoolProfile(profile, q, r, reach, vPrismDirAndMix.xy, jx, jy, prismMix, vPrismDirAndMix.z < 0.0);
    }
    // Flux spreads over the beam cross-section. Matte flooring returns a
    // smaller share at grazing incidence, even when the aerial beam is bright.
    float incidence = clamp((vLens.y - vWorld.y) / max(length(delta), 0.01), 0.0, 1.0);
    float attenuation = 1.0 / (1.0 + 0.95 * radius * radius);
    float reachFade = 1.0 - smoothstep(vOptics.z * 0.87, vOptics.z, throwDist);
    float bounce = profile * incidence * attenuation * reachFade;
    // Preserve the exact base assignment for bounce <= 1.0, and fold HDR > 1.0 prism spot peaks
    // into RGB so RGBA8 fallback targets never clamp alpha at 1.0.
    vec3 baseRgb = vTint * mix(0.85, 1.30, wash);
    if (bounce > 1.0) {
      gl_FragColor = vec4(baseRgb * bounce, 1.0);
    } else {
      gl_FragColor = vec4(baseRgb, bounce);
    }
  }
`;

export interface Platform {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

export interface BeamPoolsOptions {
  /** Enable prism floor projections (default false; zero optional allocation when off). */
  prism?: boolean;
  /** Active render tier for low-tier overlap hysteresis guard (default 'high'). */
  tier?: RenderTier;
  /** True when fragment derivatives (`dFdx`/`dFdy`) are available on the active GL context (default true). */
  derivativesSupported?: boolean;
}

export type PrismSuppressionReason =
  | 'disabled'
  | 'derivatives-unsupported'
  | 'memory-budget'
  | 'low-tier-overlap'
  | null;

export interface BeamPoolsStats {
  requested: boolean;
  allocated: boolean;
  active: boolean;
  suppressedReason: PrismSuppressionReason;
  receiverCount: number;
  totalInstances: number;
  activePrismInstances: number;
  maxReceiverPrismInstances: number;
  receiverPrismCounts: number[];
  /** Application-buffer bytes allocated for optional `prismU`/`prismV` attributes (`0` when flag is off). */
  extraBufferBytes: number;
  /** Total dynamic vertex-attribute bytes uploaded across all receivers in the most recent frame. */
  uploadBytes: number;
}

/**
 * Compute conservative horizontal XZ receiver bounds for a finite cone intersecting `surfaceY`.
 * Handles both diverging (`slope >= 0`) and converging (`slope < 0`) optics safely by taking
 * `max(r(start), r(end))` for the radial pad.
 */
export function computeConeReceiverBounds(
  lens: THREE.Vector3,
  direction: THREE.Vector3,
  nearRadius: number,
  slope: number,
  throwLength: number,
  surfaceY: number,
  receiverBounds: THREE.Vector4,
): { left: number; back: number; right: number; front: number; start: number; end: number; radius: number } | null {
  const height = lens.y - surfaceY;
  if (!Number.isFinite(height) || height <= 0) return null;
  const dy = direction.y;
  if (!Number.isFinite(dy)) return null;
  const radialY = Math.sqrt(Math.max(0, 1 - dy * dy));
  let start = 0;
  let end: number = throwLength;
  const nearY = nearRadius * radialY;
  const lowerSlope = dy - slope * radialY;
  if (lowerSlope < -1e-6) start = Math.max(start, (nearY - height) / lowerSlope);
  else if (lowerSlope > 1e-6) end = Math.min(end, (nearY - height) / lowerSlope);
  else if (height > nearY) return null;
  const upperSlope = dy + slope * radialY;
  if (upperSlope > 1e-6) start = Math.max(start, (-nearY - height) / upperSlope);
  else if (upperSlope < -1e-6) end = Math.min(end, (-nearY - height) / upperSlope);
  else if (height < -nearY) return null;
  if (end < start) return null;
  const rStart = Math.max(0, nearRadius + start * slope);
  const rEnd = Math.max(0, nearRadius + end * slope);
  const radius = Math.max(rStart, rEnd);
  const x0 = lens.x + start * direction.x;
  const x1 = lens.x + end * direction.x;
  const z0 = lens.z + start * direction.z;
  const z1 = lens.z + end * direction.z;
  const left = Math.max(receiverBounds.x, Math.min(x0, x1) - radius);
  const right = Math.min(receiverBounds.z, Math.max(x0, x1) + radius);
  const back = Math.max(receiverBounds.y, Math.min(z0, z1) - radius);
  const front = Math.min(receiverBounds.w, Math.max(z0, z1) + radius);
  if (!(left < right && back < front)) return null;
  return { left, back, right, front, start, end, radius };
}

class Receiver {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  count = 0;
  prismCount = 0;
  readonly bytesPerInstance: number;
  private attributes: {
    bounds: THREE.InstancedBufferAttribute;
    lens: THREE.InstancedBufferAttribute;
    axis: THREE.InstancedBufferAttribute;
    tint: THREE.InstancedBufferAttribute;
    optics: THREE.InstancedBufferAttribute;
    prismU?: THREE.InstancedBufferAttribute;
    prismV?: THREE.InstancedBufferAttribute;
  };
  private prismSuppressedUniform: { value: number } | null = null;

  readonly surfaceY: number;
  readonly bounds: THREE.Vector4;

  constructor(
    capacity: number,
    platform: Platform,
    readonly blockers: Platform[],
    maxBlockers: number,
    readonly prismAllocated: boolean,
  ) {
    const { x, z, width, depth, height } = platform;
    this.surfaceY = height + 0.003;
    this.bounds = new THREE.Vector4(x - width / 2, z - depth / 2, x + width / 2, z + depth / 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    // World XZ winding points towards +Y.
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.instanceCount = 0;
    const attribute = (size: number) =>
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage);
    this.attributes = {
      bounds: attribute(4),
      lens: attribute(3),
      axis: attribute(3),
      tint: attribute(3),
      optics: attribute(4),
    };
    if (prismAllocated) {
      this.attributes.prismU = attribute(4);
      this.attributes.prismV = attribute(4);
    }
    this.bytesPerInstance = prismAllocated ? (4 + 3 + 3 + 3 + 4 + 4 + 4) * 4 : (4 + 3 + 3 + 3 + 4) * 4;
    for (const [name, value] of Object.entries(this.attributes)) {
      if (value) geo.setAttribute(name, value);
    }
    // All receivers in a rig share one shader program, even at different heights.
    const blockerRects = new Float32Array(maxBlockers * 4);
    const blockerTops = new Float32Array(maxBlockers);
    blockers.forEach((b, i) => {
      blockerRects.set([b.x, b.z, b.width / 2, b.depth / 2], i * 4);
      blockerTops[i] = b.height;
    });
    const uniforms: Record<string, THREE.IUniform> = {
      surfaceY: { value: this.surfaceY },
      blockerCount: { value: blockers.length },
      blockerRects: { value: blockerRects },
      blockerTops: { value: blockerTops },
    };
    if (prismAllocated) {
      this.prismSuppressedUniform = { value: 0 };
      uniforms.uPrismSuppressed = this.prismSuppressedUniform;
    }
    const mat = new THREE.ShaderMaterial({
      vertexShader: prismAllocated ? POOL_VERTEX_PRISM : POOL_VERTEX_BASE,
      fragmentShader: prismAllocated ? POOL_FRAGMENT_PRISM : POOL_FRAGMENT_BASE,
      defines: prismAllocated ? { MAX_BLOCKERS: maxBlockers, PRISM_POOLS: 1 } : { MAX_BLOCKERS: maxBlockers },
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2;
  }

  add(
    x0: number, z0: number, x1: number, z1: number,
    origin: THREE.Vector3, direction: THREE.Vector3,
    nearRadius: number, slope: number, length: number,
    wash: boolean, color: THREE.Color, intensity: number,
    prismU?: THREE.Vector3, prismV?: THREE.Vector3, prismMix = 0, prismPhaseRad = 0, prismTopology: PrismTopology = CIRCULAR_PRISM,
  ) {
    const i = this.count++;
    const a = this.attributes;
    a.bounds.setXYZW(i, x0, z0, x1, z1);
    a.lens.setXYZ(i, origin.x, origin.y, origin.z);
    a.axis.setXYZ(i, direction.x, direction.y, direction.z);
    a.tint.setXYZ(i, color.r * intensity, color.g * intensity, color.b * intensity);
    a.optics.setXYZW(i, nearRadius, slope, length, wash ? 1 : 0);
    if (a.prismU && a.prismV) {
      const clampedMix = Number.isFinite(prismMix) ? Math.max(0, Math.min(1, prismMix)) : 0;
      if (clampedMix > 0.001 && !wash && prismU && prismV) {
        a.prismU.setXYZW(i, prismU.x, prismU.y, prismU.z, prismPhaseRad);
        a.prismV.setXYZW(i, prismV.x, prismV.y, prismV.z, encodePrismMix(clampedMix, prismTopology));
        this.prismCount++;
      } else {
        a.prismU.setXYZW(i, 1, 0, 0, 0);
        a.prismV.setXYZW(i, 0, 0, 1, 0);
      }
    }
  }

  finish(prismSuppressed: boolean): number {
    this.mesh.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this.prismSuppressedUniform) {
      this.prismSuppressedUniform.value = prismSuppressed ? 1 : 0;
    }
    if (this.count === 0) return 0;
    for (const attribute of Object.values(this.attributes)) {
      if (!attribute) continue;
      attribute.addUpdateRange(0, this.count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    return this.count * this.bytesPerInstance;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Direct fixture light received on the deck and arena floor. */
export class BeamPools {
  readonly group = new THREE.Group();
  readonly prismRequested: boolean;
  readonly derivativesSupported: boolean;
  readonly prismAllocated: boolean;
  readonly tier: RenderTier;
  private receivers: Receiver[];
  private lens = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private prismU = new THREE.Vector3();
  private prismV = new THREE.Vector3();
  private prismOverlapSuppressed = false;
  private lastTotalInstances = 0;
  private lastActivePrismInstances = 0;
  private lastMaxReceiverPrismInstances = 0;
  private lastUploadBytes = 0;
  private extraBufferBytes = 0;

  constructor(
    private capacity: number,
    width: number,
    depth: number,
    height: number,
    platforms: readonly Platform[] = [{ x: 0, z: 0, width, depth, height }],
    options?: BeamPoolsOptions,
  ) {
    this.prismRequested = Boolean(options?.prism);
    this.derivativesSupported = options?.derivativesSupported !== false;
    this.tier = options?.tier ?? 'high';
    const receiverCount = platforms.length + 1;
    const admitted = this.prismRequested && this.derivativesSupported && canAdmitPrismBuffers(capacity, receiverCount);
    this.prismAllocated = admitted;
    this.extraBufferBytes = admitted ? prismExtraBufferBytes(capacity, receiverCount) : 0;

    this.receivers = platforms.map((platform, index) => {
      // A coplanar overlap belongs to the first module. Higher modules can
      // also cast an oblique shadow from outside the receiver's own bounds.
      const blockers = platforms.filter((other, i) => other.height > platform.height ||
        (other.height === platform.height && i < index &&
          Math.abs(other.x - platform.x) * 2 < other.width + platform.width &&
          Math.abs(other.z - platform.z) * 2 < other.depth + platform.depth));
      return new Receiver(capacity, platform, blockers, platforms.length, admitted);
    });
    this.receivers.push(
      new Receiver(capacity, { x: 0, z: 0, width: 140, depth: 140, height: 0 }, [...platforms], platforms.length, admitted),
    );
    for (const receiver of this.receivers) this.group.add(receiver.mesh);
  }

  begin() {
    this.lastTotalInstances = 0;
    this.lastActivePrismInstances = 0;
    this.lastMaxReceiverPrismInstances = 0;
    this.lastUploadBytes = 0;
    for (const receiver of this.receivers) {
      receiver.count = 0;
      receiver.prismCount = 0;
    }
  }

  add(
    beam: THREE.Object3D,
    type: 'wash' | 'beam',
    isFloor: boolean,
    color: THREE.Color,
    intensity: number,
    optics: ReturnType<typeof fixtureOptics>,
    prismMix: number | boolean = 0,
    prismPhaseRad = 0,
    frustum?: CalibratedFrustum,
    prismTopology: PrismTopology = CIRCULAR_PRISM,
  ) {
    if (!Number.isFinite(intensity) || intensity <= 0.001) return;
    const sign: 1 | -1 = isFloor ? 1 : -1;
    const lensOffset = typeof beam.userData?.lensOffsetY === 'number' && Number.isFinite(beam.userData.lensOffsetY)
      ? beam.userData.lensOffsetY
      : 0.17;
    beam.updateWorldMatrix(true, false);
    this.lens.set(0, sign * lensOffset, 0).applyMatrix4(beam.matrixWorld);
    if (!Number.isFinite(this.lens.x) || !Number.isFinite(this.lens.y) || !Number.isFinite(this.lens.z)) return;

    const wash = type === 'wash';
    const numericMix = typeof prismMix === 'boolean'
      ? (prismMix ? 1 : 0)
      : (Number.isFinite(prismMix) ? Math.max(0, Math.min(1, prismMix)) : 0);

    let effectiveMix = 0;
    if (this.prismAllocated && numericMix > 0.001 && !wash) {
      const ok = extractPrismFrame(beam.matrixWorld, sign, this.direction, this.prismU, this.prismV);
      if (ok) {
        effectiveMix = numericMix;
      } else {
        // Fallback: check whether the beam axis itself is still valid even if transverse frame was rank-deficient.
        const ax = beam.matrixWorld.elements[4] * sign;
        const ay = beam.matrixWorld.elements[5] * sign;
        const az = beam.matrixWorld.elements[6] * sign;
        const lenSq = ax * ax + ay * ay + az * az;
        if (!Number.isFinite(lenSq) || lenSq <= 1e-12) return;
        const inv = 1 / Math.sqrt(lenSq);
        this.direction.set(ax * inv, ay * inv, az * inv);
      }
    } else {
      const e = beam.matrixWorld.elements;
      const ax = e[4] * sign;
      const ay = e[5] * sign;
      const az = e[6] * sign;
      const lenSq = ax * ax + ay * ay + az * az;
      if (!Number.isFinite(lenSq) || lenSq <= 1e-12) return;
      const inv = 1 / Math.sqrt(lenSq);
      this.direction.set(ax * inv, ay * inv, az * inv);
    }

    const throwLength = frustum?.length ?? optics.length;
    const zoom = Number.isFinite(beam.scale.x) && beam.scale.x > 0 ? beam.scale.x : 1;
    const nearRadius = frustum?.nearRadius ?? optics.nearRadius * zoom;
    const slope = frustum?.slope ?? (optics.farRadius * zoom - nearRadius) / throwLength;

    for (const receiver of this.receivers) {
      if (receiver.count >= this.capacity) continue;
      const hit = computeConeReceiverBounds(
        this.lens, this.direction, nearRadius, slope, throwLength, receiver.surfaceY, receiver.bounds,
      );
      if (!hit) continue;
      const { left, back, right, front } = hit;
      if (receiver.blockers.some(b => left >= b.x - b.width / 2 && right <= b.x + b.width / 2 &&
          back >= b.z - b.depth / 2 && front <= b.z + b.depth / 2)) continue;
      receiver.add(
        left, back, right, front, this.lens, this.direction, nearRadius, slope, throwLength, wash, color, intensity,
        effectiveMix > 0.001 ? this.prismU : undefined,
        effectiveMix > 0.001 ? this.prismV : undefined,
        effectiveMix,
        prismPhaseRad,
        prismTopology,
      );
    }
  }

  finish(): number {
    let totalInstances = 0;
    let totalPrism = 0;
    let maxReceiverPrism = 0;
    for (const receiver of this.receivers) {
      totalInstances += receiver.count;
      totalPrism += receiver.prismCount;
      if (receiver.prismCount > maxReceiverPrism) maxReceiverPrism = receiver.prismCount;
    }
    this.prismOverlapSuppressed = this.prismAllocated
      ? stepPrismOverlapGuard(this.prismOverlapSuppressed, maxReceiverPrism, totalPrism, this.tier)
      : false;

    let uploadBytes = 0;
    for (const receiver of this.receivers) {
      uploadBytes += receiver.finish(this.prismOverlapSuppressed);
    }
    this.lastTotalInstances = totalInstances;
    this.lastActivePrismInstances = totalPrism;
    this.lastMaxReceiverPrismInstances = maxReceiverPrism;
    this.lastUploadBytes = uploadBytes;
    return uploadBytes;
  }

  getStats(): BeamPoolsStats {
    let suppressedReason: PrismSuppressionReason = null;
    if (!this.prismRequested) suppressedReason = 'disabled';
    else if (!this.derivativesSupported) suppressedReason = 'derivatives-unsupported';
    else if (!this.prismAllocated) suppressedReason = 'memory-budget';
    else if (this.prismOverlapSuppressed) suppressedReason = 'low-tier-overlap';
    return {
      requested: this.prismRequested,
      allocated: this.prismAllocated,
      active: this.prismAllocated && !this.prismOverlapSuppressed && this.lastActivePrismInstances > 0,
      suppressedReason,
      receiverCount: this.receivers.length,
      totalInstances: this.lastTotalInstances,
      activePrismInstances: this.lastActivePrismInstances,
      maxReceiverPrismInstances: this.lastMaxReceiverPrismInstances,
      receiverPrismCounts: this.receivers.map((r) => r.prismCount),
      extraBufferBytes: this.extraBufferBytes,
      uploadBytes: this.lastUploadBytes,
    };
  }

  /** Active GPU instance inputs for the latest tick or restoration refill. */
  frustaForTest() {
    return this.receivers.flatMap(({ mesh, surfaceY }) => {
      const { lens, axis, optics, bounds, prismU, prismV } = mesh.geometry.attributes;
      return Array.from({ length: mesh.geometry.instanceCount }, (_, i) => ({
        surfaceY,
        lens: [lens.getX(i), lens.getY(i), lens.getZ(i)],
        axis: [axis.getX(i), axis.getY(i), axis.getZ(i)],
        optics: [optics.getX(i), optics.getY(i), optics.getZ(i)],
        bounds: [bounds.getX(i), bounds.getY(i), bounds.getZ(i), bounds.getW(i)],
        ...(prismU && prismV && { prism: { phase: prismU.getW(i), signedMix: prismV.getW(i) } }),
      }));
    });
  }

  dispose() {
    this.group.removeFromParent();
    for (const receiver of this.receivers) receiver.dispose();
  }
}
