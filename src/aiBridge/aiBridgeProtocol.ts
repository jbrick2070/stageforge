import type {
  AudioMapping,
  CameraPreset,
  MusicRef,
  RigConfig,
  ScreenRef,
  ShowCue,
  ShowState,
} from '../types/show';
import {
  parseShowFile,
  validateAudioMapForRig,
  validateCueListForRig,
  validateFullLookForRig,
  validateLookFragmentForRig,
  validateSecondaryScreenEventForStage,
  validateTimelineForRig,
  type NativeStage,
  type ShowInterchange,
  type ShowTimeline,
  type StageForgeShowFile,
} from '../data/showFile';
import {
  catalogLedPanels,
  EQUIPMENT_CATALOG,
} from '../data/equipmentCatalog';
import { HOIST_PROFILES, TRUSS_PROFILES } from '../data/rigCatalog';
import { focusMarks } from '../engine/focusAim';
import {
  authoredWallFrames,
  defaultSpeakerHangs,
  removeSecondaryScreenEvent,
  upsertSecondaryScreenEvent,
} from '../data/studioGeometry';
import type { PreflightReport } from '../data/preflight';
import type { ClockMode } from '../showControl/clockOwner';

export const AUDIENCE_SCAN_ERROR = 'a human must enable audience scanning on the desk';
export const MAX_PENDING_PROPOSALS = 8;
export const MAX_PROPOSAL_STORE_BYTES = 8 * 1024 * 1024; // 8 MiB
export const MAX_TOOL_LOG_ENTRIES = 500;
const MAX_TRAVERSE_DEPTH = 32;
const MAX_TRAVERSE_NODES = 50_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const AI_BRIDGE_TOOL_NAMES = [
  'get_state',
  'get_cues',
  'list_catalog',
  'get_schema',
  'get_safety_report',
  'propose_show',
  'propose_look',
  'propose_cue',
  'propose_take',
  'propose_wall_cue',
  'propose_audio_mapping',
  'get_proposal',
  'withdraw_proposal',
  'go',
  'back',
  'stop',
  'resume',
  'trigger_cue',
  'play_take',
  'pause_take',
  'seek_take',
  'blackout',
  'set_master',
  'set_bpm',
  'capture_frame',
  'get_audio_levels',
] as const;

export type AiBridgeToolName = (typeof AI_BRIDGE_TOOL_NAMES)[number];

export interface AiDeskSnapshot {
  rig: RigConfig;
  stage?: NativeStage;
  interchange?: ShowInterchange;
  mvrResources?: Map<string, Uint8Array>;
  cues: ShowCue[];
  look: ShowState;
  activeCueId: string | null;
  timeline?: ShowTimeline;
  camera: CameraPreset;
  volume: number;
  screen?: ScreenRef;
  music?: MusicRef;
  expectedMusic?: MusicRef;
  takeMetaExplicit?: boolean;
  clockMode: ClockMode;
  audioStatus: {
    playing: boolean;
    source: string;
    trackName: string;
    bpm: number;
  };
}

export interface AiRevertSnapshot {
  capturedAt: number;
  rig: RigConfig;
  stage?: NativeStage;
  interchange?: ShowInterchange;
  mvrResources?: Map<string, Uint8Array>;
  cues: ShowCue[];
  look: ShowState;
  activeCueId: string | null;
  timeline?: ShowTimeline;
  camera: CameraPreset;
  volume: number;
  screen?: ScreenRef;
  music?: MusicRef;
  expectedMusic?: MusicRef;
  takeMetaExplicit?: boolean;
}

/** Capture an isolated in-memory revert snapshot of the desk, preserving MVR resources (Codex R2). */
export function createAiRevertSnapshot(desk: AiDeskSnapshot, capturedAt = Date.now()): AiRevertSnapshot {
  return {
    capturedAt,
    rig: structuredClone(desk.rig),
    stage: desk.stage ? structuredClone(desk.stage) : undefined,
    interchange: desk.interchange ? structuredClone(desk.interchange) : undefined,
    mvrResources: desk.mvrResources ? new Map(desk.mvrResources) : undefined,
    cues: structuredClone(desk.cues),
    look: structuredClone(desk.look),
    activeCueId: desk.activeCueId,
    timeline: desk.timeline ? structuredClone(desk.timeline) : undefined,
    camera: desk.camera,
    volume: desk.volume,
    screen: desk.screen ? structuredClone(desk.screen) : undefined,
    music: desk.music ? structuredClone(desk.music) : undefined,
    expectedMusic: desk.expectedMusic ? structuredClone(desk.expectedMusic) : undefined,
    takeMetaExplicit: desk.takeMetaExplicit,
  };
}

export type AiProposalStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn';

export type AiProposalKind =
  | 'propose_show'
  | 'propose_look'
  | 'propose_cue'
  | 'propose_take'
  | 'propose_wall_cue'
  | 'propose_audio_mapping';

export interface AiProposalCandidate {
  kind: AiProposalKind;
  show?: StageForgeShowFile;
  look?: ShowState;
  lookPatch?: Record<string, unknown>;
  audioMappingPatch?: {
    audioMap?: ShowState['audioMap'];
    audioReactive?: boolean;
  };
  cues?: ShowCue[];
  activeCueId?: string | null;
  timeline?: ShowTimeline;
  stage?: NativeStage;
}

