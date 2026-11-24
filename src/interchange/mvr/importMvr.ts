import {
  MAX_PASSTHROUGH_BYTES,
  normalizeInterchange,
  parseInterchange,
  type MvrFixtureSpec,
  type MvrPassthrough,
  type NativeStage,
  type ShowInterchange,
} from '../../data/showFile';
import type { FloorFxUnit, MountedFixtureGroup, RigConfig, TrussPodConfig } from '../../types/show';
import { createBlankDesign } from '../../data/stageDesign';
import { parseRigJson } from '../../data/rigImport';
import { allocateDmx } from '../../data/dmxPatch';
import { finalizeStage, MAX_LAYOUT_ITEMS, setLayoutProps } from '../../data/stagePlan';
import { MAX_STAGE_WALLS, upsertStageWall, type LayoutProp } from '../../data/studioGeometry';
import { placeFixtures } from '../../data/fixturePlacement';
import { readArchive, utf8, type ArchiveEntry } from './archive';
import { compose, IDENTITY, matrixText, parseMatrix, readMatrix, readPose, type MvrMatrix } from './coords';
import { classifyGdtf, readGdtf, type GdtfSummary, type Hardware } from './gdtf';
import { glbBounds } from './glb';
import { attr, buildXmlFragment, child, list, parseXml, text, type XmlNode } from './xml';
import {
  exportMvr,
  FIXTURE_EXTRA_TAGS,
  fixtureKey,
  PAYLOAD_FILE,
  PAYLOAD_PROVIDER,
  resolveUuid,
  UUID_CANONICAL,
  type MvrPayload,
} from './exportMvr';

export interface MvrImportReport {
  /** "stageforge" when the file carried StageForge's payload (lossless); "mvr" for other tools. */
  source: 'stageforge' | 'mvr';
  provider: string;
  fixtures: number;
  trusses: number;
  screens: number;
  sceneObjects: number;
  focusPoints: number;
  notes: string[];
}

export interface MvrImport {
  rig: RigConfig;
  stage?: NativeStage;
  interchange?: ShowInterchange;
  /** Original archive resource files (GDTF profiles, GLB/3DS geometries, textures) kept in-memory for re-export. */
  resources?: Map<string, Uint8Array>;
  report: MvrImportReport;
}

export interface MvrAddress {
  /** 0-based MVR break index (<Address break="0">). */
  mvrBreak: number;
  /** 1-based GDTF DMXBreak (mvrBreak + 1). */
  dmxBreak: number;
  universe: number;
  channel: number;
  /** 1-based absolute DMX address: (universe - 1) * 512 + channel. */
  absolute: number;
}

type Kind = 'Fixture' | 'Truss' | 'VideoScreen' | 'SceneObject' | 'FocusPoint' | 'Support' | 'Projector';
interface Item {
  kind: Kind; node: XmlNode; uuid: string; name: string; matrix: MvrMatrix; parentTruss?: number; index: number;
  /** Its own matrix, or one it is nested in, is malformed or absurd, so its placement is unknown. */
  invalid: boolean;
  /** Whether an ancestor was already captured intact for passthrough (prevents duplicate passthrough). */
  capturedByAncestor: boolean;
}

const KINDS: Kind[] = ['Fixture', 'Truss', 'VideoScreen', 'SceneObject', 'FocusPoint', 'Support', 'Projector'];
const IMPORTED_KINDS = new Set<string>(['Fixture', 'Truss', 'VideoScreen', 'SceneObject']);
const PASSTHROUGH_AUX_TAGS = ['Symdef', 'Position', 'MappingDefinition', 'Class'] as const;
const RAD = Math.PI / 180;
const MAX_FIXTURES = 1024;
export const MAX_IMPORTED_TRUSSES = 256;
const MAX_GDTF_FILES = 64;
const MAX_NESTED_INFLATED_BYTES = 128 * 1024 * 1024;
const MAX_GDTF_TOTAL_OPS = 1_000_000;
const MAX_KEPT_RESOURCE_BYTES = 128 * 1024 * 1024;
const RESOURCE_EXT = /\.(gdtf|glb|gltf|3ds|png|jpe?g|webp|svg)$/i;
const MAX_FRAGMENT_CHARS = 262_144;
const MAX_BUCKET_ITEMS = 4096;
const MAX_OBJECT_EXTRAS = 32;
const MAX_ADDRESS_BREAKS = 64;
/** Furthest position (metres from the origin) taken from an MVR file; beyond 10 km a matrix is broken. */
const MAX_COORDINATE = 10000;
const FLOOR_TYPES = new Set<Hardware>(['hazer', 'smoke', 'co2', 'floor_laser', 'floor_beam']);
const round3 = (n: number) => Number(n.toFixed(3));
const name = (value: string, max: number) => [...value.trim()].slice(0, max).join('');
const wrapDeg = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const inRange = (p: { x: number; y: number; z: number }) =>
  [p.x, p.y, p.z].every((n) => Number.isFinite(n) && Math.abs(n) <= MAX_COORDINATE);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Normalise UUID text: upper case, no braces; old files may space-separate the hex. */
const normUuid = (value: string | undefined) => {
  const hex = (value ?? '').replace(/[{}\s-]/g, '').toUpperCase();
  return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : (value ?? '').toUpperCase();
};

/** Canonical uppercase RFC 4122/9562 UUID, or undefined if not a valid UUID. */
const canonicalUuid = (value: string | undefined): string | undefined => {
  const u = normUuid(value);
  return UUID_CANONICAL.test(u) ? u : undefined;
};

/** Real scenes nest a few levels; deeper nesting is a malformed or hostile file. */
const MAX_DEPTH = 32;

