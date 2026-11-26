import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

import {
  AudioMetrics,
  AudioTargetGroup,
  BumpState,
  CameraPreset,
  LaserColorMode,
  LaserResolution,
  LaserPattern,
  LedVisualMode,
  RigConfig,
  FixtureOptics,
  ShowState,
  TrussPodConfig,
} from '../types/show';
import {
  LASER_CONE_FRAG,
  LASER_CONE_VERT,
  LASER_SHEET_FRAG,
  LASER_SHEET_VERT,
  LED_WALL_FRAG,
  LED_WALL_VERT,
  VOLUMETRIC_BEAM_FRAG,
  VOLUMETRIC_BEAM_VERT,
} from './shaders';
import { LED_ANGULAR_DEFINE } from './ledWallResponse';
import { DeckSheenController, type DeckSheenStats } from './deckSheen';
import {
  buildStageEnvironment,
  setWetDeckMaterial,
  type WetDeckEnvironmentStats,
} from './wetDeck';
import { NeonFrameController, type NeonFrameStats } from './neonFrame';
import { AtmosphereLookController } from './atmosphereLook';
import {
  CrowdLightingController,
  createCrowdFrameInputs,
  type CrowdFrameInputs,
  type CrowdLightingStats,
} from './crowdLighting';
import {
  SharedMaterials,
  buildPlatformDeck,
  buildTrussGeometry,
  buildVenueArchitecture,
  createChainHoistUnit,
  createAuthoredLineArray,
  createDjBooth,
  createLineArray,
  createMonitorWedge,
  createSubwoofer,
  createSharedMaterials,
  disposeSharedMaterials,
  type VenueRoom,
} from './geometryBuilders';
import { FixtureModelCache, type FixtureMotion } from './fixtureModels';
import { detectRenderTier, maxPixelRatioForTier, type RenderTier } from './hardwareMaterials';
import { FocusMark, PAN_LIMIT, TILT_LIMIT, aimAngles, aimTiltOnly, axisDmx, focusMarks, focusPoint, reachablePan } from './focusAim';
import { headLook } from '../data/movingGroups';
import { buildDmxPatch, groupFootprint, writeDmxChannels } from '../data/dmxPatch';
import {
  classifyPhysicalGroup,
  writePhysicalUnitBytes,
  type PhysicalGroupClassification,
  type PhysicalUnitState,
} from '../dmx/physicalDmx';
import { floorUnitX, hungUnits, mountSlotIndex } from '../data/fixturePlacement';
import { stageSurfaceHeight } from '../data/stageDesign';
import type { NativeStage } from '../data/showFile';
import { authoredWallSurface, isCustomMainWall, resolveStudioGeometry, resolveWallFrame } from '../data/studioGeometry';
import { createAuthoredProp } from './authoredScenery';
import { ledPlacement, monitorPositions, type LedSurface } from '../data/stageEquipment';
import { AtmosphericParticles, type ParticleLightingUpdate } from './ParticleSystem';
import type { LitPuffsStats } from './litPuffs';
import { laserGeometry } from './laserGeometry';
import { BakedIldaClip, type IldaRenderMode } from './ildaRenderer';
import { ildaScanEnergyBudget, type IldaScanEnergyProjector } from './ildaScanEnergy';
import type { IldaClip } from '../data/ilda';
import { getCatalogEntry, getCatalogMode, type CatalogDmxMode, type CatalogLaserSpec } from '../data/equipmentCatalog';
import { encodeLaserDmxChannels, ildaScanTangents, LASER_ILDA_ROLL_SCALE, LASER_SHEET_ROLL_SCALE, laserPitch, laserPowerPresence } from '../data/laserAim';
import { flickerIntensityMultiplier, laserRefreshHz } from '../data/laserScan';
import { DEFAULT_LASER_COLORS, DEFAULT_LASER_RESOLUTION, laserProjectorKey } from '../data/laserProjectors';
import { BeamPools, type BeamPoolsStats } from './beamPools';
import { prismPhase } from './prismPattern';
import { aerialGain, beamZoomScale, fixtureOptics, resolvedPhotometricLumens, resolveOptics } from '../data/fixtureOptics';
import {
  buildMeasureSnapshot,
  buildSceneRaySurfaces,
  computeReachMap,
  evaluateLaserZones,
  type EngineHeadSample,
  type MeasureSnapshot,
  type ReachMapResult,
  type SceneRaySurfaces,
} from '../data/measure';
import {
  DEFAULT_MEASURE_OVERLAY_OPTIONS,
  isMeasureOverlayActive,
  MeasureOverlay3D,
  type MeasureOverlayOptions,
} from './measureOverlay';
import { fitAuthoredFoh, LED_DISPLAY_MATERIAL_NAME } from './fohFraming';
import type { WebXrAudienceScene, XrAudienceSceneConfig } from '../xr/audienceScene';
import { buildScenicPiece, ScenicPiece } from './scenicProps';
import { SPEAKER_PROFILES } from '../data/speakerProfiles';
import { PROP_CATALOG } from '../data/stageProps';
import { exportStageGlb, nameFixtureUnit } from './stageGlb';
import { RenderBatcher } from './renderBatcher';
import { VOLUMETRIC_BEAM_VARIANT, volumetricBeamProxy } from './beamProxy';
import { createMissingMediaSlate, WallPlayer, type SecondaryScreenState, type StageScreen } from './StageScreens';
import { applyDemoLighting, DEMO_BLACKOUT_STEPS, demoFade } from '../data/demoLighting';
import {
  createAudioModulationFrame,
  createAudioModulationState,
  evaluateAudioModulation,
  getOrCreateUnitRgbGov,
  rawManualStrobeOscillator,
  stepCombinedStrobeGate,
  stepDeliveredBrightness,
  stepDeliveredStrobeGate,
  stepDeliveredUnitRgb,
  type AudioModulationFrame,
  type AudioModulationState,
  type DeliveredUnitRgbResult,
  type RgbGovernorState,
} from './audioModulation';
import {
  createPreviewFlashOutput,
  createPreviewFlashState,
  evaluatePreviewFlash,
  getOrCreatePreviewFixtureGov,
  getOrCreatePreviewLaserGov,
  stepPreviewDeliveredGate,
  stepPreviewFixtureUnit,
  stepPreviewLaserUnit,
  type PreviewFlashOutput,
  type PreviewFlashState,
  type PreviewLaserGovernorEntry,
} from './previewFlash';
import {
  DEFAULT_RENDER_SETTINGS,
  estimateRenderTargetBytes,
  parseRenderSettings,
  resolveEffectiveBloomScale,
  resolveEffectiveAa,
  resolveEffectiveAtmosphere,
  resolveEffectiveLookOutput,
  type RenderSettings,
} from './renderSettings';
import {
  computeFrameLuminanceGrid,
  FrameProfilerSession,
  GpuTimerRing,
  type FrameLuminanceGrid,
  type FrameMeasureReport,
} from './renderProbe';

/** UnrealBloomPass with an independent resolution scale factor (1 or 0.5) so only bloom internal targets scale. */
class ScaledBloomPass extends UnrealBloomPass {
  private scaleFactor: 1 | 0.5;
  constructor(resolution: THREE.Vector2, strength: number, radius: number, threshold: number, scaleFactor: 1 | 0.5) {
    super(
      new THREE.Vector2(
        Math.max(2, Math.round(resolution.x * scaleFactor)),
        Math.max(2, Math.round(resolution.y * scaleFactor)),
      ),
      strength,
      radius,
      threshold,
    );
    this.scaleFactor = scaleFactor;
  }
  public setScaleFactor(scaleFactor: 1 | 0.5, width: number, height: number) {
    this.scaleFactor = scaleFactor;
    this.setSize(width, height);
  }
  public override setSize(width: number, height: number) {
    super.setSize(
      Math.max(2, Math.round(width * this.scaleFactor)),
      Math.max(2, Math.round(height * this.scaleFactor)),
    );
  }
}

interface MovingFixtureInstance {
  unitId: string;
  fixtureNumber: number;
  groupId: string;
  podId: string | null;
  positionName: string;
  label: string;
  modelName: string;
  type: 'beam' | 'wash';
  optics: ReturnType<typeof fixtureOptics>;
  configuredLumens: number | null;
  lensOffsetY: number;
  appliedDimmer: number;
  lastZoomScale: number;
  lastPoolIntensity: number;
  lastPreviewIntensity: number;
  lastPreviewR: number;
  lastPreviewG: number;
  lastPreviewB: number;
  lastWorldX: number;
  lastWorldY: number;
  lastWorldZ: number;
  lastAimX: number;
  lastAimY: number;
  lastAimZ: number;
  isFloor: boolean;
  index: number;
  fanPosition: number;
  openingStep: number;
  directedDimmer: number;
  pivotY: number;
  motion: FixtureMotion;
  root: THREE.Group;
  yoke: THREE.Group;
  head: THREE.Group;
  lensMat: THREE.MeshBasicMaterial;
  beamMesh: THREE.Mesh;
  beamMat: THREE.ShaderMaterial;
  mountYaw: number;
  currentPan: number;
  currentTilt: number;
  dmxUniverse: 1 | 2;
  dmxStart: number;
  dmxWidth: number;
  physicalClass: PhysicalGroupClassification;
  previewRgbGov: RgbGovernorState;
  physRgbGov: RgbGovernorState;
}

interface LaserUnitInstance {
  key: string;
  index: number;
  isFloor: boolean;
  root: THREE.Group;
  apertureMat: THREE.MeshBasicMaterial;
  sheetMesh: THREE.Mesh;
  sheetMat: THREE.ShaderMaterial;
  coneMesh: THREE.Mesh;
  coneMat: THREE.ShaderMaterial;
  innerConeMesh: THREE.Mesh;
  innerConeMat: THREE.ShaderMaterial;
  ildaMesh?: THREE.LineSegments;
  ildaMat?: THREE.LineBasicMaterial;
  ildaRibbon?: IldaScanEnergyProjector;
  ildaLastFrame?: number;
  ildaLastMode?: IldaRenderMode;
  ildaLastScaleX?: number;
  ildaLastScaleY?: number;
  ildaLastRoll?: number;
  ildaLastGain?: number;
  ildaLastHaze?: number;
  ildaLastVisible?: boolean;
  catalogId?: string;
  dmxMode?: string;
  laserSpec?: CatalogLaserSpec;
  singleColor?: THREE.Color;
  resolvedMode?: CatalogDmxMode;
  dmxScratch: number[];
  dmxUniverse: 1 | 2;
  dmxStart: number;
  dmxWidth: number;
  physicalClass: PhysicalGroupClassification;
  previewLaserGov: PreviewLaserGovernorEntry;
  physRgbGov: RgbGovernorState;
}

export interface WebXrSessionConfig {
  referenceSpaceType: XRReferenceSpaceType;
  framebufferScale: number;
  foveation: number;
  audience: Omit<XrAudienceSceneConfig, 'viewpoints'>;
  onEnded?: (reason: 'system-exit' | 'requested-exit' | 'error' | 'context-loss' | 'dispose') => void;
}

interface WebXrLease {
  session: XRSession;
  onEnded?: WebXrSessionConfig['onEnded'];
  endReason: 'system-exit' | 'requested-exit' | 'error' | 'context-loss' | 'dispose';
  endListener: () => void;
  visibilityListener: () => void;
  rendererPixelRatio: number;
  rendererSize: THREE.Vector2;
  cameraPosition: THREE.Vector3;
  cameraQuaternion: THREE.Quaternion;
  cameraScale: THREE.Vector3;
  cameraUp: THREE.Vector3;
  cameraFov: number;
  cameraAspect: number;
  cameraNear: number;
  cameraFar: number;
  cameraZoom: number;
  controlsEnabled: boolean;
  controlsTarget: THREE.Vector3;
  cameraLerpActive: boolean;
  orbitAuto: boolean;
  fitFohOnResize: boolean;
  litPuffs: boolean;
  xrEnabled: boolean;
  audience: WebXrAudienceScene | null;
  baseReferenceSpace: XRReferenceSpace | null;
  restored: boolean;
}

interface DmxOutput {
  buffer: Uint8Array;
  physBuffer: Uint8Array;
  start: number;
  width?: number;
  physicalClass: PhysicalGroupClassification;
}

interface StrobeInstance extends DmxOutput {
  lensMat: THREE.MeshBasicMaterial;
  index: number;
}

interface BlinderInstance extends DmxOutput {
  lensMat: THREE.MeshBasicMaterial;
}

interface TrussPodRuntime {
  config: TrussPodConfig;
  group: THREE.Group;
  currentY: number;
  currentTiltZ: number;
  currentTiltX: number;
  hoists: { anchorLocal: THREE.Vector3; chainMesh: THREE.Mesh; root: THREE.Group }[];
}

const CAMERA_FOV = 42;

const PATTERN_INDEX: Record<LaserPattern, number> = {
  liquid_sky: 0,
  tunnel: 1,
  fan: 2,
  wave: 3,
  matrix: 4,
  starburst: 5,
  horizon: 6,
  dual_cones: 7,
};

const LED_MODE_INDEX: Record<LedVisualMode, number> = {
  tunnel: 0,
  cybergrid: 1,
  spectrum: 2,
  plasma: 3,
  strobe_bars: 4,
  mandala: 5,
  tour_text: 6,
  custom: 7,
};

export class StageEngine {
  private standby = true;
  private directedStep?: number;
  private manualFadeStart?: number;
  private houseAmbient = new THREE.HemisphereLight(0x929faf, 0x302723, 0.36);
  private houseColors: { color: THREE.Color; full: THREE.Color }[] = [];
  private backgroundColor = new THREE.Color(0x030408);
  private fogColor = new THREE.Color(0x04060c);
  private fog!: THREE.FogExp2;
  private atmosphereLook = new AtmosphereLookController(this.fogColor.r, this.fogColor.g, this.fogColor.b);
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: ScaledBloomPass | null = null;
  private outputPass: OutputPass;
  private fxaaPass: ShaderPass | null = null;
  private renderSettings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
  private prefersReducedMotion = false;
  private effectiveFullRateStrobe = false;
  private contextAntialias = false;
  private composerSamplesRequested = 2;
  private contextLost = false;
  private disposed = false;
  private onContextLossChange?: (lost: boolean) => void;
  private handleContextLostBound?: (event: Event) => void;
  private handleContextRestoredBound?: () => void;
  private gpuTimer: GpuTimerRing | null = null;
  private profiler: FrameProfilerSession | null = null;
  private profilerUseGpu = true;
  private readPixelsBuf: Uint8Array | null = null;
  private readPixelsW = 0;
  private readPixelsH = 0;
  private renderTier: RenderTier;
  private modelCache: FixtureModelCache;
  private mats: SharedMaterials;
  private deckSheen!: DeckSheenController;
  private neonFrame!: NeonFrameController;
  private crowdLighting!: CrowdLightingController;
  private lastCrowdFrameInputs: CrowdFrameInputs = createCrowdFrameInputs();
  private environmentTarget: THREE.WebGLRenderTarget;
  private wetDeckEnvironmentStats!: Omit<WetDeckEnvironmentStats, 'sceneOwnsTargetTexture'>;
  private currentRig?: RigConfig;
  private lastRebuildSource?: RigConfig;
  private lastRebuildStage?: NativeStage;
  private beamPools?: BeamPools;
  private lastPoolTime = 0;
  private spillFluxGain = 1;
  private scenicPieces = new Map<string, ScenicPiece & { kind: string; phase: number; tier: RenderTier }>();
  private deckTrim: THREE.MeshBasicMaterial | null = null;
  private scenicKey: THREE.SpotLight;
  private sideFills: THREE.SpotLight[] = [];
  private activeView: CameraPreset = 'foh';

  // Dynamic rig root so rebuilding templates is clean & leak-free
  private rigGroup = new THREE.Group();
  /** Instances repeated opaque rig parts so each part type costs one draw call. */
  private batcher?: RenderBatcher;
  private geometryLayout?: NativeStage['layout'];
  private geometryKey?: string;
  private geometrySource?: RigConfig;
  private geometryCache?: ReturnType<typeof resolveStudioGeometry>;
  private focusLocal = new THREE.Vector3();
  private focusMarkCache?: { rig: RigConfig; marks: FocusMark[] };
  private particles: AtmosphericParticles;

  // Dynamic scene references
  private roofY = 15.8;
  private trussPods: TrussPodRuntime[] = [];
  private movingFixtures: MovingFixtureInstance[] = [];
  private laserUnits: LaserUnitInstance[] = [];
  private laserShapes = new Map<LaserResolution, ReturnType<typeof laserGeometry>>();
  private laserShapeGeometries = new Set<THREE.BufferGeometry>();
  private activeIldaClip: IldaClip | null = null;
  private bakedIlda: BakedIldaClip | null = null;
  private ildaRenderMode: IldaRenderMode = 'both';
  private ildaFps = 30;
  private ildaPlayTime = 0;
  private ildaDrawRangeScratch = { start: 0, count: 0 };
  private laserDmxScratchValues = {
    enabled: false,
    intensity: 0,
    patternIndex: 0,
    spreadX: 0,
    spreadY: 0,
    speed: 0,
    rotation: 0,
    tilt: 0,
    beamCount: 1,
    strobe: 0,
    colorR: 0,
    colorG: 0,
    colorB: 0,
    colorModeIndex: 0 as 0 | 1 | 2,
    scanRateNorm: 0,
  };
  private strobes: StrobeInstance[] = [];
  private blinders: BlinderInstance[] = [];
  private atmosphereDmx: (DmxOutput & { type: 'hazer' | 'smoke' | 'co2' })[] = [];
  private djStripMat: THREE.MeshBasicMaterial | null = null;
  private crowdMesh: THREE.InstancedMesh | null = null;
  private crowdBaseTransforms: { x: number; y: number; z: number; scaleY: number; phase: number; rotY: number }[] = [];
  private crowdSeated = false;
  /** Interior of a small room (theatre, club); null for arena/warehouse/festival framing. */
  private room: VenueRoom | null = null;
  private crowdDummy = new THREE.Object3D();

  // LED Wall
  private ledWallMats: THREE.ShaderMaterial[] = [];
  private allLedMaterials: THREE.ShaderMaterial[] = [];
  private screenLayout?: StageScreen[];
  private secondaryPlayers = new Map<string, WallPlayer>();
  private textCanvas: HTMLCanvasElement;
  private textTex: THREE.CanvasTexture;
  private lastTourText = '';
  private customTex: THREE.Texture | null = null;
  private missingScreenTex: THREE.CanvasTexture | null = null;
  private customVideoEl: HTMLVideoElement | null = null;
  private screenWantsPlay = true;
  private screenRunning = false;
  private pendingScreenOffset?: number;
  private screenSeekClock = 0;
  private videoPlayRequest?: Promise<void>;
  private lastCustomUrl: string | null = null;
  private mediaGeneration = 0;

  // Dynamic Stage Spill Lights (kept few for blazing 60 FPS WebGL performance!)
  private stagePrimaryLight: THREE.PointLight;
  private stageAccentLight: THREE.PointLight;
  private blinderLight: THREE.PointLight;
  private strobeLight: THREE.PointLight;
  private ledSpillLight: THREE.PointLight;

  // Camera transition state
  private cameraTargetPos = new THREE.Vector3(2.5, 6.2, 24.5);
  private cameraTargetLook = new THREE.Vector3(0, 5.35, -0.6);
  private cameraLerpActive = false;
  private orbitAuto = false;

  // DMX Universe buffers:
  // - dmxUniverse1/2 hold StageForge's simulation / monitor buffers (unchanged for legacy ?probe & monitor).
  // - physicalDmxU1/U2 hold outgoing physical wire buffers (strictly datasheet-verified personalities only; all generic & unimplemented modes = 0).
  // - serialPhysicalDmxU1/U2 hold Web Serial wire buffers (strictly passive non-strobing LED personalities only; atmospherics/blinders/lasers = 0).
  public dmxUniverse1 = new Uint8Array(512);
  public dmxUniverse2 = new Uint8Array(512);
  public physicalDmxU1 = new Uint8Array(512);
  public physicalDmxU2 = new Uint8Array(512);
  public serialPhysicalDmxU1 = new Uint8Array(512);
  public serialPhysicalDmxU2 = new Uint8Array(512);
  private dmxFrameListener?: (
    u1: Uint8Array,
    u2: Uint8Array,
    u1Changed: boolean,
    u2Changed: boolean,
    serialU1: Uint8Array,
    serialU2: Uint8Array,
  ) => void;
  private dmxAccum = 0;
  private lastDmxU1 = new Uint8Array(512);
  private lastDmxU2 = new Uint8Array(512);
  private physicalDmxScratch: number[] = [];
  private physicalUnitScratch: PhysicalUnitState = { blackout: false };

  // Audio-reactive modulation & preview-only flash limiter state (preallocated for zero per-frame allocations)
  private audioModState: AudioModulationState = createAudioModulationState();
  private audioModFrame: AudioModulationFrame = createAudioModulationFrame();
  private combinedStrobeScratch = { gate: 1.0, flashOn: false, limited: false };
  private deliveredRgbScratch: DeliveredUnitRgbResult = { rgbDimmer: 0, r: 0, g: 0, b: 0, limited: false };
  private previewFlashState: PreviewFlashState = createPreviewFlashState();
  private previewFlashOut: PreviewFlashOutput = createPreviewFlashOutput();
  private primaryColorScratch = new THREE.Color();
  private accentColorScratch = new THREE.Color();
  private beamPrimaryScratch = new THREE.Color();
  private beamAccentScratch = new THREE.Color();
  private washPrimaryScratch = new THREE.Color();
  private washAccentScratch = new THREE.Color();
  private tempColScratch = new THREE.Color();
  private previewTempColScratch = new THREE.Color();
  private governedLaserColorA = new THREE.Color();
  private governedLaserColorB = new THREE.Color();
  private warmAmberColor = new THREE.Color(0xffbe55);
  private whiteColor = new THREE.Color(0xffffff);
  private stageTintScratch = new THREE.Color();
  private hoistWorldPosScratch = new THREE.Vector3();
  private cameraFwdScratch = new THREE.Vector3(0, -0.1, -0.995);
  private particleLightingScratch: ParticleLightingUpdate = {
    beams: [],
    blackout: false,
    master: 1,
    roomGain: 1,
    camPosX: 0,
    camPosY: 4.5,
    camPosZ: 26,
    camFwdX: 0,
    camFwdY: -0.1,
    camFwdZ: -0.995,
  };
  private beamPhaseOffset = 0;
  private washPhaseOffset = 0;
  private ledPhaseOffset = 0;
  private laserSpeedPhaseOffsets: number[] = [];
  private laserRotPhaseOffsets: number[] = [];
  private inhibitedLaserKeys = new Set<string>();
  private measureOptions: MeasureOverlayOptions = DEFAULT_MEASURE_OVERLAY_OPTIONS;
  private measureOverlay: MeasureOverlay3D | null = null;
  private measureListener?: (snapshot: MeasureSnapshot) => void;
  private liveSafetyMonitorEnabled = false;
  private measureSurfacesCache: SceneRaySurfaces | null = null;
  private measureReachCache: ReachMapResult | null = null;
  private lastNohdKey = '';
  private lastNohdZones: ReturnType<typeof evaluateLaserZones>['zones'] = [];
  private ildaClipRevision = 0;
  private measureRigRevision = 0;
  private lastMeasureTickMs = -Infinity;
  private measureOriginScratch = new THREE.Vector3();
  private measureDirScratch = new THREE.Vector3();
  private measureMountScratch = new THREE.Vector3();
  private measureProjScratch = new THREE.Vector3();
  private appliedLaserProjectorKeys: string[] = [];
  private appliedLaserProjectorCount = 0;
  private appliedParams = {
    master: 0,
    legacyBoost: 0,
    beam: {
      dimmer: 0,
      zoom: 0,
      colorMix: 0,
      speed: 0,
      tiltOffset: 0,
      strobe: { mode: 'unmapped' as 'unmapped' | 'mapped', rate: 0, envelope: 0, gateOn: false, lastFlashMs: -Infinity, limited: false },
    },
    wash: {
      dimmer: 0,
      zoom: 0,
      colorMix: 0,
      speed: 0,
      tiltOffset: 0,
      strobe: { mode: 'unmapped' as 'unmapped' | 'mapped', rate: 0, envelope: 0, gateOn: false, lastFlashMs: -Infinity, limited: false },
    },
    blinder: { dimmer: 0, limited: false },
    strobe: {
      dimmer: 0,
      limited: false,
      strobe: { mode: 'unmapped' as 'unmapped' | 'mapped', rate: 0, envelope: 0, gateOn: false, lastFlashMs: -Infinity, limited: false },
    },
    ledWall: { enabled: false, brightness: 0, speed: 0 },
    laser: {
      enabled: false,
      audienceScan: false,
      intensity: 0,
      speed: 0,
      rotation: 0,
      spreadX: 0,
      spreadY: 0,
      strobe: { mode: 'unmapped' as 'unmapped' | 'mapped', rate: 0, envelope: 0, gateOn: false, lastFlashMs: -Infinity, limited: false },
      projectors: Object.create(null) as Record<string, { intensity: number; speed: number; rotation: number; spreadX: number; spreadY: number; strobeGateOn: boolean }>,
    },
    haze: { level: 0 },
    atmo: { haze: 0, smoke: 0, co2: false },
  };

  // Animation & decoupled control-loop state
  private rafId: number | null = null;
  private controlTimerId: ReturnType<typeof setInterval> | null = null;
  private controlLoopSeq = 0;
  private lastControlTickMs = 0;
  private lastRafTickMs = 0;
  private lastFrameTime = 0;
  private elapsed = 0;
  private currentState: ShowState;
  private currentBump: BumpState = {
    blinder: false,
    strobe: false,
    co2: false,
    smoke: false,
    laser: false,
    motorDrop: false,
  };
  private audioGetter: (dt: number) => AudioMetrics;
  private onFrameTelemetry?: (metrics: AudioMetrics, fps: number) => void;
  private frameCounter = 0;
  private fpsAccum = 0;
  private currentFps = 60;
  private telemetryAccum = 0;
  private resizeObserver: ResizeObserver;
  private webXrLease: WebXrLease | null = null;
  private webXrPhysicalOutputInterlock = false;
  private webXrVisibility: XRVisibilityState = 'visible';
  private webXrEntries = 0;
  private webXrExits = 0;
  private webXrFrames = 0;
  private webXrLastViews = 0;
  private webXrLastCalls = 0;
  private webXrLastTriangles = 0;

  constructor(
    container: HTMLElement,
    initialRig: RigConfig,
    initialState: ShowState,
    audioGetter: (dt: number) => AudioMetrics,
    onFrameTelemetry?: (metrics: AudioMetrics, fps: number) => void,
    private onMediaError?: (message: string) => void,
    options?: {
      renderSettings?: Partial<RenderSettings>;
      fullRateStrobePreview?: boolean;
      prefersReducedMotion?: boolean;
      onContextLossChange?: (lost: boolean) => void;
    },
  ) {
    this.container = container;
    this.currentState = initialState;
    this.audioGetter = audioGetter;
    this.onFrameTelemetry = onFrameTelemetry;
    this.onContextLossChange = options?.onContextLossChange;
    this.renderSettings = parseRenderSettings(options?.renderSettings);
    this.effectiveFullRateStrobe = Boolean(options?.fullRateStrobePreview);
    this.prefersReducedMotion = Boolean(options?.prefersReducedMotion);

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    try {
    this.renderTier = detectRenderTier();
    this.modelCache = new FixtureModelCache(this.renderTier);

    // Renderer configured for HDR concert lighting; default canvas MSAA is disabled because
    // EffectComposer renders to offscreen targets and OutputPass draws a single fullscreen quad.
    this.contextAntialias = false;
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.contextAntialias,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setSize(width, height);
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatioForTier(this.renderTier));
    this.renderer.setPixelRatio(dpr);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Count a whole frame (scene plus every bloom and output pass), not just the last pass.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.handleContextLostBound = (event: Event) => {
      event.preventDefault();
      this.contextLost = true;
      if (this.webXrLease) void this.exitWebXrSession('context-loss');
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.stopControlFallbackTimer();
      this.gpuTimer?.onContextLost();
      if (this.profiler) {
        const p = this.profiler;
        this.profiler = null;
        this.batcher?.setSyncObserver(null);
        p.finish(this.gpuTimer);
      }
      this.onContextLossChange?.(true);
    };
    this.handleContextRestoredBound = () => {
      this.contextLost = false;
      if (this.gpuTimer) {
        this.gpuTimer.onContextRestored(this.renderer.getContext());
      } else {
        this.gpuTimer = new GpuTimerRing(this.renderer.getContext());
      }
      this.updateTourTextTexture(this.lastTourText);
      this.deckSheen?.onContextRestored(this.mats?.stageDeck);
      this.restoreStageEnvironment();
      this.neonFrame?.onContextRestored();
      this.crowdLighting?.onContextRestored();
      this.particles?.onContextRestored();
      this.bakedIlda?.onContextRestored();
      if (this.currentRig && this.beamPools) this.rebuildBeamPools(true);
      this.onContextLossChange?.(false);
      if (!this.disposed && !this.webXrLease && this.rafId === null) this.startLoop();
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLostBound);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestoredBound);

    // Scene & deep arena atmosphere
    this.scene = new THREE.Scene();
    this.batcher = new RenderBatcher(this.scene);
    this.batcher.registerShaderProxy(volumetricBeamProxy);
    this.neonFrame = new NeonFrameController(this.scene, this.renderTier, this.renderer.domElement.height);
    this.scene.background = this.backgroundColor.clone();
    this.fog = new THREE.FogExp2(this.fogColor, 0.015);
    this.scene.fog = this.fog;
    this.syncAtmospherePolicy();

    // One construction-time PMREM target. Sprint 23C replaces its source composition rather than
    // retaining a second environment or rebuilding it during normal runtime.
    const environment = buildStageEnvironment(
      this.renderer,
      this.renderSettings.lookWetDeck && this.renderTier === 'high',
    );
    this.environmentTarget = environment.target;
    this.wetDeckEnvironmentStats = environment.stats;
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.55;

