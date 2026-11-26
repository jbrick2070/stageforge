import * as THREE from 'three';
import { ILDA_MAX_POINTS_PER_FRAME, normalizeIldaCoord, type IldaClip, type IldaFrameSlice } from '../data/ilda';
import { LASER_APERTURE_Z_M, LASER_BEAM_LENGTH_M } from '../data/laserAim';
import type { RenderTier } from './hardwareMaterials';
import type { IldaRenderMode } from './ildaRenderer';

export const ILDA_SCAN_ENERGY_TRIANGLES_LOW = 4_000;
export const ILDA_SCAN_ENERGY_TRIANGLES_HIGH = 16_000;
export const ILDA_SCAN_ENERGY_BYTES_PER_SEGMENT = 6 * 10 * Float32Array.BYTES_PER_ELEMENT;
export const ILDA_SCAN_ENERGY_MAX_BYTES_LOW = 512 * 1024;
export const ILDA_SCAN_ENERGY_MAX_BYTES_HIGH = 2 * 1024 * 1024;
export const ILDA_SCAN_ENERGY_NEAR_FADE_START_M = 0.30;
export const ILDA_SCAN_ENERGY_NEAR_FADE_END_M = 1.0;
export const ILDA_SCAN_ENERGY_NEAR_PLANE_FULL_M = 0.42;

export interface IldaScanEnergyBudget {
  readonly tier: RenderTier;
  readonly projectorCount: number;
  readonly globalTriangleCap: number;
  readonly globalSegmentCap: number;
  readonly segmentsPerProjector: number;
  readonly allocatedSegments: number;
  readonly allocatedTriangles: number;
  readonly extraBufferBytes: number;
}

export function ildaScanEnergyBudget(tier: RenderTier, projectorCount: number): IldaScanEnergyBudget {
  const count = Math.max(0, Math.floor(Number.isFinite(projectorCount) ? projectorCount : 0));
  const globalTriangleCap = tier === 'low' ? ILDA_SCAN_ENERGY_TRIANGLES_LOW : ILDA_SCAN_ENERGY_TRIANGLES_HIGH;
  const globalSegmentCap = Math.floor(globalTriangleCap / 2);
  const segmentsPerProjector = count > 0 ? Math.floor(globalSegmentCap / count) : 0;
  const allocatedSegments = segmentsPerProjector * count;
  return {
    tier,
    projectorCount: count,
    globalTriangleCap,
    globalSegmentCap,
    segmentsPerProjector,
    allocatedSegments,
    allocatedTriangles: allocatedSegments * 2,
    extraBufferBytes: allocatedSegments * ILDA_SCAN_ENERGY_BYTES_PER_SEGMENT,
  };
}

export interface IldaRibbonUpdate {
  readonly active: boolean;
  readonly fallback: boolean;
  readonly segments: number;
  readonly requiredSegments: number;
  readonly compactedLitPoints: number;
}

export interface IldaRibbonStats extends IldaRibbonUpdate {
  readonly capacitySegments: number;
  readonly capacityTriangles: number;
  readonly extraBufferBytes: number;
  readonly uploadBytes: number;
}

