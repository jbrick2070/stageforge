import schemaV1 from '../schemas/show-v1.schema.json';
import schemaV2 from '../schemas/show-v2.schema.json';
import schemaV3 from '../schemas/show-v3.schema.json';
import schemaV4 from '../schemas/show-v4.schema.json';
import type { BumpState, CameraPreset, MusicRef, RigConfig, ScreenRef, ShowCue, ShowState } from '../types/show';
import { parseRigJson } from './rigImport';
import { focusMarks } from '../engine/focusAim';
import { laserProjectors } from './laserProjectors';

export type { MusicRef, ScreenRef } from '../types/show';
export const MAX_SHOW_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_PASSTHROUGH_BYTES = 8 * 1024 * 1024;
export const SHOW_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v1.schema.json';

const V2_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v2.schema.json';
const V3_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v3.schema.json';
export const V4_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v4.schema.json';

export interface MvrFixtureSpec {
  spec: string;
  mode: string;
}

export interface MvrPassthrough {
  userData?: string[];
  auxData?: string[];
  sceneNodes?: string[];
  objectExtras?: Record<string, string[]>;
}

export interface MvrInterchange {
  uuids?: Record<string, string>;
  synthetic?: string[];
  fixtureSpecs?: Record<string, MvrFixtureSpec>;
  passthrough?: MvrPassthrough;
}

export interface ShowInterchange {
  mvr?: MvrInterchange;
}

export interface NativeStage {
  format: 'stageforge-native-stage';
  version: 1;
  walls: Array<{ id: string; label?: string; x?: number; y?: number; z?: number; yaw?: number; width?: number; height?: number }>;
  screenEvents: Array<Omit<ScreenRef, 'target'> & { target: string; atMs: number }>;
  layout?: {
    replace?: boolean;
    trusses?: Array<{ x: number; z: number; endX: number; endZ: number; height: number }>;
    hangs?: Array<{ x: number; y: number; z: number; yaw: number; tilt: number; count: number; splay: number }>;
    props?: Array<{ x: number; z: number; type: 'inflatable' | 'scenic'; height: number }>;
  };
}

export interface ShowControls {
  camera: CameraPreset;
  volume: number;
}

export interface TimelineEvent {
  atMs: number;
  look?: Partial<ShowState>;
  cueId?: string | null;
  camera?: CameraPreset;
  volume?: number;
  bump?: BumpState;
  music?: MusicRef;
  screen?: ScreenRef;
}

export interface ShowTimeline {
  durationMs: number;
  events: TimelineEvent[];
}

export interface ShowMedia {
  music: MusicRef;
  screen: ScreenRef;
}

export function referencedFiles(media: ShowMedia | undefined, cues: ShowCue[], timeline?: ShowTimeline, stage?: NativeStage) {
  const refs = [media?.music, media?.screen, ...cues.map(cue => cue.screen),
    ...(timeline?.events.flatMap(event => [event.music, event.screen]) ?? []), ...(stage?.screenEvents ?? [])];
  const keys = new Set<string>();
  for (const ref of refs) {
    if (ref && (ref.kind === 'file' || ref.kind === 'image' || ref.kind === 'video')) {
      keys.add(ref.kind + ':' + ref.name);
    }
  }
  return keys;
}

export interface StageForgeShowFile {
  $schema: typeof SHOW_SCHEMA_URL | typeof V2_SCHEMA_URL | typeof V3_SCHEMA_URL | typeof V4_SCHEMA_URL;
  format: 'stageforge-show';
  version: 1 | 2 | 3 | 4;
  rig: RigConfig;
  cues: ShowCue[];
  look: ShowState;
  activeCueId: string | null;
  controls?: ShowControls;
  timeline?: ShowTimeline;
  media?: ShowMedia;
  stage?: NativeStage;
  interchange?: ShowInterchange;
}

// The public schema also supplies the reader's field allowlist and value bounds.
interface Rule {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Rule;
  prefixItems?: Rule[];
  required?: string[];
  properties?: Record<string, Rule>;
  propertyNames?: Rule;
  additionalProperties?: false | Rule;
  minProperties?: number;
  maxProperties?: number;
  if?: { properties: Record<string, { const?: unknown; enum?: string[] }> };
  then?: { required?: string[]; properties?: Record<string, Rule> };
}

