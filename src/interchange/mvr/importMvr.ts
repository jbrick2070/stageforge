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
import { createBlankDesign, normalizeDesign } from '../../data/stageDesign';
import { parseRigJson } from '../../data/rigImport';
import { isLogicalDmxUniverse, MAX_LOGICAL_DMX_UNIVERSE, type LogicalDmxUniverse } from '../../data/dmxUniverses';
import { allocateDmx, groupFootprint } from '../../data/dmxPatch';
import { finalizeStage, MAX_LAYOUT_ITEMS, setLayoutProps } from '../../data/stagePlan';
import { MAX_STAGE_WALLS, resolveStudioGeometry, upsertStageWall, type LayoutProp } from '../../data/studioGeometry';
import { placeFixtures } from '../../data/fixturePlacement';
import { readArchive, utf8, type ArchiveEntry } from './archive';
import {
  compose,
  fromMvrPoint,
  IDENTITY,
  matrixRotationDeltaDeg,
  matrixText,
  parseMatrix,
  poseMatrix,
  readMatrix,
  readPose,
  type MvrMatrix,
} from './coords';
import { classifyGdtf, readGdtf, singleBreakGdtfMode, type GdtfSummary, type Hardware } from './gdtf';
import { glbBounds } from './glb';
import { attr, buildXmlFragment, child, list, parseXml, text, type XmlNode } from './xml';
import {
  exportMvr,
  FIXTURE_EXTRA_TAGS,
  fixtureKey,
  fixtureNumbers,
  PAYLOAD_FILE,
  PAYLOAD_PROVIDER,
  resolveUuid,
  UUID_CANONICAL,
  type ExportedFixtureNumbers,
  type MvrPayload,
} from './exportMvr';

export type MvrFindingSeverity = 'info' | 'warn' | 'block';

export type MvrFindingCode =
  | 'fixture-number-lost'
  | 'uuid-changed'
  | 'universe-unsupported'
  | 'gdtf-generic-reserve'
  | 'address-assigned'
  | 'break-dropped'
  | 'patch-overlap'
  | 'address-edit-ignored'
  | 'transform-simplified'
  | 'unit-suspect'
  | 'hierarchy-flattened'
  | 'truss-merged'
  | 'object-edit-ignored'
  | 'coordinate-out-of-range'
  | 'matrix-unreadable'
  | 'gdtf-missing'
  | 'gdtf-unparsed'
  | 'geometry-unsupported'
  | 'fixture-dropped'
  | 'object-dropped'
  | 'object-skipped'
  | 'resource-dropped'
  | 'passthrough-truncated'
  | 'payload-damaged';

export interface MvrFinding {
  severity: MvrFindingSeverity;
  code: MvrFindingCode;
  message: string;
  count: number;
  fixtureIds?: string[];
}

