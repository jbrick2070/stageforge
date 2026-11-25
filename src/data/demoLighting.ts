import type { DemoPosition, DemoSectionId } from './demoShow';
import type { LaserPattern, LedVisualMode, MotorMode, MovementMode, ShowState } from '../types/show';

interface DemoLook {
  colors: [string, string];
  level: [number, number];
  movement: MovementMode;
  motor: MotorMode;
  screen: LedVisualMode;
  laser?: LaserPattern;
}

const looks: Record<DemoSectionId, DemoLook> = {
  intro:     { colors: ['#ffae66', '#ffae66'], level: [0, 0.38], movement: 'fan', motor: 'low', screen: 'cybergrid' },
  groove:    { colors: ['#ffae66', '#4288dd'], level: [0.38, 0.58], movement: 'sweep', motor: 'breathe', screen: 'cybergrid' },
  build:     { colors: ['#fdab55', '#7666f0'], level: [0.58, 0.88], movement: 'wave', motor: 'high', screen: 'tunnel', laser: 'horizon' },
  drop:      { colors: ['#13c7fe', '#ff652d'], level: [1.00, 0.80], movement: 'flyout', motor: 'v_tilt', screen: 'spectrum', laser: 'fan' },
  breakdown: { colors: ['#324a99', '#efa482'], level: [0.14, 0.30], movement: 'fan', motor: 'low', screen: 'plasma' },
  rebuild:   { colors: ['#805cff', '#5fe8de'], level: [0.28, 0.93], movement: 'figure8', motor: 'high', screen: 'mandala', laser: 'wave' },
  finale:    { colors: ['#ffae45', '#f155b9'], level: [0.84, 1.00], movement: 'wave', motor: 'wave', screen: 'tunnel', laser: 'dual_cones' },
  outro:     { colors: ['#ffb779', '#ae7d80'], level: [0.57, 0.045], movement: 'fan', motor: 'breathe', screen: 'tour_text' },
};

export const DEMO_BLACKOUT_STEPS = 32;

export function demoFade(step: number, startStep: number, endStep: number): number {
  const t = Math.max(0, Math.min(1, (step - startStep) / (endStep - startStep)));
  return t * t * (3 - 2 * t);
}

