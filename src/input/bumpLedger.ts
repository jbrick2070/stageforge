import type { BumpState } from '../types/show';

export const REMOTE_BUMP_LEASE_MS = 2000;
export const GAMEPAD_BUMP_LEASE_MS = 2000;
export const MAX_BUMP_SOURCES = 64;

export type BumpSourceClass = 'local' | 'gamepad' | 'remote';

export const EMPTY_BUMP_STATE: BumpState = Object.freeze({
  blinder: false,
  strobe: false,
  co2: false,
  smoke: false,
  laser: false,
  motorDrop: false,
});

const BUMP_KEYS: readonly (keyof BumpState)[] = [
  'blinder',
  'strobe',
  'co2',
  'smoke',
  'laser',
  'motorDrop',
];

interface SourceRecord {
  sourceClass: BumpSourceClass;
  holds: Partial<Record<keyof BumpState, number>>; // key -> expiresAtMs (Infinity for local holds)
}

export interface ResolvedBumps {
  readonly effective: BumpState;
  readonly laserLocal: boolean;
  readonly laserRemote: boolean;
}

/**
 * Pure source-owned momentary bump ledger.
 * - Local UI/keyboard holds stay active until released or window blur.
 * - Remote (OSC/MSC) holds expire after `remoteLeaseMs` (default 2,000 ms) unless refreshed.
 * - Gamepad holds use a finite `gamepadLeaseMs` refreshed on every poll while pressed.
 * - Remote `laser` bumps NEVER enable a laser when the desk toggle (`laserDeskEnabled`) is off.
 * - Disconnecting a transport, disabling a listener, changing clock mode, entering viewer mode,
 *   or blurring the window clears the affected (or all) holds immediately.
 */
export class BumpLedger {
  private readonly sources = new Map<string, SourceRecord>();
  private readonly remoteLeaseMs: number;
  private readonly gamepadLeaseMs: number;

  constructor(options: { remoteLeaseMs?: number; gamepadLeaseMs?: number } = {}) {
    this.remoteLeaseMs = options.remoteLeaseMs ?? REMOTE_BUMP_LEASE_MS;
    this.gamepadLeaseMs = options.gamepadLeaseMs ?? GAMEPAD_BUMP_LEASE_MS;
  }

  public setHold(
    sourceId: string,
    sourceClass: BumpSourceClass,
    key: keyof BumpState,
    active: boolean,
    now = performance.now(),
  ): boolean {
    if (!sourceId) return false;
    this.pruneExpired(now);

    const existing = this.sources.get(sourceId);
    if (!active) {
      if (!existing || !(key in existing.holds)) return false;
      delete existing.holds[key];
      if (Object.keys(existing.holds).length === 0) {
        this.sources.delete(sourceId);
      }
      return true;
    }

    if (!existing && this.sources.size >= MAX_BUMP_SOURCES) {
      // Never let a spoofed remote flood evict an already-active legitimate hold.
      if (sourceClass === 'remote') return false;
      // Local/gamepad sources always take priority: evict the remote source with the earliest max expiry.
      let earliestId: string | null = null;
      let earliestMaxExp = Infinity;
      for (const [id, rec] of this.sources) {
        if (rec.sourceClass !== 'remote') continue;
        let maxExp = -Infinity;
        for (const k of BUMP_KEYS) {
          const exp = rec.holds[k];
          if (exp !== undefined && exp > maxExp) maxExp = exp;
        }
        if (maxExp < earliestMaxExp) {
          earliestMaxExp = maxExp;
          earliestId = id;
        }
      }
      if (earliestId !== null) {
        this.sources.delete(earliestId);
      }
    }

    const expiresAt =
      sourceClass === 'local'
        ? Infinity
        : sourceClass === 'gamepad'
          ? now + this.gamepadLeaseMs
          : now + this.remoteLeaseMs;

    if (existing) {
      existing.sourceClass = sourceClass;
      existing.holds[key] = expiresAt;
    } else {
      this.sources.set(sourceId, { sourceClass, holds: { [key]: expiresAt } });
    }
    return true;
  }

  public clearSource(sourceId: string): boolean {
    return this.sources.delete(sourceId);
  }

  public clearSourcePrefix(prefix: string): boolean {
    let removed = false;
    for (const id of [...this.sources.keys()]) {
      if (id === prefix || id.startsWith(prefix)) {
        this.sources.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  public clearClass(sourceClass: BumpSourceClass): boolean {
    let removed = false;
    for (const [id, rec] of [...this.sources.entries()]) {
      if (rec.sourceClass === sourceClass) {
        this.sources.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  public clearAll(): boolean {
    if (this.sources.size === 0) return false;
    this.sources.clear();
    return true;
  }

  public pruneExpired(now = performance.now()): boolean {
    let changed = false;
    for (const [id, rec] of [...this.sources.entries()]) {
      let anyLeft = false;
      for (const key of BUMP_KEYS) {
        const exp = rec.holds[key];
        if (exp === undefined) continue;
        if (exp <= now) {
          delete rec.holds[key];
          changed = true;
        } else {
          anyLeft = true;
        }
      }
      if (!anyLeft) {
        this.sources.delete(id);
      }
    }
    return changed;
  }

  /** Returns the earliest finite expiry timestamp (ms) across all active holds, or null if none. */
  public nextExpiryMs(now = performance.now()): number | null {
    this.pruneExpired(now);
    let earliest = Infinity;
    for (const rec of this.sources.values()) {
      for (const key of BUMP_KEYS) {
        const exp = rec.holds[key];
        if (exp !== undefined && Number.isFinite(exp) && exp < earliest) {
          earliest = exp;
        }
      }
    }
    return Number.isFinite(earliest) ? earliest : null;
  }

  public resolve(options: { laserDeskEnabled?: boolean; onlySource?: string } = {}, now = performance.now()): ResolvedBumps {
    this.pruneExpired(now);
    const effective: BumpState = {
      blinder: false,
      strobe: false,
      co2: false,
      smoke: false,
      laser: false,
      motorDrop: false,
    };
    let laserLocal = false;
    let laserRemote = false;
    const laserDeskEnabled = options.laserDeskEnabled ?? true;

    for (const [sourceId, rec] of this.sources) {
      if (options.onlySource !== undefined && sourceId !== options.onlySource) continue;
      for (const key of BUMP_KEYS) {
        const exp = rec.holds[key];
        if (exp === undefined || exp <= now) continue;
        if (key === 'laser') {
          if (rec.sourceClass === 'remote') {
            laserRemote = true;
            if (laserDeskEnabled) effective.laser = true;
          } else {
            laserLocal = true;
            effective.laser = true;
          }
        } else {
          effective[key] = true;
        }
      }
    }

    return { effective, laserLocal, laserRemote };
  }
}

export function sameBumpState(a: BumpState, b: BumpState): boolean {
  return (
    a.blinder === b.blinder &&
    a.strobe === b.strobe &&
    a.co2 === b.co2 &&
    a.smoke === b.smoke &&
    a.laser === b.laser &&
    a.motorDrop === b.motorDrop
  );
}
