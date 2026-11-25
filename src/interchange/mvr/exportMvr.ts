import {
  normalizeInterchange,
  type MvrFixtureSpec,
  type MvrPassthrough,
  type NativeStage,
  type ShowInterchange,
} from '../../data/showFile';
import type { PlanPoint, RigConfig, TrussPodConfig } from '../../types/show';
import { getPlatforms, stageSurfaceHeight } from '../../data/stageDesign';
import { resolveStudioGeometry } from '../../data/studioGeometry';
import { effectiveHangs, planWalls } from '../../data/stagePlan';
import { placeFixtures, type FixturePlacement } from '../../data/fixturePlacement';
import { focusMarks } from '../../engine/focusAim';
import { isRootName, writeArchive, utf8, type ArchiveEntry } from './archive';
import { IDENTITY, matrixText, poseMatrix, toMvrPoint, type MvrMatrix } from './coords';
import { MODE_NAME, profileArchive, profileFor, PROFILES } from './gdtf';
import { boxGlb } from './glb';
import { uuidV5 } from './uuid';
import { attr, buildXml, child, list, parseXml, text, type XmlNode } from './xml';

/**
 * Lossless re-import: the full StageForge rig, stage and interchange metadata travel as an extra
 * root file in the archive, flagged by an empty provider marker in UserData. (MVR 1.6's XSD gives
 * UserData/Data an empty content model, so keeping the payload out of the XML keeps the scene
 * strictly valid.)
 */
export const PAYLOAD_PROVIDER = 'StageForge';
export const PAYLOAD_FILE = 'StageForge_show.json';

export interface MvrPayload {
  format: 'stageforge-mvr';
  version: 1;
  rig: RigConfig;
  stage?: NativeStage;
  interchange?: ShowInterchange;
}

export interface MvrExportResult {
  bytes: Uint8Array;
  interchange: ShowInterchange;
  notes: string[];
}

export const UUID_CANONICAL = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** StageForge's deterministic object UUID for a key, upper case as MVR files write it. */
export const stageforgeUuid = (name: string) => uuidV5(name).toUpperCase();

/** Resolve an object's persisted MVR UUID from interchange metadata, falling back to deterministic v5. */
export function resolveUuid(key: string, interchange?: ShowInterchange): string {
  const stored = interchange?.mvr?.uuids?.[key];
  return stored && UUID_CANONICAL.test(stored) ? stored : stageforgeUuid(key);
}

/** UUID key of a fixture unit; JSON keeps IDs containing ':' from colliding. */
export const fixtureKey = (unit: Pick<FixturePlacement, 'podId' | 'group' | 'index'>) =>
  'fixture:' + JSON.stringify(unit.podId !== undefined ? ['pod', unit.podId, unit.group.id, unit.index] : ['floor', unit.group.id, unit.index]);

export interface ExportedFixtureNumbers {
  fixtureId: string;
  fixtureIdNumeric: number;
  unitNumber: number;
  customId: string;
}

/** Sequential console fixture numbering written by MVR export, shared with import preflight. */
export function fixtureNumbers(rig: RigConfig): Map<string, ExportedFixtureNumbers> {
  const out = new Map<string, ExportedFixtureNumbers>();
  placeFixtures(rig).forEach((unit, n) => {
    const id = String(n + 1);
    out.set(fixtureKey(unit), {
      fixtureId: id,
      fixtureIdNumeric: n + 1,
      unitNumber: unit.index + 1,
      customId: id,
    });
  });
  return out;
}

/** MVR 1.6 XSD child-element sequence order for <Fixture>. */
export const FIXTURE_XSD_ORDER = [
  'Matrix', 'Classing', 'GDTFSpec', 'GDTFMode',
  'Focus', 'CastShadow', 'DMXInvertPan', 'DMXInvertTilt', 'Position', 'Function', 'ChildPosition',
  'FixtureID', 'FixtureIDNumeric', 'UnitNumber', 'Container',
  'Addresses', 'CIEColor', 'Color', 'FixtureTypeId', 'CustomIdType', 'CustomId',
  'Overwrites', 'Connections', 'Mappings', 'Gobo', 'ChildList', 'CustomCommands', 'Protocols', 'Alignments',
] as const;

