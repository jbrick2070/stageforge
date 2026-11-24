/**
 * Coordinate bridge between StageForge and MVR.
 *
 * StageForge: right-handed, Y up, metres, +Z toward the audience; yaw is a rotation about +Y.
 * MVR 1.6: right-handed, Z up, millimetres; a Matrix is written `{u}{v}{w}{o}` where u, v, w
 * are the object's local X, Y, Z axes in the parent frame and o is the origin in millimetres.
 *
 * The change of basis C maps StageForge (x, y, z) to MVR (x, −z, y): a −90° rotation about X.
 * The audience therefore sits toward MVR −Y and upstage toward +Y. Because C is a proper
 * rotation, a yaw about StageForge +Y becomes the same-signed yaw about MVR +Z.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MvrMatrix {
  u: Vec3;
  v: Vec3;
  w: Vec3;
  /** Origin in millimetres. */
  o: Vec3;
}

export const IDENTITY: MvrMatrix = {
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  w: { x: 0, y: 0, z: 1 },
  o: { x: 0, y: 0, z: 0 },
};

const DEG = Math.PI / 180;

/** StageForge metres → MVR millimetres. */
export function toMvrPoint(p: Vec3): Vec3 {
  return { x: p.x * 1000, y: -p.z * 1000, z: p.y * 1000 };
}

/** MVR millimetres → StageForge metres. */
export function fromMvrPoint(p: Vec3): Vec3 {
  return { x: p.x / 1000, y: p.z / 1000, z: -p.y / 1000 };
}

const rotate = (axis: Vec3, c: number, s: number, flip: boolean): Vec3 => {
  // Yaw about MVR +Z, applied after an optional 180° turn about X (a standing fixture).
  const y = flip ? -axis.y : axis.y, z = flip ? -axis.z : axis.z;
  return { x: c * axis.x - s * y, y: s * axis.x + c * y, z };
};

/**
 * MVR matrix for an object at `position` (StageForge metres) yawed by `yawDeg` about +Y.
 * `standing` turns the object upright: GDTF models fixtures hanging, so a floor fixture is
 * rotated 180° about its local X axis.
 */
export function poseMatrix(position: Vec3, yawDeg: number, standing = false): MvrMatrix {
  const c = Math.cos(yawDeg * DEG), s = Math.sin(yawDeg * DEG);
  return {
    u: rotate(IDENTITY.u, c, s, standing),
    v: rotate(IDENTITY.v, c, s, standing),
    w: rotate(IDENTITY.w, c, s, standing),
    o: toMvrPoint(position),
  };
}

export interface Pose {
  position: Vec3;
  /** Yaw about StageForge +Y in degrees, −180 … 180. */
  yawDeg: number;
  /** True when the object's local Z points down in MVR (upright / floor-standing). */
  standing: boolean;
  /** Tilt of the local Z axis away from vertical, degrees (0 for hung or standing objects). */
  tiltDeg: number;
}

/** Read position and yaw back from an MVR matrix (the inverse of poseMatrix for its outputs). */
export function readPose(m: MvrMatrix): Pose {
  const standing = m.w.z < 0;
  // For a hung object u = (cos, sin, 0); for a standing one u is unchanged by the X flip.
  const yaw = Math.atan2(m.u.y, m.u.x) / DEG;
  const tilt = Math.acos(Math.max(-1, Math.min(1, Math.abs(m.w.z) / (Math.hypot(m.w.x, m.w.y, m.w.z) || 1)))) / DEG;
  const wrapped = ((((yaw + 180) % 360) + 360) % 360) - 180;
  return { position: fromMvrPoint(m.o), yawDeg: wrapped === -180 ? 180 : wrapped, standing, tiltDeg: tilt };
}

const num = (n: number) => {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/** Matrix text in MVR's `{ux,uy,uz}{vx,vy,vz}{wx,wy,wz}{ox,oy,oz}` form. */
export function matrixText(m: MvrMatrix): string {
  return [m.u, m.v, m.w, m.o].map((a) => `{${num(a.x)},${num(a.y)},${num(a.z)}}`).join('');
}

/** Largest accepted matrix component: axes are unit-ish and origins are millimetres (1000 km). */
export const MAX_MATRIX_COMPONENT = 1e9;

/**
 * Read MVR matrix text. An absent matrix is the identity (the spec's default); malformed text or
 * an absurdly large component gives undefined, so callers can tell "unknown" from "at the origin".
 */
export function readMatrix(text: string | undefined): MvrMatrix | undefined {
  if (text === undefined || !text.trim()) return structuredClone(IDENTITY);
  const groups = text.match(/\{[^}]*\}/g);
  if (!groups || groups.length !== 4) return undefined;
  const parts = groups.map((g) => g.slice(1, -1).split(',').map((v) => v.trim()));
  if (parts.some((v) => v.length !== 3 || v.some((s) => !s))) return undefined;
  const vecs = parts.map((v) => v.map(Number));
  if (vecs.some((v) => v.some((n) => !Number.isFinite(n) || Math.abs(n) > MAX_MATRIX_COMPONENT))) return undefined;
  const [u, v, w, o] = vecs.map(([x, y, z]) => ({ x, y, z }));
  return { u, v, w, o };
}

/** Parse MVR matrix text, falling back to identity for an absent, malformed or absurd value. */
export function parseMatrix(text: string | undefined): MvrMatrix {
  return readMatrix(text) ?? structuredClone(IDENTITY);
}

/** Compose parent ∘ child (child expressed in the parent's frame). */
export function compose(parent: MvrMatrix, child: MvrMatrix): MvrMatrix {
  const apply = (a: Vec3): Vec3 => ({
    x: parent.u.x * a.x + parent.v.x * a.y + parent.w.x * a.z,
    y: parent.u.y * a.x + parent.v.y * a.y + parent.w.y * a.z,
    z: parent.u.z * a.x + parent.v.z * a.y + parent.w.z * a.z,
  });
  const o = apply(child.o);
  return { u: apply(child.u), v: apply(child.v), w: apply(child.w), o: { x: o.x + parent.o.x, y: o.y + parent.o.y, z: o.z + parent.o.z } };
}
