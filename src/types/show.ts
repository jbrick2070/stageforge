import type { SpeakerProfileId } from '../data/speakerProfiles';
import type { DemoPosition } from '../data/demoShow';

export type VenueType = 'arena' | 'warehouse' | 'festival' | 'theatre' | 'club';

export const VENUE_TYPES: readonly VenueType[] = ['arena', 'warehouse', 'festival', 'theatre', 'club'];

export type TrussShape = 'box' | 'circle' | 'chevron' | 'path';

export interface PlanPoint {
  x: number;
  z: number;
}

export interface StagePlatform extends PlanPoint {
  id: string;
  name: string;
  width: number;
  depth: number;
  height: number; // Top surface above the venue floor in metres.
}

export type FixtureType = 'beam' | 'wash' | 'laser' | 'strobe' | 'blinder';

export type FloorFxType = 'hazer' | 'smoke' | 'co2' | 'floor_laser' | 'floor_beam';

export type MovementMode =
  | 'manual'
  | 'fan'
  | 'sweep'
  | 'circle'
  | 'figure8'
  | 'flyout'
  | 'wave'
  | 'ballyhoo'
  | 'crowd_scan';

export type ColorSplitMode = 'solid' | 'alternate' | 'gradient' | 'rainbow';

export type HeadGroup = 'beam' | 'wash';
export type HeadLook = Pick<ShowState, 'movementMode' | 'movementSpeed' | 'movementSpread' |
  'manualPan' | 'manualTilt' | 'focusMarkId' | 'primaryColor' | 'accentColor' | 'colorSplitMode'>;
export type MovingGroups = Partial<Record<HeadGroup, Partial<HeadLook>>>;

export type LaserPattern =
  | 'liquid_sky'
  | 'tunnel'
  | 'fan'
  | 'wave'
  | 'matrix'
  | 'starburst'
  | 'horizon'
  | 'dual_cones';

export type LaserColorMode =
  | 'primary'
  | 'dual'
  | 'rainbow'
  | 'cyan_magenta'
  | 'emerald_gold'
  | 'crimson_ice'
  | 'custom'
  | 'custom_dual';

export type LaserResolution = 8 | 16 | 48 | 96;

export interface LaserAppearance {
  beamCount: number;
  colorMode: LaserColorMode;
  patternSegments?: LaserResolution;
  colorA?: string;
  colorB?: string;
}

export type MotorMode = 'manual' | 'high' | 'low' | 'v_tilt' | 'wave' | 'drop' | 'breathe';

export type LedVisualMode =
  | 'tunnel'
  | 'cybergrid'
  | 'spectrum'
  | 'plasma'
  | 'strobe_bars'
  | 'mandala'
  | 'tour_text'
  | 'custom';

export type CameraPreset =
  | 'foh'
  | 'front_row'
  | 'wide_arena'
  | 'stage_side'
  | 'overhead'
  | 'orbit'
  | 'pa_closeup';

export interface BeamProfile {
  source?: 'datasheet';
  manufacturer: string;
  fixture: string;
  geometry: string;
  lumens?: number;
  beamAngle?: number;
}

export interface FixtureOptics {
  lumens?: number;
  beamAngle?: number;
  profile?: BeamProfile;
}

export interface MountedFixtureGroup {
  id: string;
  type: FixtureType;
  modelName: string;
  optics?: FixtureOptics;
  count: number;
  dmxUniverse: 1 | 2;
  dmxStartChannel: number;
}

export interface TrussPodConfig {
  id: string;
  name: string;
  shape: TrussShape;
  path?: PlanPoint[]; // Ordered vertices in the pod's local XZ plane.
  width: number;
  x: number;
  baseY: number;
  z: number;
  rotationY: number;
  motorized: boolean;
  motorMinY: number;
  motorMaxY: number;
  fixtures: MountedFixtureGroup[];
}

export interface FloorFxUnit {
  id: string;
  type: FloorFxType;
  modelName: string;
  optics?: FixtureOptics;
  count: number;
  x: number;
  z: number;
  spread: number;
  dmxUniverse: 1 | 2;
  dmxStartChannel: number;
}

export type StagePropKind = 'tentacle' | 'star' | 'arch' | 'marquee' | 'riser';

export interface StageProp {
  id: string;
  kind: StagePropKind;
  x: number;
  z: number;
  scale: number;
  rotation: number; // degrees
  color: string;
}

export interface LedCabinets {
  columns: number;
  rows: number;
  widthMm: number;
  heightMm: number;
  pixelsWide: number;
  pixelsHigh: number;
}

