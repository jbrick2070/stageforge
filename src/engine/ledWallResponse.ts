import * as THREE from 'three';

/**
 * Shared LED wall viewing-angle emissivity model (Sprint 17).
 *
 * Models the restrained angular falloff of black-face SMD concert LED panels with
 * louvres/shaders: full frontal readability across FOH/arena sightlines (0°–30°),
 * smooth C^∞ rolloff through wide side seats (45°–65°), and a bounded non-zero floor
 * at extreme grazing angles (75°–90°) without contouring on curved cylinder walls,
 * individual-LED geometry, extra draw calls, or extra render passes.
 *
 * Authoritative constants are interpolated directly into `LED_ANGULAR_RESPONSE_GLSL`
 * so the CPU reference oracle and GPU shader cannot drift.
 */

export const LED_ANGULAR_DEFINE = 'LED_ANGULAR_RESPONSE' as const;

/** Bounded minimum emissivity gain at 90° grazing incidence (`cosTheta = 0`). */
export const LED_ANGULAR_FLOOR = 0.30;

/** Rational shoulder knee parameter (`k > 0`; guarantees non-zero denominator `c^2 + k >= k`). */
export const LED_ANGULAR_KNEE = 0.22;

export const LED_ANGULAR_SPAN = +(1 - LED_ANGULAR_FLOOR).toFixed(6); // 0.70
export const LED_ANGULAR_NUMERATOR_SCALE = +(1 + LED_ANGULAR_KNEE).toFixed(6); // 1.22

const glslFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n));

const VIEW_POS_SCRATCH = new THREE.Vector3();
const VIEW_NORMAL_SCRATCH = new THREE.Vector3();
const MV_MATRIX_SCRATCH = new THREE.Matrix4();
const NORMAL_MATRIX_SCRATCH = new THREE.Matrix3();

/**
 * Evaluate bounded LED wall angular emissivity gain for `cosTheta = dot(N, V)`.
 * - Exact `1.0` at normal incidence (`cosTheta = 1`).
 * - Exact `LED_ANGULAR_FLOOR` (`0.30`) at grazing incidence (`cosTheta <= 0`).
 * - Neutral `1.0` fallback on non-finite input (`NaN`).
 */
export function evaluateLedAngularGain(cosTheta: number): number {
  if (Number.isNaN(cosTheta)) return 1.0;
  const c = Math.max(0, Math.min(1, cosTheta));
  const c2 = c * c;
  return LED_ANGULAR_FLOOR + LED_ANGULAR_SPAN * ((LED_ANGULAR_NUMERATOR_SCALE * c2) / (c2 + LED_ANGULAR_KNEE));
}

/**
 * Exact CPU mirror of `LED_WALL_FRAG`'s `evaluateLedAngularGainFromView(vViewNormal, vViewDir, gl_FrontFacing)`.
 * Note: Three.js implements `THREE.BackSide` via `gl.frontFace(gl.CW)` + `#define FLIP_SIDED`, so `LED_WALL_VERT`
 * negates `vViewNormal` under `FLIP_SIDED` while `gl_FrontFacing` remains `true` on `BackSide` and flips only on
 * `DoubleSide` backfaces. Returns `1.0` on degenerate vectors.
 */
export function evaluateLedWallFragmentGain(
  viewNormal: { x: number; y: number; z: number },
  viewDir: { x: number; y: number; z: number },
  frontFacing: boolean,
): number {
  const sign = frontFacing ? 1 : -1;
  const nx = viewNormal.x * sign;
  const ny = viewNormal.y * sign;
  const nz = viewNormal.z * sign;
  const vx = viewDir.x;
  const vy = viewDir.y;
  const vz = viewDir.z;
  if (
    !Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz) ||
    !Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)
  ) {
    return 1.0;
  }
  const nLenSq = nx * nx + ny * ny + nz * nz;
  const vLenSq = vx * vx + vy * vy + vz * vz;
  if (nLenSq <= 1e-10 || vLenSq <= 1e-10) return 1.0;
  const invLen = 1 / Math.sqrt(nLenSq * vLenSq);
  const cosTheta = Math.max(0, Math.min(1, (nx * vx + ny * vy + nz * vz) * invLen));
  return evaluateLedAngularGain(cosTheta);
}