export interface MvrImportReport {
  /** "stageforge" when the file carried StageForge's payload (lossless); "mvr" for other tools. */
  source: 'stageforge' | 'mvr';
  provider: string;
  fixtures: number;
  trusses: number;
  screens: number;
  sceneObjects: number;
  focusPoints: number;
  /** Structured preflight findings covering every loss, approximation, skip, merge or safety block. */
  findings: MvrFinding[];
  /** Flat summary lines derived from `findings` (kept for backward compatibility). */
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

export interface ImportMvrOptions {
  /** Optional lower cap on in-session binary resource retention (clamped to <= 128 MiB). */
  maxKeptResourceBytes?: number;
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
const DEG_TO_RAD = Math.PI / 180;
const MAX_FIXTURES = 1024;
export const MAX_IMPORTED_TRUSSES = 256;
const MAX_GDTF_FILES = 64;
const MAX_NESTED_INFLATED_BYTES = 128 * 1024 * 1024;
const MAX_GDTF_TOTAL_OPS = 1_000_000;
export const MAX_KEPT_RESOURCE_BYTES = 128 * 1024 * 1024;
const RESOURCE_EXT = /\.(gdtf|glb|gltf|3ds|png|jpe?g|webp|svg)$/i;
const MAX_FRAGMENT_CHARS = 262_144;
const MAX_BUCKET_ITEMS = 4096;
const MAX_OBJECT_EXTRAS = 32;
const MAX_ADDRESS_BREAKS = 64;
export const MAX_FINDING_IDS = 64;
/** Furthest position (metres from the origin) taken from an MVR file; beyond 10 km a matrix is broken. */
const MAX_COORDINATE = 10000;
const FLOOR_TYPES = new Set<Hardware>(['hazer', 'smoke', 'co2', 'floor_laser', 'floor_beam']);
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const round3 = (n: number) => Number(n.toFixed(3));
const name = (value: string, max: number) => [...value.replace(CONTROL_CHARS, '').trim()].slice(0, max).join('');
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

/** Format a human-readable, bounded identifier for preflight finding lists (from source MVR fields). */
function itemLabel(node: XmlNode, itemName: string, uuid: string, kind: Kind = 'Fixture', suffix?: string): string {
  const rawFid = (text(node, 'FixtureID') ?? '').replace(CONTROL_CHARS, '').trim();
  const rawNum = (text(node, 'FixtureIDNumeric') ?? '').replace(CONTROL_CHARS, '').trim();
  const fid = rawFid || (rawNum && rawNum !== '0' ? rawNum : '');
  const cleanName = name(itemName, 40) || kind;
  const shortUuid = uuid ? uuid.replace(CONTROL_CHARS, '').slice(0, 8) : 'no-uuid';
  const base = kind === 'Fixture'
    ? `${fid || '—'} · ${cleanName} (${shortUuid})`
    : `${cleanName} (${shortUuid})`;
  const full = suffix ? `${base} — ${suffix}` : base;
  const chars = [...full];
  return chars.length > 96 ? chars.slice(0, 95).join('') + '…' : full;
}

interface FindingsCollector {
  findings: MvrFinding[];
  add: (
    severity: MvrFindingSeverity,
    code: MvrFindingCode,
    message: string,
    count: number,
    fixtureIds?: string[],
  ) => void;
  notes: () => string[];
}

function createFindings(): FindingsCollector {
  const findings: MvrFinding[] = [];
  return {
    findings,
    add(severity, code, message, count, fixtureIds) {
      const ids = fixtureIds && fixtureIds.length > 0 ? fixtureIds.slice(0, MAX_FINDING_IDS) : undefined;
      findings.push({
        severity,
        code,
        message,
        count,
        ...(ids ? { fixtureIds: ids } : {}),
      });
    },
    notes() {
      return findings.map((f) => f.message);
    },
  };
}

/** True when a fixture's non-empty source console numbers differ from StageForge's sequential export numbering. */
function sourceNumberDiffers(node: XmlNode, expected: ExportedFixtureNumbers): string | undefined {
  const srcFid = (text(node, 'FixtureID') ?? '').replace(CONTROL_CHARS, '').trim();
  const srcNum = (text(node, 'FixtureIDNumeric') ?? '').replace(CONTROL_CHARS, '').trim();
  const srcUnit = (text(node, 'UnitNumber') ?? '').replace(CONTROL_CHARS, '').trim();
  const srcCustom = (text(node, 'CustomId') ?? '').replace(CONTROL_CHARS, '').trim();

  if (srcFid && srcFid !== expected.fixtureId) return `ID ${srcFid} → ${expected.fixtureId}`;
  if (srcNum && srcNum !== '0' && srcNum !== String(expected.fixtureIdNumeric)) {
    return `ID #${srcNum} → ${expected.fixtureIdNumeric}`;
  }
  if (srcUnit && srcUnit !== '0' && srcUnit !== String(expected.unitNumber)) {
    return `Unit ${srcUnit} → ${expected.unitNumber}`;
  }
  if (srcCustom && srcCustom !== '0' && srcCustom !== expected.customId) {
    return `Custom ${srcCustom} → ${expected.customId}`;
  }
  return undefined;
}

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
  const byBreak = new Map<number, MvrAddress>();
  for (const { rawBreak, rawValue } of addressEntries(node)) {
    if (!rawValue) continue;
    const mvrBreak = rawBreak === undefined || rawBreak.trim() === '' ? 0 : Number(rawBreak);
    if (!Number.isInteger(mvrBreak) || mvrBreak < 0 || mvrBreak >= MAX_ADDRESS_BREAKS) continue;
    if (byBreak.has(mvrBreak)) continue;

    const parsed = parseDmxAddress(rawValue);
    if (parsed) byBreak.set(mvrBreak, { mvrBreak, dmxBreak: mvrBreak + 1, ...parsed });
  }
  return [...byBreak.values()].sort((a, b) => a.mvrBreak - b.mvrBreak);
}

function addressEntries(node: XmlNode) {
  const raw = child(node, 'Addresses')?.['Address'];
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return entries.slice(0, MAX_ADDRESS_BREAKS).map(entry => {
    const rawBreak = entry && typeof entry === 'object' ? attr(entry, 'break') : undefined;
    const rawValue = entry && typeof entry === 'object'
      ? String((entry as XmlNode)['#text'] ?? '').replace(CONTROL_CHARS, '').trim()
      : String(entry ?? '').replace(CONTROL_CHARS, '').trim();
    return { rawBreak, rawValue };
  });
}

function parseDmxAddress(rawValue: string) {
  if (/^\d+\.\d+$/.test(rawValue)) {
    const [universe, channel] = rawValue.split('.').map(Number);
    if (universe >= 1 && universe <= 32768 && channel >= 1 && channel <= 512) return { universe, channel, absolute: (universe - 1) * 512 + channel };
  } else if (/^\d+$/.test(rawValue)) {
    const absolute = Number(rawValue);
    if (Number.isSafeInteger(absolute) && absolute >= 1 && absolute <= 32768 * 512) return {
      absolute, universe: Math.floor((absolute - 1) / 512) + 1, channel: ((absolute - 1) % 512) + 1,
    };
  }
}

/** First (lowest-break) DMX address of a fixture: an absolute integer, or the legacy "universe.channel" text. */
export function readAddress(node: XmlNode): { universe: number; channel: number } | undefined {
  const first = readAddresses(node)[0];
  return first ? { universe: first.universe, channel: first.channel } : undefined;
}

type Bounds = { min: number[]; max: number[] } | undefined;

interface GeometryBoundsResult {
  bounds?: { width: number; height: number; cx: number; cy: number };
  unsupported: boolean;
}

/**
 * Object-space extent of a scene object's GLB geometry: width along its local X and height along
 * its local Z (MVR up), with the centre offset. glTF is metres with Y up, so a glTF point
 * (gx, gy, gz) sits at MVR-local (gx, −gz, gy) before each Geometry3D's own matrix (mm origin).
 */
function geometryBounds(node: XmlNode, files: Map<string, ArchiveEntry>, cache: Map<string, Bounds>): GeometryBoundsResult {
  const geometries = child(node, 'Geometries');
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let unsupported = list(geometries, 'Symbol').length > 0;
  for (const geo of list(geometries, 'Geometry3D')) {
    const file = (attr(geo, 'fileName') ?? '').trim().split(/[\\/]/).pop()!.toLowerCase();
    if (!file) continue;
    if (!file.endsWith('.glb')) {
      unsupported = true;
      continue;
    }
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
        ![...bounds.min, ...bounds.max].every(Number.isFinite)) {
      unsupported = true;
      continue;
    }
    const m = parseMatrix(text(geo, 'Matrix'));
    for (const gx of [bounds.min[0], bounds.max[0]]) for (const gy of [bounds.min[1], bounds.max[1]]) for (const gz of [bounds.min[2], bounds.max[2]]) {
      const lx = gx, ly = -gz, lz = gy;
      const x = m.o.x / 1000 + m.u.x * lx + m.v.x * ly + m.w.x * lz;
      const z = m.o.z / 1000 + m.u.z * lx + m.v.z * ly + m.w.z * lz;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
  }
  const width = maxX - minX, height = maxZ - minZ;
  const resolved = Number.isFinite(width) && Number.isFinite(height) && width <= 1000 && height <= 1000
    ? { width, height, cx: (minX + maxX) / 2, cy: (minZ + maxZ) / 2 }
    : undefined;
  return { bounds: resolved, unsupported };
}

const close = (a: MvrMatrix, b: MvrMatrix) =>
  (['u', 'v', 'w'] as const).every((k) => ['x', 'y', 'z'].every((c) => Math.abs(a[k][c as 'x'] - b[k][c as 'x']) < 1e-3)) &&
  ['x', 'y', 'z'].every((c) => Math.abs(a.o[c as 'x'] - b.o[c as 'x']) < 1);

function itemsOf(bytes: Uint8Array): Item[] {
  return sceneItems(child(parseXml(utf8.decode(readArchive(bytes).get('generalscenedescription.xml')!.data)), 'GeneralSceneDescription'));
}

function recordUnreadable(
  items: Item[],
  verb: string,
  collector: FindingsCollector,
  severity: MvrFindingSeverity = 'warn',
) {
  const invalid = items.filter((i) => i.invalid);
  if (!invalid.length) return;
  collector.add(
    severity,
    'matrix-unreadable',
    `${plural(invalid.length, 'object')} with an unreadable or absurd matrix ${invalid.length === 1 ? 'was' : 'were'} ${verb}.`,
    invalid.length,
    invalid.map((i) => itemLabel(i.node, i.name, i.uuid, i.kind)),
  );
}

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

/** Check scene extent (before the 10 km filter) to catch feet/metres/mm scaling mix-ups and far outliers. */
function checkSceneUnits(readable: Item[], collector: FindingsCollector) {
  const primary = readable.filter((i) => i.kind === 'Fixture' || i.kind === 'Truss');
  const sample = primary.length >= 3 ? primary : readable.filter((i) => IMPORTED_KINDS.has(i.kind));
  const points = sample
    .map((item) => ({ item, pos: fromMvrPoint(item.matrix.o) }))
    .filter(({ pos }) => Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z));
  if (points.length < 2) return;

