import {
  DEMO_SECTION_ROLES,
  compileDemoTimeline,
  getDemoPosition,
  type DemoPosition,
  type DemoSection,
  type DemoSectionId,
  type DemoTimeline,
} from './demoShow';

export const DEMO_TRACK_FORMAT = 'stageforge-demo-track';
export const DEMO_TRACK_VERSION = 1;
export const DEMO_TRACK_MIN_BPM = 70;
export const DEMO_TRACK_MAX_BPM = 180;
export const DEMO_TRACK_MIN_SECTIONS = 3;
export const DEMO_TRACK_MAX_SECTIONS = 24;
export const DEMO_TRACK_MAX_SECTION_BARS = 64;
export const DEMO_TRACK_MAX_TOTAL_BARS = 512;
export const DEMO_TRACK_MAX_DOWNBEAT_MS = 600_000;
export const DEMO_TRACK_MAP_MAX_BYTES = 64 * 1024;
export const DEMO_TRACK_AUDIO_MAX_BYTES = 16 * 1024 * 1024;

const ROLE_SET = new Set<string>(DEMO_SECTION_ROLES);
const AUDIO_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(mp3|m4a|ogg|wav)$/i;
const CONTROL_AND_BIDI_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export interface DemoTrackMap {
  readonly format: typeof DEMO_TRACK_FORMAT;
  readonly version: typeof DEMO_TRACK_VERSION;
  readonly title: string;
  readonly file: string;
  readonly bpm: number;
  readonly firstDownbeatMs: number;
  readonly sections: readonly DemoSection[];
  readonly timeline: DemoTimeline;
}

export interface AvailableDemoTrack {
  readonly map: DemoTrackMap;
  readonly mapUrl: string;
  readonly audioUrl: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function sanitizeLabel(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Demo track map "${field}" must be a non-empty string.`);
  }
  const cleaned = value.replace(CONTROL_AND_BIDI_RE, '').trim();
  if (!cleaned) {
    throw new Error(`Demo track map "${field}" must be a non-empty string.`);
  }
  if ([...cleaned].length > maxLength) {
    throw new Error(`Demo track map "${field}" must be at most ${maxLength} characters.`);
  }
  return cleaned;
}

function validateFileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Demo track map "file" must be a plain audio filename.');
  }
  if (value.includes('..') || !AUDIO_BASENAME_RE.test(value)) {
    throw new Error(
      'Demo track map "file" must be a plain basename ending in .mp3, .m4a, .ogg, or .wav (no folders or "..").',
    );
  }
  return value;
}

export function parseDemoTrackMap(raw: unknown): DemoTrackMap {
  if (!isPlainObject(raw)) {
    throw new Error('Demo track map must be a JSON object.');
  }
  const format = own(raw, 'format');
  if (format !== DEMO_TRACK_FORMAT) {
    throw new Error(`Demo track map "format" must be "${DEMO_TRACK_FORMAT}".`);
  }
  const version = own(raw, 'version');
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('Demo track map "version" must be a positive integer.');
  }
  if (version > DEMO_TRACK_VERSION) {
    throw new Error(
      `Demo track map uses newer format version ${version} (this version of StageForge supports version ${DEMO_TRACK_VERSION}).`,
    );
  }

  const title = sanitizeLabel(own(raw, 'title'), 'title', 80);
  const file = validateFileName(own(raw, 'file'));

  const bpm = own(raw, 'bpm');
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < DEMO_TRACK_MIN_BPM || bpm > DEMO_TRACK_MAX_BPM) {
    throw new Error(`Demo track map "bpm" must be a finite number between ${DEMO_TRACK_MIN_BPM} and ${DEMO_TRACK_MAX_BPM}.`);
  }

  const firstDownbeatMs = own(raw, 'firstDownbeatMs');
  if (
    typeof firstDownbeatMs !== 'number' ||
    !Number.isFinite(firstDownbeatMs) ||
    firstDownbeatMs < 0 ||
    firstDownbeatMs > DEMO_TRACK_MAX_DOWNBEAT_MS
  ) {
    throw new Error(`Demo track map "firstDownbeatMs" must be a finite number between 0 and ${DEMO_TRACK_MAX_DOWNBEAT_MS}.`);
  }

  const rawSections = own(raw, 'sections');
  if (!Array.isArray(rawSections)) {
    throw new Error('Demo track map "sections" must be an array.');
  }
  if (rawSections.length < DEMO_TRACK_MIN_SECTIONS || rawSections.length > DEMO_TRACK_MAX_SECTIONS) {
    throw new Error(
      `Demo track map "sections" must contain between ${DEMO_TRACK_MIN_SECTIONS} and ${DEMO_TRACK_MAX_SECTIONS} sections.`,
    );
  }

  const sections: DemoSection[] = [];
  let totalBars = 0;
  for (let i = 0; i < rawSections.length; i++) {
    const entry = rawSections[i];
    if (!isPlainObject(entry)) {
      throw new Error(`Demo track map section #${i + 1} must be an object.`);
    }
    const role = own(entry, 'role');
    if (typeof role !== 'string' || !ROLE_SET.has(role)) {
      throw new Error(
        `Demo track map section #${i + 1} has unknown role "${String(role)}". Expected one of: ${DEMO_SECTION_ROLES.join(', ')}.`,
      );
    }
    const label = sanitizeLabel(own(entry, 'label'), `sections[${i}].label`, 48);
    const bars = own(entry, 'bars');
    if (
      typeof bars !== 'number' ||
      !Number.isInteger(bars) ||
      bars < 1 ||
      bars > DEMO_TRACK_MAX_SECTION_BARS
    ) {
      throw new Error(
        `Demo track map section #${i + 1} "bars" must be an integer between 1 and ${DEMO_TRACK_MAX_SECTION_BARS}.`,
      );
    }
    totalBars += bars;
    if (totalBars > DEMO_TRACK_MAX_TOTAL_BARS) {
      throw new Error(`Demo track map total bars (${totalBars}) exceeds the maximum of ${DEMO_TRACK_MAX_TOTAL_BARS}.`);
    }
    sections.push(Object.freeze({ role: role as DemoSectionId, label, bars }));
  }

  const frozenSections = Object.freeze(sections);
  const timeline = compileDemoTimeline(frozenSections);
  return Object.freeze({
    format: DEMO_TRACK_FORMAT,
    version: DEMO_TRACK_VERSION,
    title,
    file,
    bpm,
    firstDownbeatMs,
    sections: frozenSections,
    timeline,
  });
}

