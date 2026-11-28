import { buildDmxPatch } from '../data/dmxPatch';
import { hasExtendedDmx } from '../data/dmxUniverses';
import { getCatalogEntry } from '../data/equipmentCatalog';
import { applyDeskPatch, headLook } from '../data/movingGroups';
import type { LedVisualMode, MovementMode, RigConfig, ShowCue, ShowState } from '../types/show';

export const APC_LIFT_ID = 'deep-house-lift';
const rigAnchor = (group: { id: string; type: string }) =>
  (group.id === 'deep-house-beams' && group.type === 'beam') ||
  (group.id === 'deep-house-wash' && group.type === 'wash');

const colors = [
  { name: 'Red', hex: '#ff243f', led: 5, selectedLed: 4 },
  { name: 'Amber', hex: '#ff931a', led: 9, selectedLed: 8 },
  { name: 'Yellow', hex: '#ffe644', led: 13, selectedLed: 12 },
  { name: 'Green', hex: '#25ee75', led: 21, selectedLed: 20 },
  { name: 'Cyan', hex: '#20e7f8', led: 37, selectedLed: 36 },
  { name: 'Blue', hex: '#397aff', led: 41, selectedLed: 40 },
  { name: 'Violet', hex: '#b15aff', led: 49, selectedLed: 48 },
  { name: 'White', hex: '#ffffff', led: 2, selectedLed: 3 },
] as const;

export type ApcPatch =
  | { kind: 'lighting'; primary: string; accent: string }
  | { kind: 'laserColor'; primary: string }
  | { kind: 'wall'; mode: LedVisualMode }
  | { kind: 'movement'; mode: MovementMode }
  | { kind: 'cue'; id: string };
type ApcPad = { name: string; hex: string; accent?: string; led: number; selectedLed: number; action: ApcPatch };

const palettes = [
  ['Ember', 0, 1], ['Afterglow', 1, 6], ['Acid Garden', 2, 3], ['Lagoon', 3, 4],
  ['Blue Hour', 4, 5], ['Ultraviolet', 5, 6], ['Orchid', 6, 0], ['Daybreak', 7, 1],
] as const;
const wallLooks = [
  ['Wall Tunnel', 'tunnel'], ['Wall Grid', 'cybergrid'], ['Wall Spectrum', 'spectrum'],
  ['Wall Plasma', 'plasma'], ['Wall Mandala', 'mandala'], ['Wall Deep House', 'tour_text'],
] as const;
const cueLooks = [
  ['Intro', 5], ['Groove', 4], ['Build', 6], ['Peak', 0],
  ['Close', 1], ['Smoke Blue', 5], ['Acid Break', 3], ['White Room', 7],
] as const;

export const APC_CUE_IDS = cueLooks.map(([name]) => 'deep-house-' + name.toLowerCase().replaceAll(' ', '-'));
const cuePads: ApcPad[] = cueLooks.map(([name, color], index) => ({
  ...colors[color], name, action: { kind: 'cue', id: APC_CUE_IDS[index] },
}));
export const APC_ROWS: readonly { name: string; pads: readonly ApcPad[] }[] = [
  { name: 'Lighting color', pads: colors.map(color => ({
    ...color, action: { kind: 'lighting', primary: color.hex, accent: color.hex },
  })) },
  { name: 'Virtual laser color', pads: colors.map(color => ({
    ...color, action: { kind: 'laserColor', primary: color.hex },
  })) },
  { name: 'Lighting palettes', pads: palettes.map(([name, first, second]) => ({
    ...colors[first], name, accent: colors[second].hex,
    action: { kind: 'lighting', primary: colors[first].hex, accent: colors[second].hex },
  })) },
  { name: 'Wall and movement', pads: [
    ...wallLooks.map(([name, mode], index): ApcPad => ({
      ...colors[index], name, action: { kind: 'wall', mode },
    })),
    { ...colors[6], name: 'Movement Circle', action: { kind: 'movement', mode: 'circle' } },
    { ...colors[7], name: 'Movement Fan', action: { kind: 'movement', mode: 'fan' } },
  ] },
  { name: 'Cue looks', pads: cuePads },
];
export const APC_PADS = APC_ROWS.flatMap(row => row.pads);
export const APC_SCENES = cuePads.slice(0, 5);

export const APC_FADERS = [
  ['beamIntensity', 'Beam level'], ['washIntensity', 'Wash level'], ['laser', 'Virtual laser level'],
  ['wall', 'LED wall brightness'], ['haze', 'Haze level'], ['lift', 'Simulated lift height'],
  ['movementSpeed', 'Movement speed'], ['beamZoom', 'Beam width'], ['masterDimmer', 'Master dimmer'],
] as const;
export type ApcFader = (typeof APC_FADERS)[number][0];
export type ApcAction = ApcPatch | { kind: 'fader'; fader: ApcFader; value: number } | { kind: 'blackout' };