type ShowSchema = Rule & { $defs: Record<string, Rule> };
const versions = { 1: schemaV1 as ShowSchema, 2: schemaV2 as ShowSchema, 3: schemaV3 as ShowSchema, 4: schemaV4 as ShowSchema };
const compiledPatterns = new Map<string, RegExp>();

class ShowFormatError extends Error {}

function invalid(path: string, reason: string): never {
  throw new ShowFormatError(path + ' ' + reason + '.');
}

function read(value: unknown, rule: Rule, path: string, writing: boolean, schema: ShowSchema): unknown {
  if (rule.$ref) {
    const target = schema.$defs[rule.$ref.slice('#/$defs/'.length)];
    // Look snapshots share the cue layout, with the desk fields required.
    return read(value, rule.required ? { ...target, required: rule.required } : target, path, writing, schema);
  }
  if ('const' in rule && value !== rule.const) invalid(path, 'has an unsupported value');
  if (rule.enum && !rule.enum.includes(value)) invalid(path, 'has an unsupported value');
  if (!rule.type) return value;
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(kind) && !(types.includes('integer') && Number.isSafeInteger(value)))
    invalid(path, 'must be ' + types.join(' or '));

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < (rule.minimum ?? -Infinity) ||
        value > (rule.maximum ?? Infinity) || value <= (rule.exclusiveMinimum ?? -Infinity))
      invalid(path, 'is out of range');
  } else if (typeof value === 'string') {
    if (rule.minLength !== undefined || rule.maxLength !== undefined) {
      if (rule.maxLength !== undefined && value.length > rule.maxLength * 2) invalid(path, 'has an invalid length');
      const length = [...value].length;
      if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity)) invalid(path, 'has an invalid length');
    }
    if (rule.pattern) {
      let pattern = compiledPatterns.get(rule.pattern);
      if (!pattern) compiledPatterns.set(rule.pattern, pattern = new RegExp(rule.pattern, 'u'));
      if (!pattern.test(value)) invalid(path, 'has invalid text');
    }
  } else if (Array.isArray(value)) {
    if (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity))
      invalid(path, 'has an invalid number of entries');
    return value.map((item, i) => read(item, rule.prefixItems?.[i] ?? rule.items!, path + '[' + i + ']', writing, schema));
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const required = rule.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(record, key) || record[key] === undefined) invalid(path + '.' + key, 'is required');
    }
    const conditional = rule.if && Object.entries(rule.if.properties).every(([key, condition]) =>
      condition.enum ? condition.enum.includes(record[key] as string) : record[key] === condition.const);
    if (conditional) {
      for (const key of rule.then?.required ?? []) if (!Object.hasOwn(record, key)) invalid(path + '.' + key, 'is required');
      for (const [key, child] of Object.entries(rule.then?.properties ?? {})) read(record[key], child, path + '.' + key, writing, schema);
    }
    const output: [string, unknown][] = [];
    for (const [key, item] of Object.entries(record)) {
      if (writing && item === undefined) continue;
      const child = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : rule.additionalProperties;
      if (!child) {
        if (!writing) invalid(path + '.' + key, 'is not a show field');
        continue;
      }
      if (rule.propertyNames) read(key, rule.propertyNames, path + ' key', writing, schema);
      output.push([key, read(item, child, path + '.' + key, writing, schema)]);
    }
    if (output.length < (rule.minProperties ?? 0) || output.length > (rule.maxProperties ?? Infinity))
      invalid(path, 'has an invalid number of fields');
    return Object.fromEntries(output);
  }
  return value;
}

function rigReferences(rig: RigConfig) {
  return {
    pods: new Set(rig.trussPods.map(pod => pod.id)),
    marks: new Set(focusMarks(rig).map(mark => mark.id)),
    lasers: new Set(laserProjectors(rig).map(unit => unit.key)),
  };
}
type RigReferences = ReturnType<typeof rigReferences>;