export interface AiProposalRecord {
  id: string;
  tool: AiProposalKind;
  bridgeGeneration: number;
  documentEpoch: number;
  baseRevision: string;
  summary: string;
  diffLines: string[];
  createdAt: number;
  status: AiProposalStatus;
  byteSize: number;
  candidate: AiProposalCandidate;
}

export interface AiToolLogEntry {
  id: number;
  at: number;
  tool: string;
  argSummary: string;
  ok: boolean;
  resultSummary: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Iterative deep safety check rejecting `audienceScan` unless strictly `false`
 * and rejecting prototype-pollution keys anywhere in a payload or candidate.
 */
export function assertNoAudienceScan(root: unknown): void {
  if (root === undefined || root === null) return;
  const stack: Array<{ value: unknown; depth: number; path: string }> = [
    { value: root, depth: 0, path: 'root' },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const { value, depth, path } = stack.pop()!;
    nodes++;
    if (nodes > MAX_TRAVERSE_NODES) {
      throw new Error(`Proposal exceeds maximum node budget (${MAX_TRAVERSE_NODES}).`);
    }
    if (depth > MAX_TRAVERSE_DEPTH) {
      throw new Error(`Proposal exceeds maximum nesting depth (${MAX_TRAVERSE_DEPTH}) at ${path}.`);
    }
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], depth: depth + 1, path: `${path}[${i}]` });
      }
      continue;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`Forbidden key "${key}" at ${path}.`);
      }
      const child = (value as Record<string, unknown>)[key];
      if (key === 'audienceScan' && child !== false) {
        throw new Error(AUDIENCE_SCAN_ERROR);
      }
      stack.push({ value: child, depth: depth + 1, path: `${path}.${key}` });
    }
  }
}

/** Check whether triggering a cue or playing a timeline would enable laser audience scanning. */
export function cueEnablesAudienceScan(cue: ShowCue | undefined): boolean {
  return Boolean(cue?.state?.laser?.audienceScan === true);
}

/**
 * Walk the cue follow chain starting at `startIndex` (following `followSeconds > 0` to `idx + 1`)
 * and return true if the cue or any auto-followed successor enables laser audience scanning (H1).
 */
export function cueOrFollowChainEnablesAudienceScan(cues: readonly ShowCue[], startIndex: number): boolean {
  if (startIndex < 0 || startIndex >= cues.length) return false;
  for (let i = startIndex; i < cues.length; i++) {
    const cue = cues[i];
    if (cueEnablesAudienceScan(cue)) return true;
    if (!(cue.followSeconds && cue.followSeconds > 0)) break;
  }
  return false;
}

export function timelineEnablesAudienceScan(timeline: ShowTimeline | undefined): boolean {
  if (!timeline) return false;
  return timeline.events.some((ev) => ev.look?.laser?.audienceScan === true);
}

/**
 * Resolve the active cue pointer when accepting a `propose_cue` change: preserve the live
 * active cue during create/edit/reorder, and clear it only if that active cue was removed (Codex R4).
 */
export function resolveAcceptedCueActiveId(
  currentActiveCueId: string | null,
  nextCues: readonly ShowCue[],
): string | null {
  if (currentActiveCueId === null) return null;
  return nextCues.some((c) => c.id === currentActiveCueId) ? currentActiveCueId : null;
}

