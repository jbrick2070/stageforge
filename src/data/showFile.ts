import schemaV1 from '../schemas/show-v1.schema.json';
import schemaV2 from '../schemas/show-v2.schema.json';
import schemaV3 from '../schemas/show-v3.schema.json';
import schemaV4 from '../schemas/show-v4.schema.json';
import schemaV5 from '../schemas/show-v5.schema.json';
import schemaV6 from '../schemas/show-v6.schema.json';
import schemaV7 from '../schemas/show-v7.schema.json';
import schemaV8 from '../schemas/show-v8.schema.json';
import schemaV9 from '../schemas/show-v9.schema.json';
import schemaV10 from '../schemas/show-v10.schema.json';
import schemaV11 from '../schemas/show-v11.schema.json';
import schemaV12 from '../schemas/show-v12.schema.json';
import type { BumpState, CameraPreset, MusicRef, RigConfig, ScreenRef, ShowCue, ShowState } from '../types/show';
import type { CueFadeDescriptor } from './cueFade';
import { parseRigJson } from './rigImport';
import { focusMarks } from '../engine/focusAim';
import { laserProjectors } from './laserProjectors';
import {
  allowsNegativeAmount,
  HAZE_MIN_ATTACK_MS,
  HAZE_MIN_RELEASE_MS,
  isValidAudioTargetParam,
} from '../engine/audioModulation';
import { crowdShowVersion, resolveCrowdLayout, type CrowdLayout } from './crowdPlacement';

export type { MusicRef, ScreenRef } from '../types/show';
export const MAX_SHOW_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_PASSTHROUGH_BYTES = 8 * 1024 * 1024;
export const SHOW_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v1.schema.json';

const V2_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v2.schema.json';
const V3_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v3.schema.json';
export const V4_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v4.schema.json';
export const V5_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v5.schema.json';
export const V6_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v6.schema.json';
export const V7_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v7.schema.json';
export const V8_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v8.schema.json';
export const V9_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v9.schema.json';
export const V10_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v10.schema.json';
export const V11_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v11.schema.json';
export const V12_SCHEMA_URL = 'https://jbrick2070.github.io/stageforge/schemas/show-v12.schema.json';

export type SmpteFrameRate = 24 | 25 | 29.97 | 30;

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
  cueFade?: CueFadeDescriptor;
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
  frameRate?: SmpteFrameRate;
  timecodeOffsetMs?: number;
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
  $schema: typeof SHOW_SCHEMA_URL | typeof V2_SCHEMA_URL | typeof V3_SCHEMA_URL | typeof V4_SCHEMA_URL | typeof V5_SCHEMA_URL | typeof V6_SCHEMA_URL | typeof V7_SCHEMA_URL | typeof V8_SCHEMA_URL | typeof V9_SCHEMA_URL | typeof V10_SCHEMA_URL | typeof V11_SCHEMA_URL | typeof V12_SCHEMA_URL;
  format: 'stageforge-show';
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  rig: RigConfig;
  cues: ShowCue[];
  look: ShowState;
  activeCueId: string | null;
  controls?: ShowControls;
  timeline?: ShowTimeline;
  media?: ShowMedia;
  stage?: NativeStage;
  crowd?: CrowdLayout;
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
const versions = {
  1: schemaV1 as ShowSchema,
  2: schemaV2 as ShowSchema,
  3: schemaV3 as ShowSchema,
  4: schemaV4 as ShowSchema,
  5: schemaV5 as ShowSchema,
  6: schemaV6 as ShowSchema,
  7: schemaV7 as ShowSchema,
  8: schemaV8 as ShowSchema,
  9: schemaV9 as ShowSchema,
  10: schemaV10 as ShowSchema,
  11: schemaV11 as ShowSchema,
  12: schemaV12 as ShowSchema,
};
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

