import * as THREE from 'three';
import type {
  FixtureMeasurement,
  LaserHazardZone,
  ReachMapResult,
  VenueBounds,
} from '../data/measure';
import { laserRayWorldDirection } from '../data/laserSafety';

export interface MeasureOverlayOptions {
  readonly enabled: boolean;
  readonly showRays: boolean;
  readonly showAudienceZone: boolean;
  readonly showLaserNohd: boolean;
  readonly showReachMap: boolean;
  readonly selectedUnitId: string | null;
}

export const DEFAULT_MEASURE_OVERLAY_OPTIONS: MeasureOverlayOptions = Object.freeze({
  enabled: false,
  showRays: true,
  showAudienceZone: false,
  showLaserNohd: false,
  showReachMap: false,
  selectedUnitId: null,
});

export function isMeasureOverlayActive(opts: MeasureOverlayOptions): boolean {
  return opts.enabled || opts.showAudienceZone || opts.showLaserNohd || opts.showReachMap;
}

/**
 * Lazy-allocated 3D measurement & safety zone overlay added directly to `scene` (outside `rigGroup`
 * so GLB export and `RenderBatcher` never include it).
 *
 * When off, zero `Object3D`s, geometries, or materials exist in the scene so `renderStats()` is
 * bit-identical to off-by-default. When on, all rays + red keep-out segments + hit crosshairs draw
 * in ONE batched `THREE.LineSegments` with preallocated typed arrays (zero per-frame allocations).
 */
export class MeasureOverlay3D {
  public readonly group = new THREE.Group();

  // Batched rays + keep-out red segments + hit crosshairs (1 draw call)
  private rayLines: THREE.LineSegments | null = null;
  private rayPos: Float32Array = new Float32Array(0);
  private rayCol: Float32Array = new Float32Array(0);
  private rayCapacityVerts = 0;

  // Translucent audience keep-out volume + wireframe edges (2 draw calls when enabled)
  private audienceGroup: THREE.Group | null = null;
  private audienceKey = '';

  // Batched venue-clipped laser NOHD cones (1 draw call when enabled)
  private nohdLines: THREE.LineSegments | null = null;
  private nohdKey = '';

  // Batched stage-deck reach map outlines (1 draw call when enabled)
  private reachLines: THREE.LineSegments | null = null;
  private reachKey = '';

  constructor() {
    this.group.name = 'Measure & Safety Overlay';
    this.group.userData.kind = 'measureOverlay';
  }

