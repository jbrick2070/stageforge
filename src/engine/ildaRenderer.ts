import * as THREE from 'three';
import { normalizeIldaCoord, type IldaClip } from '../data/ilda';
import { ildaScanTangents, LASER_APERTURE_Z_M, LASER_BEAM_LENGTH_M } from '../data/laserAim';
import { IldaScanEnergyProjector } from './ildaScanEnergy';

export type IldaRenderMode = 'both' | 'beam' | 'graphic';

export interface IldaFrameRange {
  /** Starting vertex index for this frame's rays (aperture -> lit points). */
  readonly raysStart: number;
  /** Vertex count for rays (2 vertices per lit point). */
  readonly raysCount: number;
  /** Starting vertex index for this frame's graphic outline (consecutive lit points). */
  readonly outlineStart: number;
  /** Vertex count for outline (2 vertices per unblanked segment). */
  readonly outlineCount: number;
  /** Total points in the source ILDA frame (lit + blanked) for kpps scan-rate calc. */
  readonly sourcePointCount: number;
}

/**
 * Baked GPU buffer for a single ILDA clip shared across all projectors in the scene.
 *
 * Layout per frame in local projector space (aperture at (0, 0, LASER_APERTURE_Z_M), throw along +Z):
 *   [rays vertices | outline vertices]
 *
 * Each projector binds its own lightweight BufferGeometry referencing the shared BufferAttributes so
 * switching frames or Beam/Graphic/Both modes only updates `geometry.setDrawRange(start, count)`
 * with zero per-frame allocations and 1 draw call per projector.
 *
 * IMPORTANT: Never dispose an individual projector wrapper geometry on its own — Three.js frees
 * shared BufferAttribute GPU buffers on the first `.dispose()` call. Always release via `dispose()`.
 */
export class BakedIldaClip {
  readonly clip: IldaClip;
  readonly frameRanges: readonly IldaFrameRange[];
  readonly positionAttr: THREE.BufferAttribute;
  readonly rgbColorAttr: THREE.BufferAttribute;
  readonly monoColorAttr: THREE.BufferAttribute;
  private readonly wrappers = new Set<THREE.BufferGeometry>();
  private readonly scanEnergyProjectors = new Set<IldaScanEnergyProjector>();
  private disposed = false;

  constructor(clip: IldaClip, throwLengthM = LASER_BEAM_LENGTH_M) {
    this.clip = clip;

    // Pass 1: count vertices per frame [rays | outline].
    const ranges: IldaFrameRange[] = [];
    let totalVertices = 0;
    for (const frame of clip.frames) {
      const raysStart = totalVertices;
      let litPoints = 0;
      let outlineSegs = 0;
      let prevLit = false;

      for (let i = 0; i < frame.count; i++) {
        const ptIdx = frame.offset + i;
        const isLit = clip.blank[ptIdx] === 0;
        if (isLit) {
          litPoints++;
          if (prevLit) outlineSegs++;
        }
        prevLit = isLit;
      }

      const raysCount = litPoints * 2;
      const outlineStart = raysStart + raysCount;
      const outlineCount = outlineSegs * 2;
      totalVertices = outlineStart + outlineCount;
      ranges.push({
        raysStart,
        raysCount,
        outlineStart,
        outlineCount,
        sourcePointCount: frame.count,
      });
    }

    this.frameRanges = ranges;
    const positions = new Float32Array(totalVertices * 3);
    const rgbColors = new Float32Array(totalVertices * 3);
    const monoColors = new Float32Array(totalVertices * 3);

    // Base unit throw plane: local XY in [-1, 1] * tan(45 deg / 2) at z = LASER_APERTURE_Z_M + throwLengthM.
    // Per-projector scan angle and user X/Y spread scale the LineSegments mesh XY cleanly at render time!
    const baseHalfExtent = Math.tan(Math.PI / 8) * throwLengthM; // corresponds to 45 deg full angle at scale=1
    const farZ = LASER_APERTURE_Z_M + throwLengthM;

    for (let fi = 0; fi < clip.frames.length; fi++) {
      const frame = clip.frames[fi];
      const range = ranges[fi];
      let rayVert = range.raysStart;
      let outVert = range.outlineStart;

      let prevLit = false;
      let prevX = 0;
      let prevY = 0;
      let prevR = 0;
      let prevG = 0;
      let prevB = 0;
      let prevLum = 0;

      for (let i = 0; i < frame.count; i++) {
        const ptIdx = frame.offset + i;
        if (clip.blank[ptIdx] !== 0) {
          prevLit = false;
          continue;
        }

        const nx = normalizeIldaCoord(clip.xy[ptIdx * 2]);
        const ny = normalizeIldaCoord(clip.xy[ptIdx * 2 + 1]);
        const fx = nx * baseHalfExtent;
        const fy = ny * baseHalfExtent;

        const r = clip.rgb[ptIdx * 3] / 255;
        const g = clip.rgb[ptIdx * 3 + 1] / 255;
        const b = clip.rgb[ptIdx * 3 + 2] / 255;
        const lum = Math.min(1, 0.299 * r + 0.587 * g + 0.114 * b);

        // 1. Aerial ray: aperture (0, 0, apZ) -> far point (fx, fy, farZ).
        // HDR boost at aperture (x2.5) fading toward far plane (x0.25) picks up UnrealBloomPass cleanly.
        const r0 = rayVert * 3;
        positions[r0] = 0;
        positions[r0 + 1] = 0;
        positions[r0 + 2] = LASER_APERTURE_Z_M;
        rgbColors[r0] = r * 2.5;
        rgbColors[r0 + 1] = g * 2.5;
        rgbColors[r0 + 2] = b * 2.5;
        monoColors[r0] = lum * 2.5;
        monoColors[r0 + 1] = lum * 2.5;
        monoColors[r0 + 2] = lum * 2.5;

        const r1 = (rayVert + 1) * 3;
        positions[r1] = fx;
        positions[r1 + 1] = fy;
        positions[r1 + 2] = farZ;
        rgbColors[r1] = r * 0.25;
        rgbColors[r1 + 1] = g * 0.25;
        rgbColors[r1 + 2] = b * 0.25;
        monoColors[r1] = lum * 0.25;
        monoColors[r1 + 1] = lum * 0.25;
        monoColors[r1 + 2] = lum * 0.25;
        rayVert += 2;

        // 2. Graphic outline: consecutive unblanked points at farZ with bright HDR stroke (x1.8).
        if (prevLit) {
          const o0 = outVert * 3;
          positions[o0] = prevX;
          positions[o0 + 1] = prevY;
          positions[o0 + 2] = farZ;
          rgbColors[o0] = prevR * 1.8;
          rgbColors[o0 + 1] = prevG * 1.8;
          rgbColors[o0 + 2] = prevB * 1.8;
          monoColors[o0] = prevLum * 1.8;
          monoColors[o0 + 1] = prevLum * 1.8;
          monoColors[o0 + 2] = prevLum * 1.8;

          const o1 = (outVert + 1) * 3;
          positions[o1] = fx;
          positions[o1 + 1] = fy;
          positions[o1 + 2] = farZ;
          rgbColors[o1] = r * 1.8;
          rgbColors[o1 + 1] = g * 1.8;
          rgbColors[o1 + 2] = b * 1.8;
          monoColors[o1] = lum * 1.8;
          monoColors[o1 + 1] = lum * 1.8;
          monoColors[o1 + 2] = lum * 1.8;
          outVert += 2;
        }

        prevLit = true;
        prevX = fx;
        prevY = fy;
        prevR = r;
        prevG = g;
        prevB = b;
        prevLum = lum;
      }
    }

    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.rgbColorAttr = new THREE.BufferAttribute(rgbColors, 3);
    this.monoColorAttr = new THREE.BufferAttribute(monoColors, 3);
  }