  const rawAxisSpan = (values: number[]) => {
    let min = Infinity, max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  };
  const trimmedAxisSpan = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length >= 20) {
      const lo = Math.floor(sorted.length * 0.05);
      const hi = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
      return sorted[hi] - sorted[lo];
    }
    return sorted[sorted.length - 1] - sorted[0];
  };
  const xs = points.map((p) => p.pos.x);
  const ys = points.map((p) => p.pos.y);
  const zs = points.map((p) => p.pos.z);
  const extent = Math.max(trimmedAxisSpan(xs), trimmedAxisSpan(ys), trimmedAxisSpan(zs));
  const rawExtent = Math.max(rawAxisSpan(xs), rawAxisSpan(ys), rawAxisSpan(zs));
  const labels = points
    .filter(({ item }) => item.kind === 'Fixture')
    .map(({ item }) => itemLabel(item.node, item.name, item.uuid, item.kind));

  if (extent > 500) {
    collector.add(
      'block',
      'unit-suspect',
      `Scene extent is ${extent.toFixed(1)} m (over 500 m) — check source MVR units (possible metres or micrometres written as millimetres).`,
      points.length,
      labels,
    );
    return;
  }

  if (rawExtent > 500) {
    const medianOf = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const mx = medianOf(xs), my = medianOf(ys), mz = medianOf(zs);
    const outliers = points.filter(
      ({ pos }) => Math.max(Math.abs(pos.x - mx), Math.abs(pos.y - my), Math.abs(pos.z - mz)) > 250,
    );
    const outlierDetail = outliers.length
      ? ` due to ${plural(outliers.length, 'far outlier object')}`
      : '';
    collector.add(
      'warn',
      'unit-suspect',
      `Full scene extent is ${rawExtent.toFixed(1)} m (over 500 m)${outlierDetail}; check unit scale or stray coordinates.`,
      outliers.length || points.length,
      outliers.map(({ item }) => itemLabel(item.node, item.name, item.uuid, item.kind)),
    );
  }

  const distinct = new Set(
    points.map(({ pos }) => `${Math.round(pos.x * 1000)},${Math.round(pos.y * 1000)},${Math.round(pos.z * 1000)}`),
  ).size;
  if (distinct >= 3 && extent < 0.5) {
    const feetHint = extent > 0
      ? ` (×304.8 gives ${(extent * 304.8).toFixed(1)} m, likely feet written as millimetres)`
      : '';
    collector.add(
      'block',
      'unit-suspect',
      `Scene extent is ${(extent * 1000).toFixed(1)} mm (${round3(extent)} m, under 0.5 m)${feetHint} — check source MVR units.`,
      points.length,
      labels,
    );
  }
}

function formatMovedTrusses(names: string[]): string {
  if (names.length === 1) return `Moved ${names[0]} to match the MVR file.`;
  if (names.length === 2) return `Moved ${names[0]} and ${names[1]} to match the MVR file.`;
  return `Moved ${names[0]}, ${names[1]} and ${names.length - 2} more trusses to match the MVR file.`;
}

