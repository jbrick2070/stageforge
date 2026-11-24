import type { NativeStage } from '../../data/showFile';
import type { FloorFxUnit, MountedFixtureGroup, RigConfig, TrussPodConfig } from '../../types/show';
import { createBlankDesign } from '../../data/stageDesign';
import { parseRigJson } from '../../data/rigImport';
import { allocateDmx } from '../../data/dmxPatch';
import { finalizeStage, MAX_LAYOUT_ITEMS, setLayoutProps } from '../../data/stagePlan';
import { MAX_STAGE_WALLS, upsertStageWall, type LayoutProp } from '../../data/studioGeometry';
import { placeFixtures } from '../../data/fixturePlacement';
import { readArchive, utf8, type ArchiveEntry } from './archive';
import { compose, IDENTITY, parseMatrix, readMatrix, readPose, type MvrMatrix } from './coords';
import { classifyGdtf, readGdtf, type GdtfSummary, type Hardware } from './gdtf';
import { glbBounds } from './glb';
import { attr, child, list, parseXml, text, type XmlNode } from './xml';
import { exportMvr, fixtureKey, PAYLOAD_FILE, PAYLOAD_PROVIDER, stageforgeUuid, type MvrPayload } from './exportMvr';

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
  report: MvrImportReport;
}

type Kind = 'Fixture' | 'Truss' | 'VideoScreen' | 'SceneObject' | 'FocusPoint' | 'Support' | 'Projector';
interface Item {
  kind: Kind; node: XmlNode; uuid: string; name: string; matrix: MvrMatrix; parentTruss?: number; index: number;
  /** Its own matrix, or one it is nested in, is malformed or absurd, so its placement is unknown. */
  invalid: boolean;
}

const KINDS: Kind[] = ['Fixture', 'Truss', 'VideoScreen', 'SceneObject', 'FocusPoint', 'Support', 'Projector'];
const RAD = Math.PI / 180;
const MAX_FIXTURES = 1024;
export const MAX_IMPORTED_TRUSSES = 256;
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

/** Real scenes nest a few levels; deeper nesting is a malformed or hostile file. */
const MAX_DEPTH = 32;

function collect(childList: XmlNode | undefined, parent: MvrMatrix, out: Item[], parentTruss: number | undefined, depth: number, invalid: boolean) {
  if (!childList || depth > MAX_DEPTH) return;
  for (const group of list(childList, 'GroupObject')) {
    const own = readMatrix(text(group, 'Matrix'));
    collect(child(group, 'ChildList'), compose(parent, own ?? IDENTITY), out, parentTruss, depth + 1, invalid || !own);
  }
  for (const kind of KINDS) {
    for (const node of list(childList, kind)) {
      const own = readMatrix(text(node, 'Matrix'));
      const matrix = compose(parent, own ?? IDENTITY);
      const index = out.length;
      out.push({ kind, node, uuid: normUuid(attr(node, 'uuid')), name: attr(node, 'name') ?? '', matrix, parentTruss, index, invalid: invalid || !own });
      collect(child(node, 'ChildList'), matrix, out, kind === 'Truss' ? index : parentTruss, depth + 1, invalid || !own);
    }
  }
}

/** Every placed object in the scene's layers, with world matrices. */
function sceneItems(root: XmlNode | undefined): Item[] {
  const out: Item[] = [];
  for (const layer of list(child(child(root, 'Scene'), 'Layers'), 'Layer')) {
    const own = readMatrix(text(layer, 'Matrix'));
    collect(child(layer, 'ChildList'), own ?? IDENTITY, out, undefined, 0, !own);
  }
  return out;
}

/** First DMX address of a fixture: an absolute integer, or the legacy "universe.channel" text. */
export function readAddress(node: XmlNode): { universe: number; channel: number } | undefined {
  const raw = child(node, 'Addresses')?.['Address'];
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const first = entries
    .map((a) => (a && typeof a === 'object'
      ? { brk: Number(attr(a, 'break') ?? 0), value: String((a as XmlNode)['#text'] ?? '').trim() }
      : { brk: 0, value: String(a ?? '').trim() }))
    .filter((a) => a.value && Number.isFinite(a.brk))
    .sort((a, b) => a.brk - b.brk)[0]?.value;
  if (!first) return undefined;
  if (/^\d+\.\d+$/.test(first)) {
    const [universe, channel] = first.split('.').map(Number);
    return universe >= 1 && universe <= 32768 && channel >= 1 && channel <= 512 ? { universe, channel } : undefined;
  }
  if (!/^\d+$/.test(first)) return undefined;
  const abs = Number(first);
  if (!Number.isSafeInteger(abs) || abs < 1 || abs > 32768 * 512) return undefined;
  return { universe: Math.floor((abs - 1) / 512) + 1, channel: ((abs - 1) % 512) + 1 };
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
      cache.set(file, entry ? glbBounds(entry.data) : undefined);
    }
    const bounds = cache.get(file);
    if (!bounds || ![...bounds.min, ...bounds.max].every(Number.isFinite)) continue;
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