export function resolveApcRig(rig: RigConfig) {
  const groups = [...rig.trussPods.flatMap(pod => pod.fixtures), ...rig.floorFx];
  const recognized = groups.some(rigAnchor);
  if (!recognized) return { recognized, eligible: false, rgb: false, lift: undefined, wall: false };
  const atU3 = hasExtendedDmx(rig) && groups.every(group => group.dmxUniverse === 3);
  const units = atU3 ? buildDmxPatch(rig).units : [];
  const eligible = units.length === groups.reduce((count, group) => count + group.count, 0) &&
    units.length > 0 &&
    units.every(unit => unit.effectiveStart > 0 && !unit.conflict && !unit.overflow && !unit.unsupportedUniverse);
  const lasers = groups.filter(group => group.type === 'laser' || group.type === 'floor_laser');
  const projector = lasers.length === 1 && lasers[0].count === 1 ? lasers[0] : undefined;
  const rgb = !!projector && (!projector.catalogId || getCatalogEntry(projector.catalogId)?.laser?.colorType === 'rgb');
  const lift = rig.trussPods.find(pod => pod.id === APC_LIFT_ID && pod.motorized && pod.motorMaxY > pod.motorMinY);
  return { recognized, eligible, rgb, lift, wall: rig.ledWall.enabled };
}
export type ApcRig = ReturnType<typeof resolveApcRig>;

export function apcFaderValue(state: ShowState, fader: ApcFader, rig: ApcRig): number {
  switch (fader) {
    case 'laser': return state.laser.intensity;
    case 'wall': return state.led.brightness;
    case 'haze': return state.atmo.hazeLevel;
    case 'lift': {
      const pod = rig.lift;
      return state.motors.podTargets[APC_LIFT_ID]?.height ??
        (pod ? Math.max(0, Math.min(1, (pod.baseY - pod.motorMinY) / (pod.motorMaxY - pod.motorMinY))) : 0);
    }
    default: return state[fader];
  }
}

export function apcActionAvailable(action: ApcAction, rig: ApcRig, state: ShowState, cues: readonly ShowCue[],
  options: { suspended: boolean; motorDrop: boolean; laserClip: boolean }): boolean {
  if (!rig.eligible) return false;
  if (action.kind === 'blackout') return true;
  if (options.suspended) return false;
  if (action.kind === 'cue') return cues.some(cue => cue.id === action.id);
  if (action.kind === 'wall' || (action.kind === 'fader' && action.fader === 'wall')) return rig.wall && state.led.enabled;
  if (action.kind === 'laserColor' || (action.kind === 'fader' && action.fader === 'laser')) {
    return rig.rgb && state.laser.enabled && !options.laserClip && !Object.keys(state.laser.projectors ?? {}).length;
  }
  if (action.kind === 'fader' && action.fader === 'lift') return !!rig.lift && state.motors.mode === 'manual' && !options.motorDrop;
  return true;
}

export function applyApcLook(state: ShowState, action: Exclude<ApcAction, { kind: 'cue' | 'blackout' }>): ShowState {
  switch (action.kind) {
    case 'lighting':
      return applyDeskPatch(state, { primaryColor: action.primary, accentColor: action.accent,
        colorSplitMode: action.primary === action.accent ? 'solid' : 'alternate' });
    case 'laserColor':
      return { ...state, laser: { ...state.laser, colorMode: 'custom', colorA: action.primary } };
    case 'wall':
      return { ...state, led: { ...state.led, visualMode: action.mode } };
    case 'movement':
      return applyDeskPatch(state, { movementMode: action.mode });
    case 'fader': {
      if (!Number.isFinite(action.value)) return state;
      const value = Math.max(0, Math.min(1, action.value));
      switch (action.fader) {
        case 'laser': return { ...state, laser: { ...state.laser, intensity: value } };
        case 'wall': return { ...state, led: { ...state.led, brightness: value } };
        case 'haze': return { ...state, atmo: { ...state.atmo, hazeLevel: value } };
        case 'lift':
          return { ...state, motors: { ...state.motors, podTargets: { ...state.motors.podTargets,
            [APC_LIFT_ID]: { height: value, tilt: state.motors.podTargets[APC_LIFT_ID]?.tilt ?? 0 } } } };
        default: return applyDeskPatch(state, { [action.fader]: value });
      }
    }
  }
}

export function apcPadSelected(action: ApcPatch, state: ShowState, cueId: string | null): boolean {
  switch (action.kind) {
    case 'cue': return cueId === action.id;
    case 'laserColor': return state.laser.colorMode === 'custom' && state.laser.colorA === action.primary;
    case 'wall': return state.led.visualMode === action.mode;
    case 'movement': return headLook(state, 'beam').movementMode === action.mode && headLook(state, 'wash').movementMode === action.mode;
    case 'lighting':
      return (['beam', 'wash'] as const).every(group => {
        const look = headLook(state, group);
        return look.primaryColor === action.primary && (action.primary === action.accent
          ? look.colorSplitMode === 'solid'
          : look.colorSplitMode === 'alternate' && look.accentColor === action.accent);
      });
  }
}