function restore(
  payload: MvrPayload,
  root: XmlNode,
  items: Item[],
  provider: string,
  resources: Map<string, Uint8Array>,
  droppedResources: number,
  maxResourceBytes: number,
  unsupportedResources: string[],
): MvrImport {
  const maxUniverse = payload.version === 2 ? MAX_LOGICAL_DMX_UNIVERSE : 2;
  const source = parseRigJson(JSON.stringify(payload.rig), maxUniverse);
  const collector = createFindings();
  recordUnreadable(items, 'ignored', collector);

  let interchange: ShowInterchange | undefined;
  if (payload.interchange !== undefined) {
    try {
      interchange = normalizeInterchange(parseInterchange(payload.interchange));
    } catch {
      collector.add('warn', 'payload-damaged', 'The interchange metadata in this MVR file was unreadable and was left out.', 1);
    }
  }

  const byUuid = new Map(items.map((item) => [item.uuid, item]));
  // Merge truss moves made in another tool by UUID; everything else comes from the payload.
  const movedTrussNames: string[] = [];
  const refusedTrussNames: string[] = [];
  const trussTransformIgnored: string[] = [];
  const pods = source.trussPods.map((pod) => {
    const item = byUuid.get(resolveUuid(`truss:${pod.id}`, interchange));
    if (!item || item.invalid) return pod;
    const pose = readPose(item.matrix);
    const yaw = wrapDeg(pod.rotationY / DEG_TO_RAD);
    const moved = Math.hypot(pose.position.x - pod.x, pose.position.y - pod.baseY, pose.position.z - pod.z) > 0.001 ||
      Math.abs(wrapDeg(pose.yawDeg - yaw)) > 0.05;
    let nextPod = pod;
    if (moved) {
      if (!inRange(pose.position)) {
        refusedTrussNames.push(name(pod.name, 80) || pod.id);
        return pod;
      }
      movedTrussNames.push(name(pod.name, 80) || pod.id);
      const baseY = round3(pose.position.y);
      nextPod = { ...pod, x: round3(pose.position.x), z: round3(pose.position.z), baseY, rotationY: pose.yawDeg * DEG_TO_RAD,
        motorMinY: Math.min(pod.motorMinY, baseY), motorMaxY: Math.max(pod.motorMaxY, baseY) };
    }
    const mergedMatrix = poseMatrix({ x: nextPod.x, y: nextPod.baseY, z: nextPod.z }, wrapDeg(nextPod.rotationY / DEG_TO_RAD));
    if (!close(item.matrix, mergedMatrix)) {
      trussTransformIgnored.push(itemLabel(item.node, item.name || pod.name, item.uuid, 'Truss'));
    }
    return nextPod;
  });
  if (movedTrussNames.length) {
    collector.add('info', 'truss-merged', formatMovedTrusses(movedTrussNames), movedTrussNames.length, movedTrussNames);
  }
  if (refusedTrussNames.length) {
    collector.add(
      'warn',
      'coordinate-out-of-range',
      `${plural(refusedTrussNames.length, 'truss move')} beyond ${MAX_COORDINATE} m ${refusedTrussNames.length === 1 ? 'was' : 'were'} ignored.`,
      refusedTrussNames.length,
      refusedTrussNames,
    );
  }
  if (trussTransformIgnored.length) {
    collector.add(
      'warn',
      'transform-simplified',
      `${plural(trussTransformIgnored.length, 'rig truss', 'rig trusses')} had tilt, roll or scale edits that were not merged; StageForge merges truss position and yaw only.`,
      trussTransformIgnored.length,
      trussTransformIgnored,
    );
  }
  const rig = parseRigJson(JSON.stringify({ ...source, trussPods: pods }), maxUniverse);
  // The payload is untrusted too: a damaged stage overlay is left out rather than failing the open.
  let stage: NativeStage | undefined;
  let stageReadable = true;
  try {
    stage = payload.stage ? finalizeStage(rig, payload.stage) : undefined;
  } catch {
    stageReadable = false;
    collector.add('warn', 'payload-damaged', 'The StageForge screens, screen cues and layout in this file were unreadable and were left out.', 1);
  }

  // Report what the merge doesn't take: other moved objects, fixture moves, deleted/added objects, readdressing, extra breaks, renumbering.
  let expected: Item[] = [];
  let expectedAfterMove = new Map<string, Item>();
  try {
    expected = itemsOf(exportMvr(source, stageReadable ? payload.stage : undefined, '1', interchange, resources));
    if (movedTrussNames.length) {
      expectedAfterMove = new Map(
        itemsOf(exportMvr(rig, stageReadable ? stage : undefined, '1', interchange, resources)).map((i) => [i.uuid, i]),
      );
    }
  } catch {
    collector.add(
      'warn',
      'payload-damaged',
      'Could not compare the MVR scene against the embedded StageForge payload; external edits may not have been detected.',
      1,
    );
  }
  const rigTrusses = new Set(source.trussPods.map((pod) => resolveUuid(`truss:${pod.id}`, interchange)));
  const ignoredItems = expected.filter((e) => {
    const item = byUuid.get(e.uuid);
    return item && !item.invalid && !(e.kind === 'Truss' && rigTrusses.has(e.uuid)) && e.kind !== 'Fixture' && !close(item.matrix, e.matrix);
  });
  if (ignoredItems.length) {
    collector.add(
      'warn',
      'object-edit-ignored',
      `${plural(ignoredItems.length, 'other moved object')} (screens, hangs, decks, props or layout trusses) ${ignoredItems.length === 1 ? 'was' : 'were'} not merged; only rig trusses merge.`,
      ignoredItems.length,
      ignoredItems.map((e) => itemLabel(e.node, e.name, e.uuid, e.kind)),
    );
  }
  const deletedItems = expected.filter((e) => IMPORTED_KINDS.has(e.kind) && !byUuid.has(e.uuid));
  if (deletedItems.length) {
    collector.add(
      'warn',
      'object-edit-ignored',
      `${plural(deletedItems.length, 'object')} deleted in the MVR file ${deletedItems.length === 1 ? 'was' : 'were'} restored from the StageForge payload.`,
      deletedItems.length,
      deletedItems.map((e) => itemLabel(e.node, e.name, e.uuid, e.kind)),
    );
  }
  const movedFixtureItems = expected.filter((e) => {
    if (e.kind !== 'Fixture') return false;
    const item = byUuid.get(e.uuid);
    if (!item || item.invalid) return false;
    if (close(item.matrix, e.matrix)) return false;
    const afterTruss = expectedAfterMove.get(e.uuid);
    if (afterTruss && close(item.matrix, afterTruss.matrix)) return false;
    return true;
  });
  if (movedFixtureItems.length) {
    collector.add(
      'warn',
      'object-edit-ignored',
      `${plural(movedFixtureItems.length, 'fixture move')} from the MVR file ${movedFixtureItems.length === 1 ? 'was' : 'were'} not applied; StageForge places fixtures from its rig.`,
      movedFixtureItems.length,
      movedFixtureItems.map((e) => {
        const item = byUuid.get(e.uuid)!;
        return itemLabel(item.node, item.name, item.uuid, 'Fixture');
      }),
    );
  }

  const resolvedSourceRig = resolveStudioGeometry(source, stageReadable ? payload.stage?.layout : undefined).rig;
  const units = placeFixtures(resolvedSourceRig);
  const expectedNums = fixtureNumbers(resolvedSourceRig);
  const fixtures = items.filter((i) => i.kind === 'Fixture');
  const known = new Set(units.map((u) => resolveUuid(fixtureKey(u), interchange)));
  const expectedUuids = new Set(expected.map((e) => e.uuid));
  const foreignFixtures = fixtures.filter((f) => !known.has(f.uuid) && !expectedUuids.has(f.uuid));
  if (foreignFixtures.length) {
    collector.add(
      'warn',
      'object-edit-ignored',
      `${plural(foreignFixtures.length, 'fixture')} added in another tool ${foreignFixtures.length === 1 ? 'was' : 'were'} not merged.`,
      foreignFixtures.length,
      foreignFixtures.map((f) => itemLabel(f.node, f.name, f.uuid, 'Fixture')),
    );
  }
  const readdressedIds: string[] = [];
  const extraBreakIds: string[] = [];
  const renumberedIds: string[] = [];
  for (const u of units) {
    const key = fixtureKey(u);
    const uuid = resolveUuid(key, interchange);
    const item = byUuid.get(uuid);
    if (!item) continue;
    const addrs = readAddresses(item.node);
    const address = addrs[0];
    if (u.patched && (!address || address.universe !== u.universe || address.channel !== u.address)) {
      readdressedIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture'));
    }
    if (addrs.length > 1) {
      extraBreakIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture', `${addrs.length} breaks`));
    }
    const expNum = expectedNums.get(key);
    if (expNum) {
      const diff = sourceNumberDiffers(item.node, expNum);
      if (diff) renumberedIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture', diff));
    }
  }
  if (readdressedIds.length) {
    collector.add(
      'warn',
      'address-edit-ignored',
      `${plural(readdressedIds.length, 'fixture address change')} from the MVR file ${readdressedIds.length === 1 ? 'was' : 'were'} not applied; StageForge patches whole fixture groups.`,
      readdressedIds.length,
      readdressedIds,
    );
  }
  if (extraBreakIds.length) {
    collector.add(
      'warn',
      'break-dropped',
      `${plural(extraBreakIds.length, 'fixture')} had additional DMX breaks that were not applied; StageForge models one address break per fixture.`,
      extraBreakIds.length,
      extraBreakIds,
    );
  }
  if (renumberedIds.length) {
    collector.add(
      'warn',
      'fixture-number-lost',
      `${plural(renumberedIds.length, 'fixture number change')} from the MVR file ${renumberedIds.length === 1 ? 'was' : 'were'} not applied; StageForge numbers fixtures sequentially.`,
      renumberedIds.length,
      renumberedIds,
    );
  }

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
  if (recorder.truncated) {
    collector.add('warn', 'passthrough-truncated', 'Some unrecognised MVR XML exceeded the 8 MiB passthrough limit and was truncated.', 1);
  }
  if (droppedResources) {
    const limitLabel = maxResourceBytes === MAX_KEPT_RESOURCE_BYTES ? '128 MiB' : `${Math.max(1, Math.round(maxResourceBytes / 1024))} KiB`;
    collector.add(
      'warn',
      'resource-dropped',
      `${plural(droppedResources, 'archive resource')} exceeded the ${limitLabel} in-session cache limit and ${droppedResources === 1 ? 'was' : 'were'} not retained.`,
      droppedResources,
    );
  }
  if (unsupportedResources.length) {
    collector.add(
      'info',
      'resource-dropped',
      `${plural(unsupportedResources.length, 'archive file')} with an unsupported resource type ${unsupportedResources.length === 1 ? 'was' : 'were'} not retained for re-export.`,
      unsupportedResources.length,
      unsupportedResources,
    );
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
    report: {
      source: 'stageforge', provider,
      fixtures: fixtures.length,
      trusses: items.filter((i) => i.kind === 'Truss').length,
      screens: items.filter((i) => i.kind === 'VideoScreen').length,
      sceneObjects: items.filter((i) => i.kind === 'SceneObject').length,
      focusPoints: items.filter((i) => i.kind === 'FocusPoint').length,
      findings: collector.findings,
      notes: collector.notes(),
    },
  };
}

interface Unit {
  type: Hardware; model: string; x: number; y: number; z: number; standing: boolean;
  address?: { universe: number; channel: number }; parentTruss?: number;
  unsupportedAddress?: string; width?: number;
  uuid?: string; rawUuid: string; itemName: string; spec?: string; mode?: string; node: XmlNode; matrix: MvrMatrix;
}

type GdtfCacheEntry =
  | { status: 'ok'; summary: GdtfSummary }
  | { status: 'missing' }
  | { status: 'unparsed' }
  | { status: 'capped' };