  /**
   * Create a per-projector BufferGeometry referencing this clip's shared GPU attributes.
   * For single-color lasers, binds luminance colors so material.color tints cleanly to the diode hue.
   */
  createProjectorGeometry(singleColor: boolean): THREE.BufferGeometry {
    if (this.disposed) {
      throw new Error('Cannot create projector geometry from a disposed BakedIldaClip.');
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', this.positionAttr);
    geo.setAttribute('color', singleColor ? this.monoColorAttr : this.rgbColorAttr);
    geo.setDrawRange(0, 0);
    this.wrappers.add(geo);
    return geo;
  }

  /** Returns true when `geo` is a shared-attribute wrapper owned by this baked clip. */
  ownsGeometry(geo: THREE.BufferGeometry): boolean {
    if (this.wrappers.has(geo)) return true;
    for (const projector of this.scanEnergyProjectors) {
      if (projector.geometry === geo) return true;
    }
    return false;
  }

  /** Create one explicitly-owned fixed-capacity scan-energy ribbon for a live projector. */
  createScanEnergyProjector(capacitySegments: number, singleColor: boolean): IldaScanEnergyProjector {
    if (this.disposed) {
      throw new Error('Cannot create a scan-energy projector from a disposed BakedIldaClip.');
    }
    const projector = new IldaScanEnergyProjector(this.clip, capacitySegments, singleColor);
    this.scanEnergyProjectors.add(projector);
    return projector;
  }

  /** Re-upload optional dynamic ribbon buffers after WebGL context restoration. */
  onContextRestored(): void {
    for (const projector of this.scanEnergyProjectors) projector.onContextRestored();
  }

  /** Dispose only optional ribbon resources while preserving byte/pixel-identical legacy line wrappers. */
  disposeScanEnergyProjectors(): void {
    for (const projector of this.scanEnergyProjectors) projector.dispose();
    this.scanEnergyProjectors.clear();
  }

  /** Compute the exact draw-range `[start, count]` for a given frame index and Beam/Graphic/Both mode (optionally reusing `out` for zero-alloc rendering). */
  drawRangeFor(
    frameIndex: number,
    mode: IldaRenderMode,
    out: { start: number; count: number } = { start: 0, count: 0 },
  ): { start: number; count: number } {
    if (!this.frameRanges.length) {
      out.start = 0;
      out.count = 0;
      return out;
    }
    const safeIdx = ((Math.floor(frameIndex) % this.frameRanges.length) + this.frameRanges.length) % this.frameRanges.length;
    const range = this.frameRanges[safeIdx];
    if (mode === 'beam') {
      out.start = range.raysStart;
      out.count = range.raysCount;
    } else if (mode === 'graphic') {
      out.start = range.outlineStart;
      out.count = range.outlineCount;
    } else {
      out.start = range.raysStart;
      out.count = range.raysCount + range.outlineCount;
    }
    return out;
  }

  /** Dispose all projector wrapper geometries together so shared GPU buffers are freed once cleanly. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeScanEnergyProjectors();
    for (const geo of this.wrappers) {
      geo.dispose();
    }
    this.wrappers.clear();
  }
}

/**
 * Compute XY scale factor for a baked ILDA LineSegments mesh given the projector's published
 * maxScanAngleDeg and the user's normalized X/Y spread sliders.
 */
export function ildaMeshScale(maxScanAngleDeg: number | undefined, spreadX: number, spreadY: number): [number, number] {
  const { scaleX, scaleY } = ildaScanTangents(maxScanAngleDeg, spreadX, spreadY);
  return [scaleX, scaleY];
}