function hasImportedKind(childList: XmlNode | undefined, depth = 0): boolean {
  if (!childList || depth > MAX_DEPTH) return false;
  for (const kind of IMPORTED_KINDS) {
    if (list(childList, kind).length > 0) return true;
  }
  for (const group of list(childList, 'GroupObject')) {
    if (hasImportedKind(child(group, 'ChildList'), depth + 1)) return true;
  }
  for (const kind of ['FocusPoint', 'Support', 'Projector'] as const) {
    for (const node of list(childList, kind)) {
      if (hasImportedKind(child(node, 'ChildList'), depth + 1)) return true;
    }
  }
  return false;
}

interface PassthroughRecorder {
  userData: string[];
  auxData: string[];
  sceneNodes: string[];
  objectExtras: Record<string, string[]>;
  bytes: number;
  truncated: boolean;
  flattenedGroups: number;
  push: (bucket: string[], tag: string, node: unknown) => boolean;
}

function createRecorder(): PassthroughRecorder {
  const rec: PassthroughRecorder = {
    userData: [],
    auxData: [],
    sceneNodes: [],
    objectExtras: {},
    bytes: 0,
    truncated: false,
    flattenedGroups: 0,
    push(bucket, tag, node) {
      if (bucket.length >= MAX_BUCKET_ITEMS) {
        rec.truncated = true;
        return false;
      }
      const fragment = buildXmlFragment(tag, node);
      if (!fragment || fragment.length > MAX_FRAGMENT_CHARS) {
        rec.truncated = true;
        return false;
      }
      const size = utf8.encode(fragment).length;
      if (rec.bytes + size > MAX_PASSTHROUGH_BYTES) {
        rec.truncated = true;
        return false;
      }
      rec.bytes += size;
      bucket.push(fragment);
      return true;
    },
  };
  return rec;
}

/** Clone a scene node with its world matrix baked in and optionally without ChildList. */
function withBakedMatrix(node: XmlNode, worldMatrix: MvrMatrix, stripChildList: boolean): XmlNode {
  const copy: XmlNode = {};
  for (const [k, v] of Object.entries(node)) {
    if (stripChildList && k === 'ChildList') continue;
    copy[k] = v;
  }
  copy.Matrix = matrixText(worldMatrix);
  return copy;
}

function collect(
  childList: XmlNode | undefined,
  parent: MvrMatrix,
  out: Item[],
  parentTruss: number | undefined,
  depth: number,
  invalid: boolean,
  recorder?: PassthroughRecorder,
  capturedByAncestor = false,
) {
  if (!childList || depth > MAX_DEPTH) return;
  for (const group of list(childList, 'GroupObject')) {
    const own = readMatrix(text(group, 'Matrix'));
    const groupInvalid = invalid || !own;
    const matrix = compose(parent, own ?? IDENTITY);
    const groupChildren = child(group, 'ChildList');
    if (recorder && !capturedByAncestor && !hasImportedKind(groupChildren)) {
      // Preserve an entire GroupObject subtree that contains no StageForge-imported objects.
      const nodeToSave = groupInvalid ? group : withBakedMatrix(group, matrix, false);
      recorder.push(recorder.sceneNodes, 'GroupObject', nodeToSave);
      collect(groupChildren, matrix, out, parentTruss, depth + 1, groupInvalid, recorder, true);
    } else {
      if (recorder && !capturedByAncestor) recorder.flattenedGroups++;
      collect(groupChildren, matrix, out, parentTruss, depth + 1, groupInvalid, recorder, capturedByAncestor);
    }
  }
  for (const kind of KINDS) {
    for (const node of list(childList, kind)) {
      const own = readMatrix(text(node, 'Matrix'));
      const itemInvalid = invalid || !own;
      const matrix = compose(parent, own ?? IDENTITY);
      const index = out.length;
      const itemChildList = child(node, 'ChildList');
      let capturedHere = capturedByAncestor;
      if (recorder && !capturedByAncestor && itemInvalid) {
        // Invalid-matrix subtrees cannot be placed in StageForge, so capture them intact.
        recorder.push(recorder.sceneNodes, kind, node);
        capturedHere = true;
      }
      out.push({ kind, node, uuid: normUuid(attr(node, 'uuid')), name: attr(node, 'name') ?? '', matrix, parentTruss, index, invalid: itemInvalid, capturedByAncestor: capturedHere });
      collect(itemChildList, matrix, out, kind === 'Truss' ? index : parentTruss, depth + 1, itemInvalid, recorder, capturedHere);
    }
  }
}

/** Every placed object in the scene's layers, with world matrices. */
function sceneItems(root: XmlNode | undefined, recorder?: PassthroughRecorder): Item[] {
  const out: Item[] = [];
  for (const layer of list(child(child(root, 'Scene'), 'Layers'), 'Layer')) {
    const own = readMatrix(text(layer, 'Matrix'));
    collect(child(layer, 'ChildList'), own ?? IDENTITY, out, undefined, 0, !own, recorder, false);
  }
  return out;
}

/**
 * Parse every valid DMX address entry on a fixture, sorted ascending by MVR 0-based break index
 * (and mapped to GDTF 1-based DMXBreak = mvrBreak + 1).
 */
