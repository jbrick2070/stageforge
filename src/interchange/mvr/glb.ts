/**
 * Minimal binary glTF 2.0 (GLB) boxes for MVR scene geometry: decks, truss spans, LED wall
 * frames, props and speaker hangs. Pure TypeScript (no three.js), so exports run in Node tests.
 * Dimensions are metres in glTF's own frame (Y up, +Z front); the box is centred on its origin
 * unless `base` puts the origin at the bottom face.
 */

const FACES: Array<{ normal: [number, number, number]; corners: Array<[number, number, number]> }> = [
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

const pad4 = (n: number) => (n + 3) & ~3;

export function boxGlb(width: number, height: number, depth: number, options: { base?: boolean; color?: [number, number, number] } = {}): Uint8Array {
  const hx = Math.max(0.001, width) / 2, hy = Math.max(0.001, height) / 2, hz = Math.max(0.001, depth) / 2;
  const lift = options.base ? hy : 0;
  const positions = new Float32Array(24 * 3), normals = new Float32Array(24 * 3);
  const indices = new Uint16Array(36);
  FACES.forEach((face, f) => {
    face.corners.forEach(([x, y, z], c) => {
      const v = f * 4 + c;
      positions.set([x * hx, y * hy + lift, z * hz], v * 3);
      normals.set(face.normal, v * 3);
    });
    indices.set([f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3], f * 6);
  });
  const posBytes = positions.byteLength, normBytes = normals.byteLength, idxBytes = indices.byteLength;
  const binLength = pad4(posBytes + normBytes + idxBytes);
  const bin = new Uint8Array(binLength);
  bin.set(new Uint8Array(positions.buffer), 0);
  bin.set(new Uint8Array(normals.buffer), posBytes);
  bin.set(new Uint8Array(indices.buffer), posBytes + normBytes);
  const [r, g, b] = options.color ?? [0.55, 0.58, 0.62];
  const json = {
    asset: { version: '2.0', generator: 'StageForge MVR export' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [r, g, b, 1], metallicFactor: 0.2, roughnessFactor: 0.7 } }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes, byteLength: normBytes, target: 34962 },
      { buffer: 0, byteOffset: posBytes + normBytes, byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-hx, -hy + lift, -hz], max: [hx, hy + lift, hz] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, binLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true); // "BIN\0"
  out.set(bin, 28 + jsonLength);
  return out;
}

const MAX_GLB_JSON_BYTES = 16 * 1024 * 1024;
const isVec3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Read the bounding box of a GLB written by boxGlb (used by tests and import sizing). */
export function glbBounds(glb: Uint8Array): { min: [number, number, number]; max: [number, number, number] } | undefined {
  try {
    if (glb.byteLength < 20) return undefined;
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) return undefined;
    const jsonLength = view.getUint32(12, true);
    const chunkType = view.getUint32(16, true);
    if (chunkType !== 0x4e4f534a || jsonLength === 0 || jsonLength > MAX_GLB_JSON_BYTES || 20 + jsonLength > glb.byteLength) {
      return undefined;
    }
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    const positionIndex = json?.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION;
    if (typeof positionIndex !== 'number' || !Number.isInteger(positionIndex) || positionIndex < 0) return undefined;
    const accessor = Array.isArray(json?.accessors) ? json.accessors[positionIndex] : undefined;
    return isVec3(accessor?.min) && isVec3(accessor?.max) ? { min: accessor.min, max: accessor.max } : undefined;
  } catch {
    return undefined;
  }
}