function fnv1aHex(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return String(Math.round(value * 1e5) / 1e5);
  }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (obj[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Authored-document revision hash (rig, stage, interchange, cues, timeline).
 * Excludes volatile runtime playback state (live look, activeCueId, masterDimmer, blackout)
 * so running cues, adjusting master, or playing a take does not invalidate pending proposals (M6).
 */
export function computeAuthoredRevision(desk: Pick<
  AiDeskSnapshot,
  'rig' | 'stage' | 'interchange' | 'cues' | 'timeline'
>): string {
  const payload = stableStringify({
    rig: desk.rig,
    stage: desk.stage ?? null,
    interchange: desk.interchange ?? null,
    cues: desk.cues,
    timeline: desk.timeline ?? null,
  });
  return `doc-${fnv1aHex(payload)}-${payload.length}`;
}

/**
 * Full desk revision hash covering rig, stage, cues, current look, timeline, activeCueId, and interchange.
 * Intentionally distinct from `computePreflightRevision` (which excludes runtime look and timeline).
 */
export function computeDeskRevision(desk: Pick<
  AiDeskSnapshot,
  'rig' | 'stage' | 'interchange' | 'cues' | 'look' | 'activeCueId' | 'timeline'
>): string {
  const payload = stableStringify({
    rig: desk.rig,
    stage: desk.stage ?? null,
    interchange: desk.interchange ?? null,
    cues: desk.cues,
    look: desk.look,
    activeCueId: desk.activeCueId,
    timeline: desk.timeline ?? null,
  });
  return `desk-${fnv1aHex(payload)}-${payload.length}`;
}

/** Merge a validated look fragment onto the current look without generic unsafe mutation. */
function applyValidatedLookPatch(base: ShowState, patch: Partial<ShowState>): ShowState {
  const next: ShowState = {
    ...structuredClone(base),
  };
  for (const [key, val] of Object.entries(patch) as Array<[keyof ShowState, unknown]>) {
    if (val === undefined) continue;
    if (key === 'laser' && isPlainObject(val)) {
      next.laser = { ...next.laser, ...(structuredClone(val) as Partial<ShowState['laser']>) };
    } else if (key === 'motors' && isPlainObject(val)) {
      next.motors = { ...next.motors, ...(structuredClone(val) as Partial<ShowState['motors']>) };
    } else if (key === 'atmo' && isPlainObject(val)) {
      next.atmo = { ...next.atmo, ...(structuredClone(val) as Partial<ShowState['atmo']>) };
    } else if (key === 'led' && isPlainObject(val)) {
      next.led = {
        ...next.led,
        ...(structuredClone(val) as Partial<ShowState['led']>),
        customMediaUrl: next.led.customMediaUrl,
        customMediaType: next.led.customMediaType,
      };
    } else if (key === 'audioMap') {
      const am = val as ShowState['audioMap'];
      if (am && am.mappings.length > 0) {
        next.audioMap = structuredClone(am);
      } else {
        delete next.audioMap;
      }
    } else {
      Object.defineProperty(next, key, {
        value: structuredClone(val),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return next;
}

function summarizeLookDiff(before: ShowState, after: ShowState): string[] {
  const lines: string[] = [];
  const topKeys = new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof ShowState>;
  for (const key of [...topKeys].sort()) {
    const a = before[key];
    const b = after[key];
    if (stableStringify(a) === stableStringify(b)) continue;
    if (key === 'audioMap') {
      const prevCount = before.audioMap?.mappings.length ?? 0;
      const nextCount = after.audioMap?.mappings.length ?? 0;
      lines.push(`audioMap: ${prevCount} → ${nextCount} mapping(s)`);
    } else if (typeof b === 'object' && b !== null && typeof a === 'object' && a !== null) {
      const subChanged: string[] = [];
      const subKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const sk of [...subKeys].sort()) {
        if (stableStringify((a as Record<string, unknown>)[sk]) !== stableStringify((b as Record<string, unknown>)[sk])) {
          subChanged.push(sk);
        }
      }
      lines.push(`${String(key)}: changed ${subChanged.slice(0, 6).join(', ')}${subChanged.length > 6 ? '…' : ''}`);
    } else {
      lines.push(`${String(key)}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  }
  return lines.length ? lines : ['No effective look changes'];
}

export function compileShowProposal(
  rawShow: unknown,
  summary: string | undefined,
  desk: AiDeskSnapshot,
): { summary: string; diffLines: string[]; candidate: AiProposalCandidate } {
  assertNoAudienceScan(rawShow);
  const serialized = JSON.stringify(rawShow);
  const parsed = parseShowFile(serialized);
  assertNoAudienceScan(parsed);
  const diffLines: string[] = [
    `Rig: "${desk.rig.name}" → "${parsed.rig.name}" (${parsed.rig.trussPods.length} pods, ${parsed.rig.floorFx.length} floor FX)`,
    `Cues: ${desk.cues.length} → ${parsed.cues.length}`,
    `Timeline: ${desk.timeline ? `${desk.timeline.events.length} events (${(desk.timeline.durationMs / 1000).toFixed(1)}s)` : 'none'} → ${parsed.timeline ? `${parsed.timeline.events.length} events (${(parsed.timeline.durationMs / 1000).toFixed(1)}s)` : 'none'}`,
    `Show format: v${parsed.version}`,
  ];
  return {
    summary: summary?.trim() || `Replace show with "${parsed.rig.name}" (v${parsed.version})`,
    diffLines,
    candidate: { kind: 'propose_show', show: parsed },
  };
}

export function compileLookProposal(
  rawPatch: unknown,
  summary: string | undefined,
  desk: AiDeskSnapshot,
): { summary: string; diffLines: string[]; candidate: AiProposalCandidate } {
  if (!isPlainObject(rawPatch)) {
    throw new Error('patch must be a JSON object.');
  }
  assertNoAudienceScan(rawPatch);

  // Support nested partial subsystem patches (e.g. { laser: { intensity: 0.6 } }) by validating
  // each merged subsystem strictly against the v8 full-look schema + checkLook, while rejecting
  // any unknown keys or wrong types on the incoming patch itself.
  const expandedPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawPatch)) {
    if (k === 'laser' && isPlainObject(v)) {
      expandedPatch.laser = { ...structuredClone(desk.look.laser), ...structuredClone(v) };
    } else if (k === 'motors' && isPlainObject(v)) {
      expandedPatch.motors = { ...structuredClone(desk.look.motors), ...structuredClone(v) };
    } else if (k === 'atmo' && isPlainObject(v)) {
      expandedPatch.atmo = { ...structuredClone(desk.look.atmo), ...structuredClone(v) };
    } else if (k === 'led' && isPlainObject(v)) {
      // Reject AI-supplied customMediaUrl/customMediaType instead of silently overriding (L8).
      if (Object.prototype.hasOwnProperty.call(v, 'customMediaUrl') && v.customMediaUrl !== null) {
        throw new Error('patch.led.customMediaUrl cannot be set by AI proposals.');
      }
      if (Object.prototype.hasOwnProperty.call(v, 'customMediaType') && v.customMediaType !== null) {
        throw new Error('patch.led.customMediaType cannot be set by AI proposals.');
      }
      const baseLed = { ...structuredClone(desk.look.led), customMediaUrl: null, customMediaType: null };
      expandedPatch.led = { ...baseLed, ...structuredClone(v), customMediaUrl: null, customMediaType: null };
    } else {
      expandedPatch[k] = structuredClone(v);
    }
  }

  // Validate patch strictly (no unknown keys, exact schema types, valid rig references).
  const validatedPatch = validateLookFragmentForRig(expandedPatch, desk.rig, 'patch');
  const merged = applyValidatedLookPatch(desk.look, validatedPatch);
  // Validate complete resulting look against v8 full look schema (with portable null media fields).
  const toCheck = {
    ...structuredClone(merged),
    led: { ...structuredClone(merged.led), customMediaUrl: null, customMediaType: null },
  };
  validateFullLookForRig(toCheck, desk.rig, 'look');
  // Never allow a look proposal to turn audienceScan on (or keep it on if not already enabled by human).
  if (merged.laser.audienceScan === true && desk.look.laser.audienceScan !== true) {
    throw new Error(AUDIENCE_SCAN_ERROR);
  }

  const diffLines = summarizeLookDiff(desk.look, merged);
  return {
    summary: summary?.trim() || `Update look (${diffLines.length} field${diffLines.length === 1 ? '' : 's'})`,
    diffLines,
    candidate: { kind: 'propose_look', look: merged, lookPatch: structuredClone(rawPatch) },
  };
}

export function compileCueProposal(
  args: {
    action: 'create' | 'edit' | 'remove' | 'reorder';
    cue?: unknown;
    cueId?: string;
    insertIndex?: number;
    order?: string[];
    summary?: string;
  },
  desk: AiDeskSnapshot,
): { summary: string; diffLines: string[]; candidate: AiProposalCandidate } {
  assertNoAudienceScan(args);
  const nextCues: ShowCue[] = structuredClone(desk.cues);
  let nextActiveCueId = desk.activeCueId;
  let autoSummary = '';
  const diffLines: string[] = [];

  if (args.action === 'create') {
    if (!isPlainObject(args.cue)) throw new Error('propose_cue create requires a "cue" object.');
    const rawCue = structuredClone(args.cue) as unknown as ShowCue;
    const idx = args.insertIndex !== undefined
      ? Math.max(0, Math.min(nextCues.length, args.insertIndex))
      : nextCues.length;
    nextCues.splice(idx, 0, rawCue);
    const validated = validateCueListForRig(nextCues, desk.rig, 'cues');
    assertNoAudienceScan(validated[idx]);
    autoSummary = `Create cue "${validated[idx].name}" (#${idx + 1})`;
    diffLines.push(`+ Cue #${idx + 1}: "${validated[idx].name}" (id: ${validated[idx].id})`);
    return {
      summary: args.summary?.trim() || autoSummary,
      diffLines,
      candidate: { kind: 'propose_cue', cues: validated, activeCueId: nextActiveCueId },
    };
  }

  if (args.action === 'edit') {
    const targetId = args.cueId ?? (isPlainObject(args.cue) && typeof args.cue.id === 'string' ? args.cue.id : undefined);
    if (!targetId) throw new Error('propose_cue edit requires "cueId" or "cue.id".');
    if (!isPlainObject(args.cue)) throw new Error('propose_cue edit requires a "cue" object.');
    const idx = nextCues.findIndex((c) => c.id === targetId);
    if (idx < 0) throw new Error(`Cue "${targetId}" does not exist.`);
    const existing = nextCues[idx];
    const updated: Record<string, unknown> = {
      ...existing,
      ...structuredClone(args.cue),
      id: existing.id,
    };
    if (isPlainObject(args.cue.state)) {
      updated.state = {
        ...existing.state,
        ...structuredClone(args.cue.state),
      };
    }
    nextCues[idx] = updated as unknown as ShowCue;
    const validated = validateCueListForRig(nextCues, desk.rig, 'cues');
    if (validated[idx].state.laser?.audienceScan === true && existing.state.laser?.audienceScan !== true) {
      throw new Error(AUDIENCE_SCAN_ERROR);
    }
    autoSummary = `Edit cue "${validated[idx].name}"`;
    diffLines.push(`~ Cue #${idx + 1}: "${existing.name}" → "${validated[idx].name}" (id: ${existing.id})`);
    return {
      summary: args.summary?.trim() || autoSummary,
      diffLines,
      candidate: { kind: 'propose_cue', cues: validated, activeCueId: nextActiveCueId },
    };
  }

  if (args.action === 'remove') {
    if (!args.cueId) throw new Error('propose_cue remove requires "cueId".');
    const idx = nextCues.findIndex((c) => c.id === args.cueId);
    if (idx < 0) throw new Error(`Cue "${args.cueId}" does not exist.`);
    const [removed] = nextCues.splice(idx, 1);
    if (nextActiveCueId === removed.id) nextActiveCueId = null;
    const validated = validateCueListForRig(nextCues, desk.rig, 'cues');
    autoSummary = `Remove cue "${removed.name}"`;
    diffLines.push(`- Cue #${idx + 1}: "${removed.name}" (id: ${removed.id})`);
    return {
      summary: args.summary?.trim() || autoSummary,
      diffLines,
      candidate: { kind: 'propose_cue', cues: validated, activeCueId: nextActiveCueId },
    };
  }

  if (args.action === 'reorder') {
    if (!Array.isArray(args.order)) throw new Error('propose_cue reorder requires an "order" array of cue IDs.');
    if (args.order.length !== nextCues.length) {
      throw new Error(`Reorder list length (${args.order.length}) must match cue count (${nextCues.length}).`);
    }
    const byId = new Map(nextCues.map((c) => [c.id, c]));
    const seen = new Set<string>();
    const reordered: ShowCue[] = [];
    for (const id of args.order) {
      if (seen.has(id) || !byId.has(id)) {
        throw new Error(`Reorder must be an exact permutation of existing cue IDs (invalid id "${id}").`);
      }
      seen.add(id);
      reordered.push(byId.get(id)!);
    }
    const validated = validateCueListForRig(reordered, desk.rig, 'cues');
    autoSummary = `Reorder ${validated.length} cues`;
    diffLines.push(`Order: ${validated.map((c) => c.name).join(' → ')}`);
    return {
      summary: args.summary?.trim() || autoSummary,
      diffLines,
      candidate: { kind: 'propose_cue', cues: validated, activeCueId: nextActiveCueId },
    };
  }

  throw new Error(`Unsupported cue action "${String(args.action)}".`);
}

export function compileTakeProposal(
  rawTimeline: unknown,
  summary: string | undefined,
  desk: AiDeskSnapshot,
): { summary: string; diffLines: string[]; candidate: AiProposalCandidate } {
  assertNoAudienceScan(rawTimeline);
  const validated = validateTimelineForRig(rawTimeline, desk.rig, desk.stage, 'timeline');
  assertNoAudienceScan(validated);
  const diffLines = [
    `Events: ${desk.timeline?.events.length ?? 0} → ${validated.events.length}`,
    `Duration: ${((desk.timeline?.durationMs ?? 0) / 1000).toFixed(2)}s → ${(validated.durationMs / 1000).toFixed(2)}s`,
  ];
  return {
    summary: summary?.trim() || `Update take timeline (${validated.events.length} events, ${(validated.durationMs / 1000).toFixed(1)}s)`,
    diffLines,
    candidate: { kind: 'propose_take', timeline: validated },
  };
}

export function compileWallCueProposal(
  args: {
    action: 'upsert' | 'remove';
    event?: unknown;
    wallId?: string;
    atMs?: number;
    summary?: string;
  },
  desk: AiDeskSnapshot,
): { summary: string; diffLines: string[]; candidate: AiProposalCandidate } {
  assertNoAudienceScan(args);
  if (!desk.stage) {
    throw new Error('No authored secondary LED walls exist on the current stage.');
  }

  if (args.action === 'upsert') {
    if (!isPlainObject(args.event)) {
      throw new Error('propose_wall_cue upsert requires an "event" object.');
    }
    const evObj = structuredClone(args.event);
    // Normalize optional alias `wallId` -> `target` only if `target` absent, while rejecting unknown fields via schema.
    if (evObj.target === undefined && typeof evObj.wallId === 'string') {
      evObj.target = evObj.wallId;
      delete evObj.wallId;
    }
    const validatedEvent = validateSecondaryScreenEventForStage(evObj, desk.stage, 'event');
    const nextStage = upsertSecondaryScreenEvent(desk.rig, desk.stage, validatedEvent);
    const diffLines = [
      `+ Wall cue on "${validatedEvent.target}" at ${(validatedEvent.atMs / 1000).toFixed(2)}s (${validatedEvent.kind})`,
    ];
    let nextTimeline = desk.timeline ? structuredClone(desk.timeline) : undefined;
    if (nextTimeline && validatedEvent.atMs > nextTimeline.durationMs) {
      diffLines.push(
        `Timeline duration extended: ${(nextTimeline.durationMs / 1000).toFixed(2)}s → ${(validatedEvent.atMs / 1000).toFixed(2)}s`,
      );
      nextTimeline = { ...nextTimeline, durationMs: validatedEvent.atMs };
    }
    return {
      summary: args.summary?.trim() || `Set wall cue on "${validatedEvent.target}" at ${(validatedEvent.atMs / 1000).toFixed(1)}s`,
      diffLines,
      candidate: { kind: 'propose_wall_cue', stage: nextStage, ...(nextTimeline ? { timeline: nextTimeline } : {}) },
    };
  }

  if (args.action === 'remove') {
    if (!args.wallId || typeof args.atMs !== 'number' || !Number.isFinite(args.atMs)) {
      throw new Error('propose_wall_cue remove requires "wallId" and "atMs".');
    }
    const beforeCount = desk.stage.screenEvents.length;
    const nextStage = removeSecondaryScreenEvent(desk.rig, desk.stage, args.wallId, args.atMs);
    const afterCount = nextStage?.screenEvents.length ?? 0;
    if (afterCount === beforeCount) {
      throw new Error(`No secondary wall cue found on "${args.wallId}" at ${args.atMs} ms.`);
    }
    return {
      summary: args.summary?.trim() || `Remove wall cue on "${args.wallId}" at ${(args.atMs / 1000).toFixed(1)}s`,
      diffLines: [`- Wall cue on "${args.wallId}" at ${(args.atMs / 1000).toFixed(2)}s`],
      candidate: { kind: 'propose_wall_cue', stage: nextStage },
    };
  }

  throw new Error(`Unsupported wall cue action "${String(args.action)}".`);
}

export function compileAudioMappingProposal(
  args: {
    action: 'upsert' | 'remove' | 'replace';
    mapping?: unknown;
    mappingId?: string;
    mappings?: unknown[];
    audioReactive?: boolean;
    summary?: string;
  },
  desk: AiDeskSnapshot,
): { summary: string; diffLines: string[]; candidate: AiProposalCandidate } {
  assertNoAudienceScan(args);
  const current = structuredClone(desk.look.audioMap?.mappings ?? []);
  let nextMappings: AudioMapping[];

  if (args.action === 'upsert') {
    if (!isPlainObject(args.mapping)) throw new Error('propose_audio_mapping upsert requires "mapping".');
    const incoming = structuredClone(args.mapping) as unknown as AudioMapping;
    const idx = current.findIndex((m) => m.id === incoming.id);
    if (idx >= 0) current[idx] = incoming;
    else current.push(incoming);
    nextMappings = current;
  } else if (args.action === 'remove') {
    if (!args.mappingId) throw new Error('propose_audio_mapping remove requires "mappingId".');
    const idx = current.findIndex((m) => m.id === args.mappingId);
    if (idx < 0) throw new Error(`Audio mapping "${args.mappingId}" does not exist.`);
    current.splice(idx, 1);
    nextMappings = current;
  } else if (args.action === 'replace') {
    if (!Array.isArray(args.mappings)) throw new Error('propose_audio_mapping replace requires "mappings" array.');
    nextMappings = structuredClone(args.mappings) as unknown as AudioMapping[];
  } else {
    throw new Error(`Unsupported audio mapping action "${String(args.action)}".`);
  }

  const validatedMap = validateAudioMapForRig({ mappings: nextMappings }, desk.rig, 'audioMap');
  const audioMappingPatch: NonNullable<AiProposalCandidate['audioMappingPatch']> = {
    audioMap: validatedMap.mappings.length > 0 ? validatedMap : undefined,
    ...(args.audioReactive !== undefined ? { audioReactive: args.audioReactive } : {}),
  };
  const nextLook = structuredClone(desk.look);
  if (audioMappingPatch.audioMap) {
    nextLook.audioMap = structuredClone(audioMappingPatch.audioMap);
  } else {
    delete nextLook.audioMap;
  }
  if (audioMappingPatch.audioReactive !== undefined) {
    nextLook.audioReactive = audioMappingPatch.audioReactive;
  }

  const diffLines = [
    `Audio mappings: ${desk.look.audioMap?.mappings.length ?? 0} → ${validatedMap.mappings.length}`,
    ...(args.audioReactive !== undefined && args.audioReactive !== desk.look.audioReactive
      ? [`Beat sync (audioReactive): ${desk.look.audioReactive} → ${args.audioReactive}`]
      : []),
  ];
  return {
    summary: args.summary?.trim() || `Update audio mappings (${validatedMap.mappings.length} active)`,
    diffLines,
    candidate: { kind: 'propose_audio_mapping', look: nextLook, audioMappingPatch },
  };
}

/**
 * Re-applies an audio-mapping patch onto the current live desk look at accept time so
 * live safety/operator changes (audienceScan off, blackout, master dimmer, BPM) are
 * never clobbered by a stale look snapshot captured when the proposal was created.
 */
export function applyAudioMappingPatchToDesk(
  patch: NonNullable<AiProposalCandidate['audioMappingPatch']>,
  desk: AiDeskSnapshot,
): AiProposalCandidate {
  const validatedMap = patch.audioMap
    ? validateAudioMapForRig(structuredClone(patch.audioMap), desk.rig, 'audioMap')
    : { mappings: [] };
  const nextLook = structuredClone(desk.look);
  if (validatedMap.mappings.length > 0) {
    nextLook.audioMap = validatedMap;
  } else {
    delete nextLook.audioMap;
  }
  if (patch.audioReactive !== undefined) {
    nextLook.audioReactive = patch.audioReactive;
  }
  return {
    kind: 'propose_audio_mapping',
    look: nextLook,
    audioMappingPatch: {
      audioMap: validatedMap.mappings.length > 0 ? validatedMap : undefined,
      ...(patch.audioReactive !== undefined ? { audioReactive: patch.audioReactive } : {}),
    },
  };
}

/** Bounded in-memory store for AI proposals (never silently evicts pending proposals). */
export class AiProposalStore {
  private readonly records = new Map<string, AiProposalRecord>();
  private totalPendingBytes = 0;

  public countPending(): number {
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.status === 'pending') n++;
    }
    return n;
  }

  public getPendingBytes(): number {
    return this.totalPendingBytes;
  }

  public listPending(): AiProposalRecord[] {
    return [...this.records.values()].filter((r) => r.status === 'pending');
  }

  public get(id: string): AiProposalRecord | undefined {
    return this.records.get(id);
  }

  public add(record: Omit<AiProposalRecord, 'byteSize' | 'status'>): AiProposalRecord {
    const pendingCount = this.countPending();
    if (pendingCount >= MAX_PENDING_PROPOSALS) {
      throw new Error(
        `Maximum pending proposals (${MAX_PENDING_PROPOSALS}) reached. Withdraw a pending proposal or wait for human review.`,
      );
    }
    const serialized = JSON.stringify({
      summary: record.summary,
      diffLines: record.diffLines,
      candidate: record.candidate,
    });
    const byteSize = new TextEncoder().encode(serialized).length;
    if (this.totalPendingBytes + byteSize > MAX_PROPOSAL_STORE_BYTES) {
      throw new Error(
        `Pending proposal storage budget (8 MiB) exceeded. Withdraw a pending proposal or wait for human review.`,
      );
    }
    const full: AiProposalRecord = {
      ...record,
      status: 'pending',
      byteSize,
    };
    this.records.set(full.id, full);
    this.totalPendingBytes += byteSize;
    return full;
  }

  public transition(id: string, nextStatus: 'accepted' | 'rejected' | 'withdrawn'): AiProposalRecord | null {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'pending') return null;
    rec.status = nextStatus;
    this.totalPendingBytes = Math.max(0, this.totalPendingBytes - rec.byteSize);
    // Keep only lightweight metadata on resolved records so memory stays bounded.
    rec.candidate = { kind: rec.candidate.kind };
    // Cap historical resolved entries at 32.
    const resolvedIds = [...this.records.values()]
      .filter((r) => r.status !== 'pending')
      .map((r) => r.id);
    while (resolvedIds.length > 32) {
      const oldest = resolvedIds.shift()!;
      this.records.delete(oldest);
    }
    return rec;
  }

  public clearAll(): void {
    this.records.clear();
    this.totalPendingBytes = 0;
  }
}

export function buildAiStateSummary(desk: AiDeskSnapshot) {
  const walls = authoredWallFrames(desk.rig, desk.stage);
  const hangs = desk.stage?.layout?.hangs ?? defaultSpeakerHangs(desk.rig);
  const marks = focusMarks(desk.rig);
  return {
    rig: {
      name: desk.rig.name,
      venue: desk.rig.venue,
      stageWidth: desk.rig.stageWidth,
      stageDepth: desk.rig.stageDepth,
      trussPods: desk.rig.trussPods.map((pod) => ({
        id: pod.id,
        name: pod.name,
        shape: pod.shape,
        x: pod.x,
        z: pod.z,
        baseY: pod.baseY,
        motorized: pod.motorized,
        fixtures: pod.fixtures.map((fg) => ({
          id: fg.id,
          type: fg.type,
          modelName: fg.modelName,
          catalogId: fg.catalogId ?? null,
          count: fg.count,
          dmxUniverse: fg.dmxUniverse,
          dmxStartChannel: fg.dmxStartChannel,
        })),
      })),
      floorFx: desk.rig.floorFx.map((fx) => ({
        id: fx.id,
        type: fx.type,
        modelName: fx.modelName,
        catalogId: fx.catalogId ?? null,
        count: fx.count,
        dmxUniverse: fx.dmxUniverse,
        dmxStartChannel: fx.dmxStartChannel,
      })),
    },
    focusMarks: marks.map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, z: m.z })),
    walls: [
      ...(desk.rig.ledWall.enabled
        ? [{ id: 'main-led', name: 'Main LED Wall', width: desk.rig.ledWall.width, height: desk.rig.ledWall.height, isMain: true }]
        : []),
      ...walls
        .filter((w) => w.id !== 'main-led')
        .map((w) => ({
          id: w.id,
          name: w.label ?? w.id,
          width: w.width,
          height: w.height,
          isMain: false,
        })),
    ],
    hangs: hangs.map((h, i) => ({
      index: i + 1,
      x: h.x,
      y: h.y,
      z: h.z,
      count: h.count,
    })),
    cues: {
      count: desk.cues.length,
      activeCueId: desk.activeCueId,
    },
    look: {
      bpm: desk.look.bpm,
      masterDimmer: desk.look.masterDimmer,
      blackout: desk.look.blackout,
      primaryColor: desk.look.primaryColor,
      accentColor: desk.look.accentColor,
      beamIntensity: desk.look.beamIntensity,
      washIntensity: desk.look.washIntensity,
      blinderLevel: desk.look.blinderLevel,
      strobeRate: desk.look.strobeRate,
      movementMode: desk.look.movementMode,
      focusMarkId: desk.look.focusMarkId ?? null,
      audioReactive: desk.look.audioReactive,
      audioMappingCount: desk.look.audioMap?.mappings.length ?? 0,
      laserEnabled: desk.look.laser.enabled,
      laserAudienceScan: desk.look.laser.audienceScan,
    },
    clockMode: desk.clockMode,
    camera: desk.camera,
    timeline: desk.timeline
      ? { durationMs: desk.timeline.durationMs, eventCount: desk.timeline.events.length }
      : null,
    audio: desk.audioStatus,
  };
}

export function buildAiCatalogSummary(category = 'all') {
  const result: Record<string, unknown> = {};
  const includeFixtures = category === 'all' || ['beam', 'wash', 'blinder', 'strobe', 'laser', 'co2', 'smoke', 'hazer'].includes(category);
  if (includeFixtures) {
    result.fixtures = EQUIPMENT_CATALOG
      .filter((e) => e.category !== 'led_panel')
      .filter((e) => category === 'all' || e.renderTypes.includes(category as never) || e.category === category)
      .map((e) => ({
        id: e.id,
        category: e.category,
        renderTypes: e.renderTypes,
        manufacturer: e.manufacturer,
        model: e.model,
        weightKg: e.weightKg ?? null,
        powerW: e.powerW ?? null,
        defaultMode: e.modes[0]?.name ?? null,
        dmxModes: e.modes.map((m) => ({ name: m.name, channels: m.channels })),
      }));
  }
  if (category === 'all' || category === 'led') {
    result.ledCabinets = catalogLedPanels().map((c) => ({
      id: c.id,
      manufacturer: c.manufacturer,
      model: c.model,
      widthMm: c.panel?.widthMm ?? null,
      heightMm: c.panel?.heightMm ?? null,
      pitchMm: c.panel?.pitchMm ?? null,
      weightKg: c.weightKg ?? null,
      powerW: c.powerW ?? null,
    }));
  }
  if (category === 'all' || category === 'truss') {
    result.trusses = TRUSS_PROFILES.map((t) => ({
      id: t.id,
      manufacturer: t.manufacturer,
      model: t.model,
      kgPerMeter: t.kgPerMeter,
      outerWidthMm: t.outerWidthMm,
      outerHeightMm: t.outerHeightMm,
    }));
  }
  if (category === 'all' || category === 'hoist') {
    result.hoists = HOIST_PROFILES.map((h) => ({
      id: h.id,
      manufacturer: h.manufacturer,
      model: h.model,
      wllKg: h.wllKg,
      safetyClass: h.safetyClass,
    }));
  }
  return result;
}

/** Read-only safety report view for `get_safety_report` (never allows passing checks or arming). */
export function buildAiSafetyReport(report: PreflightReport | null) {
  if (!report) {
    return {
      readOnly: true,
      note: 'Safety report is not yet available. AI tools cannot pass checks, acknowledge warnings, or arm output.',
      overallStatus: 'not_checked',
    };
  }
  return {
    readOnly: true,
    note: 'Read-only guidance snapshot. AI tools cannot pass checks, acknowledge warnings, inhibit lasers, or arm live output.',
    evaluatorVersion: report.evaluatorVersion,
    configRevision: report.configRevision,
    evaluatedAtIso: report.evaluatedAtIso,
    checked: report.checked,
    stale: report.stale,
    overallStatus: report.overallStatus,
    badgeLabel: report.badgeLabel,
    calibrationNote: report.calibrationNote,
    disclaimer: report.disclaimer,
    lsoNotice: report.lsoNotice,
    crowdScanWarning: report.crowdScanWarning,
    counts: { ...report.counts },
    blockingReasons: [...report.blockingReasons],
    rows: report.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      location: r.location,
      outcome: r.outcome,
      hardBlock: r.hardBlock,
      isLaser: r.isLaser,
      summary: r.summary,
      findings: r.findings.map((f) => ({ code: f.code, outcome: f.outcome, message: f.message })),
    })),
    laserZones: report.laserZones.map((z) => ({
      projectorKey: z.projectorKey,
      label: z.label,
      nohdStatus: z.nohd.status,
      nohdM: z.nohd.nohdM,
      assumedAperture: z.nohd.assumedAperture,
      minAudienceClearanceM: z.safety.minClearanceM,
      entersAudienceBelowThreshold: z.safety.entersAudienceBelowThreshold,
      audienceInsideNohd: z.audienceInsideNohd,
    })),
  };
}