/** XSD-valid optional <Fixture> child elements preserved via objectExtras (never ChildList or StageForge-owned fields). */
export const FIXTURE_EXTRA_TAGS = new Set<string>([
  'Focus', 'CastShadow', 'DMXInvertPan', 'DMXInvertTilt', 'Position', 'Function', 'ChildPosition',
  'Container', 'CIEColor', 'Color', 'FixtureTypeId',
  'Overwrites', 'Connections', 'Mappings', 'Gobo', 'CustomCommands', 'Protocols', 'Alignments',
]);

const AUX_ALLOWED_TAGS = new Set(['Symdef', 'Position', 'MappingDefinition', 'Class']);
const SCENE_NODE_ALLOWED_TAGS = new Set([
  'Support', 'Projector', 'FocusPoint', 'GroupObject', 'Fixture', 'Truss', 'VideoScreen', 'SceneObject',
]);
const FRAGMENT_LIMITS = { maxBytes: 262_144 * 4, maxDepth: 32, maxElements: 10_000 };
const GENERIC_GDTF_FILES = new Set(Object.values(PROFILES).map((p) => p.file.toLowerCase()));

const RAD_TO_DEG = 180 / Math.PI;
const mm = (n: number) => Math.round(n * 1000);

const CLASSES = ['Lighting', 'Rigging', 'Video', 'Audio', 'Staging', 'Scenery', 'Focus'] as const;
type ClassName = (typeof CLASSES)[number];
const classUuid = (name: ClassName) => stageforgeUuid(`class:${name}`);

/** Object fields in the XSD's sequence order for Truss, VideoScreen and SceneObject. */
function placed(name: string, uuid: string, matrix: MvrMatrix, cls: ClassName, geometries: XmlNode, fixtureId = '', numeric = 0): XmlNode {
  return {
    '@_uuid': uuid, '@_name': name,
    Matrix: matrixText(matrix),
    Classing: classUuid(cls),
    Geometries: geometries,
    FixtureID: fixtureId,
    FixtureIDNumeric: String(numeric),
  };
}

/** Straight spans of a truss in its local plan frame (rings become 16 chords). */
function spans(pod: TrussPodConfig): Array<[PlanPoint, PlanPoint]> {
  const r = pod.width / 2;
  const points: PlanPoint[] = pod.shape === 'path' ? pod.path ?? []
    : pod.shape === 'circle' ? Array.from({ length: 17 }, (_, i) => ({ x: r * Math.cos((i / 16) * 2 * Math.PI), z: r * Math.sin((i / 16) * 2 * Math.PI) }))
    : pod.shape === 'chevron' ? [{ x: -r, z: -r * Math.tan(0.36) }, { x: 0, z: 0 }, { x: r, z: -r * Math.tan(0.36) }]
    : [{ x: -r, z: 0 }, { x: r, z: 0 }];
  const out: Array<[PlanPoint, PlanPoint]> = [];
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z) > 0.001) out.push([points[i - 1], points[i]]);
  }
  return out;
}

/** Parse a single-root XML fragment into { tag, value } if valid and within tight fragment bounds. */
function parseSingleFragment(fragment: string): { tag: string; value: unknown } | undefined {
  let doc: XmlNode;
  try {
    doc = parseXml(fragment, FRAGMENT_LIMITS);
  } catch {
    return undefined;
  }
  const keys = Object.keys(doc);
  if (keys.length !== 1) return undefined;
  const tag = keys[0];
  const raw = doc[tag];
  if (Array.isArray(raw)) {
    if (raw.length !== 1) return undefined;
    return { tag, value: raw[0] };
  }
  return { tag, value: raw };
}

/**
 * Remap any `@_uuid` inside a parsed passthrough node tree that collides with `usedUuids`
 * so the node (and any GroupObject siblings/children) is preserved with unique UUIDs.
 */