export const ILDA_SCAN_ENERGY_VERT = /* glsl */`
attribute vec3 other;
attribute vec3 ribbonColor;
attribute float edge;
varying vec3 vRibbonColor;
varying float vAcross;
varying float vNearFade;

void main() {
  bool atEnd = abs(edge) > 1.5;
  float sideSign = edge < 0.0 ? -1.0 : 1.0;
  vec3 localStart = atEnd ? other : position;
  vec3 localEnd = atEnd ? position : other;
  vec3 viewStart = (modelViewMatrix * vec4(localStart, 1.0)).xyz;
  vec3 viewEnd = (modelViewMatrix * vec4(localEnd, 1.0)).xyz;
  float startInFront = step(viewStart.z, -0.18);
  float endInFront = step(viewEnd.z, -0.18);
  float anyInFront = max(startInFront, endInFront);
  if (startInFront < 0.5 && endInFront > 0.5) {
    float clipT = clamp((-${ILDA_SCAN_ENERGY_NEAR_PLANE_FULL_M.toFixed(2)} - viewStart.z) / (viewEnd.z - viewStart.z), 0.0, 1.0);
    viewStart = mix(viewStart, viewEnd, clipT);
  } else if (endInFront < 0.5 && startInFront > 0.5) {
    float clipT = clamp((-${ILDA_SCAN_ENERGY_NEAR_PLANE_FULL_M.toFixed(2)} - viewStart.z) / (viewEnd.z - viewStart.z), 0.0, 1.0);
    viewEnd = mix(viewStart, viewEnd, clipT);
  }
  vec3 segment = viewEnd - viewStart;
  float segmentLenSq = dot(segment, segment);
  float segmentLen = sqrt(max(segmentLenSq, 1e-12));
  vec3 segmentDir = segment / segmentLen;

  float closestT = clamp(dot(-viewStart, segment) / max(segmentLenSq, 1e-12), 0.0, 1.0);
  vec3 closest = viewStart + segment * closestT;
  vec3 toEye = -closest;
  float eyeDistance = length(toEye);
  vec3 eyeDir = eyeDistance > 1e-6 ? toEye / eyeDistance : vec3(0.0, 0.0, 1.0);
  vec3 side = cross(segmentDir, eyeDir);
  float sideLenSq = dot(side, side);
  if (sideLenSq < 1e-8) {
    vec3 a = abs(segmentDir);
    vec3 fallbackAxis = a.x <= a.y && a.x <= a.z
      ? vec3(1.0, 0.0, 0.0)
      : (a.y <= a.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    side = cross(segmentDir, fallbackAxis);
    sideLenSq = dot(side, side);
  }
  side *= inversesqrt(max(sideLenSq, 1e-12));

  float throwDistance = max(abs(localStart.z), abs(localEnd.z));
  float halfWidth = 0.006 + min(0.044, throwDistance * 0.00062);
  vec3 viewPosition = atEnd ? viewEnd : viewStart;
  viewPosition += side * sideSign * halfWidth;

  float radialFade = smoothstep(${ILDA_SCAN_ENERGY_NEAR_FADE_START_M.toFixed(2)}, ${ILDA_SCAN_ENERGY_NEAR_FADE_END_M.toFixed(2)}, eyeDistance);
  float nearestFrontDepth = min(-viewStart.z, -viewEnd.z);
  float planeFade = smoothstep(0.18, ${ILDA_SCAN_ENERGY_NEAR_PLANE_FULL_M.toFixed(2)}, nearestFrontDepth);
  float validSegment = step(1e-6, segmentLen) * anyInFront;
  vNearFade = radialFade * planeFade * validSegment;
  vRibbonColor = ribbonColor;
  vAcross = sideSign;
  gl_Position = projectionMatrix * vec4(viewPosition, 1.0);
}
`;

export const ILDA_SCAN_ENERGY_FRAG = /* glsl */`
uniform float uGain;
uniform float uHaze;
uniform float uMonochrome;
uniform vec3 uTint;
varying vec3 vRibbonColor;
varying float vAcross;
varying float vNearFade;

void main() {
  float across = abs(vAcross);
  float core = 1.0 - smoothstep(0.0, 0.22, across);
  float halo = 1.0 - smoothstep(0.18, 1.0, across);
  halo *= halo;
  float haloGain = mix(0.10, 0.38, clamp(uHaze, 0.0, 1.0));
  float profile = core * 1.45 + halo * haloGain;
  float luminance = dot(vRibbonColor, vec3(0.299, 0.587, 0.114));
  vec3 source = mix(vRibbonColor, vec3(luminance) * uTint, uMonochrome);
  gl_FragColor = vec4(source * uGain * profile * vNearFade, vNearFade);
}
`;

interface CompactFrame {
  count: number;
  outlineSegments: number;
}

/**
 * One projector's optional fixed-capacity ribbon. The controller is the sole owner of its
 * geometry/material and never changes the clip's source-point timing metadata.
 */
export class IldaScanEnergyProjector {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  readonly capacitySegments: number;
  readonly extraBufferBytes: number;

  private readonly clip: IldaClip;
  private readonly throwLengthM: number;
  private readonly positions: Float32Array;
  private readonly others: Float32Array;
  private readonly colors: Float32Array;
  private readonly edges: Float32Array;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly otherAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly edgeAttr: THREE.BufferAttribute;
  private readonly compactX = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactY = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactR = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactG = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactB = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactDwell = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactBreak = new Uint8Array(ILDA_MAX_POINTS_PER_FRAME);
  private readonly compactEnergy = new Float32Array(ILDA_MAX_POINTS_PER_FRAME);
  private cachedFrame = -1;
  private cachedMode: IldaRenderMode | null = null;
  private last: IldaRibbonUpdate = { active: false, fallback: false, segments: 0, requiredSegments: 0, compactedLitPoints: 0 };
  private uploadBytes = 0;
  private disposed = false;

