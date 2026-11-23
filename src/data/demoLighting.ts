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
  intro:     { colors: ['#365aaa', '#b38b62'], level: [0.07, 0.32], movement: 'fan', motor: 'low', screen: 'tour_text' },
  groove:    { colors: ['#327bd3', '#ffac53'], level: [0.38, 0.58], movement: 'sweep', motor: 'breathe', screen: 'cybergrid' },
  build:     { colors: ['#6561f0', '#fdab55'], level: [0.42, 0.88], movement: 'wave', motor: 'high', screen: 'tunnel', laser: 'horizon' },
  drop:      { colors: ['#13c7fe', '#ff652d'], level: [1.00, 0.80], movement: 'flyout', motor: 'v_tilt', screen: 'spectrum', laser: 'fan' },
  breakdown: { colors: ['#324a99', '#efa482'], level: [0.14, 0.30], movement: 'fan', motor: 'low', screen: 'plasma' },
  rebuild:   { colors: ['#805cff', '#5fe8de'], level: [0.28, 0.93], movement: 'figure8', motor: 'high', screen: 'mandala', laser: 'wave' },
  finale:    { colors: ['#ffae45', '#f155b9'], level: [0.84, 1.00], movement: 'wave', motor: 'wave', screen: 'tunnel', laser: 'dual_cones' },
  outro:     { colors: ['#ffb779', '#ae7d80'], level: [0.57, 0.045], movement: 'fan', motor: 'breathe', screen: 'tour_text' },
};

// The director owns show fixtures. The operator keeps the master, blackout, camera and media.
export function applyDemoLighting(state: ShowState, pos: DemoPosition): ShowState {
  const id = pos.sectionId;
  const look = looks[id];
  const lift = id === 'build' || id === 'rebuild';
  const peak = id === 'drop' || id === 'finale';
  const rest = lift && pos.barInSection === pos.sectionBars - 1 && pos.stepInBar >= 12;
  const progress = pos.sectionProgress;
  const ease = progress * progress * (3 - 2 * progress);
  const level = rest ? 0.025 : look.level[0] + (look.level[1] - look.level[0]) * ease;
  const accent = peak && pos.barInSection % 4 === 0 && pos.stepInBar < 2;
  const laserLevel = look.laser && !rest ? (peak ? 0.48 + level * 0.35 : Math.max(0, progress - 0.35) * 0.55) : 0;
  return {
    ...state,
    primaryColor: look.colors[0], accentColor: look.colors[1],
    colorSplitMode: peak ? 'alternate' : 'gradient',
    beamIntensity: level, washIntensity: 0.035 + level * (peak ? 0.70 : 0.48),
    beamZoom: lift ? 0.52 - progress * 0.43 : peak ? 0.18 : 0.47,
    movementMode: look.movement, movementSpeed: 0.07 + level * (peak ? 0.69 : 0.53),
    movementSpread: 0.19 + level * 0.76, goboPrism: id === 'finale' && pos.barInSection >= 4,
    strobeRate: 0, blinderLevel: accent ? 0.63 : 0,
    laser: { ...state.laser, enabled: laserLevel > 0, intensity: laserLevel,
      pattern: look.laser ?? 'fan', colorMode: 'dual', beamCount: peak ? 18 : 8,
      spreadX: peak ? 0.87 : 0.52, spreadY: 0.35 + level * 0.26, speed: 0.1 + level * 0.38,
      tilt: 0.16, rotation: 0.24, strobe: 0, audienceScan: false },
    motors: { ...state.motors, mode: look.motor, speed: 0.18 + level * 0.39 },
    atmo: { ...state.atmo, hazeLevel: 0.40 + 0.21 * level, smokeOutput: peak ? 0.20 : 0.045,
      co2Active: false, co2AutoOnDrop: peak },
    led: { ...state.led, enabled: true, visualMode: look.screen, brightness: level * 0.72, speed: 0.07 + level * 0.48 },
  };
}