function remapCollidingUuids(
  node: unknown,
  usedUuids: Set<string>,
  onRemap: () => void,
  depth = 0,
): void {
  if (!node || typeof node !== 'object' || depth > 32) return;
  if (Array.isArray(node)) {
    for (const item of node) remapCollidingUuids(item, usedUuids, onRemap, depth + 1);
    return;
  }
  const record = node as XmlNode;
  const u = attr(record, 'uuid')?.toUpperCase();
  if (u) {
    if (usedUuids.has(u)) {
      let seq = 1;
      let next = stageforgeUuid(`passthrough-remap:${u}:${seq}`);
      while (usedUuids.has(next)) next = stageforgeUuid(`passthrough-remap:${u}:${++seq}`);
      record['@_uuid'] = next;
      usedUuids.add(next);
      onRemap();
    } else {
      usedUuids.add(u);
    }
  }
  for (const [k, v] of Object.entries(record)) {
    if (!k.startsWith('@_') && v && typeof v === 'object') remapCollidingUuids(v, usedUuids, onRemap, depth + 1);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Copy archive resources referenced by a passthrough node (Geometry3D/@fileName, GDTFSpec) when
 * available in `bundleResource`. Removes unbundled Geometry3D references and falls back dangling
 * passthrough Fixture GDTFSpecs to a bundled generic profile so the archive stays self-consistent.
 */
function reconcilePassthroughResources(
  node: unknown,
  bundleResource: (fileName: string) => string | undefined,
  fallbackGdtf: () => { spec: string; mode: string },
  onMissing: () => void,
  depth = 0,
): void {
  if (!node || typeof node !== 'object' || depth > 32) return;
  if (Array.isArray(node)) {
    for (const item of node) reconcilePassthroughResources(item, bundleResource, fallbackGdtf, onMissing, depth + 1);
    return;
  }
  const record = node as XmlNode;
  if (record.Geometry3D !== undefined) {
    const rawGeo3d = record.Geometry3D;
    const items = Array.isArray(rawGeo3d) ? rawGeo3d : [rawGeo3d];
    const kept: unknown[] = [];
    for (const geo of items) {
      const ref = attr(geo, 'fileName');
      if (!ref) {
        kept.push(geo);
        continue;
      }
      const bundled = bundleResource(ref);
      if (bundled) {
        (geo as XmlNode)['@_fileName'] = bundled;
        kept.push(geo);
      } else {
        onMissing();
      }
    }
    if (kept.length) record.Geometry3D = kept;
    else delete record.Geometry3D;
  }
  const spec = text(record, 'GDTFSpec');
  if (spec) {
    const bundled = bundleResource(spec) ?? bundleResource(`${spec}.gdtf`);
    if (bundled) {
      record.GDTFSpec = bundled;
    } else {
      const fb = fallbackGdtf();
      record.GDTFSpec = fb.spec;
      if (Object.hasOwn(record, 'GDTFMode')) record.GDTFMode = fb.mode;
      onMissing();
    }
  }
  for (const [k, v] of Object.entries(record)) {
    if (!k.startsWith('@_') && k !== 'Geometry3D' && v && typeof v === 'object') {
      reconcilePassthroughResources(v, bundleResource, fallbackGdtf, onMissing, depth + 1);
    }
  }
}

/** Export a StageForge rig to MVR 1.6 and return the bytes alongside persisted interchange metadata. */
export function exportMvrDocument(
  sourceRig: RigConfig,
  stage?: NativeStage,
  providerVersion = '1',
  interchange?: ShowInterchange,
  resources?: ReadonlyMap<string, Uint8Array>,
): MvrExportResult {
  const { rig, props: layoutProps } = resolveStudioGeometry(sourceRig, stage?.layout);
  const files = new Map<string, Uint8Array>();
  const filesLower = new Map<string, string>();
  const addFile = (name: string, data: Uint8Array): string => {
    const lower = name.toLowerCase();
    const existing = filesLower.get(lower);
    if (existing) return existing;
    files.set(name, data);
    filesLower.set(lower, name);
    return name;
  };
  const glb = (name: string, make: () => Uint8Array) => {
    const lower = name.toLowerCase();
    if (!filesLower.has(lower)) addFile(name, make());
    return { Geometry3D: [{ '@_fileName': filesLower.get(lower)! }] };
  };

  const resourceIndex = new Map<string, { name: string; data: Uint8Array }>();
  if (resources) {
    for (const [resName, data] of resources) {
      const base = resName.split(/[\\/]/).pop() ?? '';
      if (!isRootName(base)) continue;
      const lower = base.toLowerCase();
      if (lower === 'generalscenedescription.xml' || lower === PAYLOAD_FILE.toLowerCase()) continue;
      if (!resourceIndex.has(lower)) resourceIndex.set(lower, { name: base, data });
    }
  }
  const bundleResource = (fileName: string): string | undefined => {
    const base = fileName.trim().split(/[\\/]/).pop() ?? '';
    if (!base) return undefined;
    const hit = resourceIndex.get(base.toLowerCase());
    if (!hit) return undefined;
    const hitLower = hit.name.toLowerCase();
    const existingName = filesLower.get(hitLower);
    const reservedGeneric = GENERIC_GDTF_FILES.has(hitLower);
    if (!existingName && !reservedGeneric) return addFile(hit.name, hit.data);
    if (existingName && sameBytes(files.get(existingName)!, hit.data)) return existingName;
    // Collision with a StageForge-generated file or reserved generic profile name: store under a unique prefix.
    let seq = 1;
    let renamed = `res-${seq}-${hit.name}`;
    while (filesLower.has(renamed.toLowerCase())) {
      if (sameBytes(files.get(filesLower.get(renamed.toLowerCase())!)!, hit.data)) return filesLower.get(renamed.toLowerCase())!;
      renamed = `res-${++seq}-${hit.name}`;
    }
    return addFile(renamed, hit.data);
  };

  const notes: string[] = [];
  const emittedUuids: Record<string, string> = {};
  const usedUuids = new Set<string>();
  const claimUuid = (key: string): string => {
    let candidate = resolveUuid(key, interchange);
    if (usedUuids.has(candidate)) candidate = stageforgeUuid(key);
    while (usedUuids.has(candidate)) candidate = stageforgeUuid(`${key}#${usedUuids.size}`);
    usedUuids.add(candidate);
    emittedUuids[key] = candidate;
    return candidate;
  };

  const layerUuid = claimUuid('layer:stageforge');
  const syntheticPods = new Set(interchange?.mvr?.synthetic ?? []);
  const keptSynthetic: string[] = [];
  const keptSpecs: Record<string, MvrFixtureSpec> = {};
  const keptObjectExtras: Record<string, string[]> = {};

  type SceneBucket = 'FocusPoint' | 'SceneObject' | 'Truss' | 'VideoScreen' | 'Fixture' | 'Support' | 'Projector' | 'GroupObject';
  const children: Record<SceneBucket, XmlNode[]> = {
    FocusPoint: [], SceneObject: [], Truss: [], VideoScreen: [], Fixture: [], Support: [], Projector: [], GroupObject: [],
  };

  for (const mark of focusMarks(rig)) {
    children.FocusPoint.push({
      '@_uuid': claimUuid(`focus:${mark.id}`), '@_name': mark.name,
      Matrix: matrixText(poseMatrix({ x: mark.x, y: mark.y, z: mark.z }, 0)),
      Classing: classUuid('Focus'),
      Geometries: '',
    });
  }

  for (const deck of getPlatforms(rig)) {
    const file = `deck-${mm(deck.width)}x${mm(deck.depth)}x${mm(deck.height)}.glb`;
    children.SceneObject.push(placed(deck.name, claimUuid(`deck:${deck.id}`), poseMatrix({ x: deck.x, y: 0, z: deck.z }, 0), 'Staging',
      glb(file, () => boxGlb(deck.width, deck.height, deck.depth, { base: true, color: [0.17, 0.32, 0.3] }))));
  }

  for (const prop of rig.props ?? []) {
    const size = 1.5 * prop.scale, tall = 2.2 * prop.scale;
    const file = `scenery-${prop.kind}-${mm(size)}.glb`;
    const y = stageSurfaceHeight(rig, prop.x, prop.z);
    children.SceneObject.push(placed(`Scenery ${prop.kind}`, claimUuid(`scenery:${prop.id}`), poseMatrix({ x: prop.x, y, z: prop.z }, prop.rotation), 'Scenery',
      glb(file, () => boxGlb(size, tall, size, { base: true, color: [0.6, 0.5, 0.75] }))));
  }
  layoutProps.forEach((prop, i) => {
    const file = `prop-${prop.type}-${mm(prop.height)}.glb`;
    const y = stageSurfaceHeight(rig, prop.x, prop.z);
    children.SceneObject.push(placed(`${prop.type === 'inflatable' ? 'Inflatable' : 'Scenic'} prop ${i + 1}`, claimUuid(`prop:${i}`),
      poseMatrix({ x: prop.x, y, z: prop.z }, 0), 'Scenery',
      glb(file, () => boxGlb(1, prop.height, 1, { base: true, color: [0.76, 0.6, 0.92] }))));
  });

  for (const [i, hang] of effectiveHangs(sourceRig, stage).hangs.entries()) {
    const height = hang.count * 0.42;
    const file = `pa-hang-${hang.count}.glb`;
    // The array hangs from its pick point; tilt and splay travel in the StageForge payload.
    children.SceneObject.push(placed(`PA hang ${i + 1} (${hang.count} boxes)`, claimUuid(`hang:${i}`),
      poseMatrix({ x: hang.x, y: hang.y - height / 2, z: hang.z }, hang.yaw), 'Audio',
      glb(file, () => boxGlb(1.34, height, 0.7, { color: [0.12, 0.12, 0.13] }))));
  }

  for (const pod of rig.trussPods) {
    if (syntheticPods.has(pod.id)) {
      keptSynthetic.push(pod.id);
      continue;
    }
    const pieces = spans(pod).map(([a, b]) => {
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const centre = toMvrPoint({ x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 });
      const local: MvrMatrix = { ...poseMatrix({ x: 0, y: 0, z: 0 }, -Math.atan2(b.z - a.z, b.x - a.x) * RAD_TO_DEG), o: centre };
      const file = `truss-${mm(length)}.glb`;
      if (!filesLower.has(file.toLowerCase())) addFile(file, boxGlb(length, 0.3, 0.3, { color: [0.75, 0.77, 0.8] }));
      return { '@_fileName': filesLower.get(file.toLowerCase())!, Matrix: matrixText(local) };
    });
    children.Truss.push(placed(pod.name, claimUuid(`truss:${pod.id}`), poseMatrix({ x: pod.x, y: pod.baseY, z: pod.z }, pod.rotationY * RAD_TO_DEG),
      'Rigging', { Geometry3D: pieces }));
  }

  for (const { wall, frame, primary } of planWalls(rig, stage)) {
    const file = `screen-${mm(frame.width)}x${mm(frame.height)}.glb`;
    children.VideoScreen.push(placed(wall.label ?? (primary ? 'Main LED wall' : wall.id), claimUuid(`wall:${wall.id}`),
      poseMatrix({ x: frame.x, y: frame.y, z: frame.z }, frame.yaw), 'Video',
      glb(file, () => boxGlb(frame.width, frame.height, 0.12, { color: [0.05, 0.08, 0.12] }))));
  }

  const usedGeneric = new Set<string>();
  let droppedFragments = 0;
  let missingResourceCount = 0;

  const exportedNumbers = fixtureNumbers(rig);
  placeFixtures(rig).forEach((unit, n) => {
    const key = fixtureKey(unit);
    const fixtureUuid = claimUuid(key);
    const numbers = exportedNumbers.get(key) ?? {
      fixtureId: String(n + 1),
      fixtureIdNumeric: n + 1,
      unitNumber: unit.index + 1,
      customId: String(n + 1),
    };
    const specPref = interchange?.mvr?.fixtureSpecs?.[key];
    let gdtfSpec: string;
    let gdtfMode: string;
    const bundledSpec = specPref ? (bundleResource(specPref.spec) ?? bundleResource(`${specPref.spec}.gdtf`)) : undefined;
    if (specPref && bundledSpec) {
      gdtfSpec = bundledSpec;
      gdtfMode = specPref.mode || MODE_NAME;
      keptSpecs[key] = { spec: bundledSpec, mode: gdtfMode };
    } else {
      const profile = profileFor(unit.group.type);
      usedGeneric.add(unit.group.type);
      gdtfSpec = profile.file;
      gdtfMode = MODE_NAME;
      if (specPref) {
        keptSpecs[key] = specPref;
        missingResourceCount++;
      }
    }

    const baseFields: Record<string, unknown> = {
      Matrix: matrixText(poseMatrix(unit.position, unit.yaw * RAD_TO_DEG, unit.floor)),
      Classing: classUuid('Lighting'),
      GDTFSpec: gdtfSpec,
      GDTFMode: gdtfMode,
      FixtureID: numbers.fixtureId,
      FixtureIDNumeric: String(numbers.fixtureIdNumeric),
      UnitNumber: String(numbers.unitNumber),
      ...(unit.patched ? { Addresses: { Address: [{ '@_break': '0', '#text': String((unit.universe - 1) * 512 + unit.address) }] } } : {}),
      CustomIdType: '1',
      CustomId: numbers.customId,
    };

    const extraFragments = interchange?.mvr?.passthrough?.objectExtras?.[key];
    const extraFields: Record<string, unknown> = {};
    if (extraFragments?.length) {
      const validExtras: string[] = [];
      for (const fragment of extraFragments) {
        const parsed = parseSingleFragment(fragment);
        if (!parsed || !FIXTURE_EXTRA_TAGS.has(parsed.tag)) {
          droppedFragments++;
          continue;
        }
        extraFields[parsed.tag] = parsed.value;
        validExtras.push(fragment);
      }
      if (validExtras.length) keptObjectExtras[key] = validExtras;
    }

    // Emit fixture children in strict MVR 1.6 XSD sequence order.
    const fixtureNode: XmlNode = {
      '@_uuid': fixtureUuid,
      '@_name': `${unit.group.modelName} ${unit.index + 1}`,
    };
    for (const tag of FIXTURE_XSD_ORDER) {
      if (Object.hasOwn(baseFields, tag)) fixtureNode[tag] = baseFields[tag];
      else if (Object.hasOwn(extraFields, tag)) fixtureNode[tag] = extraFields[tag];
    }
    children.Fixture.push(fixtureNode);
  });

  const ensureGenericFallback = () => {
    usedGeneric.add('blinder');
    return { spec: profileFor('blinder').file, mode: MODE_NAME };
  };

  // Merge validated passthrough UserData, AUXData and SceneNodes.
  const userDataEntries: XmlNode[] = [{ '@_provider': PAYLOAD_PROVIDER, '@_ver': '1' }];
  const keptUserData: string[] = [];
  for (const fragment of interchange?.mvr?.passthrough?.userData ?? []) {
    const parsed = parseSingleFragment(fragment);
    if (!parsed || parsed.tag !== 'Data' || !parsed.value || typeof parsed.value !== 'object') {
      droppedFragments++;
      continue;
    }
    const provider = attr(parsed.value, 'provider');
    if (provider?.toLowerCase() === PAYLOAD_PROVIDER.toLowerCase()) {
      droppedFragments++;
      continue;
    }
    userDataEntries.push(parsed.value as XmlNode);
    keptUserData.push(fragment);
  }

  const usedClassUuids = new Set<string>(CLASSES.map(classUuid));
  const auxData: Record<string, XmlNode[]> = {
    Class: CLASSES.map((name) => ({ '@_uuid': classUuid(name), '@_name': name })),
  };
  const keptAuxData: string[] = [];
  for (const fragment of interchange?.mvr?.passthrough?.auxData ?? []) {
    const parsed = parseSingleFragment(fragment);
    if (!parsed || !AUX_ALLOWED_TAGS.has(parsed.tag) || !parsed.value || typeof parsed.value !== 'object') {
      droppedFragments++;
      continue;
    }
    const node = parsed.value as XmlNode;
    if (parsed.tag === 'Class') {
      const u = attr(node, 'uuid')?.toUpperCase();
      if (u && usedClassUuids.has(u)) continue;
      if (u) usedClassUuids.add(u);
    }
    reconcilePassthroughResources(node, bundleResource, ensureGenericFallback, () => { missingResourceCount++; });
    if (!auxData[parsed.tag]) auxData[parsed.tag] = [];
    auxData[parsed.tag].push(node);
    keptAuxData.push(fragment);
  }

  const keptSceneNodes: string[] = [];
  let remappedUuids = 0;
  for (const fragment of interchange?.mvr?.passthrough?.sceneNodes ?? []) {
    const parsed = parseSingleFragment(fragment);
    if (!parsed || !SCENE_NODE_ALLOWED_TAGS.has(parsed.tag) || !parsed.value || typeof parsed.value !== 'object') {
      droppedFragments++;
      continue;
    }
    const node = parsed.value as XmlNode;
    remapCollidingUuids(node, usedUuids, () => { remappedUuids++; });
    reconcilePassthroughResources(node, bundleResource, ensureGenericFallback, () => { missingResourceCount++; });
    children[parsed.tag as SceneBucket].push(node);
    keptSceneNodes.push(fragment);
  }

  for (const type of usedGeneric) {
    const profile = profileFor(type as Parameters<typeof profileFor>[0]);
    const data = profileArchive(profile);
    const existing = filesLower.get(profile.file.toLowerCase());
    if (!existing) {
      addFile(profile.file, data);
    } else if (!sameBytes(files.get(existing)!, data)) {
      // Never let an earlier foreign resource overwrite a StageForge generic profile.
      files.set(existing, data);
    }
  }

  if (droppedFragments) notes.push(`Skipped ${droppedFragments} invalid passthrough XML ${droppedFragments === 1 ? 'fragment' : 'fragments'}.`);
  if (remappedUuids) notes.push(`Remapped ${remappedUuids} colliding passthrough ${remappedUuids === 1 ? 'UUID' : 'UUIDs'}.`);
  if (missingResourceCount) notes.push(`${missingResourceCount} passthrough resource ${missingResourceCount === 1 ? 'file was' : 'files were'} not available in this session.`);

  const passthrough: MvrPassthrough = {};
  if (keptUserData.length) passthrough.userData = keptUserData;
  if (keptAuxData.length) passthrough.auxData = keptAuxData;
  if (keptSceneNodes.length) passthrough.sceneNodes = keptSceneNodes;
  if (Object.keys(keptObjectExtras).length) passthrough.objectExtras = keptObjectExtras;

  const nextInterchange = normalizeInterchange({
    mvr: {
      uuids: emittedUuids,
      ...(keptSynthetic.length ? { synthetic: keptSynthetic } : {}),
      ...(Object.keys(keptSpecs).length ? { fixtureSpecs: keptSpecs } : {}),
      ...(Object.keys(passthrough).length ? { passthrough } : {}),
    },
  }) ?? { mvr: { uuids: emittedUuids } };

  const payload: MvrPayload = {
    format: 'stageforge-mvr',
    version: 1,
    rig: sourceRig,
    ...(stage ? { stage } : {}),
    interchange: nextInterchange,
  };
  const xml = buildXml({
    GeneralSceneDescription: {
      '@_verMajor': '1', '@_verMinor': '6', '@_provider': 'StageForge', '@_providerVersion': providerVersion,
      UserData: { Data: userDataEntries },
      Scene: {
        AUXData: auxData,
        Layers: { Layer: [{ '@_uuid': layerUuid, '@_name': sourceRig.name || 'StageForge',
          Matrix: matrixText(IDENTITY), ChildList: children }] },
      },
    },
  });
  const entries: ArchiveEntry[] = [
    { name: 'GeneralSceneDescription.xml', data: utf8.encode(xml) },
    { name: PAYLOAD_FILE, data: utf8.encode(JSON.stringify(payload)) },
  ];
  for (const [name, data] of files) entries.push({ name, data });
  return { bytes: writeArchive(entries), interchange: nextInterchange, notes };
}

export function exportMvr(
  sourceRig: RigConfig,
  stage?: NativeStage,
  providerVersion = '1',
  interchange?: ShowInterchange,
  resources?: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  return exportMvrDocument(sourceRig, stage, providerVersion, interchange, resources).bytes;
}
