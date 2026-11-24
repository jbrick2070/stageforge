import * as THREE from 'three';

/**
 * Draws repeated opaque parts (moving-head yokes and housings, truss clamps, chain hoists, subwoofers,
 * lamp lenses…) as one InstancedMesh per part type instead of one draw call per part.
 *
 * Proxy instancing: every original mesh stays in the scene graph, so animation code, GLB export,
 * FOH framing and bounding boxes keep working unchanged. Originals move to a layer the camera never
 * renders, and once per frame, after three.js updates world matrices and before it culls objects and
 * uploads attributes (Scene.onBeforeRender), each batch copies its originals' world matrices and
 * refreshes the bounding sphere three uses to cull the batch.
 *
 * Grouping:
 * - Geometry is matched by content, so builders that make a fresh copy of the same shape per unit
 *   (hoists, subwoofers, wedges) still share a batch. Equal hashes are confirmed byte for byte, and
 *   only geometries that could share a batch are hashed.
 * - Lit materials are matched by identity (they are shared across units).
 * - MeshBasicMaterial lamps (lenses, strobe plates, blinder cells, laser apertures) usually have one
 *   material per unit whose colour the engine drives every frame. Lamps with identical settings share
 *   a white copy of the material and each instance takes its unit's colour through instanceColor.
 *
 * A hidden or detached original gets a zero-scale instance. An original whose geometry, material,
 * layers, draw order, lamp settings or handedness change is handed back to normal rendering. If
 * batching fails for any reason the rig simply renders unbatched.
 */

/** Layer for batched originals; cameras render layer 0 only. */
export const BATCH_HIDDEN_LAYER = 31;

const LIT_MATERIALS = new Set([
  'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial',
  'MeshToonMaterial', 'MeshMatcapMaterial',
]);
const DEFAULT_LAYER_MASK = new THREE.Layers().mask;
/** three.js stores masks unsigned, so take the hidden layer's mask from three itself (1 << 31 is negative in JS). */
const HIDDEN_MASK = (() => { const layers = new THREE.Layers(); layers.set(BATCH_HIDDEN_LAYER); return layers.mask; })();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0).elements;

/** Every lamp setting that changes how a MeshBasicMaterial draws; colour alone varies per instance. */
const LAMP_KEYS = [
  'map', 'alphaMap', 'aoMap', 'aoMapIntensity', 'envMap', 'envMapRotation', 'lightMap', 'lightMapIntensity', 'specularMap',
  'opacity', 'side', 'shadowSide', 'blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha',
  'blendEquationAlpha', 'blendColor', 'blendAlpha', 'premultipliedAlpha', 'depthFunc', 'depthTest', 'depthWrite',
  'colorWrite', 'stencilWrite', 'stencilFunc', 'stencilRef', 'stencilFuncMask', 'stencilWriteMask', 'stencilFail',
  'stencilZFail', 'stencilZPass', 'toneMapped', 'fog', 'wireframe', 'vertexColors', 'alphaTest', 'alphaHash',
  'alphaToCoverage', 'dithering', 'combine', 'reflectivity', 'refractionRatio', 'clippingPlanes', 'clipIntersection',
  'clipShadows', 'forceSinglePass', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits',
  'onBeforeCompile', 'customProgramCacheKey',
] as const;

type LampSettings = Record<(typeof LAMP_KEYS)[number], unknown>;

interface Batch {
  mesh: THREE.InstancedMesh;
  sources: THREE.Mesh[];
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
  released: boolean[];
  /** Lamp batches own a white copy of the material, take colour per instance, and check settings per frame. */
  lampSettings: LampSettings | null;
  /** Bounding sphere of the shared geometry, in its own space. */
  localSphere: THREE.Sphere;
}

export interface BatcherStats {
  batches: number;
  instances: number;
  released: number;
}

const isLamp = (material: THREE.Material): material is THREE.MeshBasicMaterial => material.type === 'MeshBasicMaterial';
const read = (material: THREE.Material, key: string) => (material as unknown as Record<string, unknown>)[key];
const isValueObject = (value: unknown): value is { clone(): unknown; equals(other: unknown): boolean } =>
  !!value && typeof value === 'object' && !(value as { isTexture?: boolean }).isTexture
  && typeof (value as { clone?: unknown }).clone === 'function' && typeof (value as { equals?: unknown }).equals === 'function';