  private ensureRayCapacity(neededVerts: number): THREE.LineSegments {
    if (this.rayLines && this.rayCapacityVerts >= neededVerts) {
      return this.rayLines;
    }
    if (this.rayLines) {
      this.group.remove(this.rayLines);
      this.rayLines.geometry.dispose();
      (this.rayLines.material as THREE.Material).dispose();
    }
    const cap = Math.max(64, Math.ceil(neededVerts / 64) * 64);
    this.rayCapacityVerts = cap;
    this.rayPos = new Float32Array(cap * 3);
    this.rayCol = new Float32Array(cap * 3);
    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.rayPos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.rayCol, 3);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    geom.setAttribute('color', colAttr);
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 20;
    this.rayLines = lines;
    this.group.add(lines);
    return lines;
  }

  /** Update batched moving-head beam rays, red audience keep-out segments, and hit crosshairs. */
  public updateRays(
    units: readonly FixtureMeasurement[],
    visible: boolean,
    selectedUnitId: string | null,
  ): void {
    if (!visible || units.length === 0) {
      if (this.rayLines) {
        this.rayLines.visible = false;
        this.rayLines.geometry.setDrawRange(0, 0);
      }
      return;
    }

    // Up to 5 segments (10 vertices) per fixture: pre-zone, red-zone, post-zone, + 2 crosshair ticks
    const lines = this.ensureRayCapacity(units.length * 10);
    lines.visible = true;
    const pos = this.rayPos;
    const col = this.rayCol;
    let v = 0;

    const pushSeg = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      r: number, g: number, b: number,
    ) => {
      const i0 = v * 3;
      pos[i0] = ax; pos[i0 + 1] = ay; pos[i0 + 2] = az;
      col[i0] = r; col[i0 + 1] = g; col[i0 + 2] = b;
      const i1 = (v + 1) * 3;
      pos[i1] = bx; pos[i1 + 1] = by; pos[i1 + 2] = bz;
      col[i1] = r; col[i1 + 1] = g; col[i1 + 2] = b;
      v += 2;
    };

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const isSelected = u.unitId === selectedUnitId;
      // Only draw visible or selected fixtures in the 3D overlay (pre-flight still evaluates all units).
      if (!isSelected && !u.emittedVisible && !u.entersAudienceBelowThreshold) continue;

      const ox = u.lensOrigin.x;
      const oy = u.lensOrigin.y;
      const oz = u.lensOrigin.z;
      const dx = u.direction.x;
      const dy = u.direction.y;
      const dz = u.direction.z;
      const endT = u.throwM !== null ? u.throwM : 28;

      const nr = isSelected ? 1.0 : u.type === 'wash' ? 0.45 : 0.15;
      const ng = isSelected ? 0.85 : u.type === 'wash' ? 0.82 : 0.92;
      const nb = isSelected ? 0.2 : 1.0;

      if (u.entersAudienceBelowThreshold && u.audienceEnterT !== null && u.audienceExitT !== null) {
        const t1 = Math.max(0, Math.min(endT, u.audienceEnterT));
        const t2 = Math.max(t1, Math.min(endT, u.audienceExitT));
        if (t1 > 0.02) {
          pushSeg(ox, oy, oz, ox + dx * t1, oy + dy * t1, oz + dz * t1, nr, ng, nb);
        }
        if (t2 - t1 > 0.02) {
          // Beam segment inside audience keep-out volume turns bright red.
          pushSeg(
            ox + dx * t1, oy + dy * t1, oz + dz * t1,
            ox + dx * t2, oy + dy * t2, oz + dz * t2,
            1.0, 0.14, 0.22,
          );
        }
        if (endT - t2 > 0.02) {
          pushSeg(
            ox + dx * t2, oy + dy * t2, oz + dz * t2,
            ox + dx * endT, oy + dy * endT, oz + dz * endT,
            nr, ng, nb,
          );
        }
      } else {
        pushSeg(ox, oy, oz, ox + dx * endT, oy + dy * endT, oz + dz * endT, nr, ng, nb);
      }

      if (u.hitPoint) {
        const hx = u.hitPoint.x;
        const hy = u.hitPoint.y + 0.03;
        const hz = u.hitPoint.z;
        const s = isSelected ? 0.45 : 0.22;
        const cr = u.entersAudienceBelowThreshold ? 1.0 : nr;
        const cg = u.entersAudienceBelowThreshold ? 0.2 : ng;
        const cb = u.entersAudienceBelowThreshold ? 0.25 : nb;
        pushSeg(hx - s, hy, hz, hx + s, hy, hz, cr, cg, cb);
        pushSeg(hx, hy, hz - s, hx, hy, hz + s, cr, cg, cb);
      }
    }

    const posAttr = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = lines.geometry.getAttribute('color') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    lines.geometry.setDrawRange(0, v);
  }

  /** Update translucent 3D audience keep-out box (`y = 0..3.0 m`). Rebuilt only when bounds change. */
  public updateAudienceZone(bounds: VenueBounds, visible: boolean): void {
    if (!visible) {
      if (this.audienceGroup) this.audienceGroup.visible = false;
      return;
    }
    const az = bounds.audienceZone;
    const key = `${az.minX.toFixed(2)},${az.maxX.toFixed(2)},${az.minZ.toFixed(2)},${az.maxZ.toFixed(2)},${az.maxY.toFixed(2)}`;
    if (this.audienceGroup && this.audienceKey === key) {
      this.audienceGroup.visible = true;
      return;
    }
    this.disposeAudienceZone();
    this.audienceKey = key;

    const w = Math.max(0.5, az.maxX - az.minX);
    const h = Math.max(0.5, az.maxY - az.minY);
    const d = Math.max(0.5, az.maxZ - az.minZ);
    const cx = (az.minX + az.maxX) / 2;
    const cy = (az.minY + az.maxY) / 2;
    const cz = (az.minZ + az.maxZ) / 2;

    const container = new THREE.Group();
    container.name = 'Audience Keep-Out Volume';

    const boxGeo = new THREE.BoxGeometry(w, h, d);
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0xff2d44,
      transparent: true,
      opacity: 0.11,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const boxMesh = new THREE.Mesh(boxGeo, boxMat);
    boxMesh.position.set(cx, cy, cz);
    boxMesh.renderOrder = 18;

    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0xff5263,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const edges = new THREE.LineSegments(edgesGeo, edgesMat);
    edges.position.set(cx, cy, cz);
    edges.renderOrder = 19;

    container.add(boxMesh, edges);
    this.audienceGroup = container;
    this.group.add(container);
  }

  /**
   * Update batched venue-clipped laser NOHD cones.
   * Draws ZERO hazard cone geometry for unknown-NOHD lasers; instead marks each unassessed
   * projector aperture with a compact caution diamond/crosshair so unknown lasers are visibly flagged.
   */
  public updateLaserNohd(zones: readonly LaserHazardZone[], visible: boolean, key: string): void {
    if (!visible) {
      if (this.nohdLines) this.nohdLines.visible = false;
      return;
    }
    if (this.nohdLines && this.nohdKey === key) {
      this.nohdLines.visible = true;
      return;
    }
    this.disposeNohd();
    this.nohdKey = key;

    const drawable = zones.filter((z) => z.nohd.canDrawZone && z.displayDistanceM !== null && z.displayDistanceM > 0);
    const unassessed = zones.filter((z) => !z.nohd.canDrawZone);
    if (drawable.length === 0 && unassessed.length === 0) return;

    const positions: number[] = [];
    const colors: number[] = [];
    const push = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      r: number, g: number, b: number,
    ) => {
      positions.push(ax, ay, az, bx, by, bz);
      colors.push(r, g, b, r, g, b);
    };

    const ringSteps = 16;
    for (const z of drawable) {
      const dist = z.displayDistanceM!;
      const r = z.audienceInsideNohd ? 1.0 : 1.0;
      const g = z.audienceInsideNohd ? 0.24 : 0.68;
      const b = z.audienceInsideNohd ? 0.24 : 0.15;
      const ox = z.origin.x;
      const oy = z.origin.y;
      const oz = z.origin.z;

      let prevX = 0;
      let prevY = 0;
      let prevZ = 0;
      for (let s = 0; s <= ringSteps; s++) {
        const theta = (s / ringSteps) * Math.PI * 2;
        const az = Math.cos(theta) * z.halfAzimuthRad;
        const el = Math.sin(theta) * z.halfElevationRad;
        const dir = laserRayWorldDirection(z.yaw, z.maxDownPitchRad, az, el);
        const px = ox + dir.dx * dist;
        const py = Math.max(0.02, oy + dir.dy * dist);
        const pz = oz + dir.dz * dist;

        // 4 cone spine ribs from aperture to ring
        if (s < ringSteps && s % 4 === 0) {
          push(ox, oy, oz, px, py, pz, r, g, b);
        }
        if (s > 0) {
          push(prevX, prevY, prevZ, px, py, pz, r, g, b);
        }
        prevX = px;
        prevY = py;
        prevZ = pz;
      }
    }

    // Compact unassessed-projector warning diamond at aperture (zero hazard cone drawn).
    for (const z of unassessed) {
      const ox = z.origin.x;
      const oy = z.origin.y;
      const oz = z.origin.z;
      const s = 0.55;
      const r = 1.0;
      const g = 0.26;
      const b = 0.36;
      // Octahedron-like 3D warning diamond around the projector aperture
      push(ox - s, oy, oz, ox, oy + s, oz, r, g, b);
      push(ox, oy + s, oz, ox + s, oy, oz, r, g, b);
      push(ox + s, oy, oz, ox, oy - s, oz, r, g, b);
      push(ox, oy - s, oz, ox - s, oy, oz, r, g, b);
      push(ox, oy, oz - s, ox, oy + s, oz, r, g, b);
      push(ox, oy + s, oz, ox, oy, oz + s, r, g, b);
      push(ox, oy, oz + s, ox, oy - s, oz, r, g, b);
      push(ox, oy - s, oz, ox, oy, oz - s, r, g, b);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 19;
    this.nohdLines = lines;
    this.group.add(lines);
  }

  /** Update batched stage-deck reach map polygons/loci. Rebuilt only when rig/selection changes. */
  public updateReachMap(reach: ReachMapResult, selectedUnitId: string | null, visible: boolean, key: string): void {
    if (!visible) {
      if (this.reachLines) this.reachLines.visible = false;
      return;
    }
    const fullKey = `${key}:${selectedUnitId ?? 'all'}`;
    if (this.reachLines && this.reachKey === fullKey) {
      this.reachLines.visible = true;
      return;
    }
    this.disposeReach();
    this.reachKey = fullKey;

    const positions: number[] = [];
    const colors: number[] = [];
    const push = (
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      r: number, g: number, b: number,
    ) => {
      positions.push(ax, ay, az, bx, by, bz);
      colors.push(r, g, b, r, g, b);
    };

    const selected = selectedUnitId ? reach.areas.find((a) => a.unitId === selectedUnitId) : null;
    if (selected && selected.points.length >= 2) {
      const pts = selected.points;
      const closed = selected.kind === 'polygon';
      for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        push(a.x, a.y, a.z, b.x, b.y, b.z, 0.2, 0.95, 0.78);
      }
    } else {
      // Draw union deck reach box + individual tilt-only loci
      if (reach.unionPolygon.length >= 3) {
        const pts = reach.unionPolygon;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          push(a.x, a.y, a.z, b.x, b.y, b.z, 0.16, 0.85, 0.72);
        }
      }
      for (const area of reach.areas) {
        if (area.kind === 'locus' && area.points.length >= 2) {
          const a = area.points[0];
          const b = area.points[1];
          push(a.x, a.y, a.z, b.x, b.y, b.z, 0.4, 0.75, 1.0);
        }
      }
    }

    if (positions.length === 0) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 19;
    this.reachLines = lines;
    this.group.add(lines);
  }

  private disposeAudienceZone(): void {
    if (!this.audienceGroup) return;
    this.audienceGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.group.remove(this.audienceGroup);
    this.audienceGroup = null;
    this.audienceKey = '';
  }

  private disposeNohd(): void {
    if (!this.nohdLines) return;
    this.group.remove(this.nohdLines);
    this.nohdLines.geometry.dispose();
    (this.nohdLines.material as THREE.Material).dispose();
    this.nohdLines = null;
    this.nohdKey = '';
  }

  private disposeReach(): void {
    if (!this.reachLines) return;
    this.group.remove(this.reachLines);
    this.reachLines.geometry.dispose();
    (this.reachLines.material as THREE.Material).dispose();
    this.reachLines = null;
    this.reachKey = '';
  }

  public dispose(): void {
    if (this.rayLines) {
      this.group.remove(this.rayLines);
      this.rayLines.geometry.dispose();
      (this.rayLines.material as THREE.Material).dispose();
      this.rayLines = null;
      this.rayCapacityVerts = 0;
      this.rayPos = new Float32Array(0);
      this.rayCol = new Float32Array(0);
    }
    this.disposeAudienceZone();
    this.disposeNohd();
    this.disposeReach();
  }
}
