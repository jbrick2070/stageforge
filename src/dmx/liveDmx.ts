// Renderer-side configuration types and safe localStorage persistence for live DMX output.
// Safety invariant: output `enabled` state is NEVER persisted; StageForge always boots offline.

export type DmxOutputMode = 'sacn' | 'artnet' | 'serial';

export interface DmxOutputSettings {
  mode: DmxOutputMode;
  iface: string;
  rateHz: number;
  sacnMode: 'multicast' | 'unicast';
  sacnUniverse1: number;
  sacnUniverse2: number;
  sacnPriority: number;
  sacnTtl: number;
  sacnTargets: string;
  artnetBase: number;
  artnetTargets: string;
  artnetBroadcast: boolean;
  serialUniverse: 1 | 2;
  serialAllowAll: boolean;
}

export interface LiveDmxBannerState {
  active: boolean;
  label: string;
  detail: string;
  degraded: boolean;
  error: string | null;
  stoppedNotice?: string | null;
}

const STORAGE_KEY = 'stageforge.dmx.output.v1';

export function defaultDmxOutputSettings(hasDesktopBridge: boolean): DmxOutputSettings {
  return {
    mode: hasDesktopBridge ? 'sacn' : 'serial',
    iface: '127.0.0.1',
    rateHz: 40,
    sacnMode: 'unicast',
    sacnUniverse1: 1,
    sacnUniverse2: 2,
    sacnPriority: 100,
    sacnTtl: 1,
    sacnTargets: '127.0.0.1',
    artnetBase: 0,
    artnetTargets: '127.0.0.1',
    artnetBroadcast: false,
    serialUniverse: 1,
    serialAllowAll: false,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function loadDmxOutputSettings(hasDesktopBridge: boolean): DmxOutputSettings {
  const defaults = defaultDmxOutputSettings(hasDesktopBridge);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<DmxOutputSettings>;
    if (!parsed || typeof parsed !== 'object') return defaults;
    const allowedModes: DmxOutputMode[] = hasDesktopBridge ? ['sacn', 'artnet', 'serial'] : ['serial'];
    const mode = allowedModes.includes(parsed.mode as DmxOutputMode) ? (parsed.mode as DmxOutputMode) : defaults.mode;
    const u1 = clampInt(parsed.sacnUniverse1, 1, 63999, defaults.sacnUniverse1);
    let u2 = clampInt(parsed.sacnUniverse2, 1, 63999, defaults.sacnUniverse2);
    if (u2 === u1) u2 = u1 < 63999 ? u1 + 1 : 1;
    return {
      mode,
      iface: typeof parsed.iface === 'string' && parsed.iface.length <= 64 ? parsed.iface : defaults.iface,
      rateHz: clampInt(parsed.rateHz, 1, 44, defaults.rateHz),
      sacnMode: parsed.sacnMode === 'unicast' ? 'unicast' : 'multicast',
      sacnUniverse1: u1,
      sacnUniverse2: u2,
      sacnPriority: clampInt(parsed.sacnPriority, 0, 200, defaults.sacnPriority),
      sacnTtl: clampInt(parsed.sacnTtl, 1, 255, defaults.sacnTtl),
      sacnTargets: typeof parsed.sacnTargets === 'string' && parsed.sacnTargets.length <= 256 ? parsed.sacnTargets : defaults.sacnTargets,
      artnetBase: clampInt(parsed.artnetBase, 0, 32766, defaults.artnetBase),
      artnetTargets: typeof parsed.artnetTargets === 'string' && parsed.artnetTargets.length <= 256 ? parsed.artnetTargets : defaults.artnetTargets,
      artnetBroadcast: Boolean(parsed.artnetBroadcast),
      serialUniverse: parsed.serialUniverse === 2 ? 2 : 1,
      serialAllowAll: Boolean(parsed.serialAllowAll),
    };
  } catch {
    return defaults;
  }
}

export function saveDmxOutputSettings(settings: DmxOutputSettings): void {
  try {
    // Only transport settings are saved — NEVER the enabled/live state.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore quota or storage restrictions.
  }
}

export function parseTargetList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function formatArtNetAddress(portAddress: number): string {
  const net = (portAddress >> 8) & 0x7f;
  const sub = (portAddress >> 4) & 0x0f;
  const uni = portAddress & 0x0f;
  return `${portAddress} (Net ${net} · Sub ${sub} · Uni ${uni})`;
}