export function readAddresses(node: XmlNode): MvrAddress[] {
  const raw = child(node, 'Addresses')?.['Address'];
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const byBreak = new Map<number, MvrAddress>();
  for (const entry of entries.slice(0, MAX_ADDRESS_BREAKS)) {
    const rawBreak = entry && typeof entry === 'object' ? attr(entry, 'break') : undefined;
    const rawValue = entry && typeof entry === 'object' ? String((entry as XmlNode)['#text'] ?? '').trim() : String(entry ?? '').trim();
    if (!rawValue) continue;
    const mvrBreak = rawBreak === undefined || rawBreak.trim() === '' ? 0 : Number(rawBreak);
    if (!Number.isInteger(mvrBreak) || mvrBreak < 0 || mvrBreak >= MAX_ADDRESS_BREAKS) continue;
    if (byBreak.has(mvrBreak)) continue;

    let universe: number, channel: number, absolute: number;
    if (/^\d+\.\d+$/.test(rawValue)) {
      [universe, channel] = rawValue.split('.').map(Number);
      if (universe < 1 || universe > 32768 || channel < 1 || channel > 512) continue;
      absolute = (universe - 1) * 512 + channel;
    } else if (/^\d+$/.test(rawValue)) {
      absolute = Number(rawValue);
      if (!Number.isSafeInteger(absolute) || absolute < 1 || absolute > 32768 * 512) continue;
      universe = Math.floor((absolute - 1) / 512) + 1;
      channel = ((absolute - 1) % 512) + 1;
    } else {
      continue;
    }
    byBreak.set(mvrBreak, { mvrBreak, dmxBreak: mvrBreak + 1, universe, channel, absolute });
  }
  return [...byBreak.values()].sort((a, b) => a.mvrBreak - b.mvrBreak);
}

/** First (lowest-break) DMX address of a fixture: an absolute integer, or the legacy "universe.channel" text. */
export function readAddress(node: XmlNode): { universe: number; channel: number } | undefined {
  const first = readAddresses(node)[0];
  return first ? { universe: first.universe, channel: first.channel } : undefined;
}

type Bounds = { min: number[]; max: number[] } | undefined;

/**
 * Object-space extent of a scene object's GLB geometry: width along its local X and height along
 * its local Z (MVR up), with the centre offset. glTF is metres with Y up, so a glTF point
 * (gx, gy, gz) sits at MVR-local (gx, −gz, gy) before each Geometry3D's own matrix (mm origin).
 */