export function appendToolLog(
  prev: readonly AiToolLogEntry[],
  entry: Omit<AiToolLogEntry, 'id'>,
  nextId: number,
): AiToolLogEntry[] {
  const full: AiToolLogEntry = { id: nextId, ...entry };
  const next = [full, ...prev];
  if (next.length > MAX_TOOL_LOG_ENTRIES) {
    next.length = MAX_TOOL_LOG_ENTRIES;
  }
  return next;
}

export function summarizeToolArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '{}';
  try {
    const raw = JSON.stringify(args);
    return raw.length > 140 ? raw.slice(0, 137) + '…' : raw;
  } catch {
    return `{${keys.join(', ')}}`;
  }
}

export function formatToolLogText(entries: readonly AiToolLogEntry[]): string {
  return entries
    .map((e) => {
      const ts = new Date(e.at).toISOString();
      const status = e.ok ? 'OK' : 'ERR';
      return `${ts} [${status}] ${e.tool} args=${e.argSummary} -> ${e.resultSummary}`;
    })
    .join('\n');
}

export function buildAiClientSnippets(url: string, token: string) {
  return {
    claudeCode: `claude mcp add --transport http stageforge ${url} --header "Authorization: Bearer ${token}"`,
    codexCli: `# PowerShell: $env:STAGEFORGE_MCP_TOKEN = "${token}"\ncodex mcp add stageforge --url ${url} --bearer-token-env-var STAGEFORGE_MCP_TOKEN`,
    cursorJson: JSON.stringify(
      {
        mcpServers: {
          stageforge: {
            type: 'streamable-http',
            url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      },
      null,
      2,
    ),
  };
}