export interface RigConfig {
  schemaVersion?: 1;
  name: string;
  venue: VenueType;
  stageWidth: number;
  stageDepth: number;
  stageHeight: number;
  platforms?: StagePlatform[]; // Missing means the original rectangular stage; an empty list means bare floor.
  ledWall: {
    enabled: boolean;
    width: number;
    height: number;
    curved: boolean;
    sideWings: boolean;
    cabinets?: LedCabinets;
  };
  audioRig: {
    lineArrays: boolean;
    speakerProfile?: SpeakerProfileId;
    boxesPerSide?: number;
    monitorCount?: number;
    subWall: boolean;
    subCount: number;
    djBooth: boolean;
    crowdDensity: number; // 0..1
  };
  trussPods: TrussPodConfig[];
  floorFx: FloorFxUnit[];
  props?: StageProp[]; // Earlier rig files predate scenic props.
}

export interface MotorPodTarget {
  height: number; // 0..1 normalized between motorMinY and motorMaxY
  tilt: number; // -1..1 radians scaled
}

export interface ShowState {
  masterDimmer: number; // 0..1
  blackout: boolean;
  autoDirector: boolean;
  audioReactive: boolean;
  bpm: number;

  // Lighting DMX
  movingGroups?: MovingGroups;
  beamIntensity: number;
  washIntensity: number;
  beamZoom: number; // 0 = razor narrow, 1 = wide
  goboPrism: boolean;
  primaryColor: string;
  accentColor: string;
  colorSplitMode: ColorSplitMode;
  movementMode: MovementMode;
  movementSpeed: number;
  movementSpread: number;
  manualPan: number; // -1..1 (free position: pan; on a focus point: X offset)
  manualTilt: number; // -1..1 (free position: tilt; on a focus point: Z offset)
  focusMarkId?: string | null; // Focus point the heads converge on in 'manual' (Position) mode; see engine/focusAim.
  strobeRate: number; // 0..1
  blinderLevel: number; // 0..1

  // Laser Visuals Deck
  laser: LaserAppearance & {
    enabled: boolean;
    intensity: number;
    pattern: LaserPattern;
    projectors?: Record<string, Partial<LaserAppearance>>;
    spreadX: number; // 0.1..1
    spreadY: number; // 0.1..1
    speed: number; // 0..1
    tilt: number; // -1..1
    rotation: number; // 0..1
    strobe: number; // 0..1
    audienceScan: boolean;
  };

  // Kinetic Motors
  motors: {
    mode: MotorMode;
    speed: number;
    podTargets: Record<string, MotorPodTarget>;
  };

  // Atmospherics
  atmo: {
    hazeLevel: number; // 0..1
    smokeOutput: number; // 0..1
    co2Active: boolean;
    co2AutoOnDrop: boolean;
  };

  // LED Video Wall
  led: {
    enabled: boolean;
    brightness: number;
    visualMode: LedVisualMode;
    speed: number;
    tourText: string;
    customMediaUrl: string | null;
    customMediaType: 'image' | 'video' | null;
  };

  // Quality & Atmosphere
  bloomStrength: number; // 0..2
}

export interface BumpState {
  blinder: boolean;
  strobe: boolean;
  co2: boolean;
  smoke: boolean;
  laser: boolean;
  motorDrop: boolean;
}

export interface MusicRef {
  kind: 'demo' | 'file' | 'live' | 'none';
  name: string;
  playing: boolean;
  offsetSeconds?: number;
  demoStep?: number;
}

export interface ScreenRef {
  target: 'main-led';
  kind: 'video' | 'image' | 'none';
  name: string;
  playing: boolean;
  offsetSeconds?: number;
}

export interface ShowCue {
  id: string;
  name: string;
  tag: string;
  accent: string;
  followSeconds?: number; // Omit for a manual hold.
  screen?: ScreenRef;
  state: Partial<ShowState>;
}

export interface AudioMetrics {
  demo?: DemoPosition;
  playing: boolean;
  source: 'none' | 'synth' | 'file' | 'mic';
  trackName: string;
  energy: number; // 0..1 overall
  bass: number; // 0..1 sub/kick
  mid: number; // 0..1 snare/synth
  high: number; // 0..1 hats/air
  beat: boolean; // impulse on detected kick/beat
  beatPulse: number; // decaying 0..1
  drop: boolean; // high-energy drop detection
  spectrum: Float32Array; // 32 bands normalized 0..1
}

export interface DmxChannelInfo {
  universe: 1 | 2;
  channel: number; // 1..512
  label: string;
  group: string;
  value: number; // 0..255
}