  constructor(clip: IldaClip, capacitySegments: number, singleColor: boolean, throwLengthM = LASER_BEAM_LENGTH_M) {
    this.clip = clip;
    this.throwLengthM = throwLengthM;
    this.capacitySegments = Math.max(0, Math.floor(capacitySegments));
    const vertices = this.capacitySegments * 6;
    this.positions = new Float32Array(vertices * 3);
    this.others = new Float32Array(vertices * 3);
    this.colors = new Float32Array(vertices * 3);
    this.edges = new Float32Array(vertices);
    this.extraBufferBytes = this.positions.byteLength + this.others.byteLength + this.colors.byteLength + this.edges.byteLength;

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.otherAttr = new THREE.BufferAttribute(this.others, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.edgeAttr = new THREE.BufferAttribute(this.edges, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('other', this.otherAttr);
    this.geometry.setAttribute('ribbonColor', this.colorAttr);
    this.geometry.setAttribute('edge', this.edgeAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: ILDA_SCAN_ENERGY_VERT,
      fragmentShader: ILDA_SCAN_ENERGY_FRAG,
      uniforms: {
        uGain: { value: 0 },
        uHaze: { value: 0 },
        uMonochrome: { value: singleColor ? 1 : 0 },
        uTint: { value: new THREE.Color(0xffffff) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'ILDA scan-energy ribbon';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.userData.noBatch = true;
  }

  private compact(frame: IldaFrameSlice): CompactFrame {
    let count = 0;
    let outlineSegments = 0;
    let previousLit = false;
    for (let i = 0; i < frame.count; i++) {
      const point = frame.offset + i;
      if (this.clip.blank[point] !== 0) {
        previousLit = false;
        continue;
      }
      const rawX = this.clip.xy[point * 2];
      const rawY = this.clip.xy[point * 2 + 1];
      if (previousLit && count > 0) {
        const prevPoint = point - 1;
        if (
          this.clip.blank[prevPoint] === 0 &&
          this.clip.xy[prevPoint * 2] === rawX &&
          this.clip.xy[prevPoint * 2 + 1] === rawY
        ) {
          this.compactDwell[count - 1] = Math.min(5, this.compactDwell[count - 1] + 1);
          const r = this.clip.rgb[point * 3] / 255;
          const g = this.clip.rgb[point * 3 + 1] / 255;
          const b = this.clip.rgb[point * 3 + 2] / 255;
          this.compactR[count - 1] = Math.max(this.compactR[count - 1], r);
          this.compactG[count - 1] = Math.max(this.compactG[count - 1], g);
          this.compactB[count - 1] = Math.max(this.compactB[count - 1], b);
          continue;
        }
      }

      const nx = normalizeIldaCoord(rawX);
      const ny = normalizeIldaCoord(rawY);
      const baseHalfExtent = Math.tan(Math.PI / 8) * this.throwLengthM;
      this.compactX[count] = nx * baseHalfExtent;
      this.compactY[count] = ny * baseHalfExtent;
      this.compactR[count] = this.clip.rgb[point * 3] / 255;
      this.compactG[count] = this.clip.rgb[point * 3 + 1] / 255;
      this.compactB[count] = this.clip.rgb[point * 3 + 2] / 255;
      this.compactDwell[count] = 1;
      this.compactBreak[count] = previousLit ? 0 : 1;
      if (previousLit) outlineSegments++;
      count++;
      previousLit = true;
    }

    for (let i = 0; i < count; i++) {
      let energy = 1 + 0.18 * Math.min(4, Math.max(0, this.compactDwell[i] - 1));
      const hasPrev = i > 0 && this.compactBreak[i] === 0;
      const hasNext = i + 1 < count && this.compactBreak[i + 1] === 0;
      if (hasPrev && hasNext) {
        const ax = this.compactX[i] - this.compactX[i - 1];
        const ay = this.compactY[i] - this.compactY[i - 1];
        const bx = this.compactX[i + 1] - this.compactX[i];
        const by = this.compactY[i + 1] - this.compactY[i];
        const al = Math.hypot(ax, ay);
        const bl = Math.hypot(bx, by);
        if (al > 1e-7 && bl > 1e-7) {
          const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)));
          energy += 0.35 * Math.sqrt(Math.max(0, (1 - dot) * 0.5));
        }
      }
      this.compactEnergy[i] = Math.min(1.8, energy);
    }
    return { count, outlineSegments };
  }

  private writeSegment(
    segmentIndex: number,
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    r0: number, g0: number, b0: number,
    r1: number, g1: number, b1: number,
  ): void {
    for (let v = 0; v < 6; v++) {
      const vertex = segmentIndex * 6 + v;
      const p3 = vertex * 3;
      const atStart = v === 0 || v === 1 || v === 3;
      this.positions[p3] = atStart ? x0 : x1;
      this.positions[p3 + 1] = atStart ? y0 : y1;
      this.positions[p3 + 2] = atStart ? z0 : z1;
      this.others[p3] = atStart ? x1 : x0;
      this.others[p3 + 1] = atStart ? y1 : y0;
      this.others[p3 + 2] = atStart ? z1 : z0;
      this.colors[p3] = atStart ? r0 : r1;
      this.colors[p3 + 1] = atStart ? g0 : g1;
      this.colors[p3 + 2] = atStart ? b0 : b1;
      this.edges[vertex] = v === 0 ? -1 : (v === 1 || v === 3 ? 1 : (v === 4 ? 2 : -2));
    }
  }

  updateFrame(frameIndex: number, mode: IldaRenderMode): IldaRibbonUpdate {
    if (this.disposed || this.clip.frames.length === 0 || this.capacitySegments <= 0) {
      this.geometry.setDrawRange(0, 0);
      this.last = { active: false, fallback: true, segments: 0, requiredSegments: 0, compactedLitPoints: 0 };
      return this.last;
    }
    const safeFrame = ((Math.floor(frameIndex) % this.clip.frames.length) + this.clip.frames.length) % this.clip.frames.length;
    if (this.cachedFrame === safeFrame && this.cachedMode === mode) return this.last;

    const frame = this.clip.frames[safeFrame];
    const compact = this.compact(frame);
    const rays = mode === 'graphic' ? 0 : compact.count;
    const outlines = mode === 'beam' ? 0 : compact.outlineSegments;
    const required = rays + outlines;
    this.cachedFrame = safeFrame;
    this.cachedMode = mode;

    if (required > this.capacitySegments) {
      this.geometry.setDrawRange(0, 0);
      this.last = { active: false, fallback: true, segments: 0, requiredSegments: required, compactedLitPoints: compact.count };
      return this.last;
    }

    let segment = 0;
    const apertureZ = LASER_APERTURE_Z_M;
    const farZ = LASER_APERTURE_Z_M + this.throwLengthM;
    if (mode !== 'graphic') {
      for (let i = 0; i < compact.count; i++) {
        const energy = this.compactEnergy[i];
        this.writeSegment(
          segment++, 0, 0, apertureZ, this.compactX[i], this.compactY[i], farZ,
          this.compactR[i] * 2.5 * energy, this.compactG[i] * 2.5 * energy, this.compactB[i] * 2.5 * energy,
          this.compactR[i] * 0.25 * energy, this.compactG[i] * 0.25 * energy, this.compactB[i] * 0.25 * energy,
        );
      }
    }
    if (mode !== 'beam') {
      for (let i = 1; i < compact.count; i++) {
        if (this.compactBreak[i] !== 0) continue;
        const e0 = this.compactEnergy[i - 1];
        const e1 = this.compactEnergy[i];
        this.writeSegment(
          segment++, this.compactX[i - 1], this.compactY[i - 1], farZ, this.compactX[i], this.compactY[i], farZ,
          this.compactR[i - 1] * 1.8 * e0, this.compactG[i - 1] * 1.8 * e0, this.compactB[i - 1] * 1.8 * e0,
          this.compactR[i] * 1.8 * e1, this.compactG[i] * 1.8 * e1, this.compactB[i] * 1.8 * e1,
        );
      }
    }

    const vertices = segment * 6;
    this.positionAttr.needsUpdate = true;
    this.otherAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.edgeAttr.needsUpdate = true;
    this.positionAttr.updateRanges.length = 0;
    this.otherAttr.updateRanges.length = 0;
    this.colorAttr.updateRanges.length = 0;
    this.edgeAttr.updateRanges.length = 0;
    this.positionAttr.addUpdateRange(0, vertices * 3);
    this.otherAttr.addUpdateRange(0, vertices * 3);
    this.colorAttr.addUpdateRange(0, vertices * 3);
    this.edgeAttr.addUpdateRange(0, vertices);
    this.geometry.setDrawRange(0, vertices);
    this.uploadBytes = segment * ILDA_SCAN_ENERGY_BYTES_PER_SEGMENT;
    this.last = { active: segment > 0, fallback: false, segments: segment, requiredSegments: required, compactedLitPoints: compact.count };
    return this.last;
  }

  setAppearance(gain: number, haze: number, tint?: THREE.Color): void {
    this.material.uniforms.uGain.value = Number.isFinite(gain) ? Math.max(0, Math.min(1.5, gain)) : 0;
    this.material.uniforms.uHaze.value = Number.isFinite(haze) ? Math.max(0, Math.min(1, haze)) : 0;
    if (tint) (this.material.uniforms.uTint.value as THREE.Color).copy(tint);
  }

  getStats(): IldaRibbonStats {
    return {
      ...this.last,
      capacitySegments: this.capacitySegments,
      capacityTriangles: this.capacitySegments * 2,
      extraBufferBytes: this.extraBufferBytes,
      uploadBytes: this.uploadBytes,
    };
  }

  onContextRestored(): void {
    if (this.disposed) return;
    this.cachedFrame = -1;
    this.cachedMode = null;
    this.positionAttr.needsUpdate = true;
    this.otherAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.edgeAttr.needsUpdate = true;
    this.material.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.visible = false;
    this.geometry.setDrawRange(0, 0);
    this.geometry.dispose();
    this.material.dispose();
  }
}