/** Built-in, opaque, single-material, unskinned, unmorphed meshes on the default layer. */
export function isBatchable(node: THREE.Object3D): node is THREE.Mesh {
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return false;
  if (mesh.userData.noBatch || mesh.renderOrder !== 0 || mesh.layers.mask !== DEFAULT_LAYER_MASK) return false;
  const material = mesh.material;
  if (!material || Array.isArray(material)) return false;
  if (!(LIT_MATERIALS.has(material.type) || isLamp(material)) || material.transparent || !material.visible) return false;
  const geometry = mesh.geometry;
  if (!geometry || !geometry.getAttribute('position') || Object.keys(geometry.morphAttributes ?? {}).length) return false;
  return true;
}

/** A snapshot of a lamp's settings: colours and rotations are copied, textures and hooks kept by identity. */
function snapshotLamp(material: THREE.Material): LampSettings {
  const settings = {} as LampSettings;
  for (const key of LAMP_KEYS) {
    const value = read(material, key);
    settings[key] = isValueObject(value) ? value.clone() : Array.isArray(value) ? value.slice() : value;
  }
  return settings;
}

function settingEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isValueObject(a)) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

function lampMatches(material: THREE.Material, settings: LampSettings): boolean {
  for (const key of LAMP_KEYS) if (!settingEqual(settings[key], read(material, key))) return false;
  return true;
}

/** A grouping key for lamp settings (build time only). Objects without a uuid get a stable per-run id. */
function lampKey(settings: LampSettings, ids: WeakMap<object, number>): string {
  return LAMP_KEYS.map((key) => {
    const value = settings[key];
    if (value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'function')) return String(value);
    if (isValueObject(value) && typeof (value as { toArray?: unknown }).toArray === 'function') {
      return (value as unknown as { toArray(): unknown[] }).toArray().join(',');
    }
    if (Array.isArray(value)) return value.map((item) => (item && typeof item === 'object' ? objectId(item, ids) : String(item))).join(',');
    return (value as { uuid?: string }).uuid ?? `#${objectId(value as object, ids)}`;
  }).join('|');
}

let objectIds = 0;
function objectId(value: object, ids: WeakMap<object, number>): number {
  let found = ids.get(value);
  if (found === undefined) {
    found = ++objectIds;
    ids.set(value, found);
  }
  return found;
}

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