function portableLook<T extends Partial<ShowState>>(look: T, refs: RigReferences, preserveEmptyAudioMap = false): T {
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
  if (look.audioMap) {
    // Drop mappings targeting removed laser projectors rather than turning a single-projector mapping into all-projectors.
    const kept = look.audioMap.mappings
      .filter((m) => !m.target.projectorKey || (m.target.group === 'laser' && refs.lasers.has(m.target.projectorKey)))
      .map((m) => ({
        ...m,
        ...(m.source === 'band' && m.bands ? { bands: [m.bands[0], m.bands[1]] as [number, number] } : {}),
        target: { ...m.target },
      }));
    if (kept.length > 0) {
      result.audioMap = { mappings: kept };
    } else if (preserveEmptyAudioMap) {
      // Preserve explicit `{ mappings: [] }` clears on cues and timeline patches (including when pruning empties a patch).
      result.audioMap = { mappings: [] };
    } else {
      delete result.audioMap;
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
  if (look.audioMap) {
    const seen = new Set<string>();
    look.audioMap.mappings.forEach((m, i) => {
      const mp = `${path}.audioMap.mappings[${i}]`;
      if (seen.has(m.id)) invalid(`${mp}.id`, 'duplicates another audio mapping');
      seen.add(m.id);
      if (m.bands && m.bands[0] > m.bands[1]) {
        invalid(`${mp}.bands`, 'must have start band <= end band');
      }
      if (!isValidAudioTargetParam(m.target.group, m.target.param)) {
        invalid(`${mp}.target.param`, `is not valid for target group "${m.target.group}"`);
      }
      if (m.target.projectorKey !== undefined) {
        if (m.target.group !== 'laser') {
          invalid(`${mp}.target.projectorKey`, 'is only allowed on laser targets');
        }
        if (!refs.lasers.has(m.target.projectorKey)) {
          invalid(`${mp}.target.projectorKey`, 'contains an unknown laser projector');
        }
      }
      if (!allowsNegativeAmount(m.target.group, m.target.param) && m.amount < 0) {
        invalid(`${mp}.amount`, `cannot be negative for ${m.target.group}.${m.target.param}`);
      }
      if (m.target.group === 'haze' && (m.attackMs < HAZE_MIN_ATTACK_MS || m.releaseMs < HAZE_MIN_RELEASE_MS)) {
        invalid(`${mp}`, `haze requires attackMs >= ${HAZE_MIN_ATTACK_MS} and releaseMs >= ${HAZE_MIN_RELEASE_MS}`);
      }
    });
  }
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

/** Drop imported MVR GDTF fixtureSpec entries for a group whose catalogue model or DMX mode changed. */
export function pruneInterchangeFixtureSpecs(
  interchange: ShowInterchange | undefined,
  podId: string | undefined,
  groupId: string,
): ShowInterchange | undefined {
  const specs = interchange?.mvr?.fixtureSpecs;
  if (!specs) return interchange;
  const prefix = 'fixture:' + JSON.stringify(podId !== undefined ? ['pod', podId, groupId] : ['floor', groupId]).slice(0, -1) + ',';
  let changed = false;
  const kept: Record<string, MvrFixtureSpec> = {};
  for (const [key, spec] of Object.entries(specs)) {
    if (key.startsWith(prefix)) {
      changed = true;
    } else {
      kept[key] = spec;
    }
  }
  if (!changed) return interchange;
  return normalizeInterchange({
    ...interchange,
    mvr: {
      ...interchange.mvr,
      fixtureSpecs: Object.keys(kept).length ? kept : undefined,
    },
  });
}

function decode(value: unknown, writing: boolean): StageForgeShowFile {
  const version = value && typeof value === 'object' && 'version' in value ? value.version : undefined;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9 && version !== 10 && version !== 11 && version !== 12) invalid('show.version', 'has an unsupported value');
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
  if (show.crowd) {
    try {
      resolveCrowdLayout(show.rig, show.crowd);
    } catch (error) {
      invalid('show.crowd', error instanceof Error ? error.message : 'is invalid');
    }
  }
  return show;
}

export function makeShowFile(
  rig: RigConfig, cues: ShowCue[], look: ShowState, activeCueId: string | null,
  controls?: ShowControls, timeline?: ShowTimeline, media?: ShowMedia, stage?: NativeStage,
  interchange?: ShowInterchange,
  crowd?: CrowdLayout,
): StageForgeShowFile {
  const refs = rigReferences(rig);
  const cleanInterchange = normalizeInterchange(interchange);
  // A browser take may end before a secondary wall's last native event.
  // Both tracks share the file's duration when either one is edited.
  const stageEnd = stage?.screenEvents.at(-1)?.atMs ?? 0;
  if (stageEnd > (timeline?.durationMs ?? 0)) {
    timeline = {
      durationMs: stageEnd,
      events: timeline?.events ?? [],
      ...(timeline?.frameRate !== undefined ? { frameRate: timeline.frameRate } : {}),
      ...(timeline?.timecodeOffsetMs !== undefined ? { timecodeOffsetMs: timeline.timecodeOffsetMs } : {}),
    };
  }
  const cleanCues = cues.map(cue => ({
    ...cue, state: portableLook(cue.state, refs, true), screen: cue.screen && portableMedia(cue.screen),
  }));
  const cleanLook = portableLook(look, refs, false);
  const cleanTimeline = timeline && {
    durationMs: timeline.durationMs,
    ...(timeline.frameRate !== undefined ? { frameRate: timeline.frameRate } : {}),
    ...(timeline.timecodeOffsetMs !== undefined ? { timecodeOffsetMs: timeline.timecodeOffsetMs } : {}),
    events: timeline.events.map(event => ({
      ...event, look: event.look && portableLook(event.look, refs, true),
      music: event.music && portableMedia(event.music), screen: event.screen && portableMedia(event.screen),
    })),
  };
  const hasAudioMapField = (s?: Partial<ShowState>) => s?.audioMap !== undefined;
  const hasV9 =
    cleanCues.some((cue) => cue.fadeSeconds !== undefined) ||
    (cleanTimeline?.events.some((event) => event.cueFade !== undefined) ?? false);
  const hasV8 =
    hasAudioMapField(cleanLook) ||
    cleanCues.some((c) => hasAudioMapField(c.state)) ||
    (cleanTimeline?.events.some((e) => hasAudioMapField(e.look)) ?? false);
  const hasV7 =
    rig.power !== undefined ||
    rig.trussPods.some(
      (pod) =>
        pod.trussProfileId !== undefined ||
        pod.hoistId !== undefined ||
        pod.hoistCount !== undefined ||
        pod.fixtures.some((f) => f.circuitGroup !== undefined || f.phase !== undefined),
    ) ||
    rig.floorFx.some((f) => f.circuitGroup !== undefined || f.phase !== undefined);
  const hasV6 =
    rig.trussPods.some((pod) => pod.fixtures.some((f) => f.catalogId !== undefined || f.dmxMode !== undefined || f.dmxChannels !== undefined)) ||
    rig.floorFx.some((f) => f.catalogId !== undefined || f.dmxMode !== undefined || f.dmxChannels !== undefined) ||
    rig.ledWall.cabinets?.cabinetId !== undefined;
  const hasV5Timeline = cleanTimeline?.frameRate !== undefined || cleanTimeline?.timecodeOffsetMs !== undefined;
  const version = crowd ? crowdShowVersion(crowd) : hasV9 ? 9 : hasV8 ? 8 : hasV7 ? 7 : hasV6 ? 6 : hasV5Timeline ? 5 : cleanInterchange ? 4 : stage ? 3 : 2;
  const $schema = versions[version].properties!.$schema.const as StageForgeShowFile['$schema'];
  const show = decode({
    $schema, format: 'stageforge-show', version, rig, stage, crowd, interchange: cleanInterchange,
    cues: cleanCues,
    look: cleanLook, activeCueId, controls,
    timeline: cleanTimeline,
    media: media && { music: portableMedia(media.music), screen: portableMedia(media.screen) },
  }, true);
  if (crowd || hasV9 || hasV8 || hasV7 || hasV6 || hasV5Timeline || cleanInterchange || stage) return show;
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

/**
 * Strict, non-pruning validators for AI bridge proposals.
 * Reuse the latest canonical JSON Schema reader and `checkLook` directly without calling `makeShowFile`,
 * so unknown keys, out-of-range numbers, and invalid references are rejected rather than stripped.
 */
export function validateLookFragmentForRig(value: unknown, rig: RigConfig, path = 'patch'): Partial<ShowState> {
  const schema = versions[12];
  const parsed = read(value, schema.$defs.cueState, path, false, schema) as Partial<ShowState>;
  checkLook(parsed, rigReferences(rig), path);
  return parsed;
}

export function validateFullLookForRig(value: unknown, rig: RigConfig, path = 'look'): ShowState {
  const schema = versions[12];
  const parsed = read(value, schema.$defs.look, path, false, schema) as ShowState;
  checkLook(parsed, rigReferences(rig), path);
  return parsed;
}

export function validateCueListForRig(value: unknown, rig: RigConfig, path = 'cues'): ShowCue[] {
  const schema = versions[12];
  const parsed = read(value, { type: 'array', maxItems: 500, items: { $ref: '#/$defs/cue' } }, path, false, schema) as ShowCue[];
  const refs = rigReferences(rig);
  const ids = new Set<string>();
  parsed.forEach((cue, i) => {
    if (ids.has(cue.id)) invalid(`${path}[${i}].id`, 'duplicates another cue');
    ids.add(cue.id);
    checkLook(cue.state, refs, `${path}[${i}].state`);
  });
  return parsed;
}

export function validateTimelineForRig(
  value: unknown,
  rig: RigConfig,
  stage?: NativeStage,
  path = 'timeline',
): ShowTimeline {
  const schema = versions[12];
  const parsed = read(value, schema.$defs.timeline, path, false, schema) as ShowTimeline;
  const refs = rigReferences(rig);
  let last = 0;
  for (const [index, event] of parsed.events.entries()) {
    const ep = `${path}.events[${index}]`;
    if (event.atMs < last || event.atMs > parsed.durationMs) invalid(`${ep}.atMs`, 'falls outside the ordered timeline');
    if (event.look) checkLook(event.look, refs, `${ep}.look`);
    last = event.atMs;
  }
  const stageEnd = stage?.screenEvents.at(-1)?.atMs ?? 0;
  if (stageEnd > parsed.durationMs) {
    invalid(`${path}.durationMs`, `must be at least ${stageEnd} ms to cover existing secondary wall cues`);
  }
  return parsed;
}

export function validateAudioMapForRig(
  value: unknown,
  rig: RigConfig,
  path = 'audioMap',
): NonNullable<ShowState['audioMap']> {
  const schema = versions[12];
  const parsed = read(value, schema.$defs.audioMap, path, false, schema) as NonNullable<ShowState['audioMap']>;
  checkLook({ audioMap: parsed }, rigReferences(rig), path);
  return parsed;
}

export function validateSecondaryScreenEventForStage(
  value: unknown,
  stage: NativeStage | undefined,
  path = 'event',
) {
  const schema = versions[12];
  const parsed = read(value, schema.$defs.secondaryScreenEvent, path, false, schema) as NativeStage['screenEvents'][number];
  const walls = new Set((stage?.walls ?? []).map((w) => w.id));
  if (!walls.has(parsed.target) || parsed.target === 'main-led') {
    invalid(`${path}.target`, 'must identify an existing secondary wall');
  }
  return parsed;
}
