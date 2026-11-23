import type { ScreenRef, ShowCue, ShowState } from '../types/show';

export function cueLook(previous: ShowState, cue: ShowCue, automatic = false): ShowState {
  const state = cue.state;
  const captured = state.masterDimmer !== undefined;
  return {
    ...previous, ...state,
    autoDirector: automatic && previous.autoDirector,
    bpm: state.bpm ?? previous.bpm,
    masterDimmer: state.masterDimmer ?? previous.masterDimmer,
    blackout: state.blackout ?? false,
    laser: state.laser ? { ...previous.laser, ...state.laser } : previous.laser,
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
  return !sameValue(look, cueLook(look, cue, look.autoDirector));
}