function attributeBytes(attribute: Attribute): Uint8Array {
  const array = (attribute as THREE.BufferAttribute).array as ArrayLike<number> & ArrayBufferView;
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/** FNV-1a over a geometry's layout and bytes; equal geometries always hash equal. */
export function geometryHash(geometry: THREE.BufferGeometry): string {
  let h = 0x811c9dc5;
  const mixBytes = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  };
  const names = Object.keys(geometry.attributes).sort();
  let layout = `${names.join(',')}|${geometry.index?.count ?? -1}|${geometry.drawRange.start}:${geometry.drawRange.count}|`;
  layout += geometry.groups.map((g) => `${g.start}:${g.count}:${g.materialIndex}`).join(',');
  for (const name of names) {
    const attribute = geometry.attributes[name] as Attribute;
    if ((attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return `uuid:${geometry.uuid}`;
    layout += `|${name}:${attribute.itemSize}:${attribute.count}:${attribute.normalized}:${(attribute as THREE.BufferAttribute).array.constructor.name}`;
    mixBytes(attributeBytes(attribute));
  }
  if (geometry.index) {
    layout += `|index:${geometry.index.array.constructor.name}`;
    mixBytes(attributeBytes(geometry.index));
  }
  return `${layout}#${h.toString(16)}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Byte-for-byte equality of two geometries' attributes, index, draw range and groups. */
export function sameGeometry(a: THREE.BufferGeometry, b: THREE.BufferGeometry): boolean {
  if (a === b) return true;
  const names = Object.keys(a.attributes);
  if (names.length !== Object.keys(b.attributes).length) return false;
  for (const name of names) {
    const x = a.attributes[name] as THREE.BufferAttribute, y = b.attributes[name] as THREE.BufferAttribute | undefined;
    if (!y || (x as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
      || (y as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return false;
    if (x.itemSize !== y.itemSize || x.count !== y.count || x.normalized !== y.normalized
      || x.array.constructor !== y.array.constructor || !bytesEqual(attributeBytes(x), attributeBytes(y))) return false;
  }
  if (!!a.index !== !!b.index) return false;
  if (a.index && b.index && (a.index.array.constructor !== b.index.array.constructor
    || !bytesEqual(attributeBytes(a.index), attributeBytes(b.index)))) return false;
  return a.drawRange.start === b.drawRange.start && a.drawRange.count === b.drawRange.count
    && JSON.stringify(a.groups) === JSON.stringify(b.groups);
}

/** Cheap shape key: geometries that differ here can never be byte-identical. */
const roughShape = (geometry: THREE.BufferGeometry) =>
  `${geometry.getAttribute('position').count}|${geometry.index?.count ?? -1}|${Object.keys(geometry.attributes).length}`;

export class RenderBatcher {
  /** Batches live here, outside the rig, so exports and framing never see them. */
  readonly group = new THREE.Group();
  private batches: Batch[] = [];
  private root: THREE.Object3D | null = null;
  private enabled = true;
  private previousHook: THREE.Scene['onBeforeRender'];

  constructor(private scene: THREE.Scene, private minGroup = 2) {
    this.group.name = 'Render batches';
    this.group.matrixAutoUpdate = false;
    this.group.userData.renderBatches = true;
    scene.add(this.group);
    this.previousHook = scene.onBeforeRender;
    scene.onBeforeRender = (...args) => {
      this.previousHook.apply(scene, args);
      this.sync();
    };
  }

  /** Batch every eligible repeated part under `root` (call after the rig is built). Never throws. */
  rebuild(root: THREE.Object3D) {
    this.clear();
    this.root = root;
    if (!this.enabled) return;
    try {
      this.build(root);
    } catch (error) {
      // Batching is only an optimisation: draw the rig part by part rather than fail the rebuild.
      this.clear();
      console.warn('[StageForge] Render batching skipped:', error);
    }
  }

  private build(root: THREE.Object3D) {
    root.updateWorldMatrix(true, true);
    const ids = new WeakMap<object, number>();

    // Candidates with their material key; mirrored parts flip winding, which a shared instanced draw
    // cannot do per instance, so they keep their own draw.
    const candidates: Array<{ mesh: THREE.Mesh; materialKey: string; lamp: LampSettings | null }> = [];
    root.traverse((node) => {
      if (!isBatchable(node) || node.matrixWorld.determinant() < 0) return;
      const material = node.material as THREE.Material;
      const lamp = isLamp(material) ? snapshotLamp(material) : null;
      candidates.push({ mesh: node, lamp, materialKey: lamp ? `lamp:${lampKey(lamp, ids)}` : material.uuid });
    });

    // Only geometries that could share a batch (same material key and rough shape) are hashed.
    const roughCounts = new Map<string, number>();
    for (const c of candidates) {
      const key = `${c.materialKey}|${roughShape(c.mesh.geometry)}`;
      roughCounts.set(key, (roughCounts.get(key) ?? 0) + 1);
    }
    const byHash = new Map<string, THREE.BufferGeometry[]>();
    const canonical = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    const canonicalOf = (geometry: THREE.BufferGeometry) => {
      let found = canonical.get(geometry);
      if (found) return found;
      const hash = geometryHash(geometry);
      const list = byHash.get(hash) ?? [];
      found = list.find((candidate) => sameGeometry(candidate, geometry));
      if (!found) {
        found = geometry;
        list.push(geometry);
        byHash.set(hash, list);
      }
      canonical.set(geometry, found);
      return found;
    };

    const groups = new Map<string, { geometry: THREE.BufferGeometry; sources: THREE.Mesh[]; lamp: LampSettings | null }>();
    for (const { mesh, materialKey, lamp } of candidates) {
      if ((roughCounts.get(`${materialKey}|${roughShape(mesh.geometry)}`) ?? 0) < this.minGroup) continue;
      const geometry = canonicalOf(mesh.geometry);
      const key = `${geometry.uuid}|${materialKey}`;
      const entry = groups.get(key);
      if (entry) entry.sources.push(mesh);
      else groups.set(key, { geometry, sources: [mesh], lamp });
    }

    for (const { geometry, sources, lamp } of groups.values()) {
      if (sources.length < this.minGroup) continue;
      let material = sources[0].material as THREE.Material;
      if (lamp) {
        material = material.clone();
        (material as THREE.MeshBasicMaterial).color.setRGB(1, 1, 1);
      }
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const mesh = new THREE.InstancedMesh(geometry, material, sources.length);
      mesh.name = `Batch: ${sources[0].name || sources[0].geometry.type}`;
      mesh.userData.renderBatch = true;
      mesh.matrixAutoUpdate = false;
      mesh.boundingSphere = new THREE.Sphere();
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (lamp) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(sources.length * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      for (const source of sources) source.layers.set(BATCH_HIDDEN_LAYER);
      this.batches.push({
        mesh, sources, lampSettings: lamp,
        localSphere: geometry.boundingSphere!.clone(),
        geometries: sources.map((source) => source.geometry),
        materials: sources.map((source) => source.material as THREE.Material),
        released: sources.map(() => false),
      });
      this.group.add(mesh);
    }
    this.sync();
  }

  /**
   * Copy each original's world matrix (zero scale while hidden or detached) and, for lamps, its colour,
   * and fit the batch's culling sphere around the instances that are shown.
   */
  sync() {
    const root = this.root;
    for (const batch of this.batches) {
      const { mesh, sources, released, geometries, materials, lampSettings, localSphere } = batch;
      const matrices = mesh.instanceMatrix.array as Float32Array;
      const colors = mesh.instanceColor?.array as Float32Array | undefined;
      const { x: cx, y: cy, z: cz } = localSphere.center;
      let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, reach = 0;
      let matricesChanged = false, colorsChanged = false, anyShown = false;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const material = source.material as THREE.Material;
        if (!released[i] && (source.geometry !== geometries[i] || material !== materials[i]
          || source.layers.mask !== HIDDEN_MASK || source.renderOrder !== 0 || material.transparent
          || source.matrixWorld.determinant() < 0
          || (lampSettings !== null && !lampMatches(material, lampSettings)))) {
          // Something restyled, reordered or mirrored this part: draw it normally from now on.
          released[i] = true;
          if (source.layers.mask === HIDDEN_MASK) source.layers.set(0);
        }
        let shown = !released[i] && material.visible;
        let node: THREE.Object3D | null = source;
        while (shown && node && node !== root) {
          if (!node.visible) shown = false;
          node = node.parent;
        }
        if (node !== root) shown = false;
        const e = shown ? source.matrixWorld.elements : ZERO_SCALE;
        // Instance buffers are float32: compare rounded values so an unchanged part never re-uploads.
        const offset = i * 16;
        for (let k = 0; k < 16; k++) {
          const value = Math.fround(e[k]);
          if (matrices[offset + k] !== value) {
            matrices[offset + k] = value;
            matricesChanged = true;
          }
        }
        if (!shown) continue;
        anyShown = true;
        const x = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
        const y = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
        const z = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
        const scale = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
          e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
        reach = Math.max(reach, localSphere.radius * scale);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        if (colors) {
          const color = (material as THREE.MeshBasicMaterial).color;
          const c = i * 3;
          const red = Math.fround(color.r), green = Math.fround(color.g), blue = Math.fround(color.b);
          if (colors[c] !== red || colors[c + 1] !== green || colors[c + 2] !== blue) {
            colors[c] = red; colors[c + 1] = green; colors[c + 2] = blue;
            colorsChanged = true;
          }
        }
      }
      // Cull the batch as a whole: skip it when nothing is shown, else bound every shown instance.
      mesh.visible = anyShown;
      if (anyShown && mesh.boundingSphere) {
        mesh.boundingSphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        mesh.boundingSphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + reach;
      }
      if (matricesChanged) mesh.instanceMatrix.needsUpdate = true;
      if (colorsChanged && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Return every original to normal rendering and free instance buffers and lamp material copies. */
  clear() {
    for (const { mesh, sources, released, lampSettings } of this.batches) {
      sources.forEach((source, i) => {
        if (!released[i] && source.layers.mask === HIDDEN_MASK) source.layers.set(0);
      });
      mesh.removeFromParent();
      mesh.dispose();
      if (lampSettings) (mesh.material as THREE.Material).dispose();
    }
    this.batches = [];
  }

  /** Turn batching off (originals render one by one) or back on for the last root. */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.clear();
    else if (this.root) this.rebuild(this.root);
  }

  stats(): BatcherStats {
    let instances = 0, released = 0;
    for (const batch of this.batches) {
      instances += batch.sources.length;
      released += batch.released.filter(Boolean).length;
    }
    return { batches: this.batches.length, instances, released };
  }

  dispose() {
    this.clear();
    this.root = null;
    this.scene.onBeforeRender = this.previousHook;
    this.group.removeFromParent();
  }
}
