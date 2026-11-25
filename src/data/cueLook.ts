import type { ScreenRef, ShowCue, ShowState } from '../types/show';
import { applyDeskPatch } from './movingGroups';

/**
 * Shared predicate identifying a full look snapshot (as opposed to a partial cue or timeline delta).
 * All full captured cues, built-in scene cues, and recording t=0 snapshots populate these subsystems.
 */
export function isFullLookSnapshot(state: Partial<ShowState>): state is ShowState {
  return (
    state.laser !== undefined &&
    state.motors !== undefined &&
    state.atmo !== undefined &&
    state.led !== undefined
  );
}

/** Normalize live look state so empty `audioMap` markers are omitted rather than lingering as `{ mappings: [] }`. */
export function normalizeLookAudioMap(look: ShowState): ShowState {
  if (look.audioMap && look.audioMap.mappings.length === 0) {
    const copy = { ...look };
    delete copy.audioMap;
    return copy;
  }
  return look;
}

/**
 * Apply a timeline event's look snapshot or partial patch cleanly:
 * - Full snapshots replace the look; an absent or empty `audioMap` clears any prior mappings.
 * - Partial patches inherit `audioMap` when omitted, replace it when non-empty, and clear it when `{ mappings: [] }`.
 */
export function applyTimelineLookPatch(prior: ShowState, patch: Partial<ShowState>): ShowState {
  const full = isFullLookSnapshot(patch);
  // Always merge over `prior` so legacy v1-v7 snapshots missing required fields (e.g. bpm) never drop them to undefined,
  // while clearing optional top-level fields omitted by a full snapshot so stale live overrides cannot leak across seeks.
  const next: ShowState = { ...prior, ...patch };
  if (full) {
    if (patch.movingGroups === undefined) delete next.movingGroups;
    if (patch.focusMarkId === undefined) delete next.focusMarkId;
    if (patch.audioMap && patch.audioMap.mappings.length > 0) {
      next.audioMap = structuredClone(patch.audioMap);
    } else {
      delete next.audioMap;
    }
  } else if (Object.prototype.hasOwnProperty.call(patch, 'audioMap')) {
    if (patch.audioMap && patch.audioMap.mappings.length > 0) {
      next.audioMap = structuredClone(patch.audioMap);
    } else {
      delete next.audioMap;
    }
  }
  return next;
}

export function cueLook(previous: ShowState, cue: ShowCue, automatic = false): ShowState {
  const state = cue.state;
  const fullScene = isFullLookSnapshot(state);
  const captured = state.masterDimmer !== undefined;
  const next: ShowState = {
    ...applyDeskPatch(previous, state),
    ...(state.movementMode !== undefined && captured && !state.movingGroups
      && previous.movingGroups ? { movingGroups: {} } : {}),
    autoDirector: automatic && previous.autoDirector,
    bpm: state.bpm ?? previous.bpm,
    masterDimmer: state.masterDimmer ?? previous.masterDimmer,
    blackout: state.blackout ?? false,
    laser: state.laser ?? previous.laser,
    motors: state.motors ? {
      ...previous.motors, ...state.motors,
      podTargets: captured || Object.keys(state.motors.podTargets).length ? state.motors.podTargets : previous.motors.podTargets,
    } : previous.motors,
    atmo: state.atmo ? { ...previous.atmo, ...state.atmo } : previous.atmo,
    led: state.led ? {
      ...previous.led, ...state.led,
      tourText: captured ? state.led.tourText : previous.led.tourText,
      customMediaUrl: previous.led.customMediaUrl,
      customMediaType: previous.led.customMediaType,
    } : previous.led,
  };
  if (state.audioMap !== undefined) {
    if (state.audioMap.mappings.length > 0) {
      next.audioMap = structuredClone(state.audioMap);
    } else {
      delete next.audioMap;
    }
  } else if (fullScene && 'audioMap' in next) {
    // Full cues (captured or built-in presets) without audioMap clear previous live mappings (delete key so sameValue matches).
    delete next.audioMap;
  }
  return next;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const fields = Object.entries(a);
  return fields.length === Object.keys(b).length &&
    fields.every(([key, value]) => Object.hasOwn(b, key) && sameValue(value, (b as Record<string, unknown>)[key]));
}

// A v1 file stores the live look and stack position. Inherited fields on a
// partial cue and session-only media URLs do not indicate an operator edit.
export function differsFromCue(look: ShowState, cue: ShowCue | undefined, screen: ScreenRef) {
  if (!cue) return false;
  if (cue.screen && (cue.screen.kind !== screen.kind || cue.screen.name !== screen.name)) return true;
  const normalized = normalizeLookAudioMap(look);
  return !sameValue(normalized, cueLook(normalized, cue, normalized.autoDirector));
}