function fadeColor(from: string, to: string, amount: number): string {
  if (amount <= 0) return from;
  if (amount >= 1) return to;
  const rgb = [1, 3, 5].map(i => {
    const a = parseInt(from.slice(i, i + 2), 16);
    const b = parseInt(to.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0');
  });
  return '#' + rgb.join('');
}

// The director owns show fixtures. The operator keeps the master, blackout, camera and media.
// Section timing metadata (sectionBars, stepInSection, openingStep, beforeDownbeat) is carried on `pos` by getDemoPosition().
export function applyDemoLighting(state: ShowState, pos: DemoPosition): ShowState {
  const id = pos.sectionId;
  const look = looks[id];
  if (pos.beforeDownbeat) {
    return {
      ...state,
      ...(state.movingGroups && Object.keys(state.movingGroups).length ? { movingGroups: {} } : {}),
      primaryColor: look.colors[0], accentColor: look.colors[1],
      colorSplitMode: 'gradient',
      beamIntensity: 0, washIntensity: 0,
      beamZoom: 0.12,
      movementMode: look.movement, movementSpeed: 0.07,
      movementSpread: 0.19, goboPrism: false,
      strobeRate: 0, blinderLevel: 0,
      laser: { enabled: false, intensity: 0,
        pattern: look.laser ?? 'fan', colorMode: 'dual', beamCount: 8,
        spreadX: 0.52, spreadY: 0.35, speed: 0.1,
        tilt: 0.16, rotation: 0.24, strobe: 0, audienceScan: false },
      motors: { ...state.motors, mode: look.motor, speed: 0.18 },
      atmo: { ...state.atmo, hazeLevel: 0, smokeOutput: 0, co2Active: false, co2AutoOnDrop: false },
      led: { ...state.led, enabled: false, visualMode: look.screen, brightness: 0, speed: 0.07 },
    };
  }
  const lift = id === 'build' || id === 'rebuild';
  const peak = id === 'drop' || id === 'finale';
  const rest = lift && pos.barInSection === pos.sectionBars - 1 && pos.stepInBar >= 12;
  const progress = pos.sectionProgress;
  const ease = progress * progress * (3 - 2 * progress);
  const intro = id === 'intro';
  const groove = id === 'groove';
  const openingStep = pos.openingStep ?? pos.step;
  const stepInSection = pos.stepInSection ?? (pos.barInSection * 16 + pos.stepInBar);
  // Separate the one-time opening reveal (index 0 intro + index 1 post-intro groove LED fade)
  // from section-relative choreography so repeated `intro` or `groove` roles behave consistently at equal progress.
  const isOpeningIntro = intro && (pos.isOpening ?? pos.sectionIndex === 0);
  const isOpeningGroove = groove && (pos.isOpeningTransition ?? (pos.sectionIndex === 1 && openingStep < 1_000_000));
  const sectionSteps = Math.max(16, pos.sectionBars * 16);
  const introStep = isOpeningIntro ? openingStep : (stepInSection * 128) / sectionSteps;
  const wingFade = demoFade(introStep, 64, 128);
  // Bars 1–2 are dark. The backlight pair rises in bars 3–4, then the wings join.
  const level = intro ? 0.26 * demoFade(introStep, DEMO_BLACKOUT_STEPS, 56) + 0.12 * wingFade :
    rest ? 0.025 : look.level[0] + (look.level[1] - look.level[0]) * ease;
  const wash = 0.035 + level * (peak ? 0.70 : 0.48);
  const washFade = demoFade(introStep, 96, 128);
  const ledFade = isOpeningIntro || isOpeningGroove ? demoFade(openingStep, 128, 224) : 1;
  const accentColor = intro ? fadeColor(look.colors[1], looks.groove.colors[1], wingFade) :
    id === 'build' ? fadeColor(looks.groove.colors[1], look.colors[1], demoFade(stepInSection, 0, 32)) : look.colors[1];
  const accent = peak && pos.barInSection % 4 === 0 && pos.stepInBar < 2;
  const laserLevel = look.laser && !rest ? (peak ? 0.48 + level * 0.35 : Math.max(0, progress - 0.35) * 0.55) : 0;
  return {
    ...state,
    ...(state.movingGroups && Object.keys(state.movingGroups).length ? { movingGroups: {} } : {}),
    primaryColor: look.colors[0], accentColor,
    colorSplitMode: peak ? 'alternate' : 'gradient',
    beamIntensity: level, washIntensity: intro ? wash * washFade : wash,
    beamZoom: intro ? 0.12 + wingFade * 0.35 : lift ? 0.47 - progress * 0.38 : peak ? 0.18 : 0.47,
    movementMode: look.movement, movementSpeed: 0.07 + level * (peak ? 0.69 : 0.53),
    movementSpread: 0.19 + level * 0.76, goboPrism: id === 'finale' && pos.barInSection >= 4,
    strobeRate: 0, blinderLevel: accent ? 0.63 : 0,
    laser: { enabled: laserLevel > 0, intensity: laserLevel,
      pattern: look.laser ?? 'fan', colorMode: 'dual', beamCount: peak ? 18 : 8,
      spreadX: peak ? 0.87 : 0.52, spreadY: 0.35 + level * 0.26, speed: 0.1 + level * 0.38,
      tilt: 0.16, rotation: 0.24, strobe: 0, audienceScan: false },
    motors: { ...state.motors, mode: look.motor, speed: 0.18 + level * 0.39 },
    atmo: { ...state.atmo, hazeLevel: (0.40 + 0.21 * level) * (intro ? demoFade(introStep, DEMO_BLACKOUT_STEPS, 48) : 1),
      smokeOutput: intro ? 0 : groove ? 0.045 * (isOpeningGroove ? ledFade : 1) : peak ? 0.20 : 0.045,
      co2Active: false, co2AutoOnDrop: peak },
    led: { ...state.led, enabled: !intro && (!groove || !isOpeningGroove || ledFade > 0), visualMode: look.screen,
      brightness: level * 0.72 * (isOpeningIntro || isOpeningGroove ? ledFade : intro ? 0 : 1), speed: 0.07 + level * 0.48 },
  };
}