function restore(payload: MvrPayload, items: Item[], provider: string): MvrImport {
  const source = parseRigJson(JSON.stringify(payload.rig));
  const notes: string[] = unreadableNote(items, 'ignored');
  const byUuid = new Map(items.map((item) => [item.uuid, item]));
  // Merge truss moves made in another tool by UUID; everything else comes from the payload.
  let refused = 0;
  const pods = source.trussPods.map((pod) => {
    const item = byUuid.get(stageforgeUuid(`truss:${pod.id}`));
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
    expected = itemsOf(exportMvr(source, stageReadable ? payload.stage : undefined));
  } catch {
    // A payload that no longer exports cleanly just skips this note.
  }
  const rigTrusses = new Set(source.trussPods.map((pod) => stageforgeUuid(`truss:${pod.id}`)));
  const ignored = expected.filter((e) => {
    const item = byUuid.get(e.uuid);
    return item && !item.invalid && !(e.kind === 'Truss' && rigTrusses.has(e.uuid)) && e.kind !== 'Fixture' && !close(item.matrix, e.matrix);
  }).length;
  if (ignored) notes.push(`${plural(ignored, 'other moved object')} (screens, hangs, decks, props or layout trusses) ${ignored === 1 ? 'was' : 'were'} not merged; only rig trusses merge.`);
  const units = placeFixtures(rig);
  const fixtures = items.filter((i) => i.kind === 'Fixture');
  const known = new Set(units.map((u) => stageforgeUuid(fixtureKey(u))));
  const foreign = fixtures.filter((f) => !known.has(f.uuid)).length;
  if (foreign) notes.push(`${plural(foreign, 'fixture')} added in another tool ${foreign === 1 ? 'was' : 'were'} not merged.`);
  const readdressed = units.filter((u) => {
    const item = byUuid.get(stageforgeUuid(fixtureKey(u)));
    const address = item && readAddress(item.node);
    return address && u.patched && (address.universe !== u.universe || address.channel !== u.address);
  }).length;
  if (readdressed) notes.push(`${plural(readdressed, 'fixture address change')} from the MVR file ${readdressed === 1 ? 'was' : 'were'} not applied; StageForge patches whole fixture groups.`);
  return {
    rig, stage,
    report: { source: 'stageforge', provider, fixtures: fixtures.length, trusses: items.filter((i) => i.kind === 'Truss').length,
      screens: items.filter((i) => i.kind === 'VideoScreen').length, sceneObjects: items.filter((i) => i.kind === 'SceneObject').length,
      focusPoints: items.filter((i) => i.kind === 'FocusPoint').length, notes },
  };
}

interface Unit { type: Hardware; model: string; x: number; y: number; z: number; standing: boolean; address?: { universe: number; channel: number }; parentTruss?: number }

/** Read an .mvr archive into a StageForge rig and stage overlay. */
export function importMvr(bytes: Uint8Array): MvrImport {
  const files = readArchive(bytes);
  const scene = files.get('generalscenedescription.xml');
  if (!scene) throw new Error('This MVR file has no GeneralSceneDescription.xml.');
  const doc = parseXml(utf8.decode(scene.data));
  const root = child(doc, 'GeneralSceneDescription');
  if (!root) throw new Error('This MVR file has no GeneralSceneDescription.');
  if (Number(attr(root, 'verMajor')) !== 1) throw new Error(`MVR version ${attr(root, 'verMajor')}.${attr(root, 'verMinor')} is not supported.`);
  const provider = name(attr(root, 'provider') ?? 'unknown', 64) || 'unknown';
  const items = sceneItems(root);

  const marked = list(child(root, 'UserData'), 'Data').some((d) => attr(d, 'provider') === PAYLOAD_PROVIDER);
  const payloadFile = files.get(PAYLOAD_FILE.toLowerCase());
  if (marked && payloadFile) {
    let payload: MvrPayload | undefined;
    try {
      payload = JSON.parse(utf8.decode(payloadFile.data));
    } catch {
      payload = undefined;
    }
    if (payload?.format === 'stageforge-mvr' && payload.version === 1 && payload.rig) return restore(payload, items, provider);
  }

  // A file from another tool: rebuild a rig from its trusses, fixtures, screens and objects.
  const notes: string[] = unreadableNote(items, 'skipped');
  const readable = items.filter((i) => !i.invalid);
  const outOfRange = readable.filter((i) => !inRange(readPose(i.matrix).position)).length;
  if (outOfRange) notes.push(`${plural(outOfRange, 'object')} more than ${MAX_COORDINATE} m from the origin ${outOfRange === 1 ? 'was' : 'were'} skipped.`);
  const usable = readable.filter((i) => inRange(readPose(i.matrix).position));
  const bounds = new Map<string, Bounds>();
  const layerName = attr(list(child(child(root, 'Scene'), 'Layers'), 'Layer')[0], 'name');
  const rig: RigConfig = { ...createBlankDesign(), name: name(layerName ?? '', 128) || `Imported ${provider} MVR` };

  const trussItems = usable.filter((i) => i.kind === 'Truss');
  if (trussItems.length > MAX_IMPORTED_TRUSSES) notes.push(`Only the first ${MAX_IMPORTED_TRUSSES} of ${trussItems.length} trusses were imported.`);
  const pods = new Map<number, TrussPodConfig>();
  for (const item of trussItems.slice(0, MAX_IMPORTED_TRUSSES)) {
    const pose = readPose(item.matrix);
    const geometry = geometryBounds(item.node, files, bounds);
    const width = Math.max(0.5, geometry?.width ?? 3);
    const cx = geometry?.cx ?? 0;
    const yaw = pose.yawDeg * RAD;
    const baseY = round3(pose.position.y);
    pods.set(item.index, {
      id: `mvr-truss-${pods.size + 1}`, name: name(item.name, 128) || `Truss ${pods.size + 1}`, shape: 'box', width: round3(width),
      x: round3(pose.position.x + Math.cos(yaw) * cx), z: round3(pose.position.z - Math.sin(yaw) * cx), baseY, rotationY: yaw,
      motorized: false, motorMinY: baseY, motorMaxY: baseY, fixtures: [],
    });
  }

  const gdtfCache = new Map<string, GdtfSummary | null>();
  const units: Unit[] = [];
  let fixtureItems = usable.filter((i) => i.kind === 'Fixture');
  if (fixtureItems.length > MAX_FIXTURES) {
    notes.push(`Only the first ${MAX_FIXTURES} of ${fixtureItems.length} fixtures were imported.`);
    fixtureItems = fixtureItems.slice(0, MAX_FIXTURES);
  }
  for (const item of fixtureItems) {
    const spec = (text(item.node, 'GDTFSpec') ?? '').trim().split(/[\\/]/).pop()!;
    const key = spec.toLowerCase();
    if (spec && !gdtfCache.has(key)) {
      const file = files.get(key) ?? files.get(key + '.gdtf');
      try {
        gdtfCache.set(key, file ? readGdtf(file.data) : null);
      } catch {
        gdtfCache.set(key, null);
      }
    }
    const summary = spec ? gdtfCache.get(key) : null;
    const pose = readPose(item.matrix);
    const type: Hardware = summary ? classifyGdtf(summary, text(item.node, 'GDTFMode'), pose.standing)
      : /laser/i.test(item.name) ? 'laser' : /strobe/i.test(item.name) ? 'strobe' : pose.standing ? 'floor_beam' : 'beam';
    const model = summary ? `${summary.manufacturer} ${summary.name}` : item.name.replace(/\s+\d+$/, '');
    units.push({ type, model: name(model, 256) || 'MVR fixture', ...pose.position, standing: pose.standing,
      address: readAddress(item.node), parentTruss: item.parentTruss });
  }
  const missingProfiles = [...gdtfCache.values()].filter((v) => v === null).length;
  if (missingProfiles) notes.push(`${plural(missingProfiles, 'GDTF profile')} ${missingProfiles === 1 ? 'was' : 'were'} missing or unreadable; fixture types were guessed from names.`);

  // Hung units go to their parent truss, the nearest truss, or a new position bar per height and depth.
  const clusters = new Map<string, TrussPodConfig>();
  const hungOn = new Map<TrussPodConfig, Unit[]>();
  const floor: Unit[] = [];
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
        const baseY = round3(unit.y + 0.28);
        pod = { id: `mvr-position-${clusters.size + 1}`, name: `Imported position ${clusters.size + 1}`, shape: 'box', width: 2,
          x: unit.x, z: round3(unit.z), baseY, rotationY: 0, motorized: false, motorMinY: baseY, motorMaxY: baseY, fixtures: [] };
        clusters.set(key, pod);
      }
    }
    if (!hungOn.has(pod)) hungOn.set(pod, []);
    hungOn.get(pod)!.push(unit);
  }
  for (const pod of clusters.values()) {
    const xs = hungOn.get(pod)!.map((u) => u.x);
    const left = Math.min(...xs), right = Math.max(...xs);
    pod.x = round3((left + right) / 2);
    pod.width = round3(Math.max(2, right - left + 1.3));
  }

  const toPatch: Array<{ group: MountedFixtureGroup | FloorFxUnit; type: Hardware }> = [];
  const groupOf = (unit: Unit, index: number, extra: Partial<FloorFxUnit> = {}) => {
    const group = { id: `mvr-${index + 1}`, type: unit.type, modelName: unit.model, count: 1,
      dmxUniverse: 1 as 1 | 2, dmxStartChannel: 513, ...extra };
    if (unit.address && unit.address.universe <= 2) {
      group.dmxUniverse = unit.address.universe as 1 | 2;
      group.dmxStartChannel = unit.address.channel;
    } else {
      // Off the end of the universe until re-patched below, so it claims no channels meanwhile.
      toPatch.push({ group: group as MountedFixtureGroup | FloorFxUnit, type: unit.type });
    }
    return group;
  };
  let n = 0;
  const allPods = [...pods.values(), ...clusters.values()];
  const along = (pod: TrussPodConfig, u: Unit) => (u.x - pod.x) * Math.cos(pod.rotationY) - (u.z - pod.z) * Math.sin(pod.rotationY);
  for (const pod of allPods) {
    const hung = (hungOn.get(pod) ?? []).sort((a, b) => along(pod, a) - along(pod, b));
    pod.fixtures = hung.map((unit) => groupOf(unit, n++) as MountedFixtureGroup);
  }
  rig.trussPods = allPods;
  rig.floorFx = floor.map((unit) => groupOf(unit, n++, { x: round3(unit.x), z: round3(unit.z), spread: 0 }) as FloorFxUnit);
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
    stage = upsertStageWall(finalRig, stage, {
      id: `mvr-screen-${i + 1}`, label: name(item.name, 512) || `Screen ${i + 1}`,
      x: pose.position.x + Math.cos(yaw) * cx, y: pose.position.y + (geometry?.cy ?? 0), z: pose.position.z - Math.sin(yaw) * cx,
      width: geometry?.width ?? 3, height: geometry?.height ?? 2, yaw: pose.yawDeg,
    });
  });
  if (screens.length > MAX_STAGE_WALLS) notes.push(`Only ${MAX_STAGE_WALLS} of ${screens.length} video screens were imported.`);
  const objects = usable.filter((i) => i.kind === 'SceneObject');
  const props: LayoutProp[] = objects.slice(0, MAX_LAYOUT_ITEMS).map((item) => {
    const pose = readPose(item.matrix);
    const geometry = geometryBounds(item.node, files, bounds);
    return { x: pose.position.x, z: pose.position.z, type: 'scenic', height: Math.max(0.1, geometry?.height ?? 2) };
  });
  if (props.length) stage = setLayoutProps(finalRig, stage, props);
  if (objects.length > MAX_LAYOUT_ITEMS) notes.push(`Only ${MAX_LAYOUT_ITEMS} of ${objects.length} scene objects were imported as props.`);
  const focusPoints = usable.filter((i) => i.kind === 'FocusPoint').length;
  if (focusPoints) notes.push(`${plural(focusPoints, 'focus point')} ${focusPoints === 1 ? 'was' : 'were'} skipped; StageForge derives focus points from the decks.`);
  const skipped = usable.filter((i) => i.kind === 'Support' || i.kind === 'Projector').length;
  if (skipped) notes.push(`${plural(skipped, 'support or projector object')} ${skipped === 1 ? 'was' : 'were'} skipped.`);

  return {
    rig: finalRig,
    stage: finalizeStage(finalRig, stage),
    report: { source: 'mvr', provider, fixtures: fixtureItems.length, trusses: pods.size, screens: screens.length,
      sceneObjects: objects.length, focusPoints, notes },
  };
}