function portableLook<T extends Partial<ShowState>>(look: T, refs: RigReferences): T {
  const result = { ...look };
  if (look.laser?.projectors) {
    const projectors = Object.fromEntries(Object.entries(look.laser.projectors).filter(([key]) => refs.lasers.has(key)));
    result.laser = { ...look.laser, projectors: Object.keys(projectors).length ? projectors : undefined };
  }
  if (look.led) result.led = { ...look.led, customMediaUrl: null, customMediaType: null };
  if (look.motors) {
    result.motors = {
      ...look.motors,
      podTargets: Object.fromEntries(Object.entries(look.motors.podTargets).filter(([id]) => refs.pods.has(id))),
    };
  }
  if (look.focusMarkId && !refs.marks.has(look.focusMarkId)) result.focusMarkId = null;
  if (look.movingGroups) {
    result.movingGroups = { ...look.movingGroups };
    for (const kind of ['beam','wash'] as const) {
      const group = look.movingGroups[kind];
      if (group?.focusMarkId && !refs.marks.has(group.focusMarkId))
        result.movingGroups[kind] = { ...group, focusMarkId: null };
    }
  }
  return result;
}

function portableMedia<T extends ScreenRef | MusicRef>(ref: T): T {
  // Browsers normally return File.name. Other hosts can supply full paths.
  let name = ref.name;
  const candidate = name.trimStart();
  if (candidate.startsWith('//') || (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate))) name = '';
  name = name.split(/[\\/]/).pop()!;
  if (!name.trim() && ref.kind !== 'none') name = ref.kind === 'live' ? 'Live mic' : ref.kind === 'demo' ? 'Demo' : 'Local media';
  return { ...ref, name };
}

function checkLook(look: Partial<ShowState>, refs: RigReferences, path: string) {
  if (look.laser?.projectors && Object.keys(look.laser.projectors).some(key => !refs.lasers.has(key)))
    invalid(path + '.laser.projectors', 'contains an unknown laser projector');
  if (look.focusMarkId && !refs.marks.has(look.focusMarkId)) invalid(path + '.focusMarkId', 'does not identify a focus mark');
  for (const [kind, group] of Object.entries(look.movingGroups ?? {})) {
    if (group.focusMarkId && !refs.marks.has(group.focusMarkId))
      invalid(path + '.movingGroups.' + kind + '.focusMarkId', 'does not identify a focus mark');
  }
  if (look.motors && Object.keys(look.motors.podTargets).some(id => !refs.pods.has(id)))
    invalid(path + '.motors.podTargets', 'contains an unknown pod ID');
}

const ILLEGAL_XML_FRAGMENT_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/;
const USER_DATA_ROOT = /^<Data(?:\s|\/|>)/;
const AUX_DATA_ROOT = /^<(?:Symdef|Position|MappingDefinition|Class)(?:\s|\/|>)/;
const SCENE_NODE_ROOT = /^<(?:Support|Projector|FocusPoint|GroupObject|Fixture|Truss|VideoScreen|SceneObject)(?:\s|\/|>)/;
const OBJECT_EXTRA_ROOT = /^<[A-Za-z_][A-Za-z0-9_.:-]*(?:\s|\/|>)/;
const STAGEFORGE_PROVIDER_ATTR = /\bprovider\s*=\s*(?:"StageForge"|'StageForge')/i;

/** Strip empty containers from an interchange block so an empty block never triggers v4. */
export function normalizeInterchange(interchange?: ShowInterchange): ShowInterchange | undefined {
  if (!interchange?.mvr) return undefined;
  const src = interchange.mvr;
  const mvr: MvrInterchange = {};
  if (src.uuids && Object.keys(src.uuids).length) mvr.uuids = { ...src.uuids };
  if (src.synthetic?.length) mvr.synthetic = [...new Set(src.synthetic)];
  if (src.fixtureSpecs && Object.keys(src.fixtureSpecs).length) mvr.fixtureSpecs = { ...src.fixtureSpecs };
  if (src.passthrough) {
    const pt: MvrPassthrough = {};
    if (src.passthrough.userData?.length) pt.userData = [...src.passthrough.userData];
    if (src.passthrough.auxData?.length) pt.auxData = [...src.passthrough.auxData];
    if (src.passthrough.sceneNodes?.length) pt.sceneNodes = [...src.passthrough.sceneNodes];
    if (src.passthrough.objectExtras) {
      const extras = Object.fromEntries(
        Object.entries(src.passthrough.objectExtras).filter(([, list]) => list.length > 0).map(([k, list]) => [k, [...list]]),
      );
      if (Object.keys(extras).length) pt.objectExtras = extras;
    }
    if (Object.keys(pt).length) mvr.passthrough = pt;
  }
  return Object.keys(mvr).length ? { mvr } : undefined;
}