export interface LedSurfaceViewSample {
  viewNormal: THREE.Vector3;
  viewDir: THREE.Vector3;
  flipSided: boolean;
  frontFacing: boolean;
  cosTheta: number;
  gain: number;
}

/**
 * Compute per-eye view-space normal, view vector (`-mvPos.xyz`), `FLIP_SIDED` / `gl_FrontFacing` orientation,
 * `cosTheta`, and emissivity gain for a local vertex/normal on a Three.js LED mesh.
 * Mirrors Three.js WebGLState (`BackSide` sets `gl.frontFace(gl.CW)` + `#define FLIP_SIDED`, so `vViewNormal`
 * is negated in the vertex shader and `gl_FrontFacing` is `true` for the visible inner surface).
 */
export function computeLedSurfaceViewTerms(
  mesh: THREE.Mesh,
  localPosition: THREE.Vector3,
  localNormal: THREE.Vector3,
  camera: THREE.Camera,
): LedSurfaceViewSample {
  MV_MATRIX_SCRATCH.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld);
  NORMAL_MATRIX_SCRATCH.getNormalMatrix(MV_MATRIX_SCRATCH);

  VIEW_POS_SCRATCH.copy(localPosition).applyMatrix4(MV_MATRIX_SCRATCH);
  VIEW_NORMAL_SCRATCH.copy(localNormal).applyMatrix3(NORMAL_MATRIX_SCRATCH);

  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const side = mat?.side ?? THREE.FrontSide;
  const flipSided = side === THREE.BackSide;
  if (flipSided) VIEW_NORMAL_SCRATCH.negate();

  const viewDir = VIEW_POS_SCRATCH.clone().negate();
  const viewNormal = VIEW_NORMAL_SCRATCH.clone();

  let frontFacing = true;
  if (side === THREE.DoubleSide) {
    frontFacing = viewNormal.dot(viewDir) >= 0;
  }

  const oriented = viewNormal.clone().multiplyScalar(frontFacing ? 1 : -1);
  const nLenSq = oriented.lengthSq();
  const vLenSq = viewDir.lengthSq();
  const cosTheta =
    nLenSq > 1e-10 && vLenSq > 1e-10 && Number.isFinite(nLenSq) && Number.isFinite(vLenSq)
      ? Math.max(0, Math.min(1, oriented.dot(viewDir) / Math.sqrt(nLenSq * vLenSq)))
      : 1.0;

  return {
    viewNormal,
    viewDir,
    flipSided,
    frontFacing,
    cosTheta,
    gain: evaluateLedWallFragmentGain(viewNormal, viewDir, frontFacing),
  };
}

export const LED_ANGULAR_RESPONSE_GLSL = /* glsl */ `
  float evaluateLedAngularGainFromView(vec3 viewNormal, vec3 viewDir, bool frontFacing) {
    vec3 rawN = frontFacing ? viewNormal : -viewNormal;
    float nLenSq = dot(rawN, rawN);
    float vLenSq = dot(viewDir, viewDir);
    if (nLenSq <= 1e-10 || vLenSq <= 1e-10) {
      return 1.0;
    }
    float cosTheta = clamp(dot(rawN * inversesqrt(nLenSq), viewDir * inversesqrt(vLenSq)), 0.0, 1.0);
    float c2 = cosTheta * cosTheta;
    return ${glslFloat(LED_ANGULAR_FLOOR)} + ${glslFloat(LED_ANGULAR_SPAN)} * ((${glslFloat(LED_ANGULAR_NUMERATOR_SCALE)} * c2) / (c2 + ${glslFloat(LED_ANGULAR_KNEE)}));
  }
`;