    // Camera & OrbitControls
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / height, 0.18, 220);
    this.camera.position.copy(this.cameraTargetPos);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 68;
    this.controls.target.copy(this.cameraTargetLook);
    this.controls.addEventListener('start', () => {
      this.previewRig();
      this.fitFohOnResize = false;
      this.cameraLerpActive = false;
      this.orbitAuto = false;
    });

    // Post-processing: HDR Render -> optional ScaledBloomPass -> OutputPass -> optional FXAA
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(dpr);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.outputPass = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.outputPass);
    this.applyOutputPipeline(width, height, dpr, initialState.bloomStrength);

    // Subtle ambient fill + dramatic real-time stage lights
    this.scene.add(this.houseAmbient);
    this.scenicKey = new THREE.SpotLight(0xffe6d1, 280, 33, 0.80, 0.76, 1.65);
    this.scenicKey.position.set(-3, 12, 10);
    this.scenicKey.target.position.set(0, 2.8, -0.5);
    this.scene.add(this.scenicKey, this.scenicKey.target);
    for (const side of [-1, 1]) {
      const fill = new THREE.SpotLight(0xffdad0, 0, 27, 0.68, 0.85, 1.55);
      this.scene.add(fill, fill.target);
      this.sideFills.push(fill);
    }

    this.stagePrimaryLight = new THREE.PointLight(0x00f0ff, 22, 42, 1.35);
    this.stagePrimaryLight.position.set(-4, 8.5, 4);
    this.scene.add(this.stagePrimaryLight);

    this.stageAccentLight = new THREE.PointLight(0xff00aa, 18, 42, 1.35);
    this.stageAccentLight.position.set(4, 8.5, 4);
    this.scene.add(this.stageAccentLight);

    this.blinderLight = new THREE.PointLight(0xffbe55, 0, 58, 1.2);
    this.blinderLight.position.set(0, 9.5, 9.5);
    this.scene.add(this.blinderLight);

    this.strobeLight = new THREE.PointLight(0xffffff, 0, 52, 1.15);
    this.strobeLight.position.set(0, 10.0, 4.0);
    this.scene.add(this.strobeLight);

    this.ledSpillLight = new THREE.PointLight(0x4488ff, 12, 34, 1.4);
    this.ledSpillLight.position.set(0, 5.5, -2.5);
    this.scene.add(this.ledSpillLight);

    this.mats = createSharedMaterials({
      tier: this.renderTier,
      maxAnisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    this.deckSheen = new DeckSheenController(
      this.renderTier,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    if (this.renderSettings.deckSheen) {
      this.deckSheen.apply(this.mats.stageDeck, true);
    }
    setWetDeckMaterial(
      this.mats.stageDeck,
      this.renderSettings.lookWetDeck && this.renderTier === 'high',
    );
    this.crowdLighting = new CrowdLightingController(this.renderTier);
    if (this.renderSettings.crowdLighting) {
      this.crowdLighting.setEnabled(true);
    }

    // Tour text offscreen texture for LED wall mode 6
    this.textCanvas = document.createElement('canvas');
    this.textCanvas.width = 1024;
    this.textCanvas.height = 512;
    this.textTex = new THREE.CanvasTexture(this.textCanvas);
    this.updateTourTextTexture(initialState.led.tourText);
    void document.fonts.ready.then(() => {
      if (this.renderer.domElement.parentElement === this.container) this.updateTourTextTexture(this.lastTourText);
    });

    this.scene.add(this.rigGroup);
    this.particles = new AtmosphericParticles(this.renderTier);
    this.particles.setFallingCo2(this.renderSettings.fallingCo2);
    if (this.renderSettings.litPuffs) {
      this.particles.setLitPuffs(true);
    }
    this.scene.add(this.particles.group);

    this.rebuildRig(initialRig);
    this.setShowState(initialState);
    this.setCameraPreset('foh');
    this.camera.position.copy(this.cameraTargetPos);
    this.controls.target.copy(this.cameraTargetLook);

    // Handle container resize cleanly
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.startLoop();
    } catch (error) {
      try { this.dispose(); } catch { /* preserve original constructor failure */ }
      throw error;
    }
  }

  private updateFxaaResolution() {
    if (!this.fxaaPass) return;
    const drawW = Math.max(1, this.renderer.domElement.width);
    const drawH = Math.max(1, this.renderer.domElement.height);
    const res = this.fxaaPass.material.uniforms.resolution?.value as THREE.Vector2 | undefined;
    if (res) res.set(1 / drawW, 1 / drawH);
  }

  private applyOutputPipeline(width: number, height: number, dpr: number, bloomStrength: number) {
    const effectiveAa = resolveEffectiveAa(this.renderSettings.aa);
    const requestedSamples = effectiveAa === 'msaa' ? 2 : 0;
    const samplesChanged =
      this.composer.renderTarget1.samples !== requestedSamples ||
      this.composer.renderTarget2.samples !== requestedSamples;
    this.composerSamplesRequested = requestedSamples;

    if (samplesChanged) {
      this.composer.renderTarget1.samples = requestedSamples;
      this.composer.renderTarget2.samples = requestedSamples;
      // Three.js r187 only reallocates multisample buffers after disposing existing render targets.
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }

    const look = resolveEffectiveLookOutput(this.renderSettings, this.renderTier, this.prefersReducedMotion);
    const bloomScale = resolveEffectiveBloomScale(this.renderSettings, this.renderTier, this.prefersReducedMotion);
    const effectiveBloomStrength = bloomStrength * look.bloomStrengthScale;
    if (bloomScale === 0) {
      if (this.bloomPass) {
        this.composer.removePass(this.bloomPass);
        this.bloomPass.dispose();
        this.bloomPass = null;
      }
    } else {
      const drawW = Math.max(2, Math.round(width * dpr));
      const drawH = Math.max(2, Math.round(height * dpr));
      if (!this.bloomPass) {
        this.bloomPass = new ScaledBloomPass(
          new THREE.Vector2(drawW, drawH),
          effectiveBloomStrength,
          look.bloomRadius,
          look.bloomThreshold,
          bloomScale,
        );
        const outputIdx = this.composer.passes.indexOf(this.outputPass);
        this.composer.insertPass(this.bloomPass, outputIdx >= 0 ? outputIdx : 1);
      } else {
        this.bloomPass.setScaleFactor(bloomScale, drawW, drawH);
      }
      this.bloomPass.strength = effectiveBloomStrength;
      this.bloomPass.radius = look.bloomRadius;
      this.bloomPass.threshold = look.bloomThreshold;
      this.bloomPass.enabled = effectiveBloomStrength > 0.001;
    }

    // FXAA strictly follows OutputPass (operates on tone-mapped sRGB values) and never stacks with MSAA.
    if (effectiveAa === 'fxaa') {
      if (!this.fxaaPass) {
        this.fxaaPass = new ShaderPass(FXAAShader);
        this.composer.addPass(this.fxaaPass);
      }
      this.fxaaPass.enabled = true;
      this.updateFxaaResolution();
    } else if (this.fxaaPass) {
      this.composer.removePass(this.fxaaPass);
      this.fxaaPass.dispose();
      this.fxaaPass = null;
    }
  }

  public setRenderSettings(partial: Partial<RenderSettings>) {
    const next = parseRenderSettings({ ...this.renderSettings, ...partial });
    const prev = this.renderSettings;
    this.renderSettings = next;
    this.syncAtmospherePolicy();
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const dpr = this.renderer.getPixelRatio();
    if (
      prev.bloom !== next.bloom ||
      prev.aa !== next.aa ||
      prev.lookOutput !== next.lookOutput ||
      prev.trueColour !== next.trueColour ||
      prev.reducedEffects !== next.reducedEffects
    ) {
      this.applyOutputPipeline(w, h, dpr, this.currentState.bloomStrength);
    }
    if (prev.fallingCo2 !== next.fallingCo2) {
      this.particles.setFallingCo2(next.fallingCo2);
    }
    if (prev.videoSrgbDecode !== next.videoSrgbDecode || prev.lookOutput !== next.lookOutput) {
      this.bindScreenTexture();
      const decodeVideo = resolveEffectiveLookOutput(next, this.renderTier, this.prefersReducedMotion).videoSrgbDecode;
      for (const player of this.secondaryPlayers.values()) {
        player.setVideoSrgbDecode(decodeVideo);
      }
    }
    if (prev.prismPools !== next.prismPools && this.currentRig) {
      this.rebuildBeamPools(true);
    }
    if (prev.ledAngularResponse !== next.ledAngularResponse) {
      this.applyLedAngularResponse(next.ledAngularResponse);
    }
    if (prev.deckSheen !== next.deckSheen) {
      this.deckSheen.apply(this.mats.stageDeck, next.deckSheen);
    }
    if (prev.lookWetDeck !== next.lookWetDeck) {
      // The PMREM composition is construction-only to guarantee one persistent target. This live
      // path still isolates the zero-texture material cost for probe measurements.
      setWetDeckMaterial(this.mats.stageDeck, next.lookWetDeck && this.renderTier === 'high');
    }
    if (prev.crowdLighting !== next.crowdLighting) {
      this.crowdLighting.setEnabled(next.crowdLighting);
      if (next.crowdLighting) {
        this.syncCrowdLightingFromCommittedState();
      }
    }
    if (prev.litPuffs !== next.litPuffs) {
      if (next.litPuffs) {
        this.refreshCommittedFixtureWorldTransforms();
        this.particles.setLitPuffs(true, this.buildParticleLightingUpdate());
      } else {
        this.particles.setLitPuffs(false);
      }
    }
    if (prev.ildaScanEnergy !== next.ildaScanEnergy && this.activeIldaClip) {
      this.syncIldaScanEnergyResources(next.ildaScanEnergy);
    }
    if (prev.lookNeonFrame !== next.lookNeonFrame || prev.trueColour !== next.trueColour) {
      this.neonFrame.setPolicy(next.lookNeonFrame, next.trueColour);
    }
    if (this.webXrLease) this.applyWebXrVisualSuppression();
  }

  /** Update the system accessibility signal without changing the stored device preference. */
  public setPrefersReducedMotion(enabled: boolean) {
    const next = Boolean(enabled);
    if (next === this.prefersReducedMotion) return;
    this.prefersReducedMotion = next;
    this.syncAtmospherePolicy();
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.applyOutputPipeline(w, h, this.renderer.getPixelRatio(), this.currentState.bloomStrength);
  }

  private syncAtmospherePolicy() {
    this.atmosphereLook.setPolicy(
      resolveEffectiveAtmosphere(this.renderSettings, this.renderTier, this.prefersReducedMotion),
    );
  }

  private refreshCommittedFixtureWorldTransforms() {
    for (let i = 0; i < this.movingFixtures.length; i++) {
      const fx = this.movingFixtures[i];
      if (fx.lastPreviewIntensity <= 0.001) continue;
      fx.head.updateWorldMatrix(true, false);
      const he = fx.head.matrixWorld.elements;
      const sign = fx.isFloor ? 1 : -1;
      const ax = he[4] * sign;
      const ay = he[5] * sign;
      const az = he[6] * sign;
      const lenSq = ax * ax + ay * ay + az * az;
      const invLen = lenSq > 1e-12 ? 1 / Math.sqrt(lenSq) : 0;
      fx.lastWorldX = he[12];
      fx.lastWorldY = he[13];
      fx.lastWorldZ = he[14];
      fx.lastAimX = invLen > 0 ? ax * invLen : 0;
      fx.lastAimY = invLen > 0 ? ay * invLen : -1;
      fx.lastAimZ = invLen > 0 ? az * invLen : 0;
    }
  }

  private buildParticleLightingUpdate(): ParticleLightingUpdate {
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(this.cameraFwdScratch);
    const pl = this.particleLightingScratch;
    pl.beams = this.movingFixtures;
    pl.blackout = this.lastCrowdFrameInputs.blackout;
    pl.master = this.lastCrowdFrameInputs.master;
    pl.roomGain = this.lastCrowdFrameInputs.roomGain;
    pl.camPosX = this.camera.position.x;
    pl.camPosY = this.camera.position.y;
    pl.camPosZ = this.camera.position.z;
    pl.camFwdX = this.cameraFwdScratch.x;
    pl.camFwdY = this.cameraFwdScratch.y;
    pl.camFwdZ = this.cameraFwdScratch.z;
    return pl;
  }

  /**
   * Refresh crowd show-light uniforms from the most recent committed preview-light snapshot
   * without advancing simulation time or re-entering stateful flash governors.
   */
  private syncCrowdLightingFromCommittedState() {
    if (!this.crowdLighting?.isActive()) return;
    this.refreshCommittedFixtureWorldTransforms();
    this.crowdLighting.updateFromScene(this.movingFixtures, this.lastCrowdFrameInputs);
  }

  private applyLedAngularResponse(enabled: boolean) {
    for (const mat of this.allLedMaterials) {
      const currentlyOn = mat.defines?.[LED_ANGULAR_DEFINE] === 1;
      if (currentlyOn === enabled) continue;
      mat.defines = enabled ? { [LED_ANGULAR_DEFINE]: 1 } : {};
      mat.needsUpdate = true;
    }
  }

  /**
   * Dispose and rebuild `BeamPools` with current `renderSettings.prismPools` and `renderTier`.
   * When `refill` is true (e.g. toggling `prismPools` at a frozen frame), synchronously
   * repopulates pool instances from the committed fixture state without advancing simulation time.
   */
  private rebuildBeamPools(refill: boolean) {
    this.beamPools?.dispose();
    const rig = this.currentRig;
    if (!rig) return;
    const gl = this.renderer.getContext();
    // Three.js 0.187.0 emits GLSL ES 3.00 core `dFdx`/`dFdy` on WebGL2 and removed WebGL1 `extensions.derivatives`;
    // require a real WebGL2 context before compiling `POOL_FRAGMENT_PRISM`, falling back to `POOL_FRAGMENT_BASE` otherwise.
    const derivativesSupported = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.beamPools = new BeamPools(
      this.movingFixtures.length,
      rig.stageWidth,
      rig.stageDepth,
      rig.stageHeight,
      rig.platforms,
      {
        prism: this.renderSettings.prismPools,
        tier: this.renderTier,
        derivativesSupported,
      },
    );
    this.scene.add(this.beamPools.group);
    if (refill) {
      this.beamPools.begin();
      const t = this.lastPoolTime;
      for (const fx of this.movingFixtures) {
        if (fx.lastPoolIntensity <= 0.001) continue;
        const prismMix = fx.type === 'beam' ? Number(fx.beamMat.uniforms.uPrism.value) : 0;
        const phase = prismMix > 0.001 ? prismPhase(t, Number(fx.beamMat.uniforms.uSeed.value)) : 0;
        this.beamPools.add(
          fx.beamMesh,
          fx.type,
          fx.isFloor,
          fx.beamMat.uniforms.uColor.value as THREE.Color,
          fx.lastPoolIntensity,
          fx.optics,
          prismMix,
          phase,
        );
      }
      this.beamPools.finish();
    }
  }

  public getRenderSettings(): RenderSettings {
    return { ...this.renderSettings };
  }

  private applyWebXrVisualSuppression() {
    // Round 1 has no headset evidence for Sprint 23 optional looks or mono CPU particle sorting.
    this.neonFrame.setPolicy(false, true);
    this.atmosphereLook.setPolicy({
      requested: this.renderSettings.lookAtmosphere,
      active: false,
      suppressedReason: 'disabled',
    });
    setWetDeckMaterial(this.mats.stageDeck, false);
    if (this.particles.isLitPuffsEnabled()) this.particles.setLitPuffs(false);
  }

  private buildWebXrFohFrame() {
    const rig = this.currentRig;
    if (!rig) return undefined;
    const rearLimit = this.room
      ? this.room.rearZ - 1.5
      : rig.venue === 'warehouse'
        ? 32
        : rig.venue === 'arena'
          ? 45
          : 60;
    const eyeCeiling = this.room ? this.room.ceilingY : this.roofY;
    const subjects = [...this.rigGroup.children.slice(1), ...Array.from(this.scenicPieces.values(), (piece) => piece.root)];
    const frame = fitAuthoredFoh(subjects, this.ledWallMats, this.camera.aspect, eyeCeiling, rearLimit, CAMERA_FOV);
    return {
      position: { x: frame.position.x, y: frame.position.y, z: frame.position.z },
      target: { x: frame.target.x, y: frame.target.y, z: frame.target.z },
    };
  }

  /** Acquire the renderer's single animation-loop lease for an already-requested immersive session. */
  public async enterWebXrSession(session: XRSession, config: WebXrSessionConfig): Promise<void> {
    if (this.disposed || this.contextLost) throw new Error('The 3D renderer is unavailable.');
    if (this.dmxFrameListener) throw new Error('VR cannot start while physical output is live.');
    if (this.webXrLease) throw new Error('A VR session is already pending or active.');
    this.setWebXrPhysicalOutputInterlock(true);

    const rendererSize = this.renderer.getSize(new THREE.Vector2());
    const lease: WebXrLease = {
      session,
      onEnded: config.onEnded,
      endReason: 'system-exit',
      endListener: () => queueMicrotask(() => this.restoreWebXrLease(lease.endReason)),
      visibilityListener: () => {
        this.webXrVisibility = session.visibilityState;
        this.webXrLease?.audience?.setVisible(session.visibilityState === 'visible');
      },
      rendererPixelRatio: this.renderer.getPixelRatio(),
      rendererSize,
      cameraPosition: this.camera.position.clone(),
      cameraQuaternion: this.camera.quaternion.clone(),
      cameraScale: this.camera.scale.clone(),
      cameraUp: this.camera.up.clone(),
      cameraFov: this.camera.fov,
      cameraAspect: this.camera.aspect,
      cameraNear: this.camera.near,
      cameraFar: this.camera.far,
      cameraZoom: this.camera.zoom,
      controlsEnabled: this.controls.enabled,
      controlsTarget: this.controls.target.clone(),
      cameraLerpActive: this.cameraLerpActive,
      orbitAuto: this.orbitAuto,
      fitFohOnResize: this.fitFohOnResize,
      litPuffs: this.particles.isLitPuffsEnabled(),
      xrEnabled: this.renderer.xr.enabled,
      audience: null,
      baseReferenceSpace: null,
      restored: false,
    };
    this.webXrLease = lease;
    this.webXrVisibility = session.visibilityState;
    session.addEventListener('end', lease.endListener);
    session.addEventListener('visibilitychange', lease.visibilityListener);

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.stopControlFallbackTimer();
    this.controls.enabled = false;
    this.cameraLerpActive = false;
    this.orbitAuto = false;
    this.fitFohOnResize = false;
    this.effectiveFullRateStrobe = false;
    this.camera.position.set(0, 0, 18);
    this.camera.quaternion.identity();
    this.camera.scale.set(1, 1, 1);
    this.camera.up.set(0, 1, 0);
    this.camera.updateMatrixWorld(true);
    this.applyWebXrVisualSuppression();
    if (this.wetDeckEnvironmentStats.composition === 'wet-neutral') this.restoreStageEnvironment(false);

    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType(config.referenceSpaceType);
    this.renderer.xr.setFramebufferScaleFactor(config.framebufferScale);
    this.renderer.xr.setFoveation(config.foveation);
    this.lastFrameTime = performance.now();
    this.renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
      if (this.disposed || this.contextLost || this.webXrLease !== lease) return;
      this.lastRafTickMs = performance.now();
      if (this.webXrVisibility !== 'visible') {
        // Do not spend simulation or optional-effect work while the headset is hidden/system-blurred.
        this.lastFrameTime = time;
        return;
      }
      const xrCamera = this.renderer.xr.getCamera();
      lease.audience?.update(frame, time / 1000, xrCamera);
      this.runControlTick(time, true, 'xr');
      this.webXrFrames++;
      this.webXrLastViews = xrCamera.cameras.length;
      this.webXrLastCalls = this.renderer.info.render.calls;
      this.webXrLastTriangles = this.renderer.info.render.triangles;
    });

    try {
      lease.baseReferenceSpace = await session.requestReferenceSpace(config.referenceSpaceType);
      await this.renderer.xr.setSession(session);
      if (this.webXrLease !== lease || lease.restored) throw new Error('VR session ended during startup.');
      const [{ WebXrAudienceScene }, { deriveAudienceViewpoints }] = await Promise.all([
        import('../xr/audienceScene'),
        import('../xr/audienceExperience'),
      ]);
      if (this.webXrLease !== lease || lease.restored) throw new Error('VR session ended during audience setup.');
      const foh = this.buildWebXrFohFrame();
      lease.audience = new WebXrAudienceScene(
        this.renderer,
        this.scene,
        session,
        lease.baseReferenceSpace,
        {
          ...config.audience,
          viewpoints: deriveAudienceViewpoints(this.currentRig ?? {
            venue: 'arena',
            stageWidth: 22,
            stageDepth: 11,
          }, foh),
        },
      );
      lease.audience.setVisible(this.webXrVisibility === 'visible');
      this.webXrEntries++;
    } catch (error) {
      lease.endReason = 'error';
      try {
        await session.end();
        // A fulfilled end() is authoritative even if a non-conforming runtime omitted the event.
        if (this.webXrLease === lease) this.restoreWebXrLease('error');
      } catch {
        // Do not restore ownership or release the physical-output latch without confirmed session end.
      }
      throw error;
    }
  }

  public async exitWebXrSession(
    reason: WebXrLease['endReason'] = 'requested-exit',
  ): Promise<void> {
    const lease = this.webXrLease;
    if (!lease || lease.restored) return;
    lease.endReason = reason;
    try {
      await lease.session.end();
    } catch {
      // Stay fail-closed until the session later emits `end` (or the page is reloaded).
      lease.endReason = 'error';
      return;
    }
    // Standards-compliant sessions dispatch `end`; keep fake/quirky runtimes fail-safe.
    if (this.webXrLease === lease) this.restoreWebXrLease(reason);
  }

  private restoreWebXrLease(reason: WebXrLease['endReason']) {
    const lease = this.webXrLease;
    if (!lease || lease.restored) return;
    lease.restored = true;
    this.webXrLease = null;
    this.webXrPhysicalOutputInterlock = false;
    lease.session.removeEventListener('end', lease.endListener);
    lease.session.removeEventListener('visibilitychange', lease.visibilityListener);
    if (lease.baseReferenceSpace) this.renderer.xr.setReferenceSpace(lease.baseReferenceSpace);
    lease.audience?.dispose();
    lease.audience = null;
    lease.baseReferenceSpace = null;
    this.renderer.setAnimationLoop(null);
    this.renderer.xr.enabled = lease.xrEnabled;

    this.camera.position.copy(lease.cameraPosition);
    this.camera.quaternion.copy(lease.cameraQuaternion);
    this.camera.scale.copy(lease.cameraScale);
    this.camera.up.copy(lease.cameraUp);
    this.camera.fov = lease.cameraFov;
    this.camera.aspect = lease.cameraAspect;
    this.camera.near = lease.cameraNear;
    this.camera.far = lease.cameraFar;
    this.camera.zoom = lease.cameraZoom;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.controls.target.copy(lease.controlsTarget);
    this.controls.enabled = lease.controlsEnabled;
    this.cameraLerpActive = lease.cameraLerpActive;
    this.orbitAuto = lease.orbitAuto;
    this.fitFohOnResize = lease.fitFohOnResize;
    // Session-only full-rate opt-in is intentionally not re-armed after a VR warning cycle.
    this.effectiveFullRateStrobe = false;

    this.renderer.setPixelRatio(lease.rendererPixelRatio);
    this.renderer.setSize(lease.rendererSize.x, lease.rendererSize.y, false);
    this.composer.setPixelRatio(lease.rendererPixelRatio);
    this.composer.setSize(lease.rendererSize.x, lease.rendererSize.y);
    this.updateFxaaResolution();
    this.neonFrame.setViewportHeight(this.renderer.domElement.height);
    this.neonFrame.setPolicy(this.renderSettings.lookNeonFrame, this.renderSettings.trueColour);
    this.syncAtmospherePolicy();
    setWetDeckMaterial(this.mats.stageDeck, this.renderSettings.lookWetDeck && this.renderTier === 'high');
    if (
      this.renderSettings.lookWetDeck && this.renderTier === 'high' &&
      this.wetDeckEnvironmentStats.composition !== 'wet-neutral'
    ) {
      this.restoreStageEnvironment(true);
    }
    if (lease.litPuffs && this.renderSettings.litPuffs) {
      this.refreshCommittedFixtureWorldTransforms();
      this.particles.setLitPuffs(true, this.buildParticleLightingUpdate());
    }
    this.webXrVisibility = 'visible';
    this.webXrExits++;
    this.lastFrameTime = performance.now();
    if (!this.disposed && !this.contextLost && this.rafId === null) this.startLoop();
    if (this.dmxFrameListener) this.startControlFallbackTimer();
    lease.onEnded?.(reason);
  }

  public webXrDiagnostics() {
    const lease = this.webXrLease;
    const rendererSize = this.renderer.getSize(new THREE.Vector2());
    return {
      active: Boolean(lease),
      visibility: this.webXrVisibility,
      loopOwner: lease ? 'webxr-setAnimationLoop' : this.rafId !== null ? 'window-requestAnimationFrame' : 'none',
      entries: this.webXrEntries,
      exits: this.webXrExits,
      frames: this.webXrFrames,
      lastViews: this.webXrLastViews,
      lastCalls: this.webXrLastCalls,
      lastTriangles: this.webXrLastTriangles,
      sessionListeners: lease ? 2 : 0,
      controlsEnabled: this.controls.enabled,
      rendererPixelRatio: this.renderer.getPixelRatio(),
      rendererSize: rendererSize.toArray(),
      rendererXrEnabled: this.renderer.xr.enabled,
      memory: {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        programs: this.renderer.info.programs?.length ?? 0,
      },
      audience: lease?.audience?.diagnostics() ?? null,
      camera: {
        position: this.camera.position.toArray(),
        quaternion: this.camera.quaternion.toArray(),
        scale: this.camera.scale.toArray(),
        up: this.camera.up.toArray(),
        fov: this.camera.fov,
        aspect: this.camera.aspect,
        near: this.camera.near,
        far: this.camera.far,
        zoom: this.camera.zoom,
      },
      controlsTarget: this.controls.target.toArray(),
      composerPasses: this.composer.passes.map((pass) => ({ name: pass.constructor?.name ?? 'Pass', enabled: pass.enabled })),
      directRendering: Boolean(lease),
      physicalOutputInterlocked: this.webXrPhysicalOutputInterlock,
      physicalOutputListenerAttached: Boolean(this.dmxFrameListener),
    };
  }

  public isWebXrSessionActive(): boolean {
    return Boolean(this.webXrLease);
  }

  public activateWebXrMenuForTest(action: string) {
    this.webXrLease?.audience?.activateForTest(action);
  }

  public isWebXrPhysicalOutputInterlocked(): boolean {
    return this.webXrPhysicalOutputInterlock;
  }

  public setWebXrPhysicalOutputInterlock(active: boolean) {
    if (!active && this.webXrLease) return;
    this.webXrPhysicalOutputInterlock = active;
    if (active) {
      this.dmxFrameListener = undefined;
      this.stopControlFallbackTimer();
    }
  }

  /**
   * Toggle preview-only full-rate strobe opt-in (already policy-resolved against reduced-motion / viewer / XR).
   * Never affects physical DMX output buffers or AudioModulationState.
   */
  public setFullRateStrobePreview(enabled: boolean) {
    this.effectiveFullRateStrobe = Boolean(enabled);
  }

  public getFullRateStrobePreview(): boolean {
    return this.effectiveFullRateStrobe;
  }

  private handleResize() {
    if (this.webXrLease) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspectChanged = Math.abs(this.camera.aspect - w / h) > 0.01;
    this.camera.aspect = w / h;
    if (aspectChanged && this.activeView === 'foh' && this.fitFohOnResize) this.setCameraPreset('foh');
    this.camera.updateProjectionMatrix();
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatioForTier(this.renderTier));
    this.renderer.setPixelRatio(dpr);
    this.composer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.neonFrame.setViewportHeight(this.renderer.domElement.height);
    this.updateFxaaResolution();
  }

  /**
   * Read-only GPU/memory stats exposed via `?probe` for Playwright budget & leak assertions.
   * `calls` and `triangles` cover the whole last frame (scene, bloom and output passes).
   * `visibleMeshes` counts meshes whose full ancestor chain is visible AND whose layer intersects `camera.layers`
   * (excluding hidden layer-31 batch originals, while remaining an eligible-mesh count prior to frustum culling).
   */
  public renderStats() {
    let objects = 0, meshes = 0, visibleMeshes = 0, autoUpdating = 0;
    const camLayers = this.camera.layers;
    const walk = (node: THREE.Object3D, ancestorVisible: boolean) => {
      objects++;
      if (node.matrixAutoUpdate) autoUpdating++;
      const selfVisible = ancestorVisible && node.visible;
      if ((node as THREE.Mesh).isMesh) {
        meshes++;
        if (selfVisible && node.layers.test(camLayers)) visibleMeshes++;
      }
      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i], selfVisible);
      }
    };
    walk(this.scene, true);
    return {
      tier: this.renderTier,
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length ?? 0,
      objects,
      meshes,
      visibleMeshes,
      autoUpdating,
      batching: this.batcher?.stats() ?? null,
    };
  }

  /**
   * Comprehensive Sprint 15 graphics configuration & resource snapshot (probe only).
   * Reports drawing-buffer/CSS sizes, DPR, tier, backend, AA/bloom settings, active passes,
   * particle counts/caps, ILDA segment counts, and estimated offscreen render-target bytes.
   */
  public graphicsProbe() {
    const stats = this.renderStats();
    const gl = this.renderer.getContext();
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const drawW = this.renderer.domElement.width;
    const drawH = this.renderer.domElement.height;
    const cssW = Math.max(1, this.container.clientWidth);
    const cssH = Math.max(1, this.container.clientHeight);
    const maxSamples = isWebGL2 ? Number(gl.getParameter(gl.MAX_SAMPLES)) : 0;
    const effectiveSamples = isWebGL2 ? Math.min(this.composerSamplesRequested, maxSamples) : 0;

    // Count eligible meshes that pass camera frustum culling right now (on-demand only).
    const frustum = new THREE.Frustum();
    const projScreen = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const camLayers = this.camera.layers;
    let submittedMeshes = 0;
    const walkSubmitted = (node: THREE.Object3D, ancestorVisible: boolean) => {
      const selfVisible = ancestorVisible && node.visible;
      if (!selfVisible) return;
      if ((node as THREE.Mesh).isMesh && node.layers.test(camLayers)) {
        const m = node as THREE.Mesh;
        if (!m.frustumCulled || frustum.intersectsObject(m)) submittedMeshes++;
      }
      for (let i = 0; i < node.children.length; i++) walkSubmitted(node.children[i], true);
    };
    walkSubmitted(this.scene, true);

    const activePasses: string[] = [];
    for (const p of this.composer.passes) {
      if (!p.enabled) continue;
      if (p === this.renderPass) activePasses.push('RenderPass');
      else if (p === this.bloomPass) activePasses.push('UnrealBloomPass');
      else if (p === this.outputPass) activePasses.push('OutputPass');
      else if (p === this.fxaaPass) activePasses.push('FXAAPass');
      else activePasses.push(p.constructor?.name ?? 'Pass');
    }

    const lookOutput = resolveEffectiveLookOutput(this.renderSettings, this.renderTier, this.prefersReducedMotion);
    const bloomScale = resolveEffectiveBloomScale(this.renderSettings, this.renderTier, this.prefersReducedMotion);
    const bloomAllocated = this.bloomPass !== null;
    const bloomActive = Boolean(this.bloomPass && this.bloomPass.enabled);

    let ildaActiveProjectors = 0;
    let ildaVisibleSegments = 0;
    let ildaBakedSegments = 0;
    let ildaRibbonProjectors = 0;
    let ildaFallbackProjectors = 0;
    let ildaRibbonSegments = 0;
    let ildaRibbonCapacitySegments = 0;
    let ildaScanEnergyExtraBufferBytes = 0;
    let ildaScanEnergyUploadBytes = 0;
    if (this.bakedIlda) {
      ildaBakedSegments = Math.floor(this.bakedIlda.positionAttr.count / 2);
      for (const l of this.laserUnits) {
        const ribbonStats = l.ildaRibbon?.getStats();
        if (ribbonStats) {
          ildaRibbonCapacitySegments += ribbonStats.capacitySegments;
          ildaScanEnergyExtraBufferBytes += ribbonStats.extraBufferBytes;
          ildaScanEnergyUploadBytes += ribbonStats.uploadBytes;
          if (l.ildaRibbon?.mesh.visible) {
            ildaRibbonProjectors++;
            ildaRibbonSegments += ribbonStats.segments;
          } else if (l.ildaMesh?.visible && ribbonStats.fallback) {
            ildaFallbackProjectors++;
          }
        }
        if (l.ildaRibbon?.mesh.visible) {
          ildaActiveProjectors++;
          ildaVisibleSegments += ribbonStats?.segments ?? 0;
        } else if (l.ildaMesh?.visible) {
          ildaActiveProjectors++;
          ildaVisibleSegments += Math.floor(l.ildaMesh.geometry.drawRange.count / 2);
        }
      }
    }

    let debugRenderer: string | null = null;
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) debugRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    } catch { /* ignore */ }

    const particles = this.particles.getStats();
    const prismPools: BeamPoolsStats = this.beamPools?.getStats() ?? {
      requested: this.renderSettings.prismPools,
      allocated: false,
      active: false,
      suppressedReason: this.renderSettings.prismPools ? 'memory-budget' : 'disabled',
      receiverCount: 0,
      totalInstances: 0,
      activePrismInstances: 0,
      maxReceiverPrismInstances: 0,
      receiverPrismCounts: [],
      extraBufferBytes: 0,
      uploadBytes: 0,
    };
    const renderTargetBytesEstimate = estimateRenderTargetBytes({
      drawingWidth: drawW,
      drawingHeight: drawH,
      samples: effectiveSamples,
      bloomScale: bloomAllocated ? bloomScale : 0,
      bloomAllocated,
    });
    const authoredMainScreen = this.screenLayout?.find((s) => s.id === 'main-led');
    let primaryCenter: [number, number, number] | null = null;
    if (this.currentRig) {
      if (isCustomMainWall(authoredMainScreen) && authoredMainScreen) {
        const p = resolveWallFrame(this.currentRig, authoredMainScreen);
        primaryCenter = [p.x, p.y, p.z];
      } else if (this.currentRig.ledWall.enabled) {
        const w = ledPlacement(this.currentRig);
        if (w.height > 0) primaryCenter = [w.x, w.y, w.z];
      }
    }
    const ledWalls = {
      angularResponseRequested: this.renderSettings.ledAngularResponse,
      angularResponseActive:
        this.allLedMaterials.length > 0 &&
        this.allLedMaterials.every((m) => m.defines?.[LED_ANGULAR_DEFINE] === 1),
      materialCount: this.allLedMaterials.length,
      primaryAndWingMaterialCount: this.ledWallMats.length,
      secondaryMaterialCount: Math.max(0, this.allLedMaterials.length - this.ledWallMats.length),
      primaryVideoDecodeActive: this.ledWallMats.some((m) => (m.uniforms.uCustomTexDecode?.value ?? 0) > 0.5),
      videoDecodeActiveMaterialCount: this.allLedMaterials.reduce(
        (count, m) => count + ((m.uniforms.uCustomTexDecode?.value ?? 0) > 0.5 ? 1 : 0),
        0,
      ),
      primaryCenter,
    };
    const deckSheen: DeckSheenStats = this.deckSheen.getStats();
    const wetDeck: WetDeckEnvironmentStats = {
      ...this.wetDeckEnvironmentStats,
      requested: this.renderSettings.lookWetDeck,
      active:
        this.renderSettings.lookWetDeck &&
        this.renderTier === 'high' &&
        this.wetDeckEnvironmentStats.composition === 'wet-neutral',
      sceneOwnsTargetTexture: this.scene.environment === this.environmentTarget.texture,
    };
    const neonFrame: NeonFrameStats = this.neonFrame.getStats();
    const atmosphere = this.atmosphereLook.getStats();
    const crowd: CrowdLightingStats = this.crowdLighting.getStats();
    const litPuffs: LitPuffsStats = this.particles.getLitPuffsStats();

    return {
      schemaVersion: 1 as const,
      backend: isWebGL2 ? 'webgl2' : 'webgl1',
      tier: this.renderTier,
      stats,
      submittedMeshes,
      cssSize: { width: cssW, height: cssH },
      drawingBufferSize: { width: drawW, height: drawH },
      devicePixelRatio: typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1,
      rendererPixelRatio: this.renderer.getPixelRatio(),
      contextAntialias: this.contextAntialias,
      composerSamplesRequested: this.composerSamplesRequested,
      composerSamplesEffective: effectiveSamples,
      maxSamples,
      aaEffective: resolveEffectiveAa(this.renderSettings.aa),
      bloomAllocated,
      bloomActive,
      bloomScale,
      bloomStrength: this.currentState.bloomStrength,
      lookOutput,
      activePasses,
      fullRateStrobePreview: this.effectiveFullRateStrobe,
      previewFlashLimiting: this.previewFlashOut.activeLimiting,
      settings: this.getRenderSettings(),
      webXr: this.webXrDiagnostics(),
      particles,
      litPuffs,
      prismPools,
      ledWalls,
      deckSheen,
      wetDeck,
      neonFrame,
      atmosphere: {
        ...atmosphere,
        fog: [this.fog.color.r, this.fog.color.g, this.fog.color.b] as [number, number, number],
        density: this.fog.density,
        sceneOwnsFog: this.scene.fog === this.fog,
      },
      crowd,
      ilda: {
        activeProjectors: ildaActiveProjectors,
        visibleSegments: ildaVisibleSegments,
        bakedSegments: ildaBakedSegments,
        scanEnergy: {
          requested: this.renderSettings.ildaScanEnergy,
          allocated: ildaRibbonCapacitySegments > 0,
          active: ildaRibbonProjectors > 0,
          ribbonProjectors: ildaRibbonProjectors,
          fallbackProjectors: ildaFallbackProjectors,
          activeSegments: ildaRibbonSegments,
          activeTriangles: ildaRibbonSegments * 2,
          capacitySegments: ildaRibbonCapacitySegments,
          capacityTriangles: ildaRibbonCapacitySegments * 2,
          extraBufferBytes: ildaScanEnergyExtraBufferBytes,
          uploadBytes: ildaScanEnergyUploadBytes,
        },
      },
      resources: {
        renderTargetBytesEstimate,
        prismPoolExtraBufferBytes: prismPools.extraBufferBytes,
        deckSheenExtraTextureBytes: deckSheen.extraTextureBytes,
        litPuffsExtraBufferBytes: litPuffs.extraBufferBytes,
        ildaScanEnergyExtraBufferBytes,
        lookOutputExtraGpuBytes: 0,
        neonFrameExtraBufferBytes: neonFrame.extraBufferBytes,
        wetDeckExtraGpuBytes: wetDeck.extraGpuBytes,
        atmosphereExtraGpuBytes: atmosphere.extraGpuBytes,
        sprint23ExtraGpuBytes: neonFrame.extraBufferBytes + wetDeck.extraGpuBytes + atmosphere.extraGpuBytes,
      },
      gpuTimerStatus: this.gpuTimer?.getStatus() ?? (isWebGL2 ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') ? 'ok' : 'unsupported') : 'unsupported'),
      gpuTimerPending: this.gpuTimer?.pendingCount() ?? 0,
      contextLost: this.contextLost,
      debugRenderer,
    };
  }

  /**
   * Warmed per-frame CPU-phase + async GPU-timer benchmark (probe only; zero overhead when idle).
   */
  public measureFrames(options?: { warmupFrames?: number; sampleFrames?: number; gpu?: boolean }): Promise<FrameMeasureReport> {
    if (this.profiler) {
      return Promise.reject(new Error('A frame measurement session is already running.'));
    }
    if (this.contextLost) {
      return Promise.reject(new Error('Cannot measure frames while WebGL context is lost.'));
    }
    if (this.standby) {
      return Promise.reject(new Error('Cannot measure frames while StageEngine is in standby.'));
    }
    const warmup = options?.warmupFrames ?? 60;
    const frames = options?.sampleFrames ?? 240;
    const useGpu = options?.gpu !== false;
    this.profilerUseGpu = useGpu;
    if (useGpu && !this.gpuTimer) {
      this.gpuTimer = new GpuTimerRing(this.renderer.getContext());
    }
    const session = new FrameProfilerSession(warmup, frames);
    this.profiler = session;
    this.batcher?.setSyncObserver((ms, uploadBytes) => {
      const p = this.profiler;
      if (!p) return;
      p.curBatchSyncMs += ms;
      p.curUploadBytes += uploadBytes;
    });
    return session.promise;
  }

  /** Reset particle RNG streams and pools to a deterministic seed (probe only). */
  public resetParticles(seed?: number) {
    this.particles.reset(seed);
  }

  /**
   * Deterministic presentation-step + post-bloom luminance readback hook (`?probe` only).
   * Advances simulation by `dtMs`, renders synchronously through the full output chain,
   * and returns an 8×8 WCAG luminance/red grid alongside current physical DMX bytes.
   */
  public stepAndReadLuminance(dtMs: number): {
    elapsedMs: number;
    grid: FrameLuminanceGrid;
    previewFlashLimiting: boolean;
    physicalDmxU1: number[];
    physicalDmxU2: number[];
  } {
    if (this.standby) throw new Error('stepAndReadLuminance called while StageEngine is in standby');
    const safeDtMs = Math.max(1, Math.min(250, Number.isFinite(dtMs) ? dtMs : 16.667));
    const dt = safeDtMs / 1000;
    this.elapsed += dt;
    const audio = this.audioGetter(dt);
    this.renderer.info.reset();
    if (this.updateScene(dt, audio, dt)) this.composer.render(0);
    else this.clearStage();
    this.controlLoopSeq++;
    this.lastControlTickMs = performance.now();

    const gl = this.renderer.getContext();
    const w = Math.max(1, this.renderer.domElement.width);
    const h = Math.max(1, this.renderer.domElement.height);
    if (!this.readPixelsBuf || this.readPixelsW !== w || this.readPixelsH !== h) {
      this.readPixelsBuf = new Uint8Array(w * h * 4);
      this.readPixelsW = w;
      this.readPixelsH = h;
    }
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.readPixelsBuf);
    return {
      elapsedMs: this.elapsed * 1000,
      // WebGL readPixels is bottom-up; flipY aligns row 0 with the top of the viewport.
      grid: computeFrameLuminanceGrid(this.readPixelsBuf, w, h, 8, 8, true),
      previewFlashLimiting: this.previewFlashOut.activeLimiting,
      physicalDmxU1: Array.from(this.physicalDmxU1),
      physicalDmxU2: Array.from(this.physicalDmxU2),
    };
  }

  /** Turn draw-call batching off or on (probe and A/B checks). */
  public setBatching(enabled: boolean, options?: { proxies?: boolean }) {
    this.batcher?.setMode(enabled, options?.proxies ?? true);
  }

  /** Render the current scene state without advancing simulation time and capture the canvas PNG (probe only). */
  public redrawAndCapture(options?: { hideBeams?: boolean; hidePools?: boolean; hideParticles?: boolean }): string {
    if (this.standby) throw new Error('redrawAndCapture called while StageEngine is in standby');
    const savedVisibility = options?.hideBeams
      ? this.movingFixtures.map((fx) => {
        const prev = fx.beamMesh.visible;
        fx.beamMesh.visible = false;
        return prev;
      })
      : null;
    const savedPoolsVisible = options?.hidePools && this.beamPools ? this.beamPools.group.visible : null;
    if (options?.hidePools && this.beamPools) {
      this.beamPools.group.visible = false;
    }
    const savedParticlesVisible = options?.hideParticles ? this.particles.group.visible : null;
    if (options?.hideParticles) {
      this.particles.group.visible = false;
    }
    try {
      this.renderer.info.reset();
      this.composer.render(0);
      return this.renderer.domElement.toDataURL('image/png');
    } finally {
      if (savedVisibility) {
        this.movingFixtures.forEach((fx, i) => {
          fx.beamMesh.visible = savedVisibility[i];
        });
      }
      if (savedPoolsVisible !== null && this.beamPools) {
        this.beamPools.group.visible = savedPoolsVisible;
      }
      if (savedParticlesVisible !== null) {
        this.particles.group.visible = savedParticlesVisible;
      }
    }
  }

  private captureCanvas: HTMLCanvasElement | null = null;

  /**
   * Render the committed scene state synchronously and copy to a bounded 2D canvas
   * before encoding to JPEG (for AI bridge `capture_frame`; never invokes probe or animation loop).
   */
  public async captureJpeg(options?: { maxWidth?: number; quality?: number; maxBytes?: number }): Promise<{
    base64: string;
    width: number;
    height: number;
    byteLength: number;
  }> {
    if (this.standby) {
      throw new Error('Viewport is paused (window hidden or minimised).');
    }
    const gl = this.renderer.getContext();
    if (typeof gl?.isContextLost === 'function' && gl.isContextLost()) {
      throw new Error('WebGL context is lost.');
    }
    const srcCanvas = this.renderer.domElement;
    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;
    if (srcW <= 0 || srcH <= 0) {
      throw new Error('Viewport canvas has zero dimensions.');
    }
    const targetMaxW = Math.max(160, Math.min(1280, Math.round(options?.maxWidth ?? 1280)));
    const initialQuality = Math.max(0.3, Math.min(0.95, options?.quality ?? 0.8));
    const maxBytes = Math.max(32_768, Math.min(1024 * 1024, options?.maxBytes ?? 512 * 1024));

    const encodeAt = async (maxW: number, quality: number) => {
      const scale = Math.min(1, maxW / srcW);
      const outW = Math.max(1, Math.round(srcW * scale));
      const outH = Math.max(1, Math.round(srcH * scale));
      if (!this.captureCanvas) {
        this.captureCanvas = document.createElement('canvas');
      }
      this.captureCanvas.width = outW;
      this.captureCanvas.height = outH;
      const ctx = this.captureCanvas.getContext('2d');
      if (!ctx) throw new Error('Could not acquire 2D canvas context for JPEG capture.');
      // Render and drawImage synchronously in the same task so preserveDrawingBuffer is not needed.
      this.renderer.info.reset();
      this.composer.render(0);
      ctx.drawImage(srcCanvas, 0, 0, srcW, srcH, 0, 0, outW, outH);

      const dataUrl = this.captureCanvas.toDataURL('image/jpeg', quality);
      const prefix = 'data:image/jpeg;base64,';
      if (!dataUrl.startsWith(prefix)) {
        throw new Error('Canvas JPEG encoding failed.');
      }
      const base64 = dataUrl.slice(prefix.length);
      const byteLength = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
      return { base64, width: outW, height: outH, byteLength };
    };

    let attempt = await encodeAt(targetMaxW, initialQuality);
    if (attempt.byteLength > maxBytes) {
      attempt = await encodeAt(targetMaxW, Math.min(initialQuality, 0.6));
    }
    if (attempt.byteLength > maxBytes) {
      attempt = await encodeAt(Math.min(targetMaxW, 960), 0.55);
    }
    if (attempt.byteLength > maxBytes) {
      attempt = await encodeAt(Math.min(targetMaxW, 640), 0.5);
    }
    if (attempt.byteLength > maxBytes) {
      throw new Error(`Captured JPEG exceeded ${maxBytes} byte budget.`);
    }
    return attempt;
  }

  public getRenderTier(): RenderTier {
    return this.renderTier;
  }

  /** Load or clear an in-session ILDA (.ild) clip on all laser projectors in the rig. */
  public setIldaClip(clip: IldaClip | null) {
    this.detachIldaMeshes();
    this.activeIldaClip = clip;
    this.ildaClipRevision++;
    this.ildaPlayTime = 0;
    if (clip) this.attachIldaToLaserUnits();
  }

  /** Configure ILDA playback render mode ('both' | 'beam' | 'graphic') and frame rate (fps). */
  public setIldaSettings(mode: IldaRenderMode, fps: number) {
    this.ildaRenderMode = mode;
    this.ildaFps = Math.max(1, Math.min(120, Number.isFinite(fps) ? fps : 30));
  }

  private detachIldaMeshes() {
    for (const l of this.laserUnits ?? []) {
      if (l.ildaMesh) {
        l.ildaMesh.removeFromParent();
        l.ildaMesh = undefined;
      }
      if (l.ildaMat) {
        l.ildaMat.dispose();
        l.ildaMat = undefined;
      }
      if (l.ildaRibbon) {
        l.ildaRibbon.mesh.removeFromParent();
        l.ildaRibbon = undefined;
      }
    }
    this.bakedIlda?.dispose();
    this.bakedIlda = null;
  }

  private attachIldaToLaserUnits() {
    if (!this.activeIldaClip || this.laserUnits.length === 0) return;
    const baked = new BakedIldaClip(this.activeIldaClip);
    this.bakedIlda = baked;
    for (const l of this.laserUnits) {
      const singleColor = l.laserSpec?.colorType === 'single';
      const geo = baked.createProjectorGeometry(singleColor);
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const mesh = new THREE.LineSegments(geo, mat);
      mesh.name = 'ILDA laser projection';
      mesh.frustumCulled = false;
      mesh.visible = false;
      l.root.add(mesh);
      l.ildaMesh = mesh;
      l.ildaMat = mat;
    }
    this.syncIldaScanEnergyResources(this.renderSettings.ildaScanEnergy);
  }

  /** Toggle only optional ribbons; legacy shared line buffers/materials retain exact identity and pixels. */
  private syncIldaScanEnergyResources(enabled: boolean) {
    const baked = this.bakedIlda;
    if (!baked) return;
    for (const l of this.laserUnits) {
      const restoreLine = Boolean(l.ildaRibbon?.mesh.visible);
      if (l.ildaRibbon) l.ildaRibbon.mesh.removeFromParent();
      l.ildaRibbon = undefined;
      if (restoreLine && l.ildaMesh && l.ildaMesh.geometry.drawRange.count > 0) l.ildaMesh.visible = true;
    }
    baked.disposeScanEnergyProjectors();
    if (!enabled) return;
    const ribbonBudget = ildaScanEnergyBudget(this.renderTier, this.laserUnits.length);
    if (ribbonBudget.segmentsPerProjector <= 0) return;
    for (const l of this.laserUnits) {
      const ribbon = baked.createScanEnergyProjector(
        ribbonBudget.segmentsPerProjector,
        l.laserSpec?.colorType === 'single',
      );
      l.root.add(ribbon.mesh);
      l.ildaRibbon = ribbon;
      if (l.ildaLastFrame !== undefined && l.ildaLastMode) {
        const state = ribbon.updateFrame(l.ildaLastFrame, l.ildaLastMode);
        ribbon.mesh.scale.set(l.ildaLastScaleX ?? 1, l.ildaLastScaleY ?? 1, 1);
        ribbon.mesh.rotation.z = l.ildaLastRoll ?? 0;
        ribbon.setAppearance(l.ildaLastGain ?? 0, l.ildaLastHaze ?? 0, l.singleColor);
        if (l.ildaLastVisible && state.active) this.selectIldaPath(l, 'ribbon');
      }
    }
  }

  /** Select exactly one ILDA preview path so the optional ribbon always replaces the legacy line draw. */
  private selectIldaPath(laser: LaserUnitInstance, path: 'line' | 'ribbon' | 'none') {
    if (laser.ildaMesh) laser.ildaMesh.visible = false;
    if (laser.ildaRibbon) laser.ildaRibbon.mesh.visible = false;
    if (path === 'line' && laser.ildaMesh) laser.ildaMesh.visible = true;
    if (path === 'ribbon' && laser.ildaRibbon) laser.ildaRibbon.mesh.visible = true;
  }

  /** Force a full rig teardown + rebuild (used by `?probe` leak tests). */
  public forceRebuildCurrentRig() {
    if (!this.lastRebuildSource) return;
    this.currentRig = undefined;
    this.geometryKey = undefined;
    this.rebuildRig(this.lastRebuildSource, this.lastRebuildStage);
  }

  public previewRig() {
    this.standby = false;
  }

  public beginDemo(opening: ShowState, initialOpeningStep = 0) {
    this.standby = false;
    this.manualFadeStart = undefined;
    this.directedStep = initialOpeningStep;
    this.setShowState(opening);
    this.clearStage();
  }

  private clearStage() {
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
  }

  public setShowState(state: ShowState) {
    if (state.autoDirector && !this.currentState.autoDirector) this.manualFadeStart = undefined;
    this.currentState = state;
    this.neonFrame?.setPalette(state.primaryColor, state.accentColor);
    if (this.bloomPass) {
      const look = resolveEffectiveLookOutput(this.renderSettings, this.renderTier, this.prefersReducedMotion);
      const strength = state.bloomStrength * look.bloomStrengthScale;
      this.bloomPass.strength = strength;
      this.bloomPass.enabled = strength > 0.001;
    }
    if (state.led.tourText !== this.lastTourText) {
      this.updateTourTextTexture(state.led.tourText);
    }
    if (state.led.customMediaUrl !== this.lastCustomUrl) {
      this.updateCustomLedMedia(state.led.customMediaUrl, state.led.customMediaType);
    }
    this.syncScreenPlayback();
  }

  public setBumpState(bump: BumpState) {
    if (Object.values(bump).some(Boolean)) this.previewRig();
    this.currentBump = bump;
  }

  /** Focus points follow the stage plan, so they are re-derived whenever the design changes. */
  private getFocusMarks(): FocusMark[] {
    const rig = this.currentRig;
    if (!rig) return [];
    if (this.focusMarkCache?.rig !== rig) this.focusMarkCache = { rig, marks: focusMarks(rig) };
    return this.focusMarkCache.marks;
  }

  /** Test probe & UI telemetry: current audio-modulation envelopes, values and flash-limiter state. */
  public getAudioModulationSnapshot() {
    const f = this.audioModFrame;
    const entries = [];
    for (let i = 0; i < f.entryCount; i++) {
      const e = f.entries[i];
      entries.push({
        id: e.id,
        name: e.name,
        enabled: e.enabled,
        group: e.group,
        param: e.param,
        ...(e.projectorKey ? { projectorKey: e.projectorKey } : {}),
        raw: e.raw,
        envelope: e.envelope,
        modulatedValue: e.modulatedValue,
      });
    }
    return {
      active: f.active,
      flashLimited: f.flashLimited,
      entries,
    };
  }

  /** Test probe: effective parameters applied by the engine on the last frame (per group or all groups). */
  public getFixtureParams(group?: AudioTargetGroup) {
    const p = this.appliedParams;
    const copyAll = () => ({
      master: p.master,
      legacyBoost: p.legacyBoost,
      beam: { ...p.beam, strobe: { ...p.beam.strobe } },
      wash: { ...p.wash, strobe: { ...p.wash.strobe } },
      blinder: { ...p.blinder },
      strobe: { ...p.strobe, strobe: { ...p.strobe.strobe } },
      ledWall: { ...p.ledWall },
      laser: {
        ...p.laser,
        strobe: { ...p.laser.strobe },
        projectors: Object.fromEntries(
          Object.entries(p.laser.projectors).map(([k, v]) => [k, { ...v }]),
        ),
      },
      haze: { ...p.haze },
      atmo: { ...p.atmo },
    });
    if (!group) return copyAll();
    const all = copyAll();
    return { master: all.master, legacyBoost: all.legacyBoost, ...all[group] };
  }

  /** Set the session-inhibited laser projector keys whose physical DMX channels are forced to 0 (no cue/bump bypass). */
  public setInhibitedLasers(keys: readonly string[]) {
    this.inhibitedLaserKeys.clear();
    for (const k of keys) this.inhibitedLaserKeys.add(k);
  }

  /** Configure the 3D Measure & Safety Zones overlay. Lazy-allocates on enable and removes+disposes when all off. */
  public setMeasureOverlay(options: MeasureOverlayOptions) {
    this.measureOptions = options;
    const active = isMeasureOverlayActive(options);
    if (!active) {
      if (this.measureOverlay) {
        this.scene.remove(this.measureOverlay.group);
        this.measureOverlay.dispose();
        this.measureOverlay = null;
      }
      return;
    }
    if (!this.measureOverlay) {
      this.measureOverlay = new MeasureOverlay3D();
      this.scene.add(this.measureOverlay.group);
    }
    // Force immediate refresh on next tick (or right now if already initialized).
    this.lastMeasureTickMs = -Infinity;
    this.refreshMeasureOverlayAndSnapshot(performance.now());
  }

  /** Register a throttled (<=10 Hz) MeasureSnapshot subscriber (HUD or live safety monitor). */
  public setMeasureListener(listener?: (snapshot: MeasureSnapshot) => void) {
    this.measureListener = listener;
    if (listener) {
      this.lastMeasureTickMs = -Infinity;
    }
  }

  /** Enable continuous <=10 Hz measurement snapshots while live DMX is active, independent of overlay visibility. */
  public setLiveSafetyMonitor(enabled: boolean) {
    this.liveSafetyMonitorEnabled = enabled;
    if (enabled) this.lastMeasureTickMs = -Infinity;
  }

  private getMeasureSurfaces(): SceneRaySurfaces | null {
    if (!this.currentRig) return null;
    if (!this.measureSurfacesCache) {
      this.measureSurfacesCache = buildSceneRaySurfaces(this.currentRig, this.lastRebuildStage);
    }
    return this.measureSurfacesCache;
  }

  private sampleMeasureHeads(projectToScreen: boolean): EngineHeadSample[] {
    const out: EngineHeadSample[] = new Array(this.movingFixtures.length);
    const origin = this.measureOriginScratch;
    const dir = this.measureDirScratch;
    const mount = this.measureMountScratch;
    const proj = this.measureProjScratch;
    for (let i = 0; i < this.movingFixtures.length; i++) {
      const fx = this.movingFixtures[i];
      const sign = fx.isFloor ? 1 : -1;
      fx.root.updateWorldMatrix(true, false);
      fx.head.updateWorldMatrix(true, false);
      fx.root.getWorldPosition(mount);
      // Lens origin matches BeamPools.add (local (0, sign * lensOffsetY, 0) in head/beam frame).
      origin.set(0, sign * fx.lensOffsetY, 0).applyMatrix4(fx.head.matrixWorld);
      dir.set(0, sign, 0).transformDirection(fx.head.matrixWorld).normalize();
      let screenX: number | null = null;
      let screenY: number | null = null;
      let inView = false;
      if (projectToScreen) {
        proj.copy(origin).project(this.camera);
        inView = proj.z >= -1 && proj.z <= 1 && Math.abs(proj.x) <= 1.05 && Math.abs(proj.y) <= 1.05;
        screenX = (proj.x + 1) * 0.5;
        screenY = (1 - proj.y) * 0.5;
      }
      out[i] = {
        unitId: fx.unitId,
        fixtureNumber: fx.fixtureNumber,
        groupId: fx.groupId,
        podId: fx.podId,
        positionName: fx.positionName,
        label: fx.label,
        modelName: fx.modelName,
        type: fx.type,
        motion: fx.motion,
        isFloor: fx.isFloor,
        mountPosition: { x: mount.x, y: mount.y, z: mount.z },
        lensOrigin: { x: origin.x, y: origin.y, z: origin.z },
        direction: { x: dir.x, y: dir.y, z: dir.z },
        panRad: fx.currentPan,
        tiltRad: fx.currentTilt,
        zoomScale: fx.lastZoomScale,
        optics: fx.optics,
        configuredLumens: fx.configuredLumens,
        appliedDimmer: fx.appliedDimmer,
        emittedVisible: fx.beamMesh.visible,
        screenX,
        screenY,
        inView,
      };
    }
    return out;
  }

  /** Compute a fresh immutable MeasureSnapshot on demand (used by `?probe` and 10 Hz HUD/monitor). */
  public getMeasureSnapshot(projectHitPoints = false): MeasureSnapshot | null {
    if (!this.currentRig) return null;
    const surfaces = this.getMeasureSurfaces();
    if (!surfaces) return null;
    const samples = this.sampleMeasureHeads(false);
    const snap = buildMeasureSnapshot(samples, this.currentRig, surfaces, performance.now());
    if (!projectHitPoints) return snap;

    const proj = this.measureProjScratch;
    const withScreen = snap.units.map((u) => {
      const target = u.hitPoint ?? u.lensOrigin;
      proj.set(target.x, target.y, target.z).project(this.camera);
      const inView = proj.z >= -1 && proj.z <= 1 && Math.abs(proj.x) <= 1.0 && Math.abs(proj.y) <= 1.0;
      return {
        ...u,
        screenX: inView ? (proj.x + 1) * 0.5 : null,
        screenY: inView ? (1 - proj.y) * 0.5 : null,
        inView,
      };
    });
    return { ...snap, units: withScreen };
  }

  private refreshMeasureOverlayAndSnapshot(nowMs: number) {
    const overlayActive = isMeasureOverlayActive(this.measureOptions);
    if (!overlayActive && !this.liveSafetyMonitorEnabled) return;
    if (nowMs - this.lastMeasureTickMs < 100) return; // <= 10 Hz cap
    this.lastMeasureTickMs = nowMs;

    if (!this.currentRig) return;
    const snap = this.getMeasureSnapshot(this.measureOptions.enabled);
    if (!snap) return;

    if (this.measureOverlay && overlayActive) {
      const opts = this.measureOptions;
      this.measureOverlay.updateRays(snap.units, opts.enabled && opts.showRays, opts.selectedUnitId);
      this.measureOverlay.updateAudienceZone(snap.bounds, opts.showAudienceZone);
      if (opts.showLaserNohd) {
        const s = this.currentState.laser;
        const projKey = s.projectors ? JSON.stringify(s.projectors) : '';
        const nohdKey = `${this.measureRigRevision}:${this.ildaClipRevision}:${s.pattern}:${s.beamCount}:${s.speed.toFixed(3)}:${s.spreadX.toFixed(2)}:${s.spreadY.toFixed(2)}:${s.tilt.toFixed(2)}:${s.rotation.toFixed(2)}:${s.audienceScan}:${projKey}`;
        if (nohdKey !== this.lastNohdKey) {
          this.lastNohdKey = nohdKey;
          this.lastNohdZones = evaluateLaserZones(this.currentRig, { ...s, enabled: true, intensity: 1 }, {
            stage: this.lastRebuildStage,
            ildaClip: this.activeIldaClip,
          }).zones;
        }
        this.measureOverlay.updateLaserNohd(this.lastNohdZones, true, nohdKey);
      } else {
        this.measureOverlay.updateLaserNohd([], false, '');
      }
      if (opts.showReachMap) {
        if (!this.measureReachCache) {
          this.measureReachCache = computeReachMap(this.currentRig, this.lastRebuildStage);
        }
        this.measureOverlay.updateReachMap(
          this.measureReachCache,
          opts.selectedUnitId,
          true,
          String(this.measureRigRevision),
        );
      } else {
        this.measureOverlay.updateReachMap({ deckY: 0, areas: [], unionPolygon: [] }, null, false, '');
      }
    }

    if (this.measureListener) {
      this.measureListener(snap);
    }
  }

  /** Test probe: each moving head's beam axis in world space (origin at the tilt pivot). */
  public beamAxes() {
    const origin = new THREE.Vector3(),
      tip = new THREE.Vector3();
    return this.movingFixtures.map((fx) => {
      fx.head.updateWorldMatrix(true, false);
      fx.head.getWorldPosition(origin);
      tip.set(0, fx.isFloor ? 1 : -1, 0).applyMatrix4(fx.head.matrixWorld);
      const dir = tip.sub(origin).normalize();
      const buffer = fx.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
      return { origin: origin.toArray(), dir: dir.toArray(), isFloor: fx.isFloor, group: fx.type,
        rgb: fx.beamMat.uniforms.uColor.value.getHexString(),
        optics: { lumens: fx.optics.lumens, farRadius: fx.optics.farRadius,
          emitted: fx.beamMat.uniforms.uIntensity.value, dimmer: fx.dmxStart ? buffer[fx.dmxStart + 1] : 0 } };
    });
  }

  public releaseDirector(crossfade: boolean) {
    this.manualFadeStart = crossfade && this.directedStep !== undefined && this.directedStep < 384
      ? this.elapsed : undefined;
  }

  private orbitOffset = new THREE.Vector3();
  private orbitAngles = new THREE.Spherical();

  public orbitBy(horizontal: number, vertical: number) {
    this.previewRig();
    this.fitFohOnResize = false;
    this.cameraLerpActive = false;
    this.orbitAuto = false;
    this.orbitOffset.subVectors(this.camera.position, this.controls.target);
    this.orbitAngles.setFromVector3(this.orbitOffset);
    this.orbitAngles.theta += horizontal;
    this.orbitAngles.phi = THREE.MathUtils.clamp(this.orbitAngles.phi + vertical, 0.05, this.controls.maxPolarAngle);
    this.camera.position.copy(this.controls.target).add(this.orbitOffset.setFromSpherical(this.orbitAngles));
    this.controls.update();
  }

  /**
   * Test-only hook (`?probe`): set exact deterministic camera position and target without lerp lag.
   */
  public setProbeCameraPose(pos: [number, number, number], target: [number, number, number]) {
    this.previewRig();
    this.fitFohOnResize = false;
    this.cameraLerpActive = false;
    this.orbitAuto = false;
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.controls.target.set(target[0], target[1], target[2]);
    this.cameraTargetPos.copy(this.camera.position);
    this.cameraTargetLook.copy(this.controls.target);
    this.controls.update();
    this.camera.updateMatrixWorld(true);
    if (this.particles.isLitPuffsEnabled()) {
      this.refreshCommittedFixtureWorldTransforms();
      this.particles.syncLitFromCommittedState(this.buildParticleLightingUpdate());
    }
  }

  public setCameraPreset(preset: CameraPreset) {
    this.activeView = preset;
    this.fitFohOnResize = preset === 'foh';
    this.orbitAuto = preset === 'orbit';
    this.cameraLerpActive = preset !== 'orbit';
    let fov = CAMERA_FOV;
    switch (preset) {
      case 'foh':
        {
          const rig = this.currentRig;
          const room = this.room;
          // Keep the eye inside the room: in front of the rear wall and under the ceiling.
          const rearLimit = room ? room.rearZ - 1.5 : rig?.venue === 'warehouse' ? 32 : rig?.venue === 'arena' ? 45 : 60;
          const eyeCeiling = room ? room.ceilingY : this.roofY;
          if (rig && (this.screenLayout?.some(w => w.id !== 'main-led' || isCustomMainWall(w)) || rig.platforms !== undefined || rig.trussPods.some(pod => pod.shape === 'path'))) {
            // The first rig child is the venue shell. Remaining children are stage equipment.
            const subjects = [...this.rigGroup.children.slice(1), ...Array.from(this.scenicPieces.values(), p => p.root)];
            const frame = fitAuthoredFoh(subjects, this.ledWallMats, this.camera.aspect, eyeCeiling, rearLimit, CAMERA_FOV);
            this.cameraTargetPos.copy(frame.position);
            this.cameraTargetLook.copy(frame.target);
            this.controls.maxDistance = Math.max(68, frame.distance * 1.2);
            this.camera.far = frame.far;
            this.camera.fov = frame.fov;
            this.camera.updateProjectionMatrix();
            return;
          }
          this.controls.maxDistance = 68;
          if (this.camera.far !== 220) {
            this.camera.far = 220;
            this.camera.updateProjectionMatrix();
          }
          const wall = rig?.ledWall.enabled ? ledPlacement(rig) : null;
          const screenWidth = wall ? wall.width + (wall.wing.width > 0 ? 2 * (wall.wing.width + wall.wingGap) : 0) : 0;
          const width = Math.max((this.currentRig?.stageWidth ?? 22) + 8, screenWidth + 1);
          const halfAngle = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
          const stageFront = (this.currentRig?.stageDepth ?? 11) / 2;
          const fitZ = 1 + width / (2 * halfAngle * this.camera.aspect);
          // Arenas frame from at least 25 m; a small room frames the stage from a mix-position distance.
          const desiredZ = room
            ? Math.max(stageFront + 8, fitZ, stageFront + 0.6 * (room.rearZ - stageFront))
            : Math.max(25, fitZ);
          // Keep FOH under the roof (rear edge at z=35 in the warehouse, 51 in the arena).
          const z = Math.min(desiredZ, rearLimit);
          fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfAngle * (desiredZ - stageFront) / (z - stageFront)));
          if (room) {
            // Mid-house (theatre) or just ahead of the mix position (club), at audience eye height.
            // Aim a little down so the nearest heads sit along the bottom of the frame.
            this.cameraTargetPos.set(1.2, Math.min(6.6, room.ceilingY * 0.45 + 1), z);
            this.cameraTargetLook.set(0, (rig?.stageHeight ?? 1) + room.ceilingY * 0.15, -0.6);
          } else {
            this.cameraTargetPos.set(3.8, 6.6, z);
            this.cameraTargetLook.set(0, 5.8, -0.6);
          }
        }
        break;
      case 'front_row':
        this.cameraTargetPos.set(0, 2.5, 11.4);
        this.cameraTargetLook.set(0, this.room ? Math.min(6.2, this.room.ceilingY * 0.55) : 6.2, -2.5);
        break;
      case 'wide_arena':
        if (this.room) {
          this.cameraTargetPos.set(this.room.halfWidth * 0.75, this.room.ceilingY * 0.82, this.room.rearZ - 1.2);
          this.cameraTargetLook.set(0, this.room.ceilingY * 0.35, 0);
        } else {
          this.cameraTargetPos.set(22, 12.8, 30.5);
          this.cameraTargetLook.set(0, 5.2, 0);
        }
        break;
      case 'stage_side':
        if (this.room) {
          const x = -Math.min(14.5, this.room.halfWidth - 0.8);
          const rig = this.currentRig;
          const front = rig ? rig.stageDepth / 2 : 5.5;
          // Stand just upstage of the flown stack, looking across the deck.
          const sideZ = rig?.audioRig.lineArrays ? Math.min(5.5, front - 2.4) : 5.5;
          this.cameraTargetPos.set(x, Math.min(4.6, this.room.ceilingY - 0.8), sideZ);
          this.cameraTargetLook.set(2.5, Math.min(5.5, this.room.ceilingY * 0.55), Math.min(3.5, sideZ));
        } else {
          this.cameraTargetPos.set(-14.5, 4.6, 5.5);
          this.cameraTargetLook.set(2.5, 5.5, 3.5);
        }
        break;
      case 'pa_closeup': {
        const rig = this.currentRig;
        if (!rig) break;
        const x = -rig.stageWidth / 2 - 1.35;
        const z = rig.stageDepth / 2 - 0.4;
        const hang = this.geometryLayout?.hangs?.[0];
        if (hang) {
          const height = SPEAKER_PROFILES[rig.audioRig.speakerProfile ?? 'touring'].array.height;
          const lookY = hang.y - hang.count * height / 2;
          const sideInward = hang.x === 0 ? -1 : -Math.sign(hang.x);
          const rawX = hang.x + sideInward * 2.4;
          const camX = this.room ? THREE.MathUtils.clamp(rawX, -this.room.halfWidth + 0.8, this.room.halfWidth - 0.8) : rawX;
          const camZ = this.room ? Math.min(this.room.rearZ - 1.0, hang.z + 5.0) : hang.z + 5.0;
          this.cameraTargetLook.set(hang.x, lookY, hang.z);
          this.cameraTargetPos.set(camX, lookY + 0.45, camZ);
        } else if (rig.audioRig.lineArrays) {
          const y = Math.min(this.roofY - 1.65, 11.65) - (rig.audioRig.boxesPerSide ?? 9) * 0.185;
          this.cameraTargetPos.set(x - 2.4, y - 0.6, z + 6.1);
          this.cameraTargetLook.set(x + 0.55, y, z);
        } else {
          const [monitor] = monitorPositions(rig);
          const speakerX = monitor?.x ?? 0;
          const speakerZ = monitor?.z ?? rig.stageDepth / 2 + 0.6;
          const speakerY = monitor ? monitor.y + 0.25 : (rig.audioRig.subWall ? 0.5 : 0);
          this.cameraTargetPos.set(speakerX - 2.4, speakerY + 1.3, speakerZ + 4.7);
          this.cameraTargetLook.set(speakerX, speakerY, speakerZ);
        }
        break;
      }
      case 'overhead':
        if (this.room) {
          this.cameraTargetPos.set(0.5, this.room.ceilingY - 0.5, this.room.rearZ * 0.55);
          this.cameraTargetLook.set(0, 1.0, 0);
        } else {
          this.cameraTargetPos.set(0.5, 22.0, 20.0);
          this.cameraTargetLook.set(0, 3.8, 0);
        }
        break;
      case 'orbit':
        this.cameraTargetLook.set(0, this.room ? Math.min(5.6, this.room.ceilingY * 0.45) : 5.6, 0);
        break;
    }
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private fitFohOnResize = true;

  private updateTourTextTexture(text: string) {
    this.lastTourText = text;
    const ctx = this.textCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.textCanvas.width, this.textCanvas.height);

    // Subtle graphic frame lines
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    ctx.lineWidth = 5;
    ctx.strokeRect(36, 44, this.textCanvas.width - 72, this.textCanvas.height - 88);

    const lines = (text || 'STAGEFORGE 3D').split('//').map((s) => s.trim());
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (lines.length === 1) {
      ctx.font = '900 108px "Space Grotesk", Arial, sans-serif';
      ctx.fillText(lines[0].toUpperCase(), 512, 256, 900);
    } else {
      ctx.font = '900 102px "Space Grotesk", Arial, sans-serif';
      ctx.fillText(lines[0].toUpperCase(), 512, 205, 900);
      ctx.font = '700 46px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillText(lines.slice(1).join(' // ').toUpperCase(), 512, 322, 880);
    }
    this.textTex.needsUpdate = true;
  }

  public setMissingScreen(name: string | null) {
    if ((this.missingScreenTex?.name ?? null) === name) return;
    this.missingScreenTex?.dispose();
    this.missingScreenTex = name ? createMissingMediaSlate(name) : null;
    this.bindScreenTexture();
  }

  private bindScreenTexture() {
    const texture = this.customTex ?? this.missingScreenTex;
    const decodeVideo = Boolean(
      this.customTex &&
      this.customVideoEl &&
      resolveEffectiveLookOutput(this.renderSettings, this.renderTier, this.prefersReducedMotion).videoSrgbDecode
    );
    for (const material of this.ledWallMats) {
      material.uniforms.uCustomTex.value = texture ?? this.textTex;
      material.uniforms.uHasCustom.value = texture ? 1 : 0;
      if (material.uniforms.uCustomTexDecode) {
        material.uniforms.uCustomTexDecode.value = decodeVideo ? 1.0 : 0.0;
      }
    }
  }

  public screenTransport(): { playing: boolean; offsetSeconds: number } {
    const video = this.customVideoEl;
    if (!video) return { playing: false, offsetSeconds: 0 };
    const loadingTime = this.screenRunning ? (performance.now() - this.screenSeekClock) / 1000 : 0;
    const offsetSeconds = this.pendingScreenOffset === undefined ? video.currentTime : this.pendingScreenOffset + loadingTime;
    return { playing: this.screenRunning, offsetSeconds };
  }

  public restoreScreenTransport(playing: boolean, offsetSeconds?: number) {
    if (!this.customVideoEl) return;
    this.screenWantsPlay = playing;
    if (offsetSeconds !== undefined && Number.isFinite(offsetSeconds)) {
      this.pendingScreenOffset = Math.max(0, offsetSeconds);
      this.screenSeekClock = performance.now();
    }
    this.syncScreenPlayback();
  }

  private syncScreenPlayback() {
    const video = this.customVideoEl;
    if (!video) return;
    const now = performance.now();
    if (this.pendingScreenOffset !== undefined && this.screenRunning) {
      this.pendingScreenOffset += (now - this.screenSeekClock) / 1000;
    }
    this.screenSeekClock = now;
    const led = this.currentState.led;
    // A bare {id:'main-led'} entry follows the rig; only a custom frame builds a wall on its own.
    const hasAuthoredPrimary = isCustomMainWall(this.screenLayout?.find(wall => wall.id === 'main-led'));
    const hasPrimary = hasAuthoredPrimary || !!this.currentRig?.ledWall.enabled;
    this.screenRunning = hasPrimary && led.enabled && led.visualMode === 'custom' && this.screenWantsPlay;
    if (video.readyState < 1) return;
    if (this.pendingScreenOffset !== undefined) {
      const offset = this.pendingScreenOffset;
      const target = Number.isFinite(video.duration) && video.duration > 0 ? offset % video.duration : offset;
      if (Math.abs(video.currentTime - target) > 0.015) {
        video.addEventListener('seeked', () => {
          if (this.customTex) this.customTex.needsUpdate = true;
        }, { once: true });
        video.currentTime = target;
      } else if (this.customTex) {
        this.customTex.needsUpdate = true;
      }
      this.pendingScreenOffset = undefined;
    }
    if (!this.screenRunning) {
      if (!video.paused) video.pause();
      this.videoPlayRequest = undefined;
    } else if (video.paused && !this.videoPlayRequest) {
      const play = video.play();
      this.videoPlayRequest = play;
      void play.catch(error => {
        if (this.customVideoEl !== video || this.videoPlayRequest !== play || error?.name === 'AbortError') return;
        this.screenWantsPlay = this.screenRunning = false;
        this.onMediaError?.('The LED video could not play. Try playing it again or choose another file.');
      }).finally(() => {
        if (this.videoPlayRequest === play) this.videoPlayRequest = undefined;
      });
    }
  }

  private updateCustomLedMedia(url: string | null, type: 'image' | 'video' | null) {
    const generation = ++this.mediaGeneration;
    this.lastCustomUrl = url;
    this.screenWantsPlay = true;
    this.screenRunning = false;
    this.pendingScreenOffset = undefined;
    this.videoPlayRequest = undefined;
    if (this.customVideoEl) {
      this.customVideoEl.pause();
      this.customVideoEl.removeAttribute('src');
      this.customVideoEl.load();
      this.customVideoEl = null;
    }
    if (this.customTex) {
      this.customTex.dispose();
      this.customTex = null;
    }
    this.bindScreenTexture();

    if (!url || !type) return;
    const failed = () => {
      if (generation !== this.mediaGeneration) return;
      this.updateCustomLedMedia(null, null);
      this.lastCustomUrl = url;
      this.onMediaError?.(`The LED wall could not open that ${type}. Choose another file.`);
    };

    if (type === 'video') {
      const video = document.createElement('video');
      this.customVideoEl = video;
      video.preload = 'auto';
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.addEventListener('error', failed, { once: true });
      video.addEventListener('loadedmetadata', () => {
        if (generation === this.mediaGeneration) this.syncScreenPlayback();
      }, { once: true });
      video.src = url;
      const vTex = new THREE.VideoTexture(video);
      vTex.colorSpace = THREE.SRGBColorSpace;
      this.customTex = vTex;
      this.bindScreenTexture();
    } else {
      new THREE.TextureLoader().load(url, (tex) => {
        if (generation !== this.mediaGeneration) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        this.customTex = tex;
        this.bindScreenTexture();
      }, undefined, failed);
    }
  }

  private releaseGroup(group: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const shared = new Set<THREE.Material>(Object.values(this.mats ?? {}));
    const sharedCache = this.modelCache?.sharedResources;
    group.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.geometry) return;
      if (
        !this.laserShapeGeometries.has(mesh.geometry) &&
        !sharedCache?.has(mesh.geometry) &&
        !this.bakedIlda?.ownsGeometry(mesh.geometry)
      ) {
        geometries.add(mesh.geometry);
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!shared.has(material) && !sharedCache?.has(material)) materials.add(material);
      }
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    group.clear();
  }

  private syncScenery(rig: RigConfig) {
    const props = rig.props ?? [];
    const desired = new Map(props.map(p => [p.id, p]));
    for (const [id, old] of this.scenicPieces) {
      if (desired.get(id)?.kind === old.kind && old.tier === this.renderTier) continue;
      old.root.removeFromParent();
      this.releaseGroup(old.root);
      this.scenicPieces.delete(id);
    }
    for (const [i, prop] of props.entries()) {
      let piece = this.scenicPieces.get(prop.id);
      if (!piece) {
        piece = {
          ...buildScenicPiece(prop, this.mats.fixtureBody, this.renderTier),
          kind: prop.kind,
          phase: i * 1.91,
          tier: this.renderTier,
        };
        this.scenicPieces.set(prop.id, piece);
        piece.root.name = PROP_CATALOG[prop.kind].label;
        piece.root.userData = { kind: prop.kind, id: prop.id, scenicProp: prop, scenicTier: this.renderTier };
        this.scene.add(piece.root);
      } else {
        piece.root.userData.scenicProp = prop;
      }
      piece.root.position.set(prop.x, stageSurfaceHeight(rig, prop.x, prop.z) + 0.003, prop.z);
      piece.root.rotation.y = THREE.MathUtils.degToRad(prop.rotation);
      piece.root.scale.setScalar(prop.scale);
      piece.fabric.color.set(prop.color);
      if (piece.lamps) {
        piece.lamps.color.set(prop.color);
        piece.lamps.emissive.set(prop.color);
      }
    }
  }

  public async exportCurrentStageGlb(): Promise<Blob> {
    if (!this.currentRig) throw new Error('There is no stage to export.');
    const roots = [...this.rigGroup.children, ...Array.from(this.scenicPieces.values(), piece => piece.root)];
    return exportStageGlb(this.currentRig, roots, this.mats);
  }

  public setStageScreens(walls?: StageScreen[]) {
    if (this.screenLayout === walls) return;
    this.screenLayout = walls;
    if (this.currentRig) this.neonFrame?.setLayout(this.currentRig, walls);
    const ids = new Set(walls?.filter(w => w.id !== 'main-led').map(w => w.id));
    for (const [id, player] of this.secondaryPlayers) {
      if (!ids.has(id)) { player.dispose(); this.secondaryPlayers.delete(id); }
    }
    for (const id of ids) {
      if (!this.secondaryPlayers.has(id)) {
        const player = new WallPlayer(id, this.textTex, this.onMediaError);
        player.setVideoSrgbDecode(
          resolveEffectiveLookOutput(this.renderSettings, this.renderTier, this.prefersReducedMotion).videoSrgbDecode,
        );
        this.secondaryPlayers.set(id, player);
      }
    }
  }

  public syncSecondaryScreens(states: Readonly<Record<string, SecondaryScreenState>>) {
    for (const [id, player] of this.secondaryPlayers) player.apply(Object.hasOwn(states, id) ? states[id] : undefined);
  }

  public screenDiagnostics() {
    return Array.from(this.secondaryPlayers.values(), player => player.diagnostics());
  }

  public hangDiagnostics() {
    const out: Array<{ name: string; position: [number, number, number]; cabinets: number; yaw: number; tilt: number; splay: number }> = [];
    this.rigGroup.traverse(obj => {
      if (obj.userData?.kind !== 'lineArray') return;
      out.push({
        name: obj.name,
        position: [obj.position.x, obj.position.y, obj.position.z],
        cabinets: Number(obj.userData.cabinets ?? 0),
        yaw: Number(obj.userData.yaw ?? 0),
        tilt: Number(obj.userData.tilt ?? 0),
        splay: Number(obj.userData.splay ?? 0),
      });
    });
    return out;
  }

  public rebuildRig(sourceRig: RigConfig, stage?: NativeStage) {
    this.lastRebuildSource = sourceRig;
    this.lastRebuildStage = stage;
    // Screen-event edits clone the stage; compare the physical layout by value so
    // they do not rebuild the rig, and reuse the resolved rig so identity checks hold.
    const layoutKey = JSON.stringify([stage?.layout ?? null, this.screenLayout ?? null]);
    const sameLayout = layoutKey === this.geometryKey;
    const geometry = sameLayout && this.geometrySource === sourceRig && this.geometryCache
      ? this.geometryCache : resolveStudioGeometry(sourceRig, stage?.layout);
    const { rig } = geometry;
    this.geometryKey = layoutKey;
    this.geometrySource = sourceRig;
    this.geometryCache = geometry;
    this.geometryLayout = stage?.layout;
    const old = this.currentRig;
    this.currentRig = rig;
    this.syncScreenPlayback();
    this.syncScenery(rig);
    if (sameLayout && old && old.stageWidth === rig.stageWidth && old.stageHeight === rig.stageHeight &&
      old.platforms === rig.platforms &&
      old.stageDepth === rig.stageDepth && old.venue === rig.venue && old.audioRig === rig.audioRig &&
      old.ledWall === rig.ledWall && old.trussPods === rig.trussPods && old.floorFx === rig.floorFx) return;
    this.beamPools?.dispose();
    this.measureSurfacesCache = null;
    this.measureReachCache = null;
    this.lastNohdKey = '';
    this.lastNohdZones = [];
    this.measureRigRevision++;
    this.lastMeasureTickMs = -Infinity;
    this.detachIldaMeshes();
    this.batcher?.clear();
    this.crowdLighting?.unbindVenue();
    this.releaseGroup(this.rigGroup);
    this.modelCache.beginRebuild();
    try {
    this.dmxUniverse1.fill(0);
    this.dmxUniverse2.fill(0);
    this.physicalDmxU1.fill(0);
    this.physicalDmxU2.fill(0);
    this.serialPhysicalDmxU1.fill(0);
    this.serialPhysicalDmxU2.fill(0);
    this.trussPods = [];
    this.movingFixtures = [];
    this.laserUnits = [];
    this.strobes = [];
    this.blinders = [];
    this.atmosphereDmx = [];
    const patch = buildDmxPatch(rig);
    this.ledWallMats = [];
    this.allLedMaterials = [];
    this.djStripMat = null;

    // 1. Venue architecture + animated arena crowd
    const venueBuild = buildVenueArchitecture(rig.venue, rig.audioRig.crowdDensity, this.mats, rig.stageWidth,
      rig.stageDepth, rig.stageHeight);
    venueBuild.group.userData.kind = 'venue';
    this.rigGroup.add(venueBuild.group);
    this.houseColors = venueBuild.practicals.map(material => ({ color: material.color, full: material.color.clone() }));
    this.crowdMesh = venueBuild.crowdMesh;
    this.crowdBaseTransforms = venueBuild.crowdBaseTransforms;
    this.crowdSeated = venueBuild.seated;
    this.crowdLighting?.bindVenue({
      crowdMesh: venueBuild.crowdMesh,
      phonesMesh: venueBuild.phonesMesh,
      transforms: venueBuild.crowdBaseTransforms,
      seated: venueBuild.seated,
      stageDepth: rig.stageDepth,
    });
    this.lastCrowdFrameInputs.stageWidth = rig.stageWidth;
    this.lastCrowdFrameInputs.stageDepth = rig.stageDepth;
    this.room = venueBuild.room;
    this.roofY = venueBuild.roofY;
    this.sideFills.forEach((light, i) => {
      const x = (i === 0 ? -1 : 1) * (rig.stageWidth / 2 + 1.35);
      light.position.set(x * 0.82, 8.0, rig.stageDepth / 2 + 8.5);
      light.target.position.set(x, Math.min(this.roofY - 2.3, 8.1), rig.stageDepth / 2);
    });

    // 2. Main Concert Stage Deck + Stairs + Edge Trim
    const stageGroup = new THREE.Group();
    stageGroup.name = 'Stage and PA';
    this.deckTrim = null;
    if (rig.platforms !== undefined) {
      const platforms = buildPlatformDeck(rig, this.mats);
      platforms.name = 'Platforms';
      platforms.userData.kind = 'platforms';
      stageGroup.add(platforms);
    } else {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(rig.stageWidth, rig.stageHeight, rig.stageDepth), this.mats.stageDeck);
      deck.position.y = rig.stageHeight / 2;
      deck.name = 'Main stage deck';
      stageGroup.add(deck);

      const frontTrim = new THREE.Mesh(new THREE.BoxGeometry(rig.stageWidth + 0.1, 0.14, 0.12), this.mats.aluminumTruss);
      frontTrim.position.set(0, rig.stageHeight - 0.06, rig.stageDepth / 2 + 0.04);
      frontTrim.name = 'Front deck trim';
      stageGroup.add(frontTrim);

      this.deckTrim = new THREE.MeshBasicMaterial();
      const edgeGlow = new THREE.Mesh(new THREE.BoxGeometry(rig.stageWidth - 0.6, 0.04, 0.04), this.deckTrim);
      edgeGlow.position.set(0, rig.stageHeight - 0.16, rig.stageDepth / 2 + 0.05);
      edgeGlow.name = 'Deck edge strip';
      stageGroup.add(edgeGlow);

      for (const side of [-1, 1]) {
        for (let s = 0; s < 4; s++) {
          const step = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 0.45), this.mats.darkSteel);
          step.name = `Stair ${side < 0 ? 'audience left' : 'audience right'} ${s + 1}`;
          step.position.set(side * (rig.stageWidth / 2 + 0.72), 0.18 + s * (rig.stageHeight / 4),
            rig.stageDepth / 2 - 1.2 - s * 0.45);
          stageGroup.add(step);
        }
      }
    }

    // DJ / Live Console Booth
    if (rig.audioRig.djBooth) {
      const dj = createDjBooth(this.mats);
      dj.group.name = 'DJ booth';
      dj.group.position.set(0, stageSurfaceHeight(rig, 0, 0.6), 0.6);
      stageGroup.add(dj.group);
      this.djStripMat = dj.stripMat;
    }

    // Hanging L-Acoustics Style Curved Line Arrays
    const speakerProfile = rig.audioRig.speakerProfile ?? 'touring';
    if (geometry.hangs) {
      for (const [index, hang] of geometry.hangs.entries()) {
        const array = createAuthoredLineArray(hang, this.mats, speakerProfile);
        array.name = `Speaker hang ${index + 1}`;
        stageGroup.add(array);
      }
    } else if (rig.audioRig.lineArrays) {
      const hangY = Math.min(this.roofY - 1.65, 11.65);
      for (const side of [-1, 1] as const) {
        const array = createLineArray(side, this.mats, rig.audioRig.boxesPerSide ?? 9, this.roofY - hangY, speakerProfile);
        array.name = `Line array — audience ${side < 0 ? 'left' : 'right'}`;
        array.userData = { kind: 'lineArray', model: SPEAKER_PROFILES[speakerProfile].array.label, cabinets: rig.audioRig.boxesPerSide ?? 9 };
        array.position.set(side * (rig.stageWidth / 2 + 1.35), hangY, rig.stageDepth / 2 - 0.4);
        stageGroup.add(array);
      }
    }

    geometry.props.forEach((prop, index) => stageGroup.add(createAuthoredProp(prop, index, rig, this.mats)));

    // Front-of-Stage Subwoofer Wall (SB28 twin-18" concert subs)
    if (rig.audioRig.subWall) {
      const count = Math.max(2, rig.audioRig.subCount);
      const sub = SPEAKER_PROFILES[speakerProfile].sub;
      const spacing = sub.width + 0.05;
      const cabinetsPerRow = Math.max(1, Math.floor((rig.stageWidth - 0.5) / spacing));
      const columns = Math.ceil(count / Math.ceil(count / cabinetsPerRow));
      for (let i = 0; i < count; i++) {
        const level = Math.floor(i / columns);
        const rowCount = Math.min(columns, count - level * columns);
        const sx = (i % columns - (rowCount - 1) / 2) * spacing;
        const subGroup = createSubwoofer(this.mats, speakerProfile);
        subGroup.name = `Subwoofer ${i + 1}`;
        subGroup.userData = { kind: 'subwoofer', model: SPEAKER_PROFILES[speakerProfile].sub.label };
        const sz = rig.stageDepth / 2 + sub.depth / 2 + 0.12;
        subGroup.position.set(sx, stageSurfaceHeight(rig, sx, sz) + (0.5 + level) * sub.height, sz);
        stageGroup.add(subGroup);
      }
    }

    for (const [i, { x, y, z, rotationY }] of monitorPositions(rig).entries()) {
      const wedge = createMonitorWedge(this.mats, speakerProfile);
      wedge.name = `Monitor wedge ${i + 1}`;
      wedge.userData = { kind: 'monitor', model: SPEAKER_PROFILES[speakerProfile].monitor.label };
      wedge.position.set(x, y, z);
      wedge.rotation.y = rotationY;
      stageGroup.add(wedge);
    }
    this.rigGroup.add(stageGroup);

    // 3. Giant Concert LED Video Wall + Side IMAG Wings + Authored Secondary Walls
    const wall = ledPlacement(rig);
    const authoredMain = this.screenLayout?.find(screen => screen.id === 'main-led');
    const hasCustomMain = isCustomMainWall(authoredMain);
    const buildAuthoredScreen = (screen: StageScreen, primary: boolean) => {
      const placement = resolveWallFrame(rig, screen);
      const { width, height } = placement;
      const surface = authoredWallSurface(rig, placement);
      const cabinetGrid = surface.cabinets;
      const material = this.createLedMaterial(surface, cabinetGrid);
      const mount = new THREE.Group();
      mount.position.set(placement.x, placement.y, placement.z);
      mount.rotation.y = THREE.MathUtils.degToRad(placement.yaw);
      mount.name = screen.label || screen.id;
      mount.userData = { kind: 'screen', screenId: screen.id, width, height, yaw: placement.yaw, ...(cabinetGrid ? {
        cabinetGrid: [surface.columns, surface.rows], canvasPixels: [surface.pixelsWide, surface.pixelsHigh] } : {}) };
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
      panel.name = 'LED surface ' + screen.id;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(width + 0.10, height + 0.10, 0.12), this.mats.darkSteel);
      frame.position.z = -0.075;
      mount.add(panel, frame);
      if (cabinetGrid) {
        const backs = this.createLedCabinetBacks(surface, -0.008);
        if (backs) mount.add(backs);
      }
      this.rigGroup.add(mount);
      if (primary) this.ledWallMats.push(material);
      else {
        material.uniforms.uMode.value = LED_MODE_INDEX.custom;
        material.uniforms.uBrightness.value = 0;
        this.secondaryPlayers.get(screen.id)?.bind(material);
      }
    };
    if (this.screenLayout?.length) {
      for (const screen of this.screenLayout) {
        if (screen.id !== 'main-led') buildAuthoredScreen(screen, false);
      }
    }
    if (hasCustomMain && authoredMain) {
      buildAuthoredScreen(authoredMain, true);
    } else if (rig.ledWall.enabled && wall.height > 0) {
      const { y: wallY, z: wallZ } = wall;
      const ledMat = this.createLedMaterial(wall, !!rig.ledWall.cabinets);
      const cabinetMetadata = (face: LedSurface) => rig.ledWall.cabinets ? {
        cabinetGrid: [face.columns, face.rows], canvasPixels: [face.pixelsWide, face.pixelsHigh],
      } : {};
      this.ledWallMats.push(ledMat);

      let wallGeo: THREE.BufferGeometry;
      if (rig.ledWall.curved) {
        // Gentle arena concave curve wrapping the upstage!
        // Keep the rack on the rear of the deck, behind the upstage truss.
        const radius = wall.width * 6;
        const thetaLen = wall.width / radius;
        wallGeo = new THREE.CylinderGeometry(
          radius,
          radius,
          wall.height,
          36,
          1,
          true,
          Math.PI - thetaLen / 2,
          thetaLen
        );
        // Flip UVs horizontally so text reads left-to-right from audience
        const uv = wallGeo.attributes.uv;
        for (let i = 0; i < uv.count; i++) {
          uv.setX(i, 1 - uv.getX(i));
        }
        const wallMesh = new THREE.Mesh(wallGeo, ledMat);
        wallMesh.material.side = THREE.BackSide;
        wallMesh.name = 'Curved LED wall';
        wallMesh.userData = cabinetMetadata(wall);
        wallMesh.position.set(wall.x, wallY, wallZ + radius);
        this.rigGroup.add(wallMesh);

        // A closed annular section forms the dark back, narrow bezel and end caps.
        const profile = new THREE.Shape();
        const halfArc = thetaLen / 2 + 0.10 / radius;
        const start = Math.PI / 2 - halfArc;
        const end = Math.PI / 2 + halfArc;
        profile.absarc(0, 0, radius + 0.035, start, end, false);
        profile.absarc(0, 0, radius + 0.29, end, start, true);
        profile.closePath();
        const housing = new THREE.Mesh(new THREE.ExtrudeGeometry(profile, {
          depth: wall.height + 0.20, bevelEnabled: false, curveSegments: 36,
        }), this.mats.darkSteel);
        housing.rotation.x = -Math.PI / 2;
        housing.name = 'Curved LED wall housing';
        housing.position.set(wall.x, wallY - wall.height / 2 - 0.10, wallMesh.position.z);
        this.rigGroup.add(housing);
      } else {
        wallGeo = new THREE.PlaneGeometry(wall.width, wall.height);
        const wallMesh = new THREE.Mesh(wallGeo, ledMat);
        wallMesh.position.set(wall.x, wallY, wallZ);
        wallMesh.name = 'LED wall';
        wallMesh.userData = cabinetMetadata(wall);
        this.rigGroup.add(wallMesh);

        if (rig.ledWall.cabinets) {
          const backs = this.createLedCabinetBacks(wall, -0.01);
          if (backs) {
            backs.position.set(wall.x, wallY, wallZ);
            this.rigGroup.add(backs);
          }
          // Slim structural spine behind instanced LED cabinets
          const spine = new THREE.Mesh(
            new THREE.BoxGeometry(wall.width + 0.14, wall.height + 0.14, 0.06),
            this.mats.darkSteel,
          );
          spine.position.set(wall.x, wallY, wallZ - 0.13);
          spine.name = 'LED wall housing';
          this.rigGroup.add(spine);
        } else {
          // Dark rear structural frame behind flat LED wall
          const frame = new THREE.Mesh(
            new THREE.BoxGeometry(wall.width + 0.5, wall.height + 0.5, 0.35),
            this.mats.darkSteel
          );
          frame.position.set(wall.x, wallY, wallZ - 0.22);
          frame.name = 'LED wall housing';
          this.rigGroup.add(frame);
        }
      }

      // Optional Side IMAG Wings flanking the main stage
      if (wall.wing.width > 0) {
        const { width: wingW, height: wingH } = wall.wing;
        const wingMat = this.createLedMaterial(wall.wing, !!rig.ledWall.cabinets);
        this.ledWallMats.push(wingMat);

        for (const side of [-1, 1]) {
          const wingGroup = new THREE.Group();
          wingGroup.name = `LED wing — audience ${side < 0 ? 'left' : 'right'}`;
          wingGroup.userData = cabinetMetadata(wall.wing);
          const screen = new THREE.Mesh(new THREE.PlaneGeometry(wingW, wingH), wingMat);
          const backing = new THREE.Mesh(
            new THREE.BoxGeometry(wingW + (rig.ledWall.cabinets ? 0.12 : 0.3), wingH + (rig.ledWall.cabinets ? 0.12 : 0.3), rig.ledWall.cabinets ? 0.06 : 0.26),
            this.mats.darkSteel
          );
          backing.position.z = rig.ledWall.cabinets ? -0.13 : -0.16;
          wingGroup.add(screen, backing);
          if (rig.ledWall.cabinets) {
            const wingBacks = this.createLedCabinetBacks(wall.wing, -0.01);
            if (wingBacks) wingGroup.add(wingBacks);
          }
          wingGroup.position.set(
            wall.x + side * (wall.width / 2 + wingW / 2 + wall.wingGap),
            wallY,
            wallZ + 2.2
          );
          wingGroup.rotation.y = side * -0.32;
          this.rigGroup.add(wingGroup);
        }
      }
    }

    // 4. Overhead Truss Pods + Kinetic Chain Hoist Motors + Mounted Fixtures
    let globalMovingIndex = 0;
    let globalLaserIndex = 0;
    let globalStrobeIndex = 0;

    rig.trussPods.forEach((pod) => {
      const podGroup = new THREE.Group();
      podGroup.name = pod.name;
      podGroup.userData = { kind: 'truss', id: pod.id, shape: pod.shape };
      podGroup.position.set(pod.x, pod.baseY, pod.z);
      podGroup.rotation.y = pod.rotationY;

      const fixtureCount = pod.fixtures.reduce((count, group) => count + group.count, 0);
      const built = buildTrussGeometry(
        pod.shape,
        pod.width,
        this.mats,
        pod.path,
        fixtureCount,
        pod.trussProfileId,
        pod.hoistCount,
      );
      built.group.name = 'Truss structure';
      podGroup.add(built.group);

      // Attach CM Lodestar / Kinesys Chain Hoist Motors at every anchor point
      const hoists: { anchorLocal: THREE.Vector3; chainMesh: THREE.Mesh; root: THREE.Group }[] = [];
      for (const anchor of built.anchorPoints) {
        const hoist = createChainHoistUnit(this.mats);
        hoist.root.name = `Chain hoist ${hoists.length + 1}`;
        hoist.root.position.copy(anchor);
        podGroup.add(hoist.root);
        hoists.push({ anchorLocal: anchor.clone(), chainMesh: hoist.chainMesh, root: hoist.root });
      }

      // Interleave fixture families across the same bar and preserve their DMX order.
      // Uses the same hungUnits + mountSlotIndex helpers as fixturePlacement (CAD and MVR exports).
      const hung = hungUnits(pod.fixtures);
      hung.forEach(({ group: fg, index: i }, position) => {
        const slotIdx = mountSlotIndex(position, hung.length, built.mountSlots.length);
        const slot = built.mountSlots[slotIdx];
        if (!slot) return;

        const start = patch.unitStart(fg, i);
        const width = groupFootprint(fg);
        const buffer = fg.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
        const physBuffer = fg.dmxUniverse === 1 ? this.physicalDmxU1 : this.physicalDmxU2;
        const physicalClass = classifyPhysicalGroup(fg);
        if (fg.type === 'beam' || fg.type === 'wash') {
          const lateral = slot.pos.x * Math.cos(pod.rotationY) + slot.pos.z * Math.sin(pod.rotationY);
          const inst = this.createMovingFixture(
            fg.type,
            fg.type,
            false,
            globalMovingIndex++,
            lateral / Math.max(2, pod.width / 2),
            fg.dmxUniverse,
            start,
            width,
            physicalClass,
            resolveOptics(fg),
            fg.catalogId,
            {
              unitId: `${pod.id}:${fg.id}:${i}`,
              fixtureNumber: globalMovingIndex,
              groupId: fg.id,
              podId: pod.id,
              positionName: pod.name,
              label: `${pod.name} · ${fg.modelName} #${i + 1}`,
              modelName: fg.modelName,
              configuredLumens: resolvedPhotometricLumens(fg),
            },
          );
          inst.root.position.copy(slot.pos);
          inst.root.rotation.y = slot.rotY;
          inst.mountYaw = pod.rotationY + slot.rotY;
          podGroup.add(nameFixtureUnit(inst.root, fg, i, start));
          this.movingFixtures.push(inst);
        } else if (fg.type === 'laser') {
          const laser = this.createLaserProjector(
            laserProjectorKey(pod.id, fg.id, i + 1), globalLaserIndex++,
            false,
            fg.dmxUniverse,
            start,
            width,
            physicalClass,
            fg.catalogId,
            fg.dmxMode
          );
          const drop = (laser.root.userData.mountOffsetY as number | undefined) ?? 0.22;
          laser.root.position.copy(slot.pos).add(new THREE.Vector3(0, -drop, 0.12));
          laser.root.rotation.y = pod.shape === 'circle' || pod.shape === 'path' ? -pod.rotationY : slot.rotY;
          podGroup.add(nameFixtureUnit(laser.root, fg, i, start));
          this.laserUnits.push(laser);
        } else if (fg.type === 'strobe') {
          const st = this.createStrobeBar(globalStrobeIndex++, fg.catalogId);
          const drop = (st.mesh.userData.mountOffsetY as number | undefined) ?? 0.20;
          st.mesh.position.copy(slot.pos);
          st.mesh.rotation.y = slot.rotY;
          st.mesh.translateY(-drop).translateZ(0.24);
          podGroup.add(nameFixtureUnit(st.mesh, fg, i, start));
          this.strobes.push({ lensMat: st.lensMat, index: st.index, buffer, physBuffer, start, width, physicalClass });
        } else if (fg.type === 'blinder') {
          const bl = this.createBlinderBank(fg.catalogId);
          const drop = (bl.group.userData.mountOffsetY as number | undefined) ?? 0.28;
          bl.group.position.copy(slot.pos);
          bl.group.rotation.y = slot.rotY;
          bl.group.translateY(-drop).translateZ(0.28);
          podGroup.add(nameFixtureUnit(bl.group, fg, i, start));
          this.blinders.push({ lensMat: bl.lensMat, buffer, physBuffer, start, width, physicalClass });
        }
      });

      this.rigGroup.add(podGroup);
      this.trussPods.push({
        config: pod,
        group: podGroup,
        currentY: pod.baseY,
        currentTiltZ: 0,
        currentTiltX: 0,
        hoists,
      });
    });

    // 5. Floor FX Hardware (Smoke Machines, Hazers, CO2 Cannons, Floor Lasers & Floor Beams)
    const smokeEmitters: THREE.Vector3[] = [];
    const co2Emitters: THREE.Vector3[] = [];

    for (const fx of rig.floorFx) {
      for (let i = 0; i < fx.count; i++) {
        const px = floorUnitX(fx, i);
        const pz = fx.z;
        const py = stageSurfaceHeight(rig, px, pz);

        const start = patch.unitStart(fx, i);
        const width = groupFootprint(fx);
        const physicalClass = classifyPhysicalGroup(fx);
        if (start && (fx.type === 'co2' || fx.type === 'smoke' || fx.type === 'hazer')) {
          this.atmosphereDmx.push({
            type: fx.type,
            start,
            width,
            buffer: fx.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2,
            physBuffer: fx.dmxUniverse === 1 ? this.physicalDmxU1 : this.physicalDmxU2,
            physicalClass,
          });
        }
        if (fx.type === 'co2') {
          const jet = this.createCo2JetUnit(fx.catalogId);
          jet.position.set(px, py, pz);
          this.rigGroup.add(nameFixtureUnit(jet, fx, i, start));
          co2Emitters.push(new THREE.Vector3(px, py + 0.38, pz));
        } else if (fx.type === 'smoke') {
          const sm = this.createSmokeMachineUnit(fx.catalogId);
          sm.position.set(px, py, pz);
          this.rigGroup.add(nameFixtureUnit(sm, fx, i, start));
          smokeEmitters.push(new THREE.Vector3(px, py + 0.32, pz));
        } else if (fx.type === 'hazer') {
          const hz = this.createHazerUnit(fx.catalogId);
          hz.position.set(px, py, pz);
          this.rigGroup.add(nameFixtureUnit(hz, fx, i, start));
        } else if (fx.type === 'floor_laser') {
          const fl = this.createLaserProjector(
            laserProjectorKey(null, fx.id, i + 1), globalLaserIndex++,
            true,
            fx.dmxUniverse,
            start,
            width,
            physicalClass,
            fx.catalogId,
            fx.dmxMode
          );
          const halfH = (fl.root.userData.bodyHeight as number | undefined ?? 0.28) / 2 + 0.02;
          fl.root.position.set(px, py + halfH, pz);
          this.rigGroup.add(nameFixtureUnit(fl.root, fx, i, start));
          this.laserUnits.push(fl);
        } else if (fx.type === 'floor_beam') {
          const fb = this.createMovingFixture(
            'beam',
            'floor_beam',
            true,
            globalMovingIndex++,
            px / Math.max(2, rig.stageWidth / 2),
            fx.dmxUniverse,
            start,
            width,
            physicalClass,
            resolveOptics(fx),
            fx.catalogId,
            {
              unitId: `floor:${fx.id}:${i}`,
              fixtureNumber: globalMovingIndex,
              groupId: fx.id,
              podId: null,
              positionName: 'Stage floor',
              label: `Floor · ${fx.modelName} #${i + 1}`,
              modelName: fx.modelName,
              configuredLumens: resolvedPhotometricLumens(fx),
            },
          );
          fb.root.position.set(px, py, pz);
          this.rigGroup.add(nameFixtureUnit(fb.root, fx, i, start));
          this.movingFixtures.push(fb);
        }
      }
    }

    this.assignOpeningGroups(rig.stageWidth);
    this.laserSpeedPhaseOffsets = new Array(this.laserUnits.length).fill(0);
    this.laserRotPhaseOffsets = new Array(this.laserUnits.length).fill(0);
    if (this.activeIldaClip) this.attachIldaToLaserUnits();
    this.particles.setEmitters(smokeEmitters, co2Emitters, rig.stageHeight);
    this.rebuildBeamPools(false);
    this.spillFluxGain = this.movingFixtures.reduce((total, fx) => total + fx.optics.fluxRatio, 0)
      / Math.max(1, this.movingFixtures.length);
    if ((old && old.venue !== rig.venue) || (this.activeView === 'foh' && this.fitFohOnResize) || this.activeView === 'pa_closeup') {
      this.setCameraPreset(this.activeView);
    }
    this.batcher?.rebuild(this.rigGroup);
    this.neonFrame.setLayout(rig, this.screenLayout);
    this.neonFrame.setPalette(this.currentState.primaryColor, this.currentState.accentColor);
    this.neonFrame.setPolicy(this.renderSettings.lookNeonFrame, this.renderSettings.trueColour);
    if (this.crowdLighting?.isActive()) {
      this.syncCrowdLightingFromCommittedState();
    }
    } finally {
      this.modelCache.endRebuild();
    }
  }

  private assignOpeningGroups(stageWidth: number) {
    // Choose the first two lanterns by mounting position so custom patches keep their symmetry.
    const fixtures = this.movingFixtures.map(fx => ({ fx, at: fx.root.getWorldPosition(new THREE.Vector3()) }));
    const beams = fixtures.filter(({ fx }) => fx.type === 'beam');
    const overhead = beams.filter(({ fx }) => !fx.isFloor);
    const candidates = [...(overhead.length >= 2 ? overhead : beams.length ? beams : fixtures)];
    const upstage = Math.min(...candidates.map(({ at }) => at.z));
    const pair = new Set<MovingFixtureInstance>();
    for (const side of [-1, 1]) {
      const targetX = side * stageWidth * 0.20;
      const distance = (at: THREE.Vector3) => 3 * Math.abs(at.z - upstage) + Math.abs(at.x - targetX);
      candidates.sort((a, b) => distance(a.at) - distance(b.at));
      const next = candidates.shift();
      if (next) {
        next.fx.openingStep = DEMO_BLACKOUT_STEPS;
        pair.add(next.fx);
      }
    }
    for (const type of ['beam', 'wash'] as const) {
      const rest = fixtures.filter(({ fx }) => fx.type === type && !pair.has(fx));
      rest.sort((a, b) => a.at.z - b.at.z || Math.abs(a.at.x) - Math.abs(b.at.x));
      const start = type === 'beam' ? 64 : 96;
      const span = type === 'beam' ? 40 : 16;
      const lastPair = Math.max(1, Math.floor((rest.length - 1) / 2));
      rest.forEach(({ fx }, i) => { fx.openingStep = start + span * Math.floor(i / 2) / lastPair; });
    }
  }

  private createLedMaterial(surface: LedSurface, useCabinets: boolean): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      name: LED_DISPLAY_MATERIAL_NAME,
      defines: this.renderSettings.ledAngularResponse ? { [LED_ANGULAR_DEFINE]: 1 } : {},
      vertexShader: LED_WALL_VERT,
      fragmentShader: LED_WALL_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPhaseOffset: { value: 0 },
        uMode: { value: 0 },
        uBrightness: { value: 0.85 },
        uSpeed: { value: 0.5 },
        uColorA: { value: new THREE.Color(0x00f0ff) },
        uColorB: { value: new THREE.Color(0xff00aa) },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uBeatPulse: { value: 0 },
        uCustomTex: { value: this.customTex ?? this.missingScreenTex ?? this.textTex },
        uTextTex: { value: this.textTex },
        uHasCustom: { value: (this.customTex || this.missingScreenTex) ? 1 : 0 },
        uCustomTexDecode: {
          value: (
            this.customTex &&
            this.customVideoEl &&
            resolveEffectiveLookOutput(this.renderSettings, this.renderTier, this.prefersReducedMotion).videoSrgbDecode
          ) ? 1.0 : 0.0,
        },
        uFlashLimited: { value: this.effectiveFullRateStrobe ? 0.0 : 1.0 },
        uAspect: { value: surface.width / surface.height },
        uCanvasPixels: { value: new THREE.Vector2(surface.pixelsWide, surface.pixelsHigh) },
        uCabinetGrid: { value: new THREE.Vector2(surface.columns, surface.rows) },
        uPixelSnap: { value: useCabinets },
      },
    });
    this.allLedMaterials.push(material);
    return material;
  }

  private createLedCabinetBacks(surface: LedSurface, zOffset: number): THREE.InstancedMesh | null {
    const cols = surface.columns;
    const rows = surface.rows;
    const count = cols * rows;
    if (count <= 0 || count > 4096) return null;
    const tileW = surface.width / cols;
    const tileH = surface.height / rows;
    if (tileW <= 0.02 || tileH <= 0.02) return null;

    const backGeo = this.modelCache.getLedCabinetBack(tileW, tileH);
    const mesh = new THREE.InstancedMesh(backGeo, this.mats.hardwareBody, count);
    mesh.name = 'LED cabinet backs';
    mesh.userData = { kind: 'ledCabinetBacks', columns: cols, rows };
    const matrix = new THREE.Matrix4();
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      const cy = -surface.height / 2 + (r + 0.5) * tileH;
      for (let c = 0; c < cols; c++) {
        const cx = -surface.width / 2 + (c + 0.5) * tileW;
        matrix.makeTranslation(cx, cy, zOffset);
        mesh.setMatrixAt(idx++, matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private createMovingFixture(
    type: 'beam' | 'wash',
    hardwareType: 'beam' | 'wash' | 'floor_beam',
    isFloor: boolean,
    index: number,
    fanPosition: number,
    dmxUniverse: 1 | 2,
    dmxStart: number,
    dmxWidth: number,
    physicalClass: PhysicalGroupClassification,
    profile?: FixtureOptics,
    catalogId?: string,
    meta?: {
      unitId: string;
      fixtureNumber: number;
      groupId: string;
      podId: string | null;
      positionName: string;
      label: string;
      modelName: string;
      configuredLumens: number | null;
    },
  ): MovingFixtureInstance {
    const root = new THREE.Group();
    const dir = isFloor ? 1 : -1;
    const parts = this.modelCache.getMoving(hardwareType, catalogId, isFloor);
    root.userData.pivotY = parts.spec.pivotY;
    root.userData.motion = parts.spec.motion;

    // Base housing + separate clamp (hung) or rubber feet (floor)
    const base = new THREE.Mesh(parts.baseGeo, this.mats.hardwareBody);
    base.name = 'Base housing';
    const mount = new THREE.Mesh(parts.mountGeo, this.mats.hardwareBody);
    mount.name = isFloor ? 'Rubber feet' : 'Truss clamp';
    root.add(base, mount);

    // Pan Yoke
    const yoke = new THREE.Group();
    yoke.name = 'Pan yoke';
    yoke.position.y = dir * parts.yokeY;
    root.add(yoke);

    const yokeMesh = new THREE.Mesh(parts.yokeGeo, this.mats.hardwareBody);
    yokeMesh.name = 'Yoke arms';
    yoke.add(yokeMesh);

    // Tilt Head (origin sits strictly on the tilt axis at dir * parts.spec.pivotY from root)
    const head = new THREE.Group();
    head.name = 'Tilt head';
    head.position.y = dir * parts.headY;
    yoke.add(head);

    const headBody = new THREE.Mesh(parts.headGeo, this.mats.hardwareBody);
    headBody.name = 'Head housing';
    const headGlass = new THREE.Mesh(parts.glassGeo, this.mats.hardwareGlass);
    headGlass.name = 'Lens bezel';
    head.add(headBody, headGlass);

    // Per-fixture glowing optical lens on emission end (never shared across units)
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
    const lensGeo = parts.lensShape.kind === 'rect'
      ? new THREE.PlaneGeometry(parts.lensShape.width, parts.lensShape.height)
      : new THREE.CircleGeometry(parts.lensShape.radius, 16);
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.name = 'Optical lens';
    lens.position.y = dir * (parts.lensOffsetY + 0.005);
    lens.rotation.x = isFloor ? -Math.PI / 2 : Math.PI / 2;
    head.add(lens);

    // Volumetric Light Cone (origin right at lens face, extending along `dir * Y`)
    const optics = fixtureOptics(type, profile);
    const { length: beamLen, nearRadius: topR, farRadius: botR } = optics;
    const beamGeo = new THREE.CylinderGeometry(
      isFloor ? botR : topR,
      isFloor ? topR : botR,
      beamLen,
      20,
      1,
      true
    );
    // Shift so aperture sits on the lens face and beam shoots along `dir * Y`
    beamGeo.translate(0, dir * (beamLen / 2 + parts.lensOffsetY), 0);
    if (isFloor) {
      // Flip uv.y so uv.y = 1 is ALWAYS at lens aperture for shader consistency!
      const uv = beamGeo.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        uv.setY(i, 1 - uv.getY(i));
      }
    }

    const beamMat = new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_BEAM_VERT,
      fragmentShader: VOLUMETRIC_BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uLensOffset: { value: parts.lensOffsetY },
        uColor: { value: new THREE.Color(0x00f0ff) },
        uIntensity: { value: 0.8 },
        uHaze: { value: 0.78 },
        uTime: { value: 0 },
        uPrism: { value: 0 },
        uSoftness: { value: type === 'wash' ? 2.4 : 1.55 },
        uSeed: { value: index * 0.731 },
      },
    });
    beamMat.userData.instancedVariant = VOLUMETRIC_BEAM_VARIANT;

    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.userData.lensOffsetY = parts.lensOffsetY;
    beamMesh.frustumCulled = false;
    head.add(beamMesh);

    const unitId = meta?.unitId ?? `head:${index}`;
    return {
      unitId,
      fixtureNumber: meta?.fixtureNumber ?? index + 1,
      groupId: meta?.groupId ?? `group:${index}`,
      podId: meta?.podId ?? null,
      positionName: meta?.positionName ?? (isFloor ? 'Stage floor' : 'Truss'),
      label: meta?.label ?? `${type} #${index + 1}`,
      modelName: meta?.modelName ?? type,
      type,
      optics,
      configuredLumens: meta?.configuredLumens ?? null,
      lensOffsetY: parts.lensOffsetY,
      appliedDimmer: 0,
      lastZoomScale: 1,
      lastPoolIntensity: 0,
      lastPreviewIntensity: 0,
      lastPreviewR: 0,
      lastPreviewG: 0,
      lastPreviewB: 0,
      lastWorldX: 0,
      lastWorldY: 8.5,
      lastWorldZ: 0,
      lastAimX: 0,
      lastAimY: isFloor ? 1 : -1,
      lastAimZ: 0,
      isFloor,
      index,
      fanPosition,
      openingStep: DEMO_BLACKOUT_STEPS,
      directedDimmer: 0,
      pivotY: parts.spec.pivotY,
      motion: parts.spec.motion,
      root,
      yoke,
      head,
      lensMat,
      beamMesh,
      beamMat,
      mountYaw: 0,
      currentPan: 0,
      currentTilt: 0,
      dmxUniverse,
      dmxStart,
      dmxWidth,
      physicalClass,
      previewRgbGov: getOrCreatePreviewFixtureGov(this.previewFlashState, unitId),
      physRgbGov: getOrCreateUnitRgbGov(this.audioModState, unitId),
    };
  }

  private laserShape(segments: LaserResolution) {
    let shapes = this.laserShapes.get(segments);
    if (!shapes) {
      shapes = laserGeometry(segments);
      this.laserShapes.set(segments, shapes);
      this.laserShapeGeometries.add(shapes.sheet);
      this.laserShapeGeometries.add(shapes.cone);
    }
    return shapes;
  }

  private createLaserProjector(
    key: string,
    index: number,
    isFloor: boolean,
    dmxUniverse: 1 | 2,
    dmxStart: number,
    dmxWidth: number,
    physicalClass: PhysicalGroupClassification,
    catalogId?: string,
    dmxMode?: string
  ): LaserUnitInstance {
    const entry = getCatalogEntry(catalogId);
    const laserSpec = entry?.laser;
    const singleColor = laserSpec?.colorType === 'single'
      ? new THREE.Color(laserSpec.singleColorHex ?? '#00ff3c')
      : undefined;
    const resolvedMode = entry ? getCatalogMode(entry, dmxMode) : undefined;
    const root = new THREE.Group();
    // Apply pitch (X) in the projector's own forward plane after yaw (Y), matching laserSafety.ts.
    root.rotation.order = 'YXZ';
    const parts = this.modelCache.getStatic(isFloor ? 'floor_laser' : 'laser', catalogId, isFloor);
    root.userData.bodyHeight = parts.spec.base.h;
    root.userData.mountOffsetY = parts.mountOffsetY;

    const body = new THREE.Mesh(parts.bodyGeo, this.mats.hardwareBody);
    body.name = 'Laser chassis';
    root.add(body);
    if (parts.glassGeo) {
      const bezel = new THREE.Mesh(parts.glassGeo, this.mats.hardwareGlass);
      bezel.name = 'Aperture bezel';
      root.add(bezel);
    }

    const apertureMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
    const apertureSpec = parts.lenses[0];
    const aperture = new THREE.Mesh(
      new THREE.PlaneGeometry(
        apertureSpec && apertureSpec.kind === 'rect' ? apertureSpec.w : 0.16,
        apertureSpec && apertureSpec.kind === 'rect' ? apertureSpec.h : 0.055,
      ),
      apertureMat,
    );
    aperture.name = 'Laser aperture';
    aperture.position.set(0, 0, apertureSpec ? apertureSpec.z : 0.305);
    root.add(aperture);

    const { sheet: sheetGeo, cone: coneGeo } = this.laserShape(DEFAULT_LASER_RESOLUTION);
    const sheetMat = new THREE.ShaderMaterial({
      vertexShader: LASER_SHEET_VERT,
      fragmentShader: LASER_SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uColorA: { value: new THREE.Color(0x00f0ff) },
        uColorB: { value: new THREE.Color(0xff00aa) },
        uColorMode: { value: 1 },
        uIntensity: { value: 0.9 },
        uHaze: { value: 0.8 },
        uTime: { value: 0 },
        uPhaseOffset: { value: 0 },
        uPattern: { value: 0 },
        uBeamCount: { value: 18 },
        uSpeed: { value: 0.5 },
        uSpreadX: { value: 0.8 },
        uSpreadY: { value: 0.45 },
        uStrobe: { value: 0 },
        uAudioPulse: { value: 0 },
        uSeed: { value: index * 1.13 },
      },
    });
    const sheetMesh = new THREE.Mesh(sheetGeo, sheetMat);
    sheetMesh.frustumCulled = false;
    root.add(sheetMesh);

    const makeConeMat = (seedOffset: number) =>
      new THREE.ShaderMaterial({
        vertexShader: LASER_CONE_VERT,
        fragmentShader: LASER_CONE_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uColorA: { value: new THREE.Color(0x00ff66) },
          uColorB: { value: new THREE.Color(0x00aaff) },
          uColorMode: { value: 1 },
          uIntensity: { value: 0.9 },
          uHaze: { value: 0.8 },
          uTime: { value: 0 },
          uPhaseOffset: { value: 0 },
          uRotOffset: { value: 0 },
          uBeamCount: { value: 20 },
          uSpeed: { value: 0.5 },
          uSpreadX: { value: 0.78 },
          uSpreadY: { value: 0.72 },
          uRotation: { value: 0.5 },
          uStrobe: { value: 0 },
          uAudioPulse: { value: 0 },
          uSeed: { value: index * 0.91 + seedOffset },
        },
      });

    const coneMat = makeConeMat(0);
    const coneMesh = new THREE.Mesh(coneGeo, coneMat);
    coneMesh.frustumCulled = false;
    coneMesh.visible = false;
    root.add(coneMesh);

    const innerConeMat = makeConeMat(3.7);
    const innerConeMesh = new THREE.Mesh(coneGeo, innerConeMat);
    innerConeMesh.scale.set(0.55, 0.55, 1.0);
    innerConeMesh.frustumCulled = false;
    innerConeMesh.visible = false;
    root.add(innerConeMesh);

    return {
      key,
      index,
      isFloor,
      root,
      apertureMat,
      sheetMesh,
      sheetMat,
      coneMesh,
      coneMat,
      innerConeMesh,
      innerConeMat,
      catalogId,
      dmxMode,
      laserSpec,
      singleColor,
      resolvedMode,
      dmxScratch: [],
      dmxUniverse,
      dmxStart,
      dmxWidth,
      physicalClass,
      previewLaserGov: getOrCreatePreviewLaserGov(this.previewFlashState, key),
      physRgbGov: getOrCreateUnitRgbGov(this.audioModState, `laser:${key}`),
    };
  }

  private createStrobeBar(index: number, catalogId?: string) {
    const group = new THREE.Group();
    const parts = this.modelCache.getStatic('strobe', catalogId, false);
    group.userData.mountOffsetY = parts.mountOffsetY;
    const housing = new THREE.Mesh(parts.bodyGeo, this.mats.hardwareBody);
    housing.name = 'Strobe housing';
    group.add(housing);
    if (parts.glassGeo) {
      const bezel = new THREE.Mesh(parts.glassGeo, this.mats.hardwareGlass);
      bezel.name = 'Strobe bezel';
      group.add(bezel);
    }
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    for (const [i, lens] of parts.lenses.entries()) {
      if (lens.kind !== 'rect') continue;
      const tube = new THREE.Mesh(new THREE.PlaneGeometry(lens.w, lens.h), lensMat);
      tube.name = i === 0 ? 'Strobe tube' : `Strobe plate ${i}`;
      tube.position.set(lens.x, lens.y, lens.z);
      group.add(tube);
    }
    return { mesh: group, lensMat, index };
  }

  private createBlinderBank(catalogId?: string) {
    const group = new THREE.Group();
    const parts = this.modelCache.getStatic('blinder', catalogId, false);
    group.userData.mountOffsetY = parts.mountOffsetY;
    const housing = new THREE.Mesh(parts.bodyGeo, this.mats.hardwareBody);
    housing.name = 'Blinder housing';
    group.add(housing);
    if (parts.glassGeo) {
      const reflectors = new THREE.Mesh(parts.glassGeo, this.mats.hardwareGlass);
      reflectors.name = 'Blinder reflectors';
      group.add(reflectors);
    }
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x181208 });
    for (const [i, lens] of parts.lenses.entries()) {
      if (lens.kind !== 'circle') continue;
      const pod = new THREE.Mesh(new THREE.CircleGeometry(lens.r, 14), lensMat);
      pod.name = `Blinder lamp ${i + 1}`;
      pod.position.set(lens.x, lens.y, lens.z);
      group.add(pod);
    }
    return { group, lensMat };
  }

  private createCo2JetUnit(catalogId?: string): THREE.Group {
    const g = new THREE.Group();
    const parts = this.modelCache.getStatic('co2', catalogId, true);
    const mesh = new THREE.Mesh(parts.bodyGeo, this.mats.hardwareBody);
    mesh.name = 'CO2 jet body';
    g.add(mesh);
    return g;
  }

  private createSmokeMachineUnit(catalogId?: string): THREE.Group {
    const g = new THREE.Group();
    const parts = this.modelCache.getStatic('smoke', catalogId, true);
    const mesh = new THREE.Mesh(parts.bodyGeo, this.mats.hardwareBody);
    mesh.name = 'Fogger chassis';
    g.add(mesh);
    return g;
  }

  private createHazerUnit(catalogId?: string): THREE.Group {
    const g = new THREE.Group();
    const parts = this.modelCache.getStatic('hazer', catalogId, true);
    const mesh = new THREE.Mesh(parts.bodyGeo, this.mats.hardwareBody);
    mesh.name = 'Hazer chassis';
    g.add(mesh);
    return g;
  }

  /**
   * Allocation-free laser color resolution honoring single-color diode hardware constraints.
   */
  private applyLaserColors(
    singleColor: THREE.Color | undefined,
    mode: LaserColorMode,
    primary: THREE.Color,
    accent: THREE.Color,
    colorA: string | undefined,
    colorB: string | undefined,
    a: THREE.Color,
    b: THREE.Color,
  ): 0 | 1 | 2 {
    if (singleColor) {
      a.copy(singleColor);
      b.copy(singleColor);
      return 0;
    }
    switch (mode) {
      case 'custom':
        a.set(colorA ?? DEFAULT_LASER_COLORS[0]);
        b.copy(a);
        return 0;
      case 'custom_dual':
        a.set(colorA ?? DEFAULT_LASER_COLORS[0]);
        b.set(colorB ?? DEFAULT_LASER_COLORS[1]);
        return 1;
      case 'primary': a.copy(primary); b.copy(primary); return 0;
      case 'dual': a.copy(primary); b.copy(accent); return 1;
      case 'rainbow': a.copy(primary); b.copy(accent); return 2;
      case 'cyan_magenta': a.setHex(0x00f0ff); b.setHex(0xff00aa); return 1;
      case 'emerald_gold': a.setHex(0x00ff66); b.setHex(0xffcc00); return 1;
      case 'crimson_ice': a.setHex(0xff0044); b.setHex(0x55d8ff); return 1;
    }
  }

  public isContextLost(): boolean {
    const gl = this.renderer?.getContext?.();
    const glLost = typeof gl?.isContextLost === 'function' ? gl.isContextLost() : false;
    return this.contextLost || glLost;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  /** Live control-loop health snapshot inspected by `useLiveDmxOutput` before renewing DMX heartbeats. */
  public getControlLoopHealth(): {
    seq: number;
    lastTickMs: number;
    standby: boolean;
    contextLost: boolean;
    disposed: boolean;
  } {
    return {
      seq: this.controlLoopSeq,
      lastTickMs: this.lastControlTickMs,
      standby: this.standby,
      contextLost: this.isContextLost(),
      disposed: this.disposed,
    };
  }

  /**
   * Test-only hook (`?probe`): deterministically simulate WebGL context loss/restore across SwiftShader
   * and headless Chromium without relying on driver-specific `WEBGL_lose_context` timing.
   */
  public simulateContextLossForTest(lost: boolean): void {
    if (lost) {
      if (this.contextLost) return;
      this.contextLost = true;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      this.stopControlFallbackTimer();
      this.gpuTimer?.onContextLost();
      if (this.profiler) {
        const p = this.profiler;
        this.profiler = null;
        this.batcher?.setSyncObserver(null);
        p.finish(this.gpuTimer);
      }
      this.onContextLossChange?.(true);
    } else {
      if (!this.contextLost) return;
      this.contextLost = false;
      if (this.gpuTimer) {
        this.gpuTimer.onContextRestored(this.renderer.getContext());
      } else {
        this.gpuTimer = new GpuTimerRing(this.renderer.getContext());
      }
      this.updateTourTextTexture(this.lastTourText);
      this.deckSheen?.onContextRestored(this.mats?.stageDeck);
      this.scene.environment = this.environmentTarget.texture;
      this.neonFrame?.onContextRestored();
      this.crowdLighting?.onContextRestored();
      this.particles?.onContextRestored();
      this.bakedIlda?.onContextRestored();
      if (this.currentRig && this.beamPools) this.rebuildBeamPools(true);
      this.onContextLossChange?.(false);
      if (!this.disposed && !this.webXrLease && this.rafId === null) this.startLoop();
    }
  }

  /**
   * A real WebGL context loss destroys PMREM contents even though Three.js retains the texture
   * wrapper. Dispose that invalid target before rebuilding the same construction plan into the
   * single StageEngine-owned environment slot, so two persistent environments never coexist.
   */
  private restoreStageEnvironment(wetDeckOverride?: boolean): void {
    const previousBuildCount = this.wetDeckEnvironmentStats.buildCount;
    const wetDeck = wetDeckOverride ?? this.wetDeckEnvironmentStats.composition === 'wet-neutral';
    this.scene.environment = null;
    this.environmentTarget.dispose();
    const environment = buildStageEnvironment(this.renderer, wetDeck);
    this.environmentTarget = environment.target;
    this.wetDeckEnvironmentStats = {
      ...environment.stats,
      buildCount: previousBuildCount + 1,
    };
    this.scene.environment = this.environmentTarget.texture;
  }

  private stopControlFallbackTimer() {
    if (this.controlTimerId !== null) {
      clearInterval(this.controlTimerId);
      this.controlTimerId = null;
    }
  }

  private startControlFallbackTimer() {
    this.stopControlFallbackTimer();
    if (this.disposed || this.isContextLost() || !this.dmxFrameListener) return;
    this.controlTimerId = setInterval(() => {
      if (this.disposed || this.isContextLost() || !this.dmxFrameListener) {
        this.stopControlFallbackTimer();
        return;
      }
      const now = performance.now();
      // Step simulation & DMX emission without WebGL rendering whenever rAF is throttled/occluded (> 100 ms).
      if (now - this.lastRafTickMs > 100) {
        this.runControlTick(now, false);
      }
    }, 33);
  }

  /**
   * Register or clear the live DMX output frame listener.
   * Only active while live DMX output is enabled; pushes changed universe buffers at <= 44 Hz
   * without touching React state, exits `standby`, and arms a ~33 ms non-rendering fallback timer
   * so backgrounded/occluded windows continue advancing blackout, bumps, and cues cleanly.
   */
  public setDmxFrameListener(
    listener?: (
      u1: Uint8Array,
      u2: Uint8Array,
      u1Changed: boolean,
      u2Changed: boolean,
      serialU1: Uint8Array,
      serialU2: Uint8Array,
    ) => void
  ) {
    if (listener && (this.webXrLease || this.webXrPhysicalOutputInterlock)) {
      // Renderer-level safety authority: never emit physical frames while XR owns the camera/loop.
      this.dmxFrameListener = undefined;
      this.stopControlFallbackTimer();
      return;
    }
    this.dmxFrameListener = listener;
    this.dmxAccum = 0;
    if (!listener) {
      this.stopControlFallbackTimer();
      return;
    }
    this.previewRig();
    if (!this.disposed && !this.isContextLost() && this.controlLoopSeq === 0) {
      this.runControlTick(performance.now(), false);
    }
    this.lastDmxU1.set(this.physicalDmxU1);
    this.lastDmxU2.set(this.physicalDmxU2);
    listener(
      this.physicalDmxU1,
      this.physicalDmxU2,
      true,
      true,
      this.serialPhysicalDmxU1,
      this.serialPhysicalDmxU2,
    );
    this.startControlFallbackTimer();
  }

  private pushDmxFrame(dt: number) {
    const listener = this.dmxFrameListener;
    if (!listener) return;
    const period = 1 / 44;
    this.dmxAccum = Math.min(period * 2, this.dmxAccum + dt);
    if (this.dmxAccum < period) return;
    this.dmxAccum -= period;

    let u1Changed = false;
    let u2Changed = false;
    for (let i = 0; i < 512; i++) {
      if (this.physicalDmxU1[i] !== this.lastDmxU1[i]) {
        u1Changed = true;
        break;
      }
    }
    for (let i = 0; i < 512; i++) {
      if (this.physicalDmxU2[i] !== this.lastDmxU2[i]) {
        u2Changed = true;
        break;
      }
    }
    if (!u1Changed && !u2Changed) return;
    if (u1Changed) this.lastDmxU1.set(this.physicalDmxU1);
    if (u2Changed) this.lastDmxU2.set(this.physicalDmxU2);
    listener(
      this.physicalDmxU1,
      this.physicalDmxU2,
      u1Changed,
      u2Changed,
      this.serialPhysicalDmxU1,
      this.serialPhysicalDmxU2,
    );
  }

  private runControlTick(now: number, allowRender: boolean, renderMode: 'composer' | 'xr' = 'composer') {
    if (this.disposed || this.isContextLost()) return;
    const elapsed = this.lastFrameTime ? Math.max(0, (now - this.lastFrameTime) / 1000) : 1 / 60;
    this.lastFrameTime = now;
    const dt = Math.min(0.08, elapsed);
    // Audio analysis, envelopes, and the <= 3/s flash timer track real elapsed time (capped at 0.5 s across tab stalls).
    const audioDt = Math.min(0.5, Math.max(0, elapsed));
    this.elapsed += dt;

    if (allowRender) {
      this.frameCounter++;
      this.fpsAccum += elapsed;
      if (this.fpsAccum >= 0.5) {
        this.currentFps = Math.round(this.frameCounter / this.fpsAccum);
        this.frameCounter = 0;
        this.fpsAccum = 0;
      }
    }

    const prof = allowRender ? this.profiler : null;
    const recordGpu = Boolean(prof && this.profilerUseGpu && prof.isRecording());
    if (prof) {
      prof.beginFrame(performance.now());
      if (this.profilerUseGpu) {
        this.gpuTimer?.poll((gpuMs) => prof.recordGpuSample(gpuMs));
      }
    }

    const audio = this.audioGetter(audioDt);
    if (allowRender) {
      this.renderer.info.reset();
    }
    const simStart = prof ? performance.now() : 0;
    const shouldRenderScene = this.updateScene(dt, audio, audioDt);
    if (prof) {
      // Subtract crowd and particle sub-phases so simMs does not double-count them.
      prof.curSimMs = Math.max(0, performance.now() - simStart - prof.curCrowdMs - prof.curParticlesMs);
    }

    // Control-loop liveness & DMX emission run independently of WebGL rendering and dark/blackout scenes.
    if (!this.standby && !this.disposed && !this.isContextLost()) {
      this.controlLoopSeq++;
      this.lastControlTickMs = performance.now();
      this.pushDmxFrame(dt);
    }

    if (allowRender) {
      const renderStart = prof ? performance.now() : 0;
      const gpuStarted = recordGpu && shouldRenderScene ? (this.gpuTimer?.beginFrame() ?? false) : false;
      try {
        if (shouldRenderScene) {
          if (renderMode === 'xr') this.renderer.render(this.scene, this.camera);
          else this.composer.render();
        }
        else this.clearStage();
      } finally {
        if (gpuStarted) this.gpuTimer?.endFrame();
      }
      if (prof) {
        // batchSyncMs ran inside Scene.onBeforeRender during composer.render(); subtract to avoid double-counting.
        prof.curRenderSubmitMs = Math.max(0, performance.now() - renderStart - prof.curBatchSyncMs);
        prof.curUploadBytes += this.particles.getStats().uploadBytes;
        const done = prof.endFrame(
          performance.now(),
          this.renderer.info.render.calls,
          this.renderer.info.render.triangles,
          this.profilerUseGpu ? this.gpuTimer : null,
        );
        if (done) {
          this.profiler = null;
          this.batcher?.setSyncObserver(null);
          if (this.profilerUseGpu) this.gpuTimer?.clearPending();
        }
      }
    }

    this.telemetryAccum += dt;
    if (this.onFrameTelemetry && this.telemetryAccum >= 0.05) {
      this.telemetryAccum = 0;
      this.onFrameTelemetry(audio, this.currentFps);
    }
  }

  private startLoop() {
    if (this.webXrLease || this.rafId !== null || this.disposed) return;
    const animate = (now: number) => {
      if (this.disposed || this.contextLost) {
        this.rafId = null;
        return;
      }
      this.rafId = requestAnimationFrame(animate);
      this.lastRafTickMs = performance.now();
      this.runControlTick(now, true);
    };
    this.rafId = requestAnimationFrame(animate);
  }

  private updateScene(dt: number, audio: AudioMetrics, audioDt = dt) {
    // The frame loop still clears the canvas and publishes telemetry while the desk is idle.
    if (this.standby) return false;
    const demo = this.currentState.autoDirector ? audio.demo : undefined;
    const demoOpeningStep = demo ? (demo.beforeDownbeat ? 0 : demo.openingStep) : undefined;
    // Render opening fades on the audio clock, between the slower console readouts.
    const s = demo && (demo.beforeDownbeat || demoOpeningStep! < 224) ? applyDemoLighting(this.currentState, demo) : this.currentState;
    const b = this.currentBump;
    const t = this.elapsed;
    if (demo) this.directedStep = demoOpeningStep;
    const manualMix = demo ? 0 : this.manualFadeStart === undefined ? 1 : demoFade(t - this.manualFadeStart, 0, 0.8);
    if (manualMix === 1) {
      this.manualFadeStart = undefined;
      this.directedStep = undefined;
    }
    const openingStep = this.directedStep;

    // Effective master blackout / dimmer
    const blackoutActive = Boolean(s.blackout);
    const darkOpening = !!demo && (!!demo.beforeDownbeat || demoOpeningStep! <= DEMO_BLACKOUT_STEPS);
    const master = blackoutActive || darkOpening ? 0 : s.masterDimmer;
    this.neonFrame.setBlackout(blackoutActive || darkOpening);
    this.neonFrame.setMasterDimmer(master);
    // Clear physical buffers before encoding so repatched, generic, or simulation-only ranges always stay neutral 0.
    this.physicalDmxU1.fill(0);
    this.physicalDmxU2.fill(0);
    this.serialPhysicalDmxU1.fill(0);
    this.serialPhysicalDmxU2.fill(0);
    const roomGain = openingStep === undefined ? 1 : THREE.MathUtils.lerp(demoFade(openingStep, 96, 208), 1, manualMix);
    this.houseAmbient.intensity = 0.36 * roomGain;
    this.scene.environmentIntensity = 0.55 * roomGain;
    (this.scene.background as THREE.Color).copy(this.backgroundColor).multiplyScalar(roomGain);
    this.fog.color.copy(this.fogColor).multiplyScalar(roomGain);
    for (const lamp of this.houseColors) lamp.color.copy(lamp.full).multiplyScalar(roomGain);

    // Evaluate per-mapping audio modulation once per frame BEFORE rendering and DMX output.
    const mod = evaluateAudioModulation(s, audio, this.audioModState, audioDt, this.audioModFrame);
    // Keep accumulated phase offsets intact across disables/cue switches so animations never jump;
    // when never mapped they remain 0 (exact + 0.0 parity).
    // Suppress legacy global boost whenever explicit audio mappings are active so targets don't double-react
    // and laser intensity stays strictly <= look.laser.intensity.
    const audioBoost = mod.active ? 0 : (s.audioReactive && audio.playing ? audio.beatPulse * 0.45 + audio.bass * 0.35 : 0);
    const beatPulse = s.audioReactive && audio.playing ? audio.beatPulse : 0.15 * Math.max(0, Math.sin(t * (s.bpm / 60) * Math.PI));
    const effHaze = blackoutActive ? 0 : (mod.active && mod.haze.mapped ? mod.haze.level : s.atmo.hazeLevel);
    this.atmosphereLook.beginFrame();

    const primaryColor = this.primaryColorScratch.set(s.primaryColor);
    const accentColor = this.accentColorScratch.set(s.accentColor);
    const tempCol = this.tempColScratch;
    const previewTempCol = this.previewTempColScratch;

    // Global Strobe gate (enforces <= 3 flashes/s across mappings, manual strobeRate, and strobe bump
    // before both rendering and physical DMX encoding via shared audioModState.lastGlobalStrobeEdgeMs).
    // NEVER depends on fullRateStrobePreview so physical DMX output is byte-for-byte invariant.
    const effectiveStrobe = b.strobe ? 0.92 : s.strobeRate;
    const combinedStrobe = stepCombinedStrobeGate(
      this.audioModState,
      effectiveStrobe,
      t,
      blackoutActive,
      this.combinedStrobeScratch,
    );
    const strobeGate = combinedStrobe.gate;
    const strobeFlashOn = combinedStrobe.flashOn;
    if (combinedStrobe.limited) {
      mod.flashLimited = true;
    }

    // Preview-only flash governor (Sprint 15 + Sprint 24 hardening): caps visual strobe, laser blanking,
    // laser on/off/bump/color flips, ILDA shimmer, LED strobe_bars & spectrum/audio bands, blinder mashing,
    // blackout recovery, and rapid cue/group-color/ramp flips at <= 3/s by default without touching DMX buffers.
    const previewLimited = !this.effectiveFullRateStrobe;
    const rawEffBlinder = (b.blinder ? 1.0 : (mod.active && mod.blinder.mapped ? mod.blinder.dimmer : s.blinderLevel)) * master;
    const effLedBrightRaw = mod.active && mod.ledWall.brightnessMapped ? mod.ledWall.brightness : s.led.brightness;
    const rawLedBright = s.led.enabled ? effLedBrightRaw * master : 0;
    const rawBeamIntBase = mod.active && mod.beam.dimmerMapped ? mod.beam.dimmer : s.beamIntensity;
    const rawWashIntBase = mod.active && mod.wash.dimmerMapped ? mod.wash.dimmer : s.washIntensity;
    const rawUnmappedLaserStrobe = mod.active && mod.laser.strobe.mapped ? 0 : s.laser.strobe;
    const beamHeadLook = headLook(s, 'beam');
    const washHeadLook = headLook(s, 'wash');
    const rawBeamPrimary = beamHeadLook.primaryColor === s.primaryColor ? primaryColor : this.beamPrimaryScratch.set(beamHeadLook.primaryColor);
    const rawBeamAccent = beamHeadLook.accentColor === s.accentColor ? accentColor : this.beamAccentScratch.set(beamHeadLook.accentColor);
    const rawWashPrimary = washHeadLook.primaryColor === s.primaryColor ? primaryColor : this.washPrimaryScratch.set(washHeadLook.primaryColor);
    const rawWashAccent = washHeadLook.accentColor === s.accentColor ? accentColor : this.washAccentScratch.set(washHeadLook.accentColor);
    const rawBeamColorMix = mod.active && mod.beam.colorMixMapped ? mod.beam.colorMix : 0;
    const rawWashColorMix = mod.active && mod.wash.colorMixMapped ? mod.wash.colorMix : 0;
    const rawLedBass = s.audioReactive && audio.playing ? audio.bass : 0.35 + 0.2 * Math.sin(t * 3.1);
    const rawLedMid = s.audioReactive && audio.playing ? audio.mid : 0.35 + 0.2 * Math.cos(t * 2.4);
    const rawLedHigh = s.audioReactive && audio.playing ? audio.high : 0.28 + 0.2 * Math.sin(t * 4.5);
    const previewFlash = evaluatePreviewFlash(
      this.previewFlashState,
      {
        dtSec: audioDt,
        tSec: t,
        limited: previewLimited,
        blackout: blackoutActive || darkOpening,
        master,
        blinder: rawEffBlinder,
        ledBright: rawLedBright,
        beatPulse,
        bass: rawLedBass,
        mid: rawLedMid,
        high: rawLedHigh,
        beamIntensity: rawBeamIntBase,
        washIntensity: rawWashIntBase,
        beamColorMix: rawBeamColorMix,
        washColorMix: rawWashColorMix,
        goboPrism: s.goboPrism,
        laserStrobe: rawUnmappedLaserStrobe,
        primaryColor,
        accentColor,
        beamPrimaryColor: rawBeamPrimary,
        beamAccentColor: rawBeamAccent,
        washPrimaryColor: rawWashPrimary,
        washAccentColor: rawWashAccent,
      },
      this.previewFlashOut,
    );
    const previewMaster = previewFlash.master;
    const previewPrimaryColor = previewFlash.primaryColor;
    const previewAccentColor = previewFlash.accentColor;
    const rawPreviewFlashOn = !previewLimited && effectiveStrobe > 0.03 ? rawManualStrobeOscillator(effectiveStrobe, t) : strobeFlashOn;
    const previewStrobeGate = !previewLimited && effectiveStrobe > 0.03 ? (rawPreviewFlashOn ? 1.35 : 0.06) : strobeGate;

    // 1. Update Kinetic Chain Hoist Motors & Truss Positions
    this.trussPods.forEach((pod, idx) => {
      const cfg = pod.config;
      let targetY = cfg.baseY;
      let targetTiltZ = 0;
      let targetTiltX = 0;

      if (cfg.motorized) {
        const motorMode = b.motorDrop ? 'drop' : s.motors.mode;
        const mSpeed = 0.45 + s.motors.speed * 2.2;
        const spanY = cfg.motorMaxY - cfg.motorMinY;

        if (motorMode === 'manual') {
          const custom = s.motors.podTargets[cfg.id];
          const hNorm = custom ? custom.height : (cfg.baseY - cfg.motorMinY) / Math.max(0.1, spanY);
          targetY = cfg.motorMinY + hNorm * spanY;
          targetTiltZ = (custom ? custom.tilt : 0) * 0.28;
        } else if (motorMode === 'high') {
          targetY = cfg.motorMaxY;
        } else if (motorMode === 'low') {
          targetY = cfg.motorMinY + spanY * 0.12;
        } else if (motorMode === 'drop') {
          targetY = cfg.motorMinY;
          targetTiltZ = (idx % 2 === 0 ? 1 : -1) * 0.16;
        } else if (motorMode === 'v_tilt') {
          targetY = cfg.motorMinY + spanY * (0.45 + (idx % 2) * 0.25);
          targetTiltZ = cfg.x < -1 ? 0.26 : cfg.x > 1 ? -0.26 : Math.sin(t * mSpeed) * 0.12;
        } else if (motorMode === 'wave') {
          const w = 0.5 + 0.5 * Math.sin(t * mSpeed + idx * 1.15);
          targetY = cfg.motorMinY + spanY * (0.18 + w * 0.72);
          targetTiltZ = Math.cos(t * mSpeed * 0.8 + idx) * 0.14;
          targetTiltX = Math.sin(t * mSpeed * 0.6 + idx) * 0.08;
        } else if (motorMode === 'breathe') {
          const w = 0.5 + 0.5 * Math.sin(t * mSpeed * 0.55);
          targetY = cfg.motorMinY + spanY * (0.35 + w * 0.45);
        }
      }

      const lerpRate = Math.min(1, dt * (b.motorDrop ? 7.5 : 3.2));
      if (!Number.isFinite(pod.currentY)) pod.currentY = cfg.baseY;
      if (!Number.isFinite(pod.currentTiltZ)) pod.currentTiltZ = 0;
      if (!Number.isFinite(pod.currentTiltX)) pod.currentTiltX = 0;
      if (Number.isFinite(targetY)) pod.currentY = THREE.MathUtils.lerp(pod.currentY, targetY, lerpRate);
      if (Number.isFinite(targetTiltZ)) pod.currentTiltZ = THREE.MathUtils.lerp(pod.currentTiltZ, targetTiltZ, lerpRate);
      if (Number.isFinite(targetTiltX)) pod.currentTiltX = THREE.MathUtils.lerp(pod.currentTiltX, targetTiltX, lerpRate);

      pod.group.position.y = pod.currentY;
      pod.group.rotation.z = pod.currentTiltZ;
      pod.group.rotation.x = pod.currentTiltX;
      pod.group.updateMatrixWorld();

      // Update dynamic steel hoist chains so they stay vertical and locked straight to roofY!
      for (const h of pod.hoists) {
        h.root.getWorldPosition(this.hoistWorldPosScratch);
        const chainLen = Math.max(0.5, this.roofY - this.hoistWorldPosScratch.y - 0.32);
        h.chainMesh.scale.y = chainLen;
        // Counter-rotate chain slightly so steel hoist stays plumb vertical toward ceiling!
        h.root.rotation.z = -pod.currentTiltZ;
        h.root.rotation.x = -pod.currentTiltX;
      }
    });

    // 2. Update Moving Head Beams & Washes (Articulated Pan/Tilt + Volumetric Shaders)
    const opticsLook = (kind: 'beam' | 'wash') => {
      const look = headLook(s, kind);
      const focus = look.movementMode === 'manual'
        ? focusPoint(this.getFocusMarks(), look.focusMarkId, look.manualPan, look.manualTilt) : null;
      const gMod = mod.active ? (kind === 'beam' ? mod.beam : mod.wash) : null;
      const baseMoveSpd = 0.35 + look.movementSpeed * 3.1;
      const effSpeedNorm = gMod?.speedMapped ? gMod.speed : look.movementSpeed;
      const effMoveSpd = 0.35 + effSpeedNorm * 3.1;
      if (gMod?.speedMapped) {
        if (kind === 'beam') this.beamPhaseOffset += dt * (effMoveSpd - baseMoveSpd);
        else this.washPhaseOffset += dt * (effMoveSpd - baseMoveSpd);
      }
      const phaseOffset = kind === 'beam' ? this.beamPhaseOffset : this.washPhaseOffset;
      const effZoom = gMod?.zoomMapped ? gMod.zoom : s.beamZoom;
      const colorMix = gMod?.colorMixMapped ? gMod.colorMix : 0;
      const tiltOffset = gMod?.tiltMapped ? gMod.tiltOffset : 0;
      const strobeMapped = Boolean(gMod?.strobe.mapped);
      const rawGroupStrobeGate = strobeMapped
        ? (b.strobe ? strobeGate : (gMod!.strobe.gateOn ? 1.35 : 0.06))
        : strobeGate;
      const groupStrobeGate = stepDeliveredStrobeGate(
        this.audioModState,
        kind,
        rawGroupStrobeGate,
        blackoutActive,
      );
      if (groupStrobeGate < 0.5 && rawGroupStrobeGate >= 0.5) {
        mod.flashLimited = true;
      }
      // Final composed DMX brightness limiter (Codex review-05 R1): tracks composed brightness across
      // ducking dimmer mappings, audioReactive toggles, and blackout recovery so DMX stays <= 3/s.
      const baseGroupDimmer = gMod?.dimmerMapped
        ? gMod.dimmer
        : (kind === 'beam' ? s.beamIntensity : s.washIntensity);
      const rawComposedBright = Math.min(1.6, baseGroupDimmer * master * groupStrobeGate * (1.0 + audioBoost * 0.48));
      const deliveredComposedBright = stepDeliveredBrightness(
        this.audioModState,
        kind,
        rawComposedBright,
        blackoutActive || darkOpening,
      );
      const composedBrightSuppressed =
        !blackoutActive && !darkOpening && deliveredComposedBright < rawComposedBright - 1e-4;
      if (composedBrightSuppressed) {
        mod.flashLimited = true;
      }
      const composedBrightScale = composedBrightSuppressed
        ? (rawComposedBright > 1e-6 ? deliveredComposedBright / rawComposedBright : 0)
        : 1;
      const groupDmxStrobe = strobeMapped || b.strobe ? 0 : Math.round(effectiveStrobe * 255);
      const rawPreviewGroupStrobeGate = previewLimited
        ? groupStrobeGate
        : (strobeMapped ? (b.strobe ? previewStrobeGate : groupStrobeGate) : previewStrobeGate);
      const previewGroupStrobeGate = stepPreviewDeliveredGate(
        this.previewFlashState,
        kind,
        rawPreviewGroupStrobeGate,
        blackoutActive || darkOpening,
        previewLimited,
      );
      const groupPrimary = kind === 'beam' ? rawBeamPrimary : rawWashPrimary;
      const groupAccent = kind === 'beam' ? rawBeamAccent : rawWashAccent;
      const previewGroupPrimary = kind === 'beam' ? previewFlash.beamPrimaryColor : previewFlash.washPrimaryColor;
      const previewGroupAccent = kind === 'beam' ? previewFlash.beamAccentColor : previewFlash.washAccentColor;
      const previewColorMix = kind === 'beam' ? previewFlash.beamColorMix : previewFlash.washColorMix;
      return {
        look, focus, moveSpd: baseMoveSpd, phaseOffset, effSpeedNorm, spread: 0.25 + look.movementSpread * 1.15,
        effZoom, colorMix, previewColorMix, tiltOffset, gMod, strobeMapped, groupStrobeGate, composedBrightScale, previewGroupStrobeGate, groupDmxStrobe,
        primary: groupPrimary,
        accent: groupAccent,
        previewPrimary: previewGroupPrimary,
        previewAccent: previewGroupAccent,
      };
    };
    const groups = { beam: opticsLook('beam'), wash: opticsLook('wash') };
    this.lastPoolTime = t;
    this.beamPools?.begin();
    for (const fx of this.movingFixtures) {
      const {
        look, focus, moveSpd, phaseOffset, spread, effZoom, colorMix, previewColorMix, tiltOffset,
        gMod, groupStrobeGate, composedBrightScale, previewGroupStrobeGate, groupDmxStrobe, primary, accent, previewPrimary, previewAccent,
      } = groups[fx.type];
      const i = fx.index;
      const count = Math.max(1, this.movingFixtures.length);
      const norm = i / count;
      const movePhase = t * moveSpd + phaseOffset;

      let targetPan = 0;
      let targetTilt = 0.28;

      if (focus) {
        fx.root.updateWorldMatrix(true, false);
        const local = fx.root.worldToLocal(this.focusLocal.set(focus.x, focus.y, focus.z));
        if (fx.motion === 'tilt') {
          targetPan = 0;
          targetTilt = aimTiltOnly(local, fx.isFloor, fx.pivotY);
        } else {
          // Both pan-tilt heads and manually focused PAR cans aim onto explicit focus marks.
          ({ pan: targetPan, tilt: targetTilt } = aimAngles(local, fx.isFloor, fx.currentPan, fx.currentTilt, fx.pivotY));
        }
      } else if (fx.motion === 'fixed') {
        if (look.movementMode === 'manual') {
          targetPan = look.manualPan * 1.45 - fx.mountYaw;
          targetTilt = (fx.isFloor ? 1 : -1) * look.manualTilt * 1.15;
        } else {
          // Fixed PARs hold static rigging orientation during automated moving-head chases.
          targetPan = 0;
          targetTilt = 0;
        }
      } else {
      switch (look.movementMode) {
        case 'manual':
          targetPan = look.manualPan * 1.45;
          targetTilt = look.manualTilt * 1.15;
          break;
        case 'fan':
          // Fan each bar symmetrically using its physical mounting position.
          targetPan = Math.PI * 0.5;
          targetTilt = -fx.fanPosition * (0.48 + Math.sin(movePhase * 0.55) * 0.24) * spread;
          break;
        case 'sweep':
          targetPan = Math.sin(movePhase + i * 0.22) * 1.1 * spread;
          targetTilt = 0.42 + Math.cos(movePhase * 0.5) * 0.35 * spread;
          break;
        case 'circle':
          targetPan = Math.sin(movePhase + i * 0.35) * 0.95 * spread;
          targetTilt = 0.45 + Math.cos(movePhase + i * 0.35) * 0.48 * spread;
          break;
        case 'figure8':
          targetPan = Math.sin(movePhase + i * 0.25) * 1.15 * spread;
          targetTilt = 0.4 + Math.sin(movePhase * 2.0 + i * 0.25) * 0.42 * spread;
          break;
        case 'flyout': {
          targetPan = ((i % 2 === 0 ? -1 : 1) * 0.4 + (norm - 0.5)) * spread;
          const rawFly = (movePhase * 0.55 + (i % 4) * 0.25) % 1.0;
          targetTilt = 0.1 + (rawFly < 0 ? rawFly + 1.0 : rawFly) * 1.15;
          break;
        }
        case 'wave':
          targetPan = (norm - 0.5) * 1.4 * spread;
          targetTilt = 0.42 + Math.sin(movePhase * 1.4 - norm * 5.2) * 0.58 * spread;
          break;
        case 'ballyhoo':
          targetPan = Math.sin(movePhase * 1.3 + i * 1.7) * 1.35 * spread;
          targetTilt = 0.35 + Math.cos(movePhase * 1.7 + i * 2.3) * 0.65 * spread;
          break;
        case 'crowd_scan':
          targetPan = Math.sin(movePhase * 0.9 + i * 0.4) * 0.85 * spread;
          targetTilt = 0.72 + Math.sin(movePhase * 1.8 + i * 0.3) * 0.26 * spread;
          break;
      }

      // Pan is relative to the audience (+Z), even on a radial or rotated mount.
      // A ceiling head emits along local −Y, while its floor counterpart emits along +Y.
      if (fx.motion === 'tilt') {
        targetPan = 0;
        if (!fx.isFloor) targetTilt = -targetTilt;
      } else {
        targetPan -= fx.mountYaw;
        if (look.movementMode === 'fan') {
          if (fx.isFloor) targetTilt = -targetTilt;
        } else {
          if (!fx.isFloor) targetTilt = -targetTilt;
          else if (look.movementMode !== 'manual') targetTilt = Math.abs(targetTilt) * 0.65 + 0.15;
        }
      }
      }
      if (tiltOffset !== 0 && fx.motion !== 'fixed') {
        targetTilt = THREE.MathUtils.clamp(targetTilt + tiltOffset, -TILT_LIMIT, TILT_LIMIT);
      }

      const moveFraction = Math.min(1, dt * 8);
      if (!Number.isFinite(fx.currentPan)) fx.currentPan = 0;
      if (!Number.isFinite(fx.currentTilt)) fx.currentTilt = 0;
      if (Number.isFinite(targetPan)) fx.currentPan = THREE.MathUtils.lerp(fx.currentPan, reachablePan(targetPan, fx.currentPan), moveFraction);
      if (Number.isFinite(targetTilt)) fx.currentTilt = THREE.MathUtils.lerp(fx.currentTilt, targetTilt, moveFraction);
      fx.yoke.rotation.y = fx.currentPan;
      fx.head.rotation.x = fx.currentTilt;

      // Fixture color resolution (DMX uses authored color; preview uses flash-governed color)
      if (look.colorSplitMode === 'solid') {
        tempCol.copy(primary);
        previewTempCol.copy(previewPrimary);
      } else if (look.colorSplitMode === 'alternate') {
        tempCol.copy(i % 2 === 0 ? primary : accent);
        previewTempCol.copy(i % 2 === 0 ? previewPrimary : previewAccent);
      } else if (look.colorSplitMode === 'gradient') {
        tempCol.copy(primary).lerp(accent, norm);
        previewTempCol.copy(previewPrimary).lerp(previewAccent, norm);
      } else {
        tempCol.setHSL((norm + t * 0.12) % 1, 0.96, 0.55);
        previewTempCol.copy(tempCol);
      }
      if (colorMix > 0) {
        tempCol.lerp(accent, colorMix);
      }
      if (previewColorMix > 0) {
        previewTempCol.lerp(previewAccent, previewColorMix);
      }

      const firstPair = fx.openingStep === DEMO_BLACKOUT_STEPS;
      const groupGain = demo && !firstPair ? demoFade(demoOpeningStep!, fx.openingStep, fx.openingStep + 12) : 1;
      let baseInt = gMod?.dimmerMapped
        ? gMod.dimmer
        : (fx.type === 'beam' ? s.beamIntensity : s.washIntensity);
      let previewBaseInt = fx.type === 'beam' ? previewFlash.beamIntensity : previewFlash.washIntensity;
      if (demo && firstPair && fx.type === 'wash' && demoOpeningStep! < 128) {
        baseInt = THREE.MathUtils.lerp(s.beamIntensity, baseInt, demoFade(demoOpeningStep!, 96, 128));
        previewBaseInt = THREE.MathUtils.lerp(previewFlash.beamIntensity, previewBaseInt, demoFade(demoOpeningStep!, 96, 128));
      }
      // Release each lantern from its last rendered level, including fixtures still out.
      if (demo) fx.directedDimmer = groupGain * baseInt;
      const dimmer = manualMix < 1 ? THREE.MathUtils.lerp(fx.directedDimmer, baseInt, manualMix) : baseInt;
      const previewDimmer = manualMix < 1 ? THREE.MathUtils.lerp(fx.directedDimmer, previewBaseInt, manualMix) : previewBaseInt;
      this.atmosphereLook.addFixture(tempCol.r, tempCol.g, tempCol.b, dimmer, master);
      const finalInt = Math.min(1.6, dimmer * master * groupStrobeGate * (1.0 + audioBoost * 0.48)) * composedBrightScale;
      const rawPreviewFinalInt =
        Math.min(1.6, previewDimmer * previewMaster * previewGroupStrobeGate * (1.0 + audioBoost * 0.48)) *
        (previewLimited ? composedBrightScale : 1);
      const previewFinalInt = stepPreviewFixtureUnit(
        this.previewFlashState,
        fx.previewRgbGov,
        previewLimited,
        blackoutActive || darkOpening,
        rawPreviewFinalInt,
        previewTempCol,
        previewTempCol,
      );

      fx.beamMat.uniforms.uColor.value.copy(previewTempCol);
      const zoomScale = beamZoomScale(fx.type, effZoom);
      fx.lastZoomScale = zoomScale;
      const clampedFinalInt = THREE.MathUtils.clamp(finalInt, 0, 1);
      fx.appliedDimmer = clampedFinalInt;
      const emitted = previewFinalInt * aerialGain(fx.optics, zoomScale);
      const previewPrismMix = fx.type === 'beam' ? previewFlash.prismMix : 0;
      const fxSeed = Number(fx.beamMat.uniforms.uSeed.value);
      fx.beamMat.uniforms.uIntensity.value = emitted;
      fx.beamMat.uniforms.uHaze.value = effHaze;
      fx.beamMat.uniforms.uTime.value = t;
      fx.beamMat.uniforms.uPrism.value = previewPrismMix;

      // Live Beam Zoom (narrow razor beam vs wide flood)
      fx.beamMesh.scale.set(zoomScale, 1, zoomScale);
      fx.beamMesh.visible = emitted > 0.001;
      // The pool shader already spreads incident power across the footprint.
      const poolIntensity = previewFinalInt * fx.optics.fluxRatio;
      fx.lastPoolIntensity = poolIntensity;
      this.beamPools?.add(
        fx.beamMesh,
        fx.type,
        fx.isFloor,
        previewTempCol,
        poolIntensity,
        fx.optics,
        previewPrismMix,
        previewPrismMix > 0.001 ? prismPhase(t, fxSeed) : 0,
      );
      fx.lastPreviewIntensity = previewFinalInt;
      fx.lastPreviewR = previewTempCol.r;
      fx.lastPreviewG = previewTempCol.g;
      fx.lastPreviewB = previewTempCol.b;
      if (previewFinalInt > 0.001) {
        if (!this.beamPools || poolIntensity <= 0.001) {
          fx.head.updateWorldMatrix(true, false);
        }
        const he = fx.head.matrixWorld.elements;
        const sign = fx.isFloor ? 1 : -1;
        const ax = he[4] * sign;
        const ay = he[5] * sign;
        const az = he[6] * sign;
        const lenSq = ax * ax + ay * ay + az * az;
        const invLen = lenSq > 1e-12 ? 1 / Math.sqrt(lenSq) : 0;
        fx.lastWorldX = he[12];
        fx.lastWorldY = he[13];
        fx.lastWorldZ = he[14];
        fx.lastAimX = invLen > 0 ? ax * invLen : 0;
        fx.lastAimY = invLen > 0 ? ay * invLen : -1;
        fx.lastAimZ = invLen > 0 ? az * invLen : 0;
      }

      // Glowing optical fixture lens
      fx.lensMat.color.copy(previewTempCol).multiplyScalar(previewFinalInt * fx.optics.fluxRatio * 2.6);

      // Invalid or conflicting fixture footprints have start 0 and make no writes.
      // Clamp writes strictly to fx.dmxWidth so narrow catalogue modes (e.g. 1–6 ch PARs) never overwrite neighbours.
      const uBuf = fx.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
      const physBuf = fx.dmxUniverse === 1 ? this.physicalDmxU1 : this.physicalDmxU2;
      const serialPhysBuf = fx.dmxUniverse === 1 ? this.serialPhysicalDmxU1 : this.serialPhysicalDmxU2;
      if (fx.dmxStart > 0) {
        writeDmxChannels(uBuf, fx.dmxStart, fx.dmxWidth, [
          axisDmx(fx.currentPan, PAN_LIMIT),
          axisDmx(fx.currentTilt, TILT_LIMIT),
          Math.round(THREE.MathUtils.clamp(finalInt * 255, 0, 255)),
          Math.round(tempCol.r * 255),
          Math.round(tempCol.g * 255),
          Math.round(tempCol.b * 255),
          Math.round(effZoom * 255),
          groupDmxStrobe,
        ]);
        if (fx.physicalClass.status === 'implemented') {
          const unitRgb = stepDeliveredUnitRgb(
            this.audioModState,
            fx.physRgbGov,
            clampedFinalInt,
            tempCol.r,
            tempCol.g,
            tempCol.b,
            blackoutActive || darkOpening,
            this.deliveredRgbScratch,
          );
          if (unitRgb.limited) {
            mod.flashLimited = true;
          }
          const ps = this.physicalUnitScratch;
          ps.blackout = blackoutActive;
          if (fx.physicalClass.personalityKey === 'etc-colorsource-par::1-Ch') {
            ps.dimmer = clampedFinalInt;
            ps.r = tempCol.r;
            ps.g = tempCol.g;
            ps.b = tempCol.b;
          } else {
            ps.dimmer = unitRgb.rgbDimmer;
            ps.r = unitRgb.r;
            ps.g = unitRgb.g;
            ps.b = unitRgb.b;
          }
          writePhysicalUnitBytes(physBuf, uBuf, fx.dmxStart, fx.dmxWidth, fx.physicalClass, ps, this.physicalDmxScratch, false);
          writePhysicalUnitBytes(serialPhysBuf, uBuf, fx.dmxStart, fx.dmxWidth, fx.physicalClass, ps, this.physicalDmxScratch, true);
        }
      }
    }

    const poolUploadBytes = this.beamPools?.finish() ?? 0;
    if (this.profiler) {
      this.profiler.curUploadBytes += poolUploadBytes;
    }
    this.atmosphereLook.step(dt, effHaze, master, roomGain, blackoutActive, darkOpening);
    this.fog.color.setRGB(
      this.atmosphereLook.getAppliedR(),
      this.atmosphereLook.getAppliedG(),
      this.atmosphereLook.getAppliedB(),
    );

    // 3. Update Volumetric RGB / Single-Color Laser Projectors & ILDA Playback
    const laserEnabled = (s.laser.enabled || b.laser) && master > 0.01;
    const globalLaserStrobeGate = mod.active && mod.laser.strobe.mapped ? (mod.laser.strobe.gateOn ? 1 : 0) : 1;
    const globalLaserBaseInt = mod.active && mod.laser.intensityMapped ? mod.laser.intensity : s.laser.intensity;
    const baseLaserInt = laserEnabled
      ? Math.min(1.5, (b.laser ? 1.0 : globalLaserBaseInt) * master * (1.0 + audioBoost * 0.38) * (b.laser ? 1 : globalLaserStrobeGate))
      : 0;
    const patIdx = PATTERN_INDEX[s.laser.pattern];
    const isConePattern = s.laser.pattern === 'tunnel' || s.laser.pattern === 'dual_cones';
    const ildaActive = Boolean(this.bakedIlda && this.bakedIlda.frameRanges.length > 0);
    if (ildaActive && laserEnabled) {
      this.ildaPlayTime += dt;
    }
    const ildaFrameIdx = ildaActive
      ? Math.floor(this.ildaPlayTime * this.ildaFps) % this.bakedIlda!.frameRanges.length
      : 0;

    let maxPreviewLaserInt = 0;
    const appliedLaserProjectors = this.appliedParams.laser.projectors;
    if (this.appliedLaserProjectorCount > 0) {
      for (let pk = 0; pk < this.appliedLaserProjectorCount; pk++) {
        delete appliedLaserProjectors[this.appliedLaserProjectorKeys[pk]];
      }
      this.appliedLaserProjectorCount = 0;
    }

    for (let ui = 0; ui < this.laserUnits.length; ui++) {
      const l = this.laserUnits[ui];
      const override = s.laser.projectors?.[l.key];
      const count = override?.beamCount ?? s.laser.beamCount;
      const lMod = mod.active ? (mod.laser.projectors[l.key] ?? mod.laser) : null;
      const unitStrobeGate = lMod?.strobe.mapped && !b.laser ? (lMod.strobe.gateOn ? 1 : 0) : 1;
      const unitEffIntBase = lMod?.intensityMapped ? lMod.intensity : s.laser.intensity;
      const unitBaseLaserInt = laserEnabled
        ? Math.min(1.5, (b.laser ? 1.0 : unitEffIntBase) * master * (1.0 + audioBoost * 0.38) * unitStrobeGate)
        : 0;

      const effSpreadX = lMod?.spreadMapped ? lMod.spreadX : s.laser.spreadX;
      const effSpreadY = lMod?.spreadMapped ? lMod.spreadY : s.laser.spreadY;
      const effSpeed = lMod?.speedMapped ? lMod.speed : s.laser.speed;
      const effRotation = lMod?.rotationMapped ? lMod.rotation : s.laser.rotation;
      // DMX strobe rate: zero when audio-mapped, raw look strobe otherwise (invariant of preview setting).
      const effLaserStrobe = lMod?.strobe.mapped ? 0 : s.laser.strobe;
      // Preview laser blanking + emission governor (Codex review-06 R5): governs `s.laser.enabled`,
      // `b.laser`, `s.laser.intensity` ramps, and custom/preset `colorA/B` flips to <= 3/s while keeping off/blackout instant.
      const previewLaserEnabled = (s.laser.enabled || b.laser) && previewMaster > 0.01;
      const previewLaserGate =
        previewLimited && !lMod?.strobe.mapped && !b.laser ? previewFlash.laserStrobeMultiplier : 1;
      const rawPreviewUnitBaseLaserInt = previewLaserEnabled
        ? Math.min(1.5, (b.laser ? 1.0 : unitEffIntBase) * previewMaster * (1.0 + audioBoost * 0.38) * unitStrobeGate * previewLaserGate)
        : 0;
      const rawPreviewUnitInt = Math.min(1.5, rawPreviewUnitBaseLaserInt * laserPowerPresence(l.laserSpec));
      const previewShaderLaserStrobe = previewFlash.bypassLaserShaderStrobe ? 0 : effLaserStrobe;

      if (lMod?.speedMapped) {
        this.laserSpeedPhaseOffsets[ui] = (this.laserSpeedPhaseOffsets[ui] ?? 0) + dt * ((0.45 + effSpeed * 2.6) - (0.45 + s.laser.speed * 2.6));
      }
      if (lMod?.rotationMapped) {
        this.laserRotPhaseOffsets[ui] = (this.laserRotPhaseOffsets[ui] ?? 0) + dt * (effRotation - s.laser.rotation);
      }
      const speedPhaseOff = this.laserSpeedPhaseOffsets[ui] ?? 0;
      const rotPhaseOff = this.laserRotPhaseOffsets[ui] ?? 0;

      if (mod.active && mod.laser.projectors[l.key]) {
        appliedLaserProjectors[l.key] = {
          intensity: Math.min(1, unitBaseLaserInt),
          speed: effSpeed,
          rotation: effRotation,
          spreadX: effSpreadX,
          spreadY: effSpreadY,
          strobeGateOn: unitStrobeGate > 0,
        };
        this.appliedLaserProjectorKeys[this.appliedLaserProjectorCount++] = l.key;
      }

      // Single source of truth for laser pitch (shared with laserSafety.ts; always uses base s.laser).
      l.root.rotation.x = laserPitch(l.isFloor, s.laser, t, l.index);

      // Single-color diode constraints + preview flash governor enforced with zero per-frame allocations.
      const su = l.sheetMat.uniforms;
      const shaderColorMode = this.applyLaserColors(
        l.singleColor,
        override?.colorMode ?? s.laser.colorMode,
        previewPrimaryColor,
        previewAccentColor,
        override?.colorA ?? s.laser.colorA,
        override?.colorB ?? s.laser.colorB,
        this.governedLaserColorA,
        this.governedLaserColorB,
      );
      const governedLaser = stepPreviewLaserUnit(
        this.previewFlashState,
        l.previewLaserGov,
        previewLimited,
        blackoutActive || darkOpening,
        rawPreviewUnitInt,
        this.governedLaserColorA,
        this.governedLaserColorB,
        su.uColorA.value,
        su.uColorB.value,
      );
      const previewUnitInt = governedLaser.intensity;
      const previewLaserVisible = previewUnitInt > 0.001;
      if (previewUnitInt > maxPreviewLaserInt) maxPreviewLaserInt = previewUnitInt;
      this.previewFlashOut.activeLimiting =
        this.previewFlashOut.activeLimiting || governedLaser.limited;
      su.uColorMode.value = shaderColorMode;

      if (ildaActive && this.bakedIlda && l.ildaMesh && l.ildaMat) {
        // Hide procedural sheet/cone meshes while ILDA frame clip is active.
        l.sheetMesh.visible = false;
        l.coneMesh.visible = false;
        l.innerConeMesh.visible = false;

        const effectiveMode: IldaRenderMode =
          l.laserSpec?.capability === 'beam' && this.ildaRenderMode === 'graphic'
            ? 'beam'
            : this.ildaRenderMode;
        const dr = this.bakedIlda.drawRangeFor(ildaFrameIdx, effectiveMode, this.ildaDrawRangeScratch);
        const frameRange = this.bakedIlda.frameRanges[ildaFrameIdx];
        const refreshHz = laserRefreshHz(l.laserSpec?.scanSpeedKpps, frameRange.sourcePointCount);
        const flicker = flickerIntensityMultiplier(refreshHz, t, previewLimited);

        l.ildaMesh.geometry.setDrawRange(dr.start, dr.count);
        const tangents = ildaScanTangents(l.laserSpec?.maxScanAngleDeg, effSpreadX, effSpreadY);
        l.ildaMesh.scale.set(tangents.scaleX, tangents.scaleY, 1);
        const ildaRoll = effRotation * Math.sin(t * (0.4 + s.laser.speed * 1.4) + speedPhaseOff * 0.54 + l.index) * LASER_ILDA_ROLL_SCALE;
        l.ildaMesh.rotation.z = ildaRoll;

        const hazeGain = 0.35 + 0.65 * effHaze;
        const ildaGain = Math.min(1.5, previewUnitInt * flicker * hazeGain);
        if (l.singleColor) {
          l.ildaMat.color.copy(l.singleColor).multiplyScalar(ildaGain);
        } else {
          l.ildaMat.color.setRGB(ildaGain, ildaGain, ildaGain);
        }
        l.ildaLastFrame = ildaFrameIdx;
        l.ildaLastMode = effectiveMode;
        l.ildaLastScaleX = tangents.scaleX;
        l.ildaLastScaleY = tangents.scaleY;
        l.ildaLastRoll = ildaRoll;
        l.ildaLastGain = Math.min(1.5, previewUnitInt * flicker);
        l.ildaLastHaze = effHaze;
        l.ildaLastVisible = previewLaserVisible && dr.count > 0;
        let selectedPath: 'line' | 'ribbon' | 'none' = previewLaserVisible && dr.count > 0 ? 'line' : 'none';
        if (this.renderSettings.ildaScanEnergy && l.ildaRibbon) {
          const ribbon = l.ildaRibbon;
          const ribbonFrame = ribbon.updateFrame(ildaFrameIdx, effectiveMode);
          ribbon.mesh.scale.set(tangents.scaleX, tangents.scaleY, 1);
          ribbon.mesh.rotation.z = ildaRoll;
          ribbon.setAppearance(Math.min(1.5, previewUnitInt * flicker), effHaze, l.singleColor);
          if (previewLaserVisible && ribbonFrame.active) selectedPath = 'ribbon';
          else if (!ribbonFrame.fallback) selectedPath = 'none';
        }
        // The legacy GL line has no per-eye near fade. Keep only the audited ribbon path in XR.
        if (this.webXrLease && selectedPath === 'line') selectedPath = 'none';
        this.selectIldaPath(l, selectedPath);
        l.apertureMat.color.copy(su.uColorA.value).multiplyScalar(previewUnitInt * flicker * 2.6);
      } else {
        l.ildaLastVisible = false;
        this.selectIldaPath(l, 'none');
        const shapes = this.laserShape(override?.patternSegments ?? s.laser.patternSegments ?? DEFAULT_LASER_RESOLUTION);
        l.sheetMesh.geometry = shapes.sheet;
        l.coneMesh.geometry = shapes.cone;
        l.innerConeMesh.geometry = shapes.cone;
        l.sheetMesh.visible = previewLaserVisible && !isConePattern;
        l.coneMesh.visible = previewLaserVisible && isConePattern;
        l.innerConeMesh.visible = previewLaserVisible && s.laser.pattern === 'dual_cones' && count > 1;

        // Subtle roll rotation on sheet patterns when rotation slider > 0 (phase-continuous under modulation)
        const rotPhase = t * s.laser.rotation + rotPhaseOff;
        const rollAngle = isConePattern
          ? 0
          : s.laser.pattern === 'matrix'
            ? (l.index % 2 === 0 ? 0.0 : Math.PI / 2) + rotPhase * 0.65
            : Math.sin(rotPhase * 1.4 + l.index) * effRotation * LASER_SHEET_ROLL_SCALE;
        l.sheetMesh.rotation.z = rollAngle;

        // Update sheet uniforms
        su.uIntensity.value = previewUnitInt;
        su.uHaze.value = effHaze;
        su.uTime.value = t;
        su.uPhaseOffset.value = speedPhaseOff;
        su.uPattern.value = patIdx;
        su.uBeamCount.value = count;
        su.uSpeed.value = s.laser.speed;
        su.uSpreadX.value = effSpreadX;
        su.uSpreadY.value = effSpreadY;
        su.uStrobe.value = previewShaderLaserStrobe;
        su.uAudioPulse.value = previewFlash.beatPulse;

        // Update cone / dual cone uniforms
        for (const [cm, dirMult] of [
          [l.coneMat, 1],
          [l.innerConeMat, -1.45],
        ] as const) {
          const cu = cm.uniforms;
          cu.uColorA.value.copy(dirMult < 0 ? su.uColorB.value : su.uColorA.value);
          cu.uColorB.value.copy(dirMult < 0 ? su.uColorA.value : su.uColorB.value);
          cu.uColorMode.value = su.uColorMode.value;
          cu.uIntensity.value = previewUnitInt;
          cu.uHaze.value = effHaze;
          cu.uTime.value = t;
          cu.uPhaseOffset.value = speedPhaseOff;
          cu.uRotOffset.value = rotPhaseOff * dirMult;
          cu.uBeamCount.value = s.laser.pattern === 'dual_cones'
            ? (dirMult < 0 ? Math.floor(count / 2) : Math.ceil(count / 2)) : count;
          cu.uSpeed.value = s.laser.speed;
          cu.uSpreadX.value = effSpreadX;
          cu.uSpreadY.value = effSpreadY;
          cu.uRotation.value = s.laser.rotation * dirMult;
          cu.uStrobe.value = previewShaderLaserStrobe;
          cu.uAudioPulse.value = previewFlash.beatPulse;
        }

        l.apertureMat.color.copy(su.uColorA.value).multiplyScalar(previewUnitInt * 2.6);
      }

      // Write Laser DMX Universe channels using unscaled authored unitBaseLaserInt & authored colors
      // (never preview flash slew or visual power presence), clamped strictly to l.dmxWidth.
      const uBuf = l.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
      const physBuf = l.dmxUniverse === 1 ? this.physicalDmxU1 : this.physicalDmxU2;
      if (l.dmxStart > 0) {
        const dmxColorMode = this.applyLaserColors(
          l.singleColor,
          override?.colorMode ?? s.laser.colorMode,
          primaryColor,
          accentColor,
          override?.colorA ?? s.laser.colorA,
          override?.colorB ?? s.laser.colorB,
          tempCol,
          previewTempCol,
        );
        const dv = this.laserDmxScratchValues;
        dv.enabled = laserEnabled;
        dv.intensity = Math.min(1, unitBaseLaserInt);
        dv.patternIndex = patIdx;
        dv.spreadX = effSpreadX;
        dv.spreadY = effSpreadY;
        dv.speed = effSpeed;
        dv.rotation = effRotation;
        dv.tilt = s.laser.tilt;
        dv.beamCount = count;
        dv.strobe = effLaserStrobe;
        dv.colorR = tempCol.r;
        dv.colorG = tempCol.g;
        dv.colorB = tempCol.b;
        dv.colorModeIndex = dmxColorMode;
        dv.scanRateNorm = l.laserSpec ? Math.min(1, l.laserSpec.scanSpeedKpps / 40) : 0;
        const dmxBytes = encodeLaserDmxChannels(l.resolvedMode, dv, l.dmxScratch);
        writeDmxChannels(uBuf, l.dmxStart, l.dmxWidth, dmxBytes);
        const ps = this.physicalUnitScratch;
        ps.blackout = blackoutActive;
        if (this.inhibitedLaserKeys.has(l.key)) {
          // Session-inhibited laser projector: force physical DMX to neutral 0 with no cue/bump bypass.
          const ch = l.dmxStart - 1;
          const clampedW = Math.min(l.dmxWidth, physBuf.length - ch);
          if (ch >= 0 && clampedW > 0) physBuf.fill(0, ch, ch + clampedW);
        } else {
          writePhysicalUnitBytes(physBuf, uBuf, l.dmxStart, l.dmxWidth, l.physicalClass, ps, this.physicalDmxScratch);
        }
      }
    }
    const laserInt = this.laserUnits.length ? maxPreviewLaserInt : (previewLimited ? 0 : baseLaserInt);

    // 4. Update Audience Blinders & LED Strobes (governed via stepDeliveredBrightness for review-06 R3)
    const effBlinder = stepDeliveredBrightness(
      this.audioModState,
      'blinder',
      rawEffBlinder,
      blackoutActive || darkOpening,
    );
    const blinderGovLimited = !blackoutActive && !darkOpening && effBlinder < rawEffBlinder - 1e-4;
    if (blinderGovLimited) {
      mod.flashLimited = true;
    }
    const previewBlinder = previewFlash.blinder;
    const warmAmber = this.warmAmberColor;
    for (const bl of this.blinders) {
      bl.lensMat.color.copy(warmAmber).multiplyScalar(previewBlinder * 4.2);
      if (bl.start) {
        bl.buffer[bl.start - 1] = Math.round(THREE.MathUtils.clamp(effBlinder, 0, 1) * 255);
        const ps = this.physicalUnitScratch;
        ps.blackout = blackoutActive;
        ps.blinder = THREE.MathUtils.clamp(effBlinder, 0, 1);
        writePhysicalUnitBytes(bl.physBuffer, bl.buffer, bl.start, bl.width ?? 1, bl.physicalClass, ps, this.physicalDmxScratch);
      }
    }
    this.blinderLight.intensity = previewBlinder * 75;

    const strobeBarAudioMapped = mod.active && (mod.strobeBar.strobe.mapped || mod.strobeBar.dimmerMapped);
    const rawStrobeBarBright = strobeBarAudioMapped
      ? (b.strobe && strobeFlashOn
          ? 3.8 * master
          : Math.max(mod.strobeBar.strobe.mapped && mod.strobeBar.strobe.gateOn ? 1 : 0, mod.strobeBar.dimmerMapped ? mod.strobeBar.dimmer : 0) * 3.8 * master)
      : (effectiveStrobe > 0.03 && strobeFlashOn
          ? 3.8 * master
          : s.audioReactive && audio.beat && master > 0.2
            ? 2.2 * master * (openingStep === undefined ? 1 : THREE.MathUtils.lerp(demoFade(openingStep, 256, 384), 1, manualMix))
            : 0);
    const rawBarGate = rawStrobeBarBright > 0.01 ? 1.0 : 0.06;
    const deliveredBarGate = stepDeliveredStrobeGate(this.audioModState, 'bar', rawBarGate, blackoutActive);
    const barGateLimited = deliveredBarGate < 0.5 && rawBarGate >= 0.5;
    if (barGateLimited) {
      mod.flashLimited = true;
    }
    const strobeBarBrightBeforeCap = barGateLimited ? 0 : rawStrobeBarBright;
    const strobeBarBright = stepDeliveredBrightness(
      this.audioModState,
      'bar',
      strobeBarBrightBeforeCap / 3.8,
      blackoutActive || darkOpening,
    ) * 3.8;
    if (!blackoutActive && !darkOpening && strobeBarBright < strobeBarBrightBeforeCap - 0.01) {
      mod.flashLimited = true;
    }
    const strobeBarDmxRate = strobeBarAudioMapped || b.strobe ? 0 : Math.round(255 * effectiveStrobe);
    const strobeBarFlash = !barGateLimited && (strobeBarAudioMapped ? strobeBarBright > 0.01 : (effectiveStrobe > 0.03 && strobeFlashOn));
    const previewBarDeliveredGate = stepPreviewDeliveredGate(
      this.previewFlashState,
      'bar',
      previewLimited ? deliveredBarGate : (effectiveStrobe > 0.03 ? (rawPreviewFlashOn ? 1.0 : 0.06) : deliveredBarGate),
      blackoutActive || darkOpening,
      previewLimited,
    );
    const previewBarSuppressed = previewLimited && previewBarDeliveredGate < 0.5 && deliveredBarGate >= 0.5;
    const previewStrobeBarFlash = previewLimited
      ? (!previewBarSuppressed && strobeBarFlash && strobeBarBright > 0.01)
      : (strobeBarAudioMapped ? (b.strobe ? rawPreviewFlashOn : strobeBarFlash) : (effectiveStrobe > 0.03 && rawPreviewFlashOn));
    const previewStrobeBarBright = previewLimited
      ? ((barGateLimited || previewBarSuppressed) ? 0 : (master > 1e-4 ? strobeBarBright * (previewMaster / master) : 0))
      : (effectiveStrobe > 0.03
          ? (rawPreviewFlashOn ? 3.8 * previewMaster : 0)
          : strobeBarBright);
    for (const st of this.strobes) {
      if (st.start) {
        const w = st.width ?? 2;
        const dimByte = Math.round(255 * strobeBarBright / 3.8);
        writeDmxChannels(st.buffer, st.start, w, [
          dimByte,
          strobeBarDmxRate,
        ]);
        const ps = this.physicalUnitScratch;
        ps.blackout = blackoutActive;
        writePhysicalUnitBytes(st.physBuffer, st.buffer, st.start, w, st.physicalClass, ps, this.physicalDmxScratch);
      }
      const strobeLensWhite = previewLimited
        ? (strobeBarAudioMapped
            ? (b.strobe && strobeFlashOn) || (mod.strobeBar.strobe.mapped && mod.strobeBar.strobe.gateOn)
            : strobeFlashOn)
        : (strobeBarAudioMapped
            ? (b.strobe && rawPreviewFlashOn) || (mod.strobeBar.strobe.mapped && mod.strobeBar.strobe.gateOn)
            : rawPreviewFlashOn);
      st.lensMat.color
        .copy(strobeLensWhite ? this.whiteColor : previewPrimaryColor)
        .multiplyScalar(previewStrobeBarBright);
    }
    this.strobeLight.intensity = previewStrobeBarFlash
      ? 65 * previewMaster * Math.min(1, previewStrobeBarBright / Math.max(0.01, 3.8 * previewMaster))
      : 0;

    // 5. Update Concert LED Video Wall Shaders
    const ledBright = rawLedBright;
    const previewLedBright = previewFlash.ledBright;
    const effLedSpeed = mod.active && mod.ledWall.speedMapped ? mod.ledWall.speed : s.led.speed;
    if (mod.active && mod.ledWall.speedMapped) {
      this.ledPhaseOffset += dt * ((0.4 + effLedSpeed * 2.2) - (0.4 + s.led.speed * 2.2));
    }
    for (const player of this.secondaryPlayers.values()) player.setMaster(previewMaster);
    const ledModeNum = LED_MODE_INDEX[s.led.visualMode];
    const ledFlashLimitedUniform = previewFlash.ledFlashLimited ? 1.0 : 0.0;
    for (const m of this.ledWallMats) {
      m.uniforms.uTime.value = t;
      m.uniforms.uPhaseOffset.value = this.ledPhaseOffset;
      m.uniforms.uMode.value = ledModeNum;
      m.uniforms.uBrightness.value = previewLedBright;
      m.uniforms.uSpeed.value = s.led.speed;
      m.uniforms.uColorA.value.copy(previewPrimaryColor);
      m.uniforms.uColorB.value.copy(previewAccentColor);
      m.uniforms.uBass.value = previewFlash.bass;
      m.uniforms.uMid.value = previewFlash.mid;
      m.uniforms.uHigh.value = previewFlash.high;
      m.uniforms.uBeatPulse.value = previewFlash.beatPulse;
      if (m.uniforms.uFlashLimited) m.uniforms.uFlashLimited.value = ledFlashLimitedUniform;
    }

    // 6. Stage Dynamic Spill Lights & DJ Booth Strip
    const rigHasLight = this.movingFixtures.length > 0;
    const effBeamIntSpill = previewFlash.beamIntensity;
    const effWashIntSpill = previewFlash.washIntensity;
    const spillStrobeGate = previewLimited
      ? (!b.strobe && mod.active && (mod.strobeBar.strobe.mapped || mod.strobeBar.dimmerMapped || (mod.beam.strobe.mapped && mod.wash.strobe.mapped))
          ? (mod.strobeBar.strobe.mapped
              ? (previewStrobeBarFlash ? 1.35 : 0.06)
              : (mod.beam.strobe.mapped && mod.wash.strobe.mapped
                  ? (groups.beam.previewGroupStrobeGate >= 0.5 || groups.wash.previewGroupStrobeGate >= 0.5 ? 1.35 : 0.06)
                  : 1.0))
          : Math.max(groups.beam.previewGroupStrobeGate, groups.wash.previewGroupStrobeGate))
      : Math.max(groups.beam.previewGroupStrobeGate, groups.wash.previewGroupStrobeGate);
    const activeLightPower = ((rigHasLight ? (effBeamIntSpill * 0.55 + effWashIntSpill * 0.72) * this.spillFluxGain : 0) +
      (this.laserUnits.length ? laserInt * 0.09 : 0)) * previewMaster * spillStrobeGate * roomGain;
    this.stagePrimaryLight.color.copy(previewPrimaryColor);
    this.stagePrimaryLight.intensity = activeLightPower * (24 + previewFlash.beatPulse * 14);
    this.stageAccentLight.color.copy(previewAccentColor);
    this.stageAccentLight.intensity = activeLightPower * (20 + previewFlash.beatPulse * 12);
    this.ledSpillLight.color.copy(previewPrimaryColor).lerp(previewAccentColor, 0.5);
    this.ledSpillLight.intensity = this.ledWallMats.length ? previewLedBright * (16 + previewFlash.beatPulse * 10) : 0;
    this.scenicKey.intensity = activeLightPower * 168 + previewBlinder * 80;
    for (const light of this.sideFills) light.intensity = activeLightPower * 113 + previewBlinder * 70;
    this.deckTrim?.color.copy(previewAccentColor).multiplyScalar(previewMaster * roomGain * 0.42);

    if (this.djStripMat) {
      this.djStripMat.color.copy(previewPrimaryColor).multiplyScalar(previewMaster * roomGain * (1.2 + previewFlash.beatPulse * 0.9));
    }

    for (const piece of this.scenicPieces.values()) {
      if (piece.air) {
        const travel = piece.kind === 'arch' ? 0.003 : 0.012;
        piece.air.rotation.z = Math.sin(t * 0.72 + piece.phase) * travel;
        piece.air.scale.z = 1 + Math.sin(t * 0.98 + piece.phase) * 0.007;
      }
      if (piece.lamps) piece.lamps.emissiveIntensity = previewMaster * roomGain * (1.35 + previewFlash.beatPulse * 0.38);
    }

    // 8. Animated Silhouetted Arena Crowd Bounce & Optional Show-Light Response!
    const cf = this.lastCrowdFrameInputs;
    cf.blackout = blackoutActive || darkOpening;
    cf.master = previewMaster;
    cf.roomGain = roomGain;
    cf.blinder = previewBlinder;
    cf.strobeBarBright = previewStrobeBarBright;
    cf.ledBright = previewLedBright;
    cf.hasLedWalls = this.ledWallMats.length > 0;
    cf.laserInt = laserInt;
    cf.hasLasers = this.laserUnits.length > 0;
    cf.primaryR = previewPrimaryColor.r;
    cf.primaryG = previewPrimaryColor.g;
    cf.primaryB = previewPrimaryColor.b;
    cf.accentR = previewAccentColor.r;
    cf.accentG = previewAccentColor.g;
    cf.accentB = previewAccentColor.b;
    cf.stageWidth = this.currentRig?.stageWidth ?? 22;
    cf.stageDepth = this.currentRig?.stageDepth ?? 11;

    const prof = this.profiler;
    const crowdStart = prof ? performance.now() : 0;
    if (this.crowdMesh && this.crowdBaseTransforms.length > 0) {
      // A seated house sways rather than jumps.
      const bounceAmp = (s.audioReactive && audio.playing ? 0.06 + audio.bass * 0.16 : 0.045) * (0.5 + previewMaster * 0.5)
        * (this.crowdSeated ? 0.12 : 1);
      const bounceFreq = (s.bpm / 60) * Math.PI * 2;
      for (let i = 0; i < this.crowdBaseTransforms.length; i++) {
        const c = this.crowdBaseTransforms[i];
        const hop = Math.abs(Math.sin(t * bounceFreq * 0.5 + c.phase)) * bounceAmp;
        this.crowdDummy.position.set(c.x, c.y + hop, c.z);
        this.crowdDummy.scale.set(1, c.scaleY + hop * 0.25, 1);
        this.crowdDummy.rotation.set(0, c.rotY, Math.sin(t * 2.2 + c.phase) * 0.05);
        this.crowdDummy.updateMatrix();
        this.crowdMesh.setMatrixAt(i, this.crowdDummy.matrix);
      }
      this.crowdMesh.instanceMatrix.needsUpdate = true;
      if (prof) {
        prof.curUploadBytes += (this.crowdMesh.instanceMatrix.array as Float32Array).byteLength;
      }
    }
    if (this.crowdLighting.isActive()) {
      this.crowdLighting.updateFromScene(this.movingFixtures, cf);
    }
    if (prof) prof.curCrowdMs = performance.now() - crowdStart;

    // 9. Camera Smooth Transitions & Arena Drone Orbit (updated before particle upload so depth sort matches this frame's view)
    if (!this.webXrLease && this.orbitAuto) {
      // Small rooms orbit inside their walls and under the ceiling.
      const room = this.room;
      const radius = room ? Math.max(3, room.halfWidth - 1.2) : 29;
      const angle = t * 0.16;
      this.camera.position.x = Math.sin(angle) * radius;
      this.camera.position.z = Math.cos(angle) * radius * 0.72 + 12;
      this.camera.position.y = room
        ? room.ceilingY * 0.6 + Math.sin(t * 0.28) * room.ceilingY * 0.15
        : 7.5 + Math.sin(t * 0.28) * 3.4;
      this.controls.target.lerp(this.cameraTargetLook, dt * 3);
    } else if (!this.webXrLease && this.cameraLerpActive) {
      this.camera.position.lerp(this.cameraTargetPos, Math.min(1, dt * 4.5));
      this.controls.target.lerp(this.cameraTargetLook, Math.min(1, dt * 4.5));
      if (this.camera.position.distanceTo(this.cameraTargetPos) < 0.08) {
        this.cameraLerpActive = false;
      }
    }
    if (!this.webXrLease) this.controls.update();

    // 10. Smoke Machines, Haze, & CO2 Cryo Cannons
    // Emergency blackout suppresses CO2, smoke, and haze after all modulation and bumps (preserving programmed levels underneath).
    const effSmoke = blackoutActive ? 0 : (b.smoke ? 1.0 : s.atmo.smokeOutput);
    const effCo2 = blackoutActive ? false : (b.co2 || s.atmo.co2Active || (s.atmo.co2AutoOnDrop && audio.drop && s.audioReactive));
    for (const fx of this.atmosphereDmx) {
      const output = fx.type === 'co2' ? Number(effCo2) : fx.type === 'smoke' ? effSmoke : effHaze;
      fx.buffer[fx.start - 1] = Math.round(output * 255);
      const ps = this.physicalUnitScratch;
      ps.blackout = blackoutActive;
      ps.smoke = effSmoke;
      writePhysicalUnitBytes(fx.physBuffer, fx.buffer, fx.start, fx.width ?? 1, fx.physicalClass, ps, this.physicalDmxScratch);
    }
    const particlesStart = prof ? performance.now() : 0;
    const stageTint = this.stageTintScratch.copy(previewPrimaryColor).lerp(previewAccentColor, 0.35);
    this.particles.group.visible = roomGain > 0 || effSmoke > 0 || effCo2;
    const pl = this.particles.isLitPuffsEnabled() ? this.buildParticleLightingUpdate() : undefined;
    this.particles.update(dt, t, effHaze, effSmoke, effCo2, stageTint, activeLightPower, pl);
    if (prof) prof.curParticlesMs = performance.now() - particlesStart;

    // Update arena fog slightly with haze density for rich depth
    this.fog.density = 0.008 + effHaze * 0.015;

    // Record applied per-group parameters for `?probe` `fixtureParams(group)` (zero per-frame allocations).
    const ap = this.appliedParams;
    ap.master = master;
    ap.legacyBoost = audioBoost;
    const bGrp = groups.beam;
    ap.beam.dimmer = Math.min(1.6, (bGrp.gMod?.dimmerMapped ? bGrp.gMod.dimmer : s.beamIntensity) * master * bGrp.groupStrobeGate * (1.0 + audioBoost * 0.48));
    ap.beam.zoom = bGrp.effZoom;
    ap.beam.colorMix = bGrp.colorMix;
    ap.beam.speed = bGrp.effSpeedNorm;
    ap.beam.tiltOffset = bGrp.tiltOffset;
    ap.beam.strobe.mode = bGrp.strobeMapped ? 'mapped' : 'unmapped';
    ap.beam.strobe.rate = bGrp.strobeMapped || b.strobe ? 0 : effectiveStrobe;
    ap.beam.strobe.envelope = bGrp.gMod?.strobe.envelope ?? 0;
    ap.beam.strobe.gateOn = bGrp.strobeMapped && !b.strobe ? (bGrp.gMod?.strobe.gateOn ?? false) : strobeFlashOn;
    ap.beam.strobe.lastFlashMs = bGrp.gMod?.strobe.lastFlashMs ?? -Infinity;
    ap.beam.strobe.limited = (bGrp.gMod?.strobe.limited ?? false) || (effectiveStrobe > 0.03 && combinedStrobe.limited);

    const wGrp = groups.wash;
    ap.wash.dimmer = Math.min(1.6, (wGrp.gMod?.dimmerMapped ? wGrp.gMod.dimmer : s.washIntensity) * master * wGrp.groupStrobeGate * (1.0 + audioBoost * 0.48));
    ap.wash.zoom = wGrp.effZoom;
    ap.wash.colorMix = wGrp.colorMix;
    ap.wash.speed = wGrp.effSpeedNorm;
    ap.wash.tiltOffset = wGrp.tiltOffset;
    ap.wash.strobe.mode = wGrp.strobeMapped ? 'mapped' : 'unmapped';
    ap.wash.strobe.rate = wGrp.strobeMapped || b.strobe ? 0 : effectiveStrobe;
    ap.wash.strobe.envelope = wGrp.gMod?.strobe.envelope ?? 0;
    ap.wash.strobe.gateOn = wGrp.strobeMapped && !b.strobe ? (wGrp.gMod?.strobe.gateOn ?? false) : strobeFlashOn;
    ap.wash.strobe.lastFlashMs = wGrp.gMod?.strobe.lastFlashMs ?? -Infinity;
    ap.wash.strobe.limited = (wGrp.gMod?.strobe.limited ?? false) || (effectiveStrobe > 0.03 && combinedStrobe.limited);

    ap.blinder.dimmer = effBlinder;
    ap.blinder.limited = (mod.active && mod.blinder.limited) || blinderGovLimited;

    ap.strobe.dimmer = strobeBarBright / 3.8;
    ap.strobe.limited = (mod.active && (mod.strobeBar.dimmerLimited || mod.strobeBar.strobe.limited)) || (effectiveStrobe > 0.03 && combinedStrobe.limited);
    ap.strobe.strobe.mode = mod.active && mod.strobeBar.strobe.mapped ? 'mapped' : 'unmapped';
    ap.strobe.strobe.rate = strobeBarDmxRate / 255;
    ap.strobe.strobe.envelope = mod.active ? mod.strobeBar.strobe.envelope : 0;
    ap.strobe.strobe.gateOn = mod.active && mod.strobeBar.strobe.mapped && !b.strobe ? mod.strobeBar.strobe.gateOn : strobeFlashOn;
    ap.strobe.strobe.lastFlashMs = mod.active ? mod.strobeBar.strobe.lastFlashMs : -Infinity;
    ap.strobe.strobe.limited = (mod.active && mod.strobeBar.strobe.limited) || (effectiveStrobe > 0.03 && combinedStrobe.limited);

    ap.ledWall.enabled = s.led.enabled;
    ap.ledWall.brightness = ledBright;
    ap.ledWall.speed = effLedSpeed;

    ap.laser.enabled = laserEnabled;
    ap.laser.audienceScan = s.laser.audienceScan;
    ap.laser.intensity = Math.min(1, baseLaserInt);
    ap.laser.speed = mod.active && mod.laser.speedMapped ? mod.laser.speed : s.laser.speed;
    ap.laser.rotation = mod.active && mod.laser.rotationMapped ? mod.laser.rotation : s.laser.rotation;
    ap.laser.spreadX = mod.active && mod.laser.spreadMapped ? mod.laser.spreadX : s.laser.spreadX;
    ap.laser.spreadY = mod.active && mod.laser.spreadMapped ? mod.laser.spreadY : s.laser.spreadY;
    ap.laser.strobe.mode = mod.active && mod.laser.strobe.mapped ? 'mapped' : 'unmapped';
    ap.laser.strobe.rate = mod.active && mod.laser.strobe.mapped ? 0 : s.laser.strobe;
    ap.laser.strobe.envelope = mod.active ? mod.laser.strobe.envelope : 0;
    ap.laser.strobe.gateOn = mod.active && mod.laser.strobe.mapped ? mod.laser.strobe.gateOn : false;
    ap.laser.strobe.lastFlashMs = mod.active ? mod.laser.strobe.lastFlashMs : -Infinity;
    ap.laser.strobe.limited = mod.active && mod.laser.strobe.limited;

    ap.haze.level = effHaze;
    ap.atmo.haze = effHaze;
    ap.atmo.smoke = effSmoke;
    ap.atmo.co2 = effCo2;

    this.refreshMeasureOverlayAndSnapshot(performance.now());
    return previewMaster > 0;
  }

  public dispose() {
    this.disposed = true;
    if (this.webXrLease) {
      const lease = this.webXrLease;
      lease.endReason = 'dispose';
      void lease.session.end().catch(() => {});
      this.restoreWebXrLease('dispose');
    }
    this.stopControlFallbackTimer();
    this.dmxFrameListener = undefined;
    for (const player of this.secondaryPlayers.values()) player.dispose();
    this.secondaryPlayers.clear();
    this.allLedMaterials = [];
    this.mediaGeneration++;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.profiler) {
      const p = this.profiler;
      this.profiler = null;
      this.batcher?.setSyncObserver(null);
      p.finish(this.gpuTimer);
    }
    this.gpuTimer?.dispose();
    this.gpuTimer = null;
    if (this.renderer?.domElement) {
      if (this.handleContextLostBound) {
        this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLostBound);
      }
      if (this.handleContextRestoredBound) {
        this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestoredBound);
      }
    }
    this.readPixelsBuf = null;
    this.resizeObserver?.disconnect();
    this.controls?.dispose();
    if (this.measureOverlay) {
      this.scene.remove(this.measureOverlay.group);
      this.measureOverlay.dispose();
      this.measureOverlay = null;
    }
    this.measureListener = undefined;
    this.liveSafetyMonitorEnabled = false;
    this.beamPools?.dispose();
    this.measureSurfacesCache = null;
    this.measureReachCache = null;
    this.lastNohdKey = '';
    this.lastNohdZones = [];
    this.measureRigRevision++;
    this.lastMeasureTickMs = -Infinity;
    this.detachIldaMeshes();
    this.activeIldaClip = null;
    this.batcher?.dispose();
    this.neonFrame?.dispose();
    this.crowdLighting?.dispose();
    this.releaseGroup(this.rigGroup);
    this.laserShapeGeometries.forEach(geometry => geometry.dispose());
    this.laserShapeGeometries.clear();
    this.laserShapes.clear();
    for (const piece of this.scenicPieces.values()) this.releaseGroup(piece.root);
    this.scenicPieces.clear();
    this.modelCache?.dispose();
    this.deckSheen?.dispose(this.mats?.stageDeck);
    disposeSharedMaterials(this.mats);
    this.environmentTarget?.dispose();
    if (this.composer) {
      this.composer.passes.forEach(pass => pass.dispose());
      this.composer.dispose();
    }
    this.particles?.dispose();
    this.textTex?.dispose();
    this.missingScreenTex?.dispose();
    if (this.customTex) this.customTex.dispose();
    if (this.customVideoEl) {
      this.customVideoEl.pause();
      this.customVideoEl.removeAttribute('src');
      this.customVideoEl.load();
    }
    if (this.renderer) {
      this.renderer.forceContextLoss();
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode === this.container) {
        this.container.removeChild(this.renderer.domElement);
      }
    }
  }
}