/** Return the opening tag slice "<Tag ...>" respecting quoted attributes, or undefined if malformed. */
function openingTagSlice(trimmed: string): string | undefined {
  if (!trimmed.startsWith('<') || !trimmed.endsWith('>')) return undefined;
  let quote = 0;
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed.charCodeAt(i);
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (ch === 34 /* '"' */ || ch === 39 /* "'" */) {
      quote = ch;
    } else if (ch === 62 /* '>' */) {
      return trimmed.slice(0, i + 1);
    }
  }
  return undefined;
}

function checkInterchange(interchange: ShowInterchange, path: string) {
  const mvr = interchange.mvr;
  if (!mvr) return;
  if (mvr.synthetic) {
    const seen = new Set<string>();
    for (const id of mvr.synthetic) {
      if (seen.has(id)) invalid(path + '.mvr.synthetic', 'contains a duplicate pod ID');
      seen.add(id);
    }
  }
  const pt = mvr.passthrough;
  if (!pt) return;
  let totalBytes = 0;
  const encoder = new TextEncoder();
  const checkFragment = (fragment: string, rootPattern: RegExp, fragPath: string, forbidStageForgeProvider = false, forbidChildList = false) => {
    const trimmed = fragment.trim();
    if (trimmed.includes('<!') || trimmed.includes('<?') || ILLEGAL_XML_FRAGMENT_CHARS.test(fragment)) {
      invalid(fragPath, 'contains disallowed XML constructs');
    }
    const openTag = openingTagSlice(trimmed);
    if (!openTag || !rootPattern.test(openTag)) invalid(fragPath, 'does not start with an allowed MVR element');
    if (forbidChildList && /^<ChildList(?:\s|\/|>)/.test(openTag)) invalid(fragPath, 'cannot contain ChildList');
    if (forbidStageForgeProvider && STAGEFORGE_PROVIDER_ATTR.test(openTag)) {
      invalid(fragPath, 'cannot spoof the StageForge UserData provider');
    }
    totalBytes += encoder.encode(fragment).length;
    if (totalBytes > MAX_PASSTHROUGH_BYTES) invalid(path + '.mvr.passthrough', 'exceeds the 8 MiB passthrough limit');
  };
  pt.userData?.forEach((frag, i) => checkFragment(frag, USER_DATA_ROOT, `${path}.mvr.passthrough.userData[${i}]`, true));
  pt.auxData?.forEach((frag, i) => checkFragment(frag, AUX_DATA_ROOT, `${path}.mvr.passthrough.auxData[${i}]`));
  pt.sceneNodes?.forEach((frag, i) => checkFragment(frag, SCENE_NODE_ROOT, `${path}.mvr.passthrough.sceneNodes[${i}]`));
  if (pt.objectExtras) {
    for (const [key, list] of Object.entries(pt.objectExtras)) {
      list.forEach((frag, i) => checkFragment(frag, OBJECT_EXTRA_ROOT, `${path}.mvr.passthrough.objectExtras.${key}[${i}]`, false, true));
    }
  }
}

/** Validate a standalone interchange block (for example from an embedded MVR payload). */
export function parseInterchange(value: unknown): ShowInterchange {
  const schema = versions[4];
  const parsed = read(value, schema.$defs.interchange, 'interchange', false, schema) as ShowInterchange;
  checkInterchange(parsed, 'interchange');
  return parsed;
}