function geometryBounds(node: XmlNode, files: Map<string, ArchiveEntry>, cache: Map<string, Bounds>) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const geo of list(child(node, 'Geometries'), 'Geometry3D')) {
    const file = (attr(geo, 'fileName') ?? '').split(/[\\/]/).pop()!.toLowerCase();
    if (!file.endsWith('.glb')) continue;
    if (!cache.has(file)) {
      const entry = files.get(file);
      let parsed: Bounds;
      try {
        parsed = entry ? glbBounds(entry.data) : undefined;
      } catch {
        parsed = undefined;
      }
      cache.set(file, parsed);
    }
    const bounds = cache.get(file);
    if (!bounds || !Array.isArray(bounds.min) || !Array.isArray(bounds.max) ||
        bounds.min.length !== 3 || bounds.max.length !== 3 ||
        ![...bounds.min, ...bounds.max].every(Number.isFinite)) continue;
    const m = parseMatrix(text(geo, 'Matrix'));
    for (const gx of [bounds.min[0], bounds.max[0]]) for (const gy of [bounds.min[1], bounds.max[1]]) for (const gz of [bounds.min[2], bounds.max[2]]) {
      const lx = gx, ly = -gz, lz = gy;
      const x = m.o.x / 1000 + m.u.x * lx + m.v.x * ly + m.w.x * lz;
      const z = m.o.z / 1000 + m.u.z * lx + m.v.z * ly + m.w.z * lz;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  const width = maxX - minX, height = maxZ - minZ;
  return Number.isFinite(width) && Number.isFinite(height) && width <= 1000 && height <= 1000
    ? { width, height, cx: (minX + maxX) / 2, cy: (minZ + maxZ) / 2 }
    : undefined;
}

const close = (a: MvrMatrix, b: MvrMatrix) =>
  (['u', 'v', 'w'] as const).every((k) => ['x', 'y', 'z'].every((c) => Math.abs(a[k][c as 'x'] - b[k][c as 'x']) < 1e-3)) &&
  ['x', 'y', 'z'].every((c) => Math.abs(a.o[c as 'x'] - b.o[c as 'x']) < 1);

function itemsOf(bytes: Uint8Array): Item[] {
  return sceneItems(child(parseXml(utf8.decode(readArchive(bytes).get('generalscenedescription.xml')!.data)), 'GeneralSceneDescription'));
}

const unreadableNote = (items: Item[], verb: string) => {
  const n = items.filter((i) => i.invalid).length;
  return n ? [`${plural(n, 'object')} with an unreadable or absurd matrix ${n === 1 ? 'was' : 'were'} ${verb}.`] : [];
};

function captureTopLevelPassthrough(root: XmlNode, recorder: PassthroughRecorder) {
  for (const data of list(child(root, 'UserData'), 'Data')) {
    if (attr(data, 'provider')?.toLowerCase() === PAYLOAD_PROVIDER.toLowerCase()) continue;
    recorder.push(recorder.userData, 'Data', data);
  }
  const aux = child(child(root, 'Scene'), 'AUXData');
  if (aux) {
    for (const tag of PASSTHROUGH_AUX_TAGS) {
      for (const node of list(aux, tag)) recorder.push(recorder.auxData, tag, node);
    }
  }
}

function restore(
  payload: MvrPayload,
  root: XmlNode,
  items: Item[],
  provider: string,
  resources: Map<string, Uint8Array>,
): MvrImport {
  const source = parseRigJson(JSON.stringify(payload.rig));
  const notes: string[] = unreadableNote(items, 'ignored');
  let interchange: ShowInterchange | undefined;
  if (payload.interchange !== undefined) {
    try {
      interchange = normalizeInterchange(parseInterchange(payload.interchange));
    } catch {
      notes.push('The interchange metadata in this MVR file was unreadable and was left out.');
    }
  }

  const byUuid = new Map(items.map((item) => [item.uuid, item]));
  // Merge truss moves made in another tool by UUID; everything else comes from the payload.
  let refused = 0;
  const pods = source.trussPods.map((pod) => {
    const item = byUuid.get(resolveUuid(`truss:${pod.id}`, interchange));
    if (!item || item.invalid) return pod;
    const pose = readPose(item.matrix);
    const yaw = wrapDeg(pod.rotationY / RAD);
    const moved = Math.hypot(pose.position.x - pod.x, pose.position.y - pod.baseY, pose.position.z - pod.z) > 0.001 ||
      Math.abs(wrapDeg(pose.yawDeg - yaw)) > 0.05;
    if (!moved) return pod;
    if (!inRange(pose.position)) {
      refused++;
      return pod;
    }
    notes.push(`Moved ${pod.name} to match the MVR file.`);
    const baseY = round3(pose.position.y);
    return { ...pod, x: round3(pose.position.x), z: round3(pose.position.z), baseY, rotationY: pose.yawDeg * RAD,
      motorMinY: Math.min(pod.motorMinY, baseY), motorMaxY: Math.max(pod.motorMaxY, baseY) };
  });
  if (refused) notes.push(`${plural(refused, 'truss move')} beyond ${MAX_COORDINATE} m ${refused === 1 ? 'was' : 'were'} ignored.`);
  const rig = parseRigJson(JSON.stringify({ ...source, trussPods: pods }));
  // The payload is untrusted too: a damaged stage overlay is left out rather than failing the open.
  let stage: NativeStage | undefined;
  let stageReadable = true;
  try {
    stage = payload.stage ? finalizeStage(rig, payload.stage) : undefined;
  } catch {
    stageReadable = false;
    notes.push('The StageForge screens, screen cues and layout in this file were unreadable and were left out.');
  }

  // Report what the merge doesn't take: other moved objects, added fixtures, single-unit readdressing.
  let expected: Item[] = [];
  try {
    expected = itemsOf(exportMvr(source, stageReadable ? payload.stage : undefined, '1', interchange, resources));
  } catch {
    // A payload that no longer exports cleanly just skips this note.
  }
  const rigTrusses = new Set(source.trussPods.map((pod) => resolveUuid(`truss:${pod.id}`, interchange)));
  const ignored = expected.filter((e) => {
    const item = byUuid.get(e.uuid);
    return item && !item.invalid && !(e.kind === 'Truss' && rigTrusses.has(e.uuid)) && e.kind !== 'Fixture' && !close(item.matrix, e.matrix);
  }).length;
  if (ignored) notes.push(`${plural(ignored, 'other moved object')} (screens, hangs, decks, props or layout trusses) ${ignored === 1 ? 'was' : 'were'} not merged; only rig trusses merge.`);
  const units = placeFixtures(rig);
  const fixtures = items.filter((i) => i.kind === 'Fixture');
  const known = new Set(units.map((u) => resolveUuid(fixtureKey(u), interchange)));
  const expectedUuids = new Set(expected.map((e) => e.uuid));
  const foreign = fixtures.filter((f) => !known.has(f.uuid) && !expectedUuids.has(f.uuid)).length;
  if (foreign) notes.push(`${plural(foreign, 'fixture')} added in another tool ${foreign === 1 ? 'was' : 'were'} not merged.`);
  const readdressed = units.filter((u) => {
    const item = byUuid.get(resolveUuid(fixtureKey(u), interchange));
    const address = item && readAddress(item.node);
    return address && u.patched && (address.universe !== u.universe || address.channel !== u.address);
  }).length;
  if (readdressed) notes.push(`${plural(readdressed, 'fixture address change')} from the MVR file ${readdressed === 1 ? 'was' : 'were'} not applied; StageForge patches whole fixture groups.`);

  // Preserve any new foreign nodes or UserData added in another tool since StageForge exported.
  const recorder = createRecorder();
  if (interchange?.mvr?.passthrough) {
    for (const frag of interchange.mvr.passthrough.userData ?? []) recorder.userData.push(frag);
    for (const frag of interchange.mvr.passthrough.auxData ?? []) recorder.auxData.push(frag);
    for (const frag of interchange.mvr.passthrough.sceneNodes ?? []) recorder.sceneNodes.push(frag);
    if (interchange.mvr.passthrough.objectExtras) {
      for (const [k, list] of Object.entries(interchange.mvr.passthrough.objectExtras)) recorder.objectExtras[k] = [...list];
    }
    for (const list of [recorder.userData, recorder.auxData, recorder.sceneNodes, ...Object.values(recorder.objectExtras)]) {
      for (const frag of list) recorder.bytes += utf8.encode(frag).length;
    }
  }
  const existingUserData = new Set(recorder.userData);
  for (const data of list(child(root, 'UserData'), 'Data')) {
    if (attr(data, 'provider')?.toLowerCase() === PAYLOAD_PROVIDER.toLowerCase()) continue;
    const frag = buildXmlFragment('Data', data);
    if (!existingUserData.has(frag)) {
      if (recorder.push(recorder.userData, 'Data', data)) existingUserData.add(frag);
    }
  }
  for (const item of items) {
    if (!item.uuid || expectedUuids.has(item.uuid) || known.has(item.uuid)) continue;
    if (item.kind === 'Support' || item.kind === 'Projector' || item.kind === 'FocusPoint') {
      recorder.push(recorder.sceneNodes, item.kind, item.invalid ? item.node : withBakedMatrix(item.node, item.matrix, true));
    }
  }
  const mergedPassthrough: MvrPassthrough = {};
  if (recorder.userData.length) mergedPassthrough.userData = recorder.userData;
  if (recorder.auxData.length) mergedPassthrough.auxData = recorder.auxData;
  if (recorder.sceneNodes.length) mergedPassthrough.sceneNodes = recorder.sceneNodes;
  if (Object.keys(recorder.objectExtras).length) mergedPassthrough.objectExtras = recorder.objectExtras;
  const finalInterchange = normalizeInterchange({
    mvr: {
      ...(interchange?.mvr ?? {}),
      ...(Object.keys(mergedPassthrough).length ? { passthrough: mergedPassthrough } : {}),
    },
  });

  return {
    rig, stage, interchange: finalInterchange, resources: resources.size ? resources : undefined,
    report: { source: 'stageforge', provider, fixtures: fixtures.length, trusses: items.filter((i) => i.kind === 'Truss').length,
      screens: items.filter((i) => i.kind === 'VideoScreen').length, sceneObjects: items.filter((i) => i.kind === 'SceneObject').length,
      focusPoints: items.filter((i) => i.kind === 'FocusPoint').length, notes },
  };
}

interface Unit {
  type: Hardware; model: string; x: number; y: number; z: number; standing: boolean;
  address?: { universe: number; channel: number }; parentTruss?: number;
  uuid?: string; spec?: string; mode?: string; node: XmlNode; matrix: MvrMatrix;
}

/** Read an .mvr archive into a StageForge rig, stage overlay and interchange metadata. */
export function importMvr(bytes: Uint8Array): MvrImport {
  const files = readArchive(bytes);
  const scene = files.get('generalscenedescription.xml');
  if (!scene) throw new Error('This MVR file has no GeneralSceneDescription.xml.');
  const doc = parseXml(utf8.decode(scene.data));
  const root = child(doc, 'GeneralSceneDescription');
  if (!root) throw new Error('This MVR file has no GeneralSceneDescription.');
  const verMajor = attr(root, 'verMajor');
  const verMinor = attr(root, 'verMinor');
  if (!verMajor || Number(verMajor) !== 1) {
    throw new Error(verMajor ? `MVR version ${verMajor}.${verMinor ?? '0'} is not supported.` : 'MVR version is missing or unsupported.');
  }
  const provider = name(attr(root, 'provider') ?? 'unknown', 64) || 'unknown';

  const resources = new Map<string, Uint8Array>();
  let keptResourceBytes = 0;
  let droppedResources = 0;
  for (const [lower, entry] of files) {
    if (lower === 'generalscenedescription.xml' || lower === PAYLOAD_FILE.toLowerCase()) continue;
    if (!RESOURCE_EXT.test(entry.name)) continue;
    if (keptResourceBytes + entry.data.byteLength > MAX_KEPT_RESOURCE_BYTES) {
      droppedResources++;
      continue;
    }
    keptResourceBytes += entry.data.byteLength;
    resources.set(entry.name, entry.data);
  }

  const marked = list(child(root, 'UserData'), 'Data').some((d) => attr(d, 'provider') === PAYLOAD_PROVIDER);
  const payloadFile = files.get(PAYLOAD_FILE.toLowerCase());
  let payloadFallbackNote: string | undefined;
  if (marked && payloadFile) {
    let payload: MvrPayload | undefined;
    try {
      payload = JSON.parse(utf8.decode(payloadFile.data));
    } catch {
      payload = undefined;
    }
    if (payload?.format === 'stageforge-mvr' && payload.version === 1 && payload.rig) {
      const restored = restore(payload, root, sceneItems(root), provider, resources);
      if (droppedResources) {
        restored.report.notes.push(`${plural(droppedResources, 'archive resource')} exceeded the 128 MiB in-session cache limit and ${droppedResources === 1 ? 'was' : 'were'} not retained.`);
      }
      return restored;
    }
    payloadFallbackNote = 'The embedded StageForge payload was unreadable; the scene was imported as a generic MVR.';
  }

  // A file from another tool: rebuild a rig from its trusses, fixtures, screens and objects,
  // while preserving UUIDs and unrecognised/unmodeled MVR XML in the interchange block.
  const recorder = createRecorder();
  captureTopLevelPassthrough(root, recorder);
  const items = sceneItems(root, recorder);

  const uuids: Record<string, string> = {};
  const fixtureSpecs: Record<string, MvrFixtureSpec> = {};
  const firstLayer = list(child(child(root, 'Scene'), 'Layers'), 'Layer')[0];
  const layerUuid = canonicalUuid(attr(firstLayer, 'uuid'));
  if (layerUuid) uuids['layer:stageforge'] = layerUuid;

  const notes: string[] = [...(payloadFallbackNote ? [payloadFallbackNote] : []), ...unreadableNote(items, 'skipped')];
  const readable = items.filter((i) => !i.invalid);
  const outOfRangeItems = readable.filter((i) => !inRange(readPose(i.matrix).position));
  if (outOfRangeItems.length) {
    notes.push(`${plural(outOfRangeItems.length, 'object')} more than ${MAX_COORDINATE} m from the origin ${outOfRangeItems.length === 1 ? 'was' : 'were'} skipped.`);
    for (const item of outOfRangeItems) {
      if (!item.capturedByAncestor) recorder.push(recorder.sceneNodes, item.kind, withBakedMatrix(item.node, item.matrix, true));
    }
  }
  const usable = readable.filter((i) => inRange(readPose(i.matrix).position));
  const bounds = new Map<string, Bounds>();
  const layerName = attr(firstLayer, 'name');
  const rig: RigConfig = { ...createBlankDesign(), name: name(layerName ?? '', 128) || `Imported ${provider} MVR` };

  const trussItems = usable.filter((i) => i.kind === 'Truss');
  if (trussItems.length > MAX_IMPORTED_TRUSSES) {
    notes.push(`Only the first ${MAX_IMPORTED_TRUSSES} of ${trussItems.length} trusses were imported.`);
    for (const dropped of trussItems.slice(MAX_IMPORTED_TRUSSES)) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'Truss', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
  }
  const pods = new Map<number, TrussPodConfig>();
  for (const item of trussItems.slice(0, MAX_IMPORTED_TRUSSES)) {
    const pose = readPose(item.matrix);
    const geometry = geometryBounds(item.node, files, bounds);
    const width = Math.max(0.5, geometry?.width ?? 3);
    const cx = geometry?.cx ?? 0;
    const yaw = pose.yawDeg * RAD;
    const baseY = round3(pose.position.y);
    const podId = `mvr-truss-${pods.size + 1}`;
    pods.set(item.index, {
      id: podId, name: name(item.name, 128) || `Truss ${pods.size + 1}`, shape: 'box', width: round3(width),
      x: round3(pose.position.x + Math.cos(yaw) * cx), z: round3(pose.position.z - Math.sin(yaw) * cx), baseY, rotationY: yaw,
      motorized: false, motorMinY: baseY, motorMaxY: baseY, fixtures: [],
    });
    const u = canonicalUuid(item.uuid);
    if (u) uuids[`truss:${podId}`] = u;
  }

  const gdtfCache = new Map<string, GdtfSummary | null>();
  const gdtfBudget = { remaining: MAX_NESTED_INFLATED_BYTES, opsRemaining: MAX_GDTF_TOTAL_OPS };
  let gdtfReads = 0;
  let gdtfCapped = false;
  const units: Unit[] = [];
  let fixtureItems = usable.filter((i) => i.kind === 'Fixture');
  if (fixtureItems.length > MAX_FIXTURES) {
    notes.push(`Only the first ${MAX_FIXTURES} of ${fixtureItems.length} fixtures were imported.`);
    for (const dropped of fixtureItems.slice(MAX_FIXTURES)) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'Fixture', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
    fixtureItems = fixtureItems.slice(0, MAX_FIXTURES);
  }
  for (const item of fixtureItems) {
    const spec = (text(item.node, 'GDTFSpec') ?? '').trim().split(/[\\/]/).pop()!;
    const modeName = text(item.node, 'GDTFMode');
    const key = spec.toLowerCase();
    if (spec && !gdtfCache.has(key)) {
      const file = files.get(key) ?? files.get(key + '.gdtf');
      if (!file) {
        gdtfCache.set(key, null);
      } else if (gdtfReads >= MAX_GDTF_FILES || gdtfBudget.remaining <= 0) {
        gdtfCapped = true;
        gdtfCache.set(key, null);
      } else {
        gdtfReads++;
        try {
          gdtfCache.set(key, readGdtf(file.data, gdtfBudget));
        } catch {
          gdtfCache.set(key, null);
        }
      }
    }
    const summary = spec ? gdtfCache.get(key) : null;
    const pose = readPose(item.matrix);
    const type: Hardware = summary ? classifyGdtf(summary, modeName, pose.standing)
      : /laser/i.test(item.name) ? 'laser' : /strobe/i.test(item.name) ? 'strobe' : pose.standing ? 'floor_beam' : 'beam';
    const model = summary ? `${summary.manufacturer} ${summary.name}` : item.name.replace(/\s+\d+$/, '');
    units.push({
      type, model: name(model, 256) || 'MVR fixture', ...pose.position, standing: pose.standing,
      address: readAddress(item.node), parentTruss: item.parentTruss,
      uuid: canonicalUuid(item.uuid),
      spec: spec ? name(spec, 512) : undefined,
      mode: modeName ? name(modeName, 512) : undefined,
      node: item.node,
      matrix: item.matrix,
    });
  }
  const missingProfiles = [...gdtfCache.values()].filter((v) => v === null).length;
  if (gdtfCapped) notes.push(`Only the first ${MAX_GDTF_FILES} distinct GDTF profiles (within 128 MiB) were read; remaining fixtures were guessed from names.`);
  else if (missingProfiles) notes.push(`${plural(missingProfiles, 'GDTF profile')} ${missingProfiles === 1 ? 'was' : 'were'} missing or unreadable; fixture types were guessed from names.`);

  // Hung units go to their parent truss, the nearest truss, or a new synthetic position bar per height and depth.
  const clusters = new Map<string, TrussPodConfig>();
  const hungOn = new Map<TrussPodConfig, Unit[]>();
  const floor: Unit[] = [];
  const droppedClusterUnits: Unit[] = [];
  const nearestPod = (u: Unit) => {
    let best: TrussPodConfig | undefined, bestDistance = 1.5;
    for (const pod of pods.values()) {
      const dx = u.x - pod.x, dz = u.z - pod.z;
      const along = dx * Math.cos(pod.rotationY) - dz * Math.sin(pod.rotationY);
      const across = dx * Math.sin(pod.rotationY) + dz * Math.cos(pod.rotationY);
      const distance = Math.hypot(Math.max(0, Math.abs(along) - pod.width / 2), across);
      if (distance < bestDistance && u.y < pod.baseY + 1 && u.y > pod.baseY - 2) { best = pod; bestDistance = distance; }
    }
    return best;
  };
  for (const unit of units) {
    // Only floor hardware stands on the deck; other upright units hang on a position bar.
    if (FLOOR_TYPES.has(unit.type)) {
      floor.push(unit);
      continue;
    }
    let pod = (unit.parentTruss !== undefined ? pods.get(unit.parentTruss) : undefined) ?? nearestPod(unit);
    if (!pod) {
      const key = `${Math.round(unit.y * 2) / 2}:${Math.round(unit.z)}`;
      pod = clusters.get(key);
      if (!pod) {
        if (pods.size + clusters.size >= MAX_IMPORTED_TRUSSES) {
          droppedClusterUnits.push(unit);
          continue;
        }
        const baseY = round3(unit.y + 0.28);
        pod = { id: `mvr-position-${clusters.size + 1}`, name: `Imported position ${clusters.size + 1}`, shape: 'box', width: 2,
          x: unit.x, z: round3(unit.z), baseY, rotationY: 0, motorized: false, motorMinY: baseY, motorMaxY: baseY, fixtures: [] };
        clusters.set(key, pod);
      }
    }
    if (!hungOn.has(pod)) hungOn.set(pod, []);
    hungOn.get(pod)!.push(unit);
  }
  if (droppedClusterUnits.length) {
    notes.push(`${plural(droppedClusterUnits.length, 'fixture')} exceeded the ${MAX_IMPORTED_TRUSSES}-position limit and ${droppedClusterUnits.length === 1 ? 'was' : 'were'} left out.`);
    for (const u of droppedClusterUnits) {
      recorder.push(recorder.sceneNodes, 'Fixture', withBakedMatrix(u.node, u.matrix, true));
    }
  }
  for (const pod of clusters.values()) {
    const xs = hungOn.get(pod)!.map((u) => u.x);
    const left = Math.min(...xs), right = Math.max(...xs);
    pod.x = round3((left + right) / 2);
    pod.width = round3(Math.max(2, right - left + 1.3));
  }

  const synthetic = [...clusters.values()].map((p) => p.id);
  const toPatch: Array<{ group: MountedFixtureGroup | FloorFxUnit; type: Hardware; key: string; unit: Unit }> = [];
  const captureFixtureExtras = (fKey: string, unitNode: XmlNode) => {
    const extras: string[] = [];
    for (const [tag, value] of Object.entries(unitNode)) {
      if (!FIXTURE_EXTRA_TAGS.has(tag) || value === undefined || value === null || value === '') continue;
      if (extras.length >= MAX_OBJECT_EXTRAS) {
        recorder.truncated = true;
        break;
      }
      const itemsToSave = Array.isArray(value) ? value : [value];
      for (const item of itemsToSave) {
        if (extras.length >= MAX_OBJECT_EXTRAS) {
          recorder.truncated = true;
          break;
        }
        recorder.push(extras, tag, item);
      }
    }
    if (extras.length) recorder.objectExtras[fKey] = extras;
  };

  const groupOf = (unit: Unit, index: number, podId: string | undefined, extra: Partial<FloorFxUnit> = {}) => {
    const group = { id: `mvr-${index + 1}`, type: unit.type, modelName: unit.model, count: 1,
      dmxUniverse: 1 as 1 | 2, dmxStartChannel: 513, ...extra };
    const fKey = fixtureKey({ podId, group: group as MountedFixtureGroup | FloorFxUnit, index: 0 });
    if (unit.uuid) uuids[fKey] = unit.uuid;
    if (unit.spec) fixtureSpecs[fKey] = { spec: unit.spec, mode: unit.mode ?? '' };
    captureFixtureExtras(fKey, unit.node);
    if (unit.address && unit.address.universe <= 2) {
      group.dmxUniverse = unit.address.universe as 1 | 2;
      group.dmxStartChannel = unit.address.channel;
    } else {
      // Off the end of the universe until re-patched below, so it claims no channels meanwhile.
      toPatch.push({ group: group as MountedFixtureGroup | FloorFxUnit, type: unit.type, key: fKey, unit });
    }
    return group;
  };
  let n = 0;
  const allPods = [...pods.values(), ...clusters.values()];
  const along = (pod: TrussPodConfig, u: Unit) => (u.x - pod.x) * Math.cos(pod.rotationY) - (u.z - pod.z) * Math.sin(pod.rotationY);
  for (const pod of allPods) {
    const hung = (hungOn.get(pod) ?? []).sort((a, b) => along(pod, a) - along(pod, b));
    pod.fixtures = hung.map((unit) => groupOf(unit, n++, pod.id) as MountedFixtureGroup);
  }
  rig.trussPods = allPods;
  rig.floorFx = floor.map((unit) => groupOf(unit, n++, undefined, { x: round3(unit.x), z: round3(unit.z), spread: 0 }) as FloorFxUnit);
  // Units outside StageForge's two universes (or unpatched) take the next free addresses.
  for (const { group, type } of toPatch) {
    const patch = allocateDmx(rig, type, 1, 2);
    if (patch) {
      group.dmxUniverse = patch.dmxUniverse;
      group.dmxStartChannel = patch.dmxStartChannel;
    }
  }
  if (toPatch.length) notes.push(`${plural(toPatch.length, 'fixture')} unpatched or outside universes 1–2 took free addresses.`);
  const unplaced = toPatch.filter(({ group }) => group.dmxStartChannel > 512);
  if (unplaced.length) {
    const drop = new Set(unplaced.map(({ group }) => group));
    for (const entry of unplaced) {
      delete uuids[entry.key];
      delete fixtureSpecs[entry.key];
      delete recorder.objectExtras[entry.key];
      recorder.push(recorder.sceneNodes, 'Fixture', withBakedMatrix(entry.unit.node, entry.unit.matrix, true));
    }
    rig.trussPods = rig.trussPods.map((pod) => ({ ...pod, fixtures: pod.fixtures.filter((g) => !drop.has(g)) }));
    rig.floorFx = rig.floorFx.filter((g) => !drop.has(g));
    notes.push(`${plural(unplaced.length, 'fixture')} did not fit in two universes and ${unplaced.length === 1 ? 'was' : 'were'} left out.`);
  }
  const finalRig = parseRigJson(JSON.stringify(rig));
  const overlapping = new Set(placeFixtures(finalRig).filter((u) => !u.patched).map((u) => u.group)).size;
  if (overlapping) notes.push(`${plural(overlapping, 'fixture')} overlap in StageForge's simulated patch (it reserves a fixed footprint per type).`);

  let stage: NativeStage | undefined;
  const screens = usable.filter((i) => i.kind === 'VideoScreen');
  screens.slice(0, MAX_STAGE_WALLS).forEach((item, i) => {
    const pose = readPose(item.matrix);
    const geometry = geometryBounds(item.node, files, bounds);
    const yaw = pose.yawDeg * RAD;
    const cx = geometry?.cx ?? 0;
    const wallId = `mvr-screen-${i + 1}`;
    stage = upsertStageWall(finalRig, stage, {
      id: wallId, label: name(item.name, 512) || `Screen ${i + 1}`,
      x: pose.position.x + Math.cos(yaw) * cx, y: pose.position.y + (geometry?.cy ?? 0), z: pose.position.z - Math.sin(yaw) * cx,
      width: geometry?.width ?? 3, height: geometry?.height ?? 2, yaw: pose.yawDeg,
    });
    const u = canonicalUuid(item.uuid);
    if (u) uuids[`wall:${wallId}`] = u;
  });
  if (screens.length > MAX_STAGE_WALLS) {
    notes.push(`Only ${MAX_STAGE_WALLS} of ${screens.length} video screens were imported.`);
    for (const dropped of screens.slice(MAX_STAGE_WALLS)) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'VideoScreen', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
  }
  const objects = usable.filter((i) => i.kind === 'SceneObject');
  const props: LayoutProp[] = objects.slice(0, MAX_LAYOUT_ITEMS).map((item, i) => {
    const pose = readPose(item.matrix);
    const geometry = geometryBounds(item.node, files, bounds);
    const u = canonicalUuid(item.uuid);
    if (u) uuids[`prop:${i}`] = u;
    return { x: pose.position.x, z: pose.position.z, type: 'scenic', height: Math.max(0.1, geometry?.height ?? 2) };
  });
  if (props.length) stage = setLayoutProps(finalRig, stage, props);
  if (objects.length > MAX_LAYOUT_ITEMS) {
    notes.push(`Only ${MAX_LAYOUT_ITEMS} of ${objects.length} scene objects were imported as props.`);
    for (const dropped of objects.slice(MAX_LAYOUT_ITEMS)) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'SceneObject', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
  }

  const focusPointItems = usable.filter((i) => i.kind === 'FocusPoint');
  for (const item of focusPointItems) {
    if (!item.capturedByAncestor) {
      recorder.push(recorder.sceneNodes, 'FocusPoint', withBakedMatrix(item.node, item.matrix, hasImportedKind(child(item.node, 'ChildList'))));
    }
  }
  if (focusPointItems.length) notes.push(`${plural(focusPointItems.length, 'focus point')} ${focusPointItems.length === 1 ? 'was' : 'were'} skipped; StageForge derives focus points from the decks.`);

  const skippedItems = usable.filter((i) => i.kind === 'Support' || i.kind === 'Projector');
  for (const item of skippedItems) {
    if (!item.capturedByAncestor) {
      recorder.push(recorder.sceneNodes, item.kind, withBakedMatrix(item.node, item.matrix, hasImportedKind(child(item.node, 'ChildList'))));
    }
  }
  if (skippedItems.length) notes.push(`${plural(skippedItems.length, 'support or projector object')} ${skippedItems.length === 1 ? 'was' : 'were'} skipped.`);
  if (recorder.flattenedGroups) notes.push(`${plural(recorder.flattenedGroups, 'GroupObject wrapper')} containing imported gear ${recorder.flattenedGroups === 1 ? 'was' : 'were'} flattened.`);
  if (recorder.truncated) notes.push('Some unrecognised MVR XML exceeded the 8 MiB passthrough limit and was truncated.');
  if (droppedResources) notes.push(`${plural(droppedResources, 'archive resource')} exceeded the 128 MiB in-session cache limit and ${droppedResources === 1 ? 'was' : 'were'} not retained.`);

  const passthrough: MvrPassthrough = {};
  if (recorder.userData.length) passthrough.userData = recorder.userData;
  if (recorder.auxData.length) passthrough.auxData = recorder.auxData;
  if (recorder.sceneNodes.length) passthrough.sceneNodes = recorder.sceneNodes;
  if (Object.keys(recorder.objectExtras).length) passthrough.objectExtras = recorder.objectExtras;

  const interchange = normalizeInterchange({
    mvr: {
      ...(Object.keys(uuids).length ? { uuids } : {}),
      ...(synthetic.length ? { synthetic } : {}),
      ...(Object.keys(fixtureSpecs).length ? { fixtureSpecs } : {}),
      ...(Object.keys(passthrough).length ? { passthrough } : {}),
    },
  });

  return {
    rig: finalRig,
    stage: finalizeStage(finalRig, stage),
    interchange,
    resources: resources.size ? resources : undefined,
    report: { source: 'mvr', provider, fixtures: fixtureItems.length, trusses: pods.size, screens: screens.length,
      sceneObjects: objects.length, focusPoints: focusPointItems.length, notes },
  };
}