/** Read an .mvr archive into a StageForge rig, stage overlay and interchange metadata. Pure: mutates no app state or input bytes. */
export function importMvr(bytes: Uint8Array, options?: ImportMvrOptions): MvrImport {
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

  const maxResourceBytes = options?.maxKeptResourceBytes !== undefined &&
    Number.isFinite(options.maxKeptResourceBytes) &&
    options.maxKeptResourceBytes >= 0
    ? Math.min(MAX_KEPT_RESOURCE_BYTES, Math.floor(options.maxKeptResourceBytes))
    : MAX_KEPT_RESOURCE_BYTES;

  // Retain GDTF profiles ahead of meshes/textures so large media cannot evict fixture profiles.
  const resources = new Map<string, Uint8Array>();
  let keptResourceBytes = 0;
  let droppedResources = 0;
  const unsupportedResources: string[] = [];
  const candidateResources: ArchiveEntry[] = [];
  for (const [lower, entry] of files) {
    if (lower === 'generalscenedescription.xml' || lower === PAYLOAD_FILE.toLowerCase()) continue;
    if (!RESOURCE_EXT.test(entry.name)) {
      unsupportedResources.push(name(entry.name, 80));
      continue;
    }
    candidateResources.push(entry);
  }
  candidateResources.sort((a, b) => Number(b.name.toLowerCase().endsWith('.gdtf')) - Number(a.name.toLowerCase().endsWith('.gdtf')));
  for (const entry of candidateResources) {
    if (keptResourceBytes + entry.data.byteLength > maxResourceBytes) {
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
    if (payload?.format === 'stageforge-mvr') {
      if (payload.version !== 1 && payload.version !== 2) throw new Error('Unsupported embedded StageForge MVR version.');
      if (payload.rig) return restore(payload, root, sceneItems(root), provider, resources, droppedResources, maxResourceBytes, unsupportedResources);
    }
    payloadFallbackNote = 'The embedded StageForge payload was unreadable; the scene was imported as a generic MVR.';
  } else if (marked && !payloadFile) {
    payloadFallbackNote = 'The embedded StageForge payload was missing; the scene was imported as a generic MVR.';
  }

  // A file from another tool: rebuild a rig from its trusses, fixtures, screens and objects,
  // while preserving UUIDs and unrecognised/unmodeled MVR XML in the interchange block.
  const recorder = createRecorder();
  captureTopLevelPassthrough(root, recorder);
  const items = sceneItems(root, recorder);

  const collector = createFindings();
  const uuids: Record<string, string> = {};
  const fixtureSpecs: Record<string, MvrFixtureSpec> = {};
  const firstLayer = list(child(child(root, 'Scene'), 'Layers'), 'Layer')[0];
  const layerUuid = canonicalUuid(attr(firstLayer, 'uuid'));
  if (layerUuid) uuids['layer:stageforge'] = layerUuid;

  const totalAllFixtures = items.filter((i) => i.kind === 'Fixture').length;
  let cumulativeDroppedFixtures = 0;
  const noteFixtureDrops = (addedDrops: number): MvrFindingSeverity => {
    cumulativeDroppedFixtures += addedDrops;
    return addedDrops > 0 && totalAllFixtures > 0 && cumulativeDroppedFixtures / totalAllFixtures > 0.1
      ? 'block'
      : 'warn';
  };

  if (payloadFallbackNote) collector.add('warn', 'payload-damaged', payloadFallbackNote, 1);
  const invalidFixtureCount = items.filter((i) => i.invalid && i.kind === 'Fixture').length;
  recordUnreadable(items, 'skipped', collector, noteFixtureDrops(invalidFixtureCount));

  const readable = items.filter((i) => !i.invalid);
  checkSceneUnits(readable, collector);

  const outOfRangeItems = readable.filter((i) => !inRange(readPose(i.matrix).position));
  if (outOfRangeItems.length) {
    const outOfRangeFixtures = outOfRangeItems.filter((i) => i.kind === 'Fixture').length;
    collector.add(
      noteFixtureDrops(outOfRangeFixtures),
      'coordinate-out-of-range',
      `${plural(outOfRangeItems.length, 'object')} more than ${MAX_COORDINATE} m from the origin ${outOfRangeItems.length === 1 ? 'was' : 'were'} skipped.`,
      outOfRangeItems.length,
      outOfRangeItems.map((i) => itemLabel(i.node, i.name, i.uuid, i.kind)),
    );
    for (const item of outOfRangeItems) {
      if (!item.capturedByAncestor) recorder.push(recorder.sceneNodes, item.kind, withBakedMatrix(item.node, item.matrix, true));
    }
  }
  const usable = readable.filter((i) => inRange(readPose(i.matrix).position));
  const bounds = new Map<string, Bounds>();
  const layerName = attr(firstLayer, 'name');
  const rig: RigConfig = { ...createBlankDesign(), name: name(layerName ?? '', 128) || `Imported ${provider} MVR` };

  const seenUuids = new Set<string>(layerUuid ? [layerUuid] : []);
  const uuidChangedIds: string[] = [];
  const trackObjectUuid = (key: string, item: Pick<Item, 'node' | 'name' | 'uuid' | 'kind'>) => {
    const u = canonicalUuid(item.uuid);
    if (!u) {
      uuidChangedIds.push(itemLabel(item.node, item.name, item.uuid, item.kind, 'missing or non-canonical UUID'));
      return;
    }
    if (seenUuids.has(u)) {
      uuidChangedIds.push(itemLabel(item.node, item.name, item.uuid, item.kind, 'duplicate UUID'));
      return;
    }
    seenUuids.add(u);
    uuids[key] = u;
  };

  const unsupportedGeometryIds: string[] = [];
  const tiltedTrusses: string[] = [];

  const trussItems = usable.filter((i) => i.kind === 'Truss');
  if (trussItems.length > MAX_IMPORTED_TRUSSES) {
    const droppedTrusses = trussItems.slice(MAX_IMPORTED_TRUSSES);
    collector.add(
      'warn',
      'object-dropped',
      `Only the first ${MAX_IMPORTED_TRUSSES} of ${trussItems.length} trusses were imported.`,
      droppedTrusses.length,
      droppedTrusses.map((t) => itemLabel(t.node, t.name, t.uuid, 'Truss')),
    );
    for (const dropped of droppedTrusses) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'Truss', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
  }
  const pods = new Map<number, TrussPodConfig>();
  for (const item of trussItems.slice(0, MAX_IMPORTED_TRUSSES)) {
    const pose = readPose(item.matrix);
    if (pose.tiltDeg > 2) {
      tiltedTrusses.push(itemLabel(item.node, item.name, item.uuid, 'Truss', `${pose.tiltDeg.toFixed(1)}° tilt`));
    }
    const geo = geometryBounds(item.node, files, bounds);
    if (geo.unsupported) unsupportedGeometryIds.push(itemLabel(item.node, item.name, item.uuid, 'Truss'));
    const width = Math.max(0.5, geo.bounds?.width ?? 3);
    const cx = geo.bounds?.cx ?? 0;
    const yaw = pose.yawDeg * DEG_TO_RAD;
    const baseY = round3(pose.position.y);
    const podId = `mvr-truss-${pods.size + 1}`;
    pods.set(item.index, {
      id: podId, name: name(item.name, 128) || `Truss ${pods.size + 1}`, shape: 'box', width: round3(width),
      x: round3(pose.position.x + Math.cos(yaw) * cx), z: round3(pose.position.z - Math.sin(yaw) * cx), baseY, rotationY: yaw,
      motorized: false, motorMinY: baseY, motorMaxY: baseY, fixtures: [],
    });
    trackObjectUuid(`truss:${podId}`, item);
  }

  const gdtfCache = new Map<string, GdtfCacheEntry>();
  const gdtfBudget = { remaining: MAX_NESTED_INFLATED_BYTES, opsRemaining: MAX_GDTF_TOTAL_OPS };
  let gdtfReads = 0;
  const units: Unit[] = [];
  const allUsableFixtures = usable.filter((i) => i.kind === 'Fixture');

  let fixtureItems = allUsableFixtures;
  if (fixtureItems.length > MAX_FIXTURES) {
    const droppedFixtures = fixtureItems.slice(MAX_FIXTURES);
    collector.add(
      noteFixtureDrops(droppedFixtures.length),
      'fixture-dropped',
      `Only the first ${MAX_FIXTURES} of ${fixtureItems.length} fixtures were imported.`,
      droppedFixtures.length,
      droppedFixtures.map((f) => itemLabel(f.node, f.name, f.uuid, 'Fixture')),
    );
    for (const dropped of droppedFixtures) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'Fixture', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
    fixtureItems = fixtureItems.slice(0, MAX_FIXTURES);
  }

  const gdtfMissingIds: string[] = [];
  const gdtfUnparsedIds: string[] = [];
  const gdtfCappedIds: string[] = [];
  const multiBreakIds: string[] = [];

  for (const item of fixtureItems) {
    const spec = (text(item.node, 'GDTFSpec') ?? '').trim().split(/[\\/]/).pop()!;
    const modeName = text(item.node, 'GDTFMode')?.trim();
    const key = spec.toLowerCase();
    let entry: GdtfCacheEntry;
    if (!spec) {
      entry = { status: 'missing' };
    } else if (gdtfCache.has(key)) {
      entry = gdtfCache.get(key)!;
    } else {
      const file = files.get(key) ?? files.get(key + '.gdtf');
      if (!file) {
        entry = { status: 'missing' };
      } else if (gdtfReads >= MAX_GDTF_FILES || gdtfBudget.remaining <= 0) {
        entry = { status: 'capped' };
      } else {
        gdtfReads++;
        try {
          entry = { status: 'ok', summary: readGdtf(file.data, gdtfBudget) };
        } catch {
          entry = { status: 'unparsed' };
        }
      }
      gdtfCache.set(key, entry);
    }

    const summary = entry.status === 'ok' ? entry.summary : undefined;
    if (entry.status === 'missing') gdtfMissingIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture'));
    else if (entry.status === 'unparsed') gdtfUnparsedIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture'));
    else if (entry.status === 'capped') gdtfCappedIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture'));

    const addresses = readAddresses(item.node);
    const unsupportedAddress = addressEntries(item.node).find(({ rawValue }) =>
      rawValue && !isLogicalDmxUniverse(parseDmxAddress(rawValue)?.universe),
    )?.rawValue;
    const mode = summary && singleBreakGdtfMode(summary, modeName);
    const modeBreaks = summary ? (summary.modes.find((m) => m.name === modeName) ?? summary.modes[0])?.breaks.length ?? 0 : 0;
    if (addresses.length > 1 || modeBreaks > 1) {
      const countLabel = Math.max(addresses.length, modeBreaks);
      multiBreakIds.push(itemLabel(item.node, item.name, item.uuid, 'Fixture', `${countLabel} breaks`));
    }

    const pose = readPose(item.matrix);
    const type: Hardware = summary ? classifyGdtf(summary, modeName, pose.standing)
      : /laser/i.test(item.name) ? 'laser' : /strobe/i.test(item.name) ? 'strobe' : pose.standing ? 'floor_beam' : 'beam';
    const model = summary ? `${summary.manufacturer} ${summary.name}` : item.name.replace(/\s+\d+$/, '');
    units.push({
      type, model: name(model, 256) || 'MVR fixture', ...pose.position, standing: pose.standing,
      address: addresses[0] ? { universe: addresses[0].universe, channel: addresses[0].channel } : undefined,
      unsupportedAddress,
      width: mode?.footprint,
      parentTruss: item.parentTruss,
      uuid: canonicalUuid(item.uuid),
      rawUuid: item.uuid,
      itemName: item.name,
      spec: spec ? name(spec, 512) : undefined,
      mode: modeName ? name(modeName, 512) : undefined,
      node: item.node,
      matrix: item.matrix,
    });
  }
  if (gdtfCappedIds.length) {
    collector.add(
      'warn',
      'gdtf-unparsed',
      `Only the first ${MAX_GDTF_FILES} distinct GDTF profiles (within 128 MiB) were read; remaining fixtures were guessed from names.`,
      gdtfCappedIds.length,
      gdtfCappedIds,
    );
  }
  if (gdtfMissingIds.length) {
    collector.add(
      'warn',
      'gdtf-missing',
      `${plural(gdtfMissingIds.length, 'fixture')} referenced a missing or empty GDTF profile; fixture types were guessed from names.`,
      gdtfMissingIds.length,
      gdtfMissingIds,
    );
  }
  if (gdtfUnparsedIds.length) {
    collector.add(
      'warn',
      'gdtf-unparsed',
      `${plural(gdtfUnparsedIds.length, 'fixture')} had an unreadable GDTF profile; fixture types were guessed from names.`,
      gdtfUnparsedIds.length,
      gdtfUnparsedIds,
    );
  }
  if (multiBreakIds.length) {
    collector.add(
      'warn',
      'break-dropped',
      `${plural(multiBreakIds.length, 'fixture')} had additional DMX breaks that were dropped; StageForge models one address break per fixture.`,
      multiBreakIds.length,
      multiBreakIds,
    );
  }

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
    collector.add(
      noteFixtureDrops(droppedClusterUnits.length),
      'fixture-dropped',
      `${plural(droppedClusterUnits.length, 'fixture')} exceeded the ${MAX_IMPORTED_TRUSSES}-position limit and ${droppedClusterUnits.length === 1 ? 'was' : 'were'} left out.`,
      droppedClusterUnits.length,
      droppedClusterUnits.map((u) => itemLabel(u.node, u.itemName, u.rawUuid, 'Fixture')),
    );
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
  const toPatch: Array<{ group: MountedFixtureGroup | FloorFxUnit; key: string; unit: Unit }> = [];
  const sourceByKey = new Map<string, Unit>();
  const genericReserveIds: string[] = [];
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
    const defaultWidth = groupFootprint({ type: unit.type });
    const group = { id: `mvr-${index + 1}`, type: unit.type, modelName: unit.model, count: 1,
      dmxUniverse: 1 as LogicalDmxUniverse, dmxStartChannel: 513,
      ...(unit.width !== undefined && unit.width !== defaultWidth ? { dmxChannels: unit.width } : {}), ...extra };
    const fKey = fixtureKey({ podId, group: group as MountedFixtureGroup | FloorFxUnit, index: 0 });
    sourceByKey.set(fKey, unit);
    if (unit.spec) fixtureSpecs[fKey] = { spec: unit.spec, mode: unit.mode ?? '' };
    captureFixtureExtras(fKey, unit.node);
    if (unit.width === undefined && !unit.unsupportedAddress) {
      const width = groupFootprint(group);
      genericReserveIds.push(itemLabel(unit.node, unit.itemName, unit.rawUuid, 'Fixture', `${width} reserved slots`));
    }
    if (!unit.unsupportedAddress && unit.address && isLogicalDmxUniverse(unit.address.universe)) {
      group.dmxUniverse = unit.address.universe;
      group.dmxStartChannel = unit.address.channel;
    } else {
      // Off the end of the universe until re-patched below, so it claims no channels meanwhile.
      toPatch.push({ group: group as MountedFixtureGroup | FloorFxUnit, key: fKey, unit });
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

  // Unpatched fixtures retain the legacy auto-allocation behavior. Explicit unsupported addresses are never reassigned.
  for (const { group, unit } of toPatch) {
    if (unit.unsupportedAddress) continue;
    const patch = allocateDmx(rig, group, 1, 2);
    if (patch) {
      group.dmxUniverse = patch.dmxUniverse;
      group.dmxStartChannel = patch.dmxStartChannel;
    }
  }
  const unsupported = toPatch.filter(({ unit }) => unit.unsupportedAddress);
  const assignedUnpatched = toPatch.filter(({ group, unit }) => group.dmxStartChannel <= 512 && !unit.unsupportedAddress);
  if (unsupported.length) {
    collector.add(
      'block',
      'universe-unsupported',
      `${plural(unsupported.length, 'fixture')} had a DMX address outside the supported U1–U16 range or an invalid channel. Correct the patch in the source MVR and import again.`,
      unsupported.length,
      unsupported.map(({ unit }) => itemLabel(unit.node, unit.itemName, unit.rawUuid, 'Fixture',
        `Unsupported address ${name(unit.unsupportedAddress ?? '', 80)}`,
      )),
    );
  }
  if (genericReserveIds.length) collector.add('warn', 'gdtf-generic-reserve',
    `${plural(genericReserveIds.length, 'fixture')} used a generic StageForge reservation because no supported GDTF mode was available. Reserved widths are listed below.`,
    genericReserveIds.length, genericReserveIds);
  if (assignedUnpatched.length) {
    collector.add(
      'info',
      'address-assigned',
      `${plural(assignedUnpatched.length, 'unpatched fixture')} took free addresses in universes 1–2.`,
      assignedUnpatched.length,
      assignedUnpatched.map(({ unit, group }) =>
        itemLabel(unit.node, unit.itemName, unit.rawUuid, 'Fixture', `→ U${group.dmxUniverse}.${group.dmxStartChannel}`),
      ),
    );
  }

  const unplaced = toPatch.filter(({ group }) => group.dmxStartChannel > 512);
  if (unplaced.length) {
    const drop = new Set(unplaced.map(({ group }) => group));
    for (const entry of unplaced) {
      sourceByKey.delete(entry.key);
      delete fixtureSpecs[entry.key];
      delete recorder.objectExtras[entry.key];
      recorder.push(recorder.sceneNodes, 'Fixture', withBakedMatrix(entry.unit.node, entry.unit.matrix, true));
    }
    rig.trussPods = rig.trussPods.map((pod) => ({ ...pod, fixtures: pod.fixtures.filter((g) => !drop.has(g)) }));
    rig.floorFx = rig.floorFx.filter((g) => !drop.has(g));
    const noRoom = unplaced.filter(({ unit }) => !unit.unsupportedAddress);
    if (noRoom.length) collector.add(
      noteFixtureDrops(noRoom.length),
      'fixture-dropped',
      `${plural(noRoom.length, 'fixture')} did not fit in two universes and ${noRoom.length === 1 ? 'was' : 'were'} left out.`,
      noRoom.length,
      noRoom.map(({ unit }) => itemLabel(unit.node, unit.itemName, unit.rawUuid, 'Fixture')),
    );
  }

  const finalRig = parseRigJson(JSON.stringify(rig), MAX_LOGICAL_DMX_UNIVERSE);
  const normalizedRig = normalizeDesign(finalRig);
  const placedUnits = placeFixtures(normalizedRig);
  const exportedNumbers = fixtureNumbers(normalizedRig);

  // Record UUIDs for surviving placed fixtures in placement order and detect missing/duplicate UUIDs.
  for (const placed of placedUnits) {
    const key = fixtureKey(placed);
    const src = sourceByKey.get(key);
    if (!src) continue;
    trackObjectUuid(key, { node: src.node, name: src.itemName, uuid: src.rawUuid, kind: 'Fixture' });
  }

  const overlappingUnits = placedUnits.filter((u) => !u.patched);
  const overlappingGroupCount = new Set(overlappingUnits.map((u) => u.group)).size;
  if (overlappingGroupCount) {
    collector.add(
      'warn',
      'patch-overlap',
      `${plural(overlappingGroupCount, 'fixture')} overlap in StageForge's simulated patch (it reserves a fixed footprint per type).`,
      overlappingGroupCount,
      overlappingUnits.map((u) => {
        const src = sourceByKey.get(fixtureKey(u));
        return src ? itemLabel(src.node, src.itemName, src.rawUuid, 'Fixture') : u.group.modelName;
      }),
    );
  }

  // Check console fixture numbers against StageForge's sequential export numbering.
  const lostNumberIds: string[] = [];
  for (const placed of placedUnits) {
    const key = fixtureKey(placed);
    const src = sourceByKey.get(key);
    const exp = exportedNumbers.get(key);
    if (!src || !exp) continue;
    const diff = sourceNumberDiffers(src.node, exp);
    if (diff) lostNumberIds.push(itemLabel(src.node, src.itemName, src.rawUuid, 'Fixture', diff));
  }
  if (lostNumberIds.length) {
    collector.add(
      'warn',
      'fixture-number-lost',
      `${plural(lostNumberIds.length, 'fixture')} will be renumbered sequentially (1–${placedUnits.length}); StageForge does not store custom console fixture numbers.`,
      lostNumberIds.length,
      lostNumberIds,
    );
  }

  // Measure actual 3D position and orientation deltas between source MVR world matrices and placeFixtures(normalizedRig).
  interface DriftedFixture {
    label: string;
    posDelta: number;
    rotDeg: number;
    major: boolean;
  }
  const drifted: DriftedFixture[] = [];
  let majorCount = 0;
  let worstPos = 0;
  let worstDeg = 0;
  let anyMirrored = false;
  let anyDegenerate = false;

  for (const placed of placedUnits) {
    const src = sourceByKey.get(fixtureKey(placed));
    if (!src) continue;
    const srcPos = fromMvrPoint(src.matrix.o);
    const posDelta = Math.hypot(placed.position.x - srcPos.x, placed.position.y - srcPos.y, placed.position.z - srcPos.z);
    const targetMatrix = poseMatrix(placed.position, (placed.yaw * 180) / Math.PI, placed.floor);
    const rot = matrixRotationDeltaDeg(src.matrix, targetMatrix);
    if (posDelta > worstPos) worstPos = posDelta;
    if (!rot.degenerate && rot.deg > worstDeg) worstDeg = rot.deg;
    if (rot.mirrored) anyMirrored = true;
    if (rot.degenerate) anyDegenerate = true;

    const isMajor = posDelta > 0.5;
    if (isMajor) majorCount++;
    if (posDelta > 0.05 || rot.deg > 2 || rot.degenerate || rot.mirrored) {
      const detailParts: string[] = [];
      if (posDelta > 0.05) detailParts.push(`${posDelta.toFixed(2)} m`);
      if (rot.degenerate) detailParts.push('degenerate matrix');
      else if (rot.mirrored) detailParts.push(`mirrored, ${rot.deg.toFixed(1)}°`);
      else if (rot.deg > 2) detailParts.push(`${rot.deg.toFixed(1)}°`);
      drifted.push({
        label: itemLabel(src.node, src.itemName, src.rawUuid, 'Fixture', detailParts.join(', ')),
        posDelta,
        rotDeg: rot.deg,
        major: isMajor,
      });
    }
  }
  if (drifted.length) {
    drifted.sort((a, b) => b.posDelta - a.posDelta || b.rotDeg - a.rotDeg);
    const isBlock = placedUnits.length > 0 && majorCount / placedUnits.length > 0.1;
    const pct = Math.round((majorCount / Math.max(1, placedUnits.length)) * 100);
    const flags = [anyMirrored ? 'mirrored' : '', anyDegenerate ? 'degenerate' : ''].filter(Boolean);
    const flagSuffix = flags.length ? ` (${flags.join(', ')})` : '';
    let msg = `${drifted.length} of ${placedUnits.length} ${placedUnits.length === 1 ? 'fixture' : 'fixtures'} will sit more than 0.05 m or 2° from the MVR file (worst ${worstPos.toFixed(2)} m, ${worstDeg.toFixed(1)}°)${flagSuffix}`;
    if (majorCount > 0) msg += `; ${majorCount} (${pct}%) move more than 0.5 m`;
    collector.add(
      isBlock ? 'block' : 'warn',
      'transform-simplified',
      msg + '.',
      drifted.length,
      drifted.map((d) => d.label),
    );
  }
  if (tiltedTrusses.length) {
    collector.add(
      'warn',
      'transform-simplified',
      `${plural(tiltedTrusses.length, 'tilted truss', 'tilted trusses')} ${tiltedTrusses.length === 1 ? 'was' : 'were'} laid level.`,
      tiltedTrusses.length,
      tiltedTrusses,
    );
  }

  let stage: NativeStage | undefined;
  const screens = usable.filter((i) => i.kind === 'VideoScreen');
  screens.slice(0, MAX_STAGE_WALLS).forEach((item, i) => {
    const pose = readPose(item.matrix);
    const geo = geometryBounds(item.node, files, bounds);
    if (geo.unsupported) unsupportedGeometryIds.push(itemLabel(item.node, item.name, item.uuid, 'VideoScreen'));
    const yaw = pose.yawDeg * DEG_TO_RAD;
    const cx = geo.bounds?.cx ?? 0;
    const wallId = `mvr-screen-${i + 1}`;
    stage = upsertStageWall(finalRig, stage, {
      id: wallId, label: name(item.name, 512) || `Screen ${i + 1}`,
      x: pose.position.x + Math.cos(yaw) * cx, y: pose.position.y + (geo.bounds?.cy ?? 0), z: pose.position.z - Math.sin(yaw) * cx,
      width: geo.bounds?.width ?? 3, height: geo.bounds?.height ?? 2, yaw: pose.yawDeg,
    });
    trackObjectUuid(`wall:${wallId}`, item);
  });
  if (screens.length > MAX_STAGE_WALLS) {
    const droppedScreens = screens.slice(MAX_STAGE_WALLS);
    collector.add(
      'warn',
      'object-dropped',
      `Only ${MAX_STAGE_WALLS} of ${screens.length} video screens were imported.`,
      droppedScreens.length,
      droppedScreens.map((s) => itemLabel(s.node, s.name, s.uuid, 'VideoScreen')),
    );
    for (const dropped of droppedScreens) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'VideoScreen', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
  }
  const objects = usable.filter((i) => i.kind === 'SceneObject');
  const props: LayoutProp[] = objects.slice(0, MAX_LAYOUT_ITEMS).map((item, i) => {
    const pose = readPose(item.matrix);
    const geo = geometryBounds(item.node, files, bounds);
    if (geo.unsupported) unsupportedGeometryIds.push(itemLabel(item.node, item.name, item.uuid, 'SceneObject'));
    trackObjectUuid(`prop:${i}`, item);
    return { x: pose.position.x, z: pose.position.z, type: 'scenic', height: Math.max(0.1, geo.bounds?.height ?? 2) };
  });
  if (props.length) stage = setLayoutProps(finalRig, stage, props);
  if (objects.length > MAX_LAYOUT_ITEMS) {
    const droppedObjects = objects.slice(MAX_LAYOUT_ITEMS);
    collector.add(
      'warn',
      'object-dropped',
      `Only ${MAX_LAYOUT_ITEMS} of ${objects.length} scene objects were imported as props.`,
      droppedObjects.length,
      droppedObjects.map((o) => itemLabel(o.node, o.name, o.uuid, 'SceneObject')),
    );
    for (const dropped of droppedObjects) {
      if (!dropped.capturedByAncestor) recorder.push(recorder.sceneNodes, 'SceneObject', withBakedMatrix(dropped.node, dropped.matrix, true));
    }
  }

  if (unsupportedGeometryIds.length) {
    collector.add(
      'info',
      'geometry-unsupported',
      `${plural(unsupportedGeometryIds.length, 'object')} used non-GLB, symbol or unreadable geometry and fell back to default dimensions.`,
      unsupportedGeometryIds.length,
      unsupportedGeometryIds,
    );
  }
  if (uuidChangedIds.length) {
    collector.add(
      'warn',
      'uuid-changed',
      `${plural(uuidChangedIds.length, 'object')} had a missing, non-canonical or duplicate UUID and will be assigned a new UUID on export.`,
      uuidChangedIds.length,
      uuidChangedIds,
    );
  }

  const focusPointItems = usable.filter((i) => i.kind === 'FocusPoint');
  for (const item of focusPointItems) {
    if (!item.capturedByAncestor) {
      recorder.push(recorder.sceneNodes, 'FocusPoint', withBakedMatrix(item.node, item.matrix, hasImportedKind(child(item.node, 'ChildList'))));
    }
  }
  if (focusPointItems.length) {
    collector.add(
      'info',
      'object-skipped',
      `${plural(focusPointItems.length, 'focus point')} ${focusPointItems.length === 1 ? 'was' : 'were'} skipped; StageForge derives focus points from the decks.`,
      focusPointItems.length,
    );
  }

  const skippedItems = usable.filter((i) => i.kind === 'Support' || i.kind === 'Projector');
  for (const item of skippedItems) {
    if (!item.capturedByAncestor) {
      recorder.push(recorder.sceneNodes, item.kind, withBakedMatrix(item.node, item.matrix, hasImportedKind(child(item.node, 'ChildList'))));
    }
  }
  if (skippedItems.length) {
    collector.add(
      'info',
      'object-skipped',
      `${plural(skippedItems.length, 'support or projector object')} ${skippedItems.length === 1 ? 'was' : 'were'} skipped.`,
      skippedItems.length,
    );
  }
  if (recorder.flattenedGroups) {
    collector.add(
      'info',
      'hierarchy-flattened',
      `${plural(recorder.flattenedGroups, 'GroupObject wrapper')} containing imported gear ${recorder.flattenedGroups === 1 ? 'was' : 'were'} flattened.`,
      recorder.flattenedGroups,
    );
  }
  if (recorder.truncated) {
    collector.add('warn', 'passthrough-truncated', 'Some unrecognised MVR XML exceeded the 8 MiB passthrough limit and was truncated.', 1);
  }
  if (droppedResources) {
    const limitLabel = maxResourceBytes === MAX_KEPT_RESOURCE_BYTES ? '128 MiB' : `${Math.max(1, Math.round(maxResourceBytes / 1024))} KiB`;
    collector.add(
      'warn',
      'resource-dropped',
      `${plural(droppedResources, 'archive resource')} exceeded the ${limitLabel} in-session cache limit and ${droppedResources === 1 ? 'was' : 'were'} not retained.`,
      droppedResources,
    );
  }
  if (unsupportedResources.length) {
    collector.add(
      'info',
      'resource-dropped',
      `${plural(unsupportedResources.length, 'archive file')} with an unsupported resource type ${unsupportedResources.length === 1 ? 'was' : 'were'} not retained for re-export.`,
      unsupportedResources.length,
      unsupportedResources,
    );
  }

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
    report: {
      source: 'mvr', provider,
      fixtures: fixtureItems.length,
      trusses: pods.size,
      screens: screens.length,
      sceneObjects: objects.length,
      focusPoints: focusPointItems.length,
      findings: collector.findings,
      notes: collector.notes(),
    },
  };
}