function decode(value: unknown, writing: boolean): StageForgeShowFile {
  const version = value && typeof value === 'object' && 'version' in value ? value.version : undefined;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) invalid('show.version', 'has an unsupported value');
  const schema = versions[version];
  const show = read(value, schema, 'show', writing, schema) as StageForgeShowFile;
  // Share ID, geometry, patch count and motor-range checks with the legacy rig reader.
  const rig = parseRigJson(JSON.stringify(show.rig));
  show.rig = read(rig, schema.$defs.rig, 'show.rig', false, schema) as RigConfig;
  const refs = rigReferences(show.rig);
  const ids = new Set<string>();
  show.cues.forEach((cue, i) => {
    if (ids.has(cue.id)) invalid('show.cues[' + i + '].id', 'duplicates another cue');
    ids.add(cue.id);
    checkLook(cue.state, refs, 'show.cues[' + i + '].state');
  });
  if (show.activeCueId !== null && !ids.has(show.activeCueId)) invalid('show.activeCueId', 'does not identify a cue');
  checkLook(show.look, refs, 'show.look');
  if (show.timeline) {
    let last = 0;
    for (const [index, event] of show.timeline.events.entries()) {
      const path = 'show.timeline.events[' + index + ']';
      if (event.atMs < last || event.atMs > show.timeline.durationMs) invalid(path + '.atMs', 'falls outside the ordered timeline');
      if (event.look) checkLook(event.look, refs, path + '.look');
      last = event.atMs;
    }
  }
  if (show.stage) {
    const walls = new Set<string>();
    for (const wall of show.stage.walls) {
      if (walls.has(wall.id)) invalid('show.stage.walls', 'contains a duplicate wall ID');
      walls.add(wall.id);
    }
    let previous = 0;
    for (const [i, event] of show.stage.screenEvents.entries()) {
      const path = 'show.stage.screenEvents[' + i + ']';
      if (!walls.has(event.target) || event.target === 'main-led') invalid(path + '.target', 'must identify a secondary wall');
      if (event.atMs < previous || event.atMs > (show.timeline?.durationMs ?? 0)) invalid(path + '.atMs', 'falls outside the ordered timeline');
      previous = event.atMs;
    }
  }
  if (show.interchange) checkInterchange(show.interchange, 'show.interchange');
  return show;
}

export function makeShowFile(
  rig: RigConfig, cues: ShowCue[], look: ShowState, activeCueId: string | null,
  controls?: ShowControls, timeline?: ShowTimeline, media?: ShowMedia, stage?: NativeStage,
  interchange?: ShowInterchange,
): StageForgeShowFile {
  const refs = rigReferences(rig);
  const cleanInterchange = normalizeInterchange(interchange);
  // A browser take may end before a secondary wall's last native event.
  // Both tracks share the file's duration when either one is edited.
  const stageEnd = stage?.screenEvents.at(-1)?.atMs ?? 0;
  if (stageEnd > (timeline?.durationMs ?? 0)) timeline = { durationMs: stageEnd, events: timeline?.events ?? [] };
  const version = cleanInterchange ? 4 : stage ? 3 : 2;
  const $schema = cleanInterchange ? V4_SCHEMA_URL : stage ? V3_SCHEMA_URL : V2_SCHEMA_URL;
  const show = decode({
    $schema, format: 'stageforge-show', version, rig, stage, interchange: cleanInterchange,
    cues: cues.map(cue => ({
      ...cue, state: portableLook(cue.state, refs), screen: cue.screen && portableMedia(cue.screen),
    })),
    look: portableLook(look, refs), activeCueId, controls,
    timeline: timeline && {
      durationMs: timeline.durationMs,
      events: timeline.events.map(event => ({
        ...event, look: event.look && portableLook(event.look, refs),
        music: event.music && portableMedia(event.music), screen: event.screen && portableMedia(event.screen),
      })),
    },
    media: media && { music: portableMedia(media.music), screen: portableMedia(media.screen) },
  }, true);
  if (cleanInterchange || stage) return show;
  // Emit the oldest schema that represents every field, including saved cues and takes.
  const legacy = { ...show, version: 1 as const, $schema: SHOW_SCHEMA_URL as typeof SHOW_SCHEMA_URL };
  try {
    read(legacy, versions[1], 'show', false, versions[1]);
    return legacy;
  } catch (error) {
    if (!(error instanceof ShowFormatError)) throw error;
    return show;
  }
}

export function parseShowFile(source: string): StageForgeShowFile {
  const clean = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (clean.length > MAX_SHOW_JSON_BYTES || new TextEncoder().encode(clean).length > MAX_SHOW_JSON_BYTES) {
    throw new Error('This show JSON file exceeds the 32 MiB limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch {
    throw new Error('Choose a valid StageForge show JSON file.');
  }
  return decode(value, false);
}