export function demoTrackStepAtMs(map: Pick<DemoTrackMap, 'bpm' | 'firstDownbeatMs'>, playbackMs: number): number {
  if (!Number.isFinite(playbackMs)) return 0;
  return ((playbackMs - map.firstDownbeatMs) * map.bpm) / 15000;
}

export function demoTrackMsForStep(map: Pick<DemoTrackMap, 'bpm' | 'firstDownbeatMs'>, step: number): number {
  if (!Number.isFinite(step)) return map.firstDownbeatMs;
  return map.firstDownbeatMs + (step * 15000) / map.bpm;
}

export function getDemoTrackPosition(map: DemoTrackMap, playbackMs: number, ended = false): DemoPosition {
  const rawStep = demoTrackStepAtMs(map, playbackMs);
  if (!ended && rawStep < 0) {
    const start = getDemoPosition(0, map.timeline);
    return {
      ...start,
      openingStep: 0,
      finished: false,
      beforeDownbeat: true,
    };
  }
  const pos = getDemoPosition(rawStep, map.timeline);
  if (ended && !pos.finished) {
    return { ...pos, finished: true };
  }
  return pos;
}

export function resolveDemoTrackMapUrl(baseUrl: string, baseHref: string): URL {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(`${normalizedBase}demo/track.json`, baseHref);
}

export function resolveDemoTrackAudioUrl(mapUrl: URL, file: string): URL {
  const safeFile = validateFileName(file);
  const audioUrl = new URL(safeFile, mapUrl);
  const mapDir = mapUrl.pathname.slice(0, mapUrl.pathname.lastIndexOf('/') + 1);
  if (audioUrl.origin !== mapUrl.origin || !audioUrl.pathname.startsWith(mapDir)) {
    throw new Error('Demo track audio URL must stay in the same directory as demo/track.json.');
  }
  return audioUrl;
}

function mimeForAudioFile(file: string): string {
  const lower = file.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

async function readBoundedBytes(
  res: Response,
  maxBytes: number,
  label: string,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLengthHeader = res.headers.get('content-length');
  const declared = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (total !== null && total > maxBytes) {
    throw new Error(`${label} exceeds the ${Math.round(maxBytes / (1024 * 1024)) || 1} MB size limit.`);
  }
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new Error(`${label} exceeds the size limit.`);
    }
    onProgress?.(ab.byteLength, ab.byteLength);
    return new Uint8Array(ab);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      loaded += value.byteLength;
      if (loaded > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds the size limit.`);
      }
      chunks.push(value);
      onProgress?.(loaded, total);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(new ArrayBuffer(loaded));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function probeDemoTrack(
  baseUrl: string,
  baseHref: string,
  signal?: AbortSignal,
): Promise<AvailableDemoTrack | null> {
  try {
    const mapUrl = resolveDemoTrackMapUrl(baseUrl, baseHref);
    const res = await fetch(mapUrl.href, {
      method: 'GET',
      cache: 'no-cache',
      redirect: 'error',
      signal,
    });
    if (!res.ok || res.status === 204) return null;
    const bytes = await readBoundedBytes(res, DEMO_TRACK_MAP_MAX_BYTES, 'Demo track map');
    if (bytes.byteLength === 0) return null;
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const json: unknown = JSON.parse(text);
    const map = parseDemoTrackMap(json);
    const audioUrl = resolveDemoTrackAudioUrl(mapUrl, map.file);
    return Object.freeze({
      map,
      mapUrl: mapUrl.href,
      audioUrl: audioUrl.href,
    });
  } catch {
    return null;
  }
}

export async function fetchDemoTrackAudio(
  track: AvailableDemoTrack,
  signal?: AbortSignal,
  onProgress?: (loaded: number, total: number | null) => void,
): Promise<File> {
  const mapUrl = new URL(track.mapUrl);
  const audioUrl = resolveDemoTrackAudioUrl(mapUrl, track.map.file);
  const res = await fetch(audioUrl.href, {
    method: 'GET',
    redirect: 'error',
    signal,
  });
  if (!res.ok) {
    throw new Error(`Could not load demo track audio (${res.status}).`);
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
    throw new Error('Demo track audio URL returned HTML instead of an audio file.');
  }
  const bytes = await readBoundedBytes(res, DEMO_TRACK_AUDIO_MAX_BYTES, 'Demo track audio', onProgress);
  if (bytes.byteLength === 0) {
    throw new Error('Demo track audio file is empty.');
  }
  return new File([bytes], track.map.file, { type: mimeForAudioFile(track.map.file) });
}
