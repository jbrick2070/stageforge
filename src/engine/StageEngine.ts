import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import {
  AudioMetrics,
  BumpState,
  CameraPreset,
  LaserColorMode,
  LaserPattern,
  LedVisualMode,
  RigConfig,
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
import {
  SharedMaterials,
  buildPlatformDeck,
  buildTrussGeometry,
  buildVenueArchitecture,
  createChainHoistUnit,
  createDjBooth,
  createLineArray,
  createMonitorWedge,
  createSubwoofer,
  createSharedMaterials,
} from './geometryBuilders';
import { buildDmxPatch } from '../data/dmxPatch';
import { stageSurfaceHeight } from '../data/stageDesign';
import { AtmosphericParticles } from './ParticleSystem';
import { BeamPools, MOVING_HEAD_OPTICS } from './beamPools';
import { fitAuthoredFoh } from './fohFraming';
import { buildScenicPiece, ScenicPiece } from './scenicProps';
import { SPEAKER_PROFILES } from '../data/speakerProfiles';
import { applyDemoLighting, DEMO_BLACKOUT_STEPS, demoFade } from '../data/demoLighting';

interface MovingFixtureInstance {
  type: 'beam' | 'wash';
  isFloor: boolean;
  index: number;
  fanPosition: number;
  openingStep: number;
  directedDimmer: number;
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
}

interface LaserUnitInstance {
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
  dmxUniverse: 1 | 2;
  dmxStart: number;
}

interface DmxOutput {
  buffer: Uint8Array;
  start: number;
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
const LED_WING_WIDTH = 5.4;
const LED_WING_GAP = 2.2;

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
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private mats: SharedMaterials;
  private environmentTarget: THREE.WebGLRenderTarget;
  private currentRig?: RigConfig;
  private beamPools?: BeamPools;
  private scenicPieces = new Map<string, ScenicPiece & { kind: string; phase: number }>();
  private deckTrim: THREE.MeshBasicMaterial | null = null;
  private scenicKey: THREE.SpotLight;
  private sideFills: THREE.SpotLight[] = [];
  private activeView: CameraPreset = 'foh';

  // Dynamic rig root so rebuilding templates is clean & leak-free
  private rigGroup = new THREE.Group();
  private particles: AtmosphericParticles;

  // Dynamic scene references
  private roofY = 15.8;
  private trussPods: TrussPodRuntime[] = [];
  private movingFixtures: MovingFixtureInstance[] = [];
  private laserUnits: LaserUnitInstance[] = [];
  private strobes: StrobeInstance[] = [];
  private blinders: BlinderInstance[] = [];
  private atmosphereDmx: (DmxOutput & { type: 'hazer' | 'smoke' | 'co2' })[] = [];
  private djStripMat: THREE.MeshBasicMaterial | null = null;
  private crowdMesh: THREE.InstancedMesh | null = null;
  private crowdBaseTransforms: { x: number; z: number; scaleY: number; phase: number; rotY: number }[] = [];
  private crowdDummy = new THREE.Object3D();

  // LED Wall
  private ledWallMats: THREE.ShaderMaterial[] = [];
  private textCanvas: HTMLCanvasElement;
  private textTex: THREE.CanvasTexture;
  private lastTourText = '';
  private customTex: THREE.Texture | null = null;
  private customVideoEl: HTMLVideoElement | null = null;
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

  // DMX Universe buffers (2 x 512 real channels!)
  public dmxUniverse1 = new Uint8Array(512);
  public dmxUniverse2 = new Uint8Array(512);

  // Animation loop state
  private rafId: number | null = null;
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

  constructor(
    container: HTMLElement,
    initialRig: RigConfig,
    initialState: ShowState,
    audioGetter: (dt: number) => AudioMetrics,
    onFrameTelemetry?: (metrics: AudioMetrics, fps: number) => void,
    private onMediaError?: (message: string) => void
  ) {
    this.container = container;
    this.currentState = initialState;
    this.audioGetter = audioGetter;
    this.onFrameTelemetry = onFrameTelemetry;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    // Renderer configured for HDR concert lighting + crisp specular reflections
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.96;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Scene & deep arena atmosphere
    this.scene = new THREE.Scene();
    this.scene.background = this.backgroundColor.clone();
    this.scene.fog = new THREE.FogExp2(this.fogColor, 0.015);

    // Generate dark metallic reflection environment map via PMREM
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x090c14);
    const envLight1 = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 6),
      new THREE.MeshBasicMaterial({ color: 0x3b6699, side: THREE.DoubleSide })
    );
    envLight1.position.set(0, 10, -10);
    const envLight2 = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 4),
      new THREE.MeshBasicMaterial({ color: 0x552266, side: THREE.DoubleSide })
    );
    envLight2.position.set(12, 6, 8);
    envLight2.rotation.y = -Math.PI / 2;
    envScene.add(envLight1, envLight2);
    const softbox = new THREE.Mesh(new THREE.PlaneGeometry(16, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.7, 1.55), side: THREE.DoubleSide }));
    softbox.position.set(-4, 12, 7);
    softbox.lookAt(0, 3, 0);
    envScene.add(softbox);
    this.environmentTarget = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = 0.55;
    for (const panel of [envLight1, envLight2, softbox]) {
      panel.geometry.dispose();
      panel.material.dispose();
    }
    pmrem.dispose();

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

    // Post-processing: HDR Render -> UnrealBloomPass -> OutputPass
    this.composer = new EffectComposer(this.renderer);
    this.composer.renderTarget1.samples = 2;
    this.composer.renderTarget2.samples = 2;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      initialState.bloomStrength,
      0.38,
      0.66
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

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

    this.mats = createSharedMaterials();

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
    this.particles = new AtmosphericParticles();
    this.scene.add(this.particles.group);

    this.rebuildRig(initialRig);
    this.setCameraPreset('foh');
    this.camera.position.copy(this.cameraTargetPos);
    this.controls.target.copy(this.cameraTargetLook);

    // Handle container resize cleanly
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    this.startLoop();
  }

  private handleResize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspectChanged = Math.abs(this.camera.aspect - w / h) > 0.01;
    this.camera.aspect = w / h;
    if (aspectChanged && this.activeView === 'foh' && this.fitFohOnResize) this.setCameraPreset('foh');
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  public previewRig() {
    this.standby = false;
  }

  public beginDemo(opening: ShowState) {
    this.standby = false;
    this.manualFadeStart = undefined;
    this.directedStep = 0;
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
    this.bloomPass.strength = state.bloomStrength;
    if (state.led.tourText !== this.lastTourText) {
      this.updateTourTextTexture(state.led.tourText);
    }
    if (state.led.customMediaUrl !== this.lastCustomUrl) {
      this.updateCustomLedMedia(state.led.customMediaUrl, state.led.customMediaType);
    }
  }

  public setBumpState(bump: BumpState) {
    if (Object.values(bump).some(Boolean)) this.previewRig();
    this.currentBump = bump;
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
          const rearLimit = rig?.venue === 'warehouse' ? 32 : rig?.venue === 'arena' ? 45 : 60;
          if (rig && (rig.platforms !== undefined || rig.trussPods.some(pod => pod.shape === 'path'))) {
            // The first rig child is the venue shell. Remaining children are stage equipment.
            const subjects = [...this.rigGroup.children.slice(1), ...Array.from(this.scenicPieces.values(), p => p.root)];
            const frame = fitAuthoredFoh(subjects, this.ledWallMats, this.camera.aspect, this.roofY, rearLimit, CAMERA_FOV);
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
          const wall = rig?.ledWall;
          const screenWidth = wall?.enabled ? wall.width + (wall.sideWings ? 2 * (LED_WING_WIDTH + LED_WING_GAP) : 0) : 0;
          const width = Math.max((this.currentRig?.stageWidth ?? 22) + 8, screenWidth + 1);
          const halfAngle = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
          const desiredZ = Math.max(25, 1 + width / (2 * halfAngle * this.camera.aspect));
          // Keep FOH under the roof (rear edge at z=35 in the warehouse, 51 in the arena).
          const z = Math.min(desiredZ, rearLimit);
          const stageFront = (this.currentRig?.stageDepth ?? 11) / 2;
          fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfAngle * (desiredZ - stageFront) / (z - stageFront)));
          this.cameraTargetPos.set(3.8, 6.6, z);
          this.cameraTargetLook.set(0, 5.8, -0.6);
        }
        break;
      case 'front_row':
        this.cameraTargetPos.set(0, 2.5, 11.4);
        this.cameraTargetLook.set(0, 6.2, -2.5);
        break;
      case 'wide_arena':
        this.cameraTargetPos.set(22, 12.8, 30.5);
        this.cameraTargetLook.set(0, 5.2, 0);
        break;
      case 'stage_side':
        this.cameraTargetPos.set(-14.5, 4.6, 5.5);
        this.cameraTargetLook.set(2.5, 5.5, 3.5);
        break;
      case 'pa_closeup': {
        const rig = this.currentRig;
        if (!rig) break;
        const x = -rig.stageWidth / 2 - 1.35;
        const z = rig.stageDepth / 2 - 0.4;
        if (rig.audioRig.lineArrays) {
          const y = Math.min(this.roofY - 1.65, 11.65) - (rig.audioRig.boxesPerSide ?? 9) * 0.185;
          this.cameraTargetPos.set(x - 2.4, y - 0.6, z + 6.1);
          this.cameraTargetLook.set(x + 0.55, y, z);
        } else {
          const monitors = rig.audioRig.monitorCount ?? 0;
          const speakerX = monitors > 1 ? -rig.stageWidth * 0.34 : 0;
          const speakerZ = monitors ? rig.stageDepth / 2 - 0.65 : rig.stageDepth / 2 + 0.6;
          const surfaceY = stageSurfaceHeight(rig, speakerX, speakerZ);
          const speakerY = surfaceY + (monitors ? 0.25 : rig.audioRig.subWall ? 0.5 : 0);
          this.cameraTargetPos.set(speakerX - 2.4, speakerY + 1.3, speakerZ + 4.7);
          this.cameraTargetLook.set(speakerX, speakerY, speakerZ);
        }
        break;
      }
      case 'overhead':
        this.cameraTargetPos.set(0.5, 22.0, 20.0);
        this.cameraTargetLook.set(0, 3.8, 0);
        break;
      case 'orbit':
        this.cameraTargetLook.set(0, 5.6, 0);
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

  private updateCustomLedMedia(url: string | null, type: 'image' | 'video' | null) {
    const generation = ++this.mediaGeneration;
    this.lastCustomUrl = url;
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
    for (const m of this.ledWallMats) {
      m.uniforms.uHasCustom.value = 0;
      m.uniforms.uCustomTex.value = this.textTex;
    }

    if (!url || !type) return;
    const failed = () => {
      if (generation !== this.mediaGeneration) return;
      this.updateCustomLedMedia(null, null);
      this.lastCustomUrl = url;
      this.onMediaError?.(`The LED wall could not open that ${type}. Choose another file.`);
    };

    if (type === 'video') {
      const video = document.createElement('video');
      video.src = url;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      video.play().catch(failed);
      this.customVideoEl = video;
      const vTex = new THREE.VideoTexture(video);
      vTex.colorSpace = THREE.SRGBColorSpace;
      this.customTex = vTex;
      for (const m of this.ledWallMats) {
        m.uniforms.uCustomTex.value = vTex;
        m.uniforms.uHasCustom.value = 1;
      }
    } else {
      new THREE.TextureLoader().load(url, (tex) => {
        if (generation !== this.mediaGeneration) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        this.customTex = tex;
        for (const m of this.ledWallMats) {
          m.uniforms.uCustomTex.value = tex;
          m.uniforms.uHasCustom.value = 1;
        }
      }, undefined, failed);
    }
  }

  private releaseGroup(group: THREE.Object3D) {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const shared = new Set<THREE.Material>(Object.values(this.mats));
    group.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.geometry) return;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!shared.has(material)) materials.add(material);
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
      if (desired.get(id)?.kind === old.kind) continue;
      old.root.removeFromParent();
      this.releaseGroup(old.root);
      this.scenicPieces.delete(id);
    }
    for (const [i, prop] of props.entries()) {
      let piece = this.scenicPieces.get(prop.id);
      if (!piece) {
        piece = { ...buildScenicPiece(prop, this.mats.fixtureBody), kind: prop.kind, phase: i * 1.91 };
        this.scenicPieces.set(prop.id, piece);
        this.scene.add(piece.root);
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

  public rebuildRig(rig: RigConfig) {
    const old = this.currentRig;
    this.currentRig = rig;
    this.syncScenery(rig);
    if (old && old.stageWidth === rig.stageWidth && old.stageHeight === rig.stageHeight &&
      old.platforms === rig.platforms &&
      old.stageDepth === rig.stageDepth && old.venue === rig.venue && old.audioRig === rig.audioRig &&
      old.ledWall === rig.ledWall && old.trussPods === rig.trussPods && old.floorFx === rig.floorFx) return;
    this.beamPools?.dispose();
    this.releaseGroup(this.rigGroup);
    this.dmxUniverse1.fill(0);
    this.dmxUniverse2.fill(0);
    this.trussPods = [];
    this.movingFixtures = [];
    this.laserUnits = [];
    this.strobes = [];
    this.blinders = [];
    this.atmosphereDmx = [];
    const patch = buildDmxPatch(rig);
    this.ledWallMats = [];
    this.djStripMat = null;

    // 1. Venue architecture + animated arena crowd
    const venueBuild = buildVenueArchitecture(rig.venue, rig.audioRig.crowdDensity, this.mats, rig.stageWidth, rig.stageDepth);
    this.rigGroup.add(venueBuild.group);
    this.houseColors = venueBuild.practicals.map(material => ({ color: material.color, full: material.color.clone() }));
    this.crowdMesh = venueBuild.crowdMesh;
    this.crowdBaseTransforms = venueBuild.crowdBaseTransforms;
    this.roofY = venueBuild.roofY;
    this.sideFills.forEach((light, i) => {
      const x = (i === 0 ? -1 : 1) * (rig.stageWidth / 2 + 1.35);
      light.position.set(x * 0.82, 8.0, rig.stageDepth / 2 + 8.5);
      light.target.position.set(x, Math.min(this.roofY - 2.3, 8.1), rig.stageDepth / 2);
    });

    // 2. Main Concert Stage Deck + Stairs + Edge Trim
    const stageGroup = new THREE.Group();
    this.deckTrim = null;
    if (rig.platforms !== undefined) {
      stageGroup.add(buildPlatformDeck(rig, this.mats));
    } else {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(rig.stageWidth, rig.stageHeight, rig.stageDepth), this.mats.stageDeck);
      deck.position.y = rig.stageHeight / 2;
      stageGroup.add(deck);

      const frontTrim = new THREE.Mesh(new THREE.BoxGeometry(rig.stageWidth + 0.1, 0.14, 0.12), this.mats.aluminumTruss);
      frontTrim.position.set(0, rig.stageHeight - 0.06, rig.stageDepth / 2 + 0.04);
      stageGroup.add(frontTrim);

      this.deckTrim = new THREE.MeshBasicMaterial();
      const edgeGlow = new THREE.Mesh(new THREE.BoxGeometry(rig.stageWidth - 0.6, 0.04, 0.04), this.deckTrim);
      edgeGlow.position.set(0, rig.stageHeight - 0.16, rig.stageDepth / 2 + 0.05);
      stageGroup.add(edgeGlow);

      for (const side of [-1, 1]) {
        for (let s = 0; s < 4; s++) {
          const step = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 0.45), this.mats.darkSteel);
          step.position.set(side * (rig.stageWidth / 2 + 0.72), 0.18 + s * (rig.stageHeight / 4),
            rig.stageDepth / 2 - 1.2 - s * 0.45);
          stageGroup.add(step);
        }
      }
    }

    // DJ / Live Console Booth
    if (rig.audioRig.djBooth) {
      const dj = createDjBooth(this.mats);
      dj.group.position.set(0, stageSurfaceHeight(rig, 0, 0.6), 0.6);
      stageGroup.add(dj.group);
      this.djStripMat = dj.stripMat;
    }

    // Hanging L-Acoustics Style Curved Line Arrays
    const speakerProfile = rig.audioRig.speakerProfile ?? 'touring';
    if (rig.audioRig.lineArrays) {
      const hangY = Math.min(this.roofY - 1.65, 11.65);
      for (const side of [-1, 1] as const) {
        const array = createLineArray(side, this.mats, rig.audioRig.boxesPerSide ?? 9, this.roofY - hangY, speakerProfile);
        array.position.set(side * (rig.stageWidth / 2 + 1.35), hangY, rig.stageDepth / 2 - 0.4);
        stageGroup.add(array);
      }
    }

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
        const sz = rig.stageDepth / 2 + sub.depth / 2 + 0.12;
        subGroup.position.set(sx, stageSurfaceHeight(rig, sx, sz) + (0.5 + level) * sub.height, sz);
        stageGroup.add(subGroup);
      }
    }

    const wedgeCount = Math.min(8, Math.max(0, Math.floor(rig.audioRig.monitorCount ?? 0)));
    for (let i = 0; i < wedgeCount; i++) {
      const x = wedgeCount === 1 ? 0 : (i / (wedgeCount - 1) - 0.5) * rig.stageWidth * 0.68;
      const wedge = createMonitorWedge(this.mats, speakerProfile);
      const z = rig.stageDepth * 0.5 - 0.65;
      wedge.position.set(x, stageSurfaceHeight(rig, x, z), z);
      wedge.rotation.y = x * 0.032;
      stageGroup.add(wedge);
    }
    this.rigGroup.add(stageGroup);

    // 3. Giant Concert LED Video Wall + Side IMAG Wings
    if (rig.ledWall.enabled) {
      const wallZ = -rig.stageDepth / 2 + 0.4;
      const wallY = stageSurfaceHeight(rig, 0, wallZ) + rig.ledWall.height / 2 + 0.35;
      const aspect = rig.ledWall.width / rig.ledWall.height;

      const ledMat = this.createLedMaterial(aspect);
      this.ledWallMats.push(ledMat);

      let wallGeo: THREE.BufferGeometry;
      if (rig.ledWall.curved) {
        // Gentle arena concave curve wrapping the upstage!
        // Keep the rack on the rear of the deck, behind the upstage truss.
        const radius = rig.ledWall.width * 6;
        const thetaLen = rig.ledWall.width / radius;
        wallGeo = new THREE.CylinderGeometry(
          radius,
          radius,
          rig.ledWall.height,
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
        wallMesh.position.set(0, wallY, wallZ + radius);
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
          depth: rig.ledWall.height + 0.20, bevelEnabled: false, curveSegments: 36,
        }), this.mats.darkSteel);
        housing.rotation.x = -Math.PI / 2;
        housing.position.set(0, wallY - rig.ledWall.height / 2 - 0.10, wallMesh.position.z);
        this.rigGroup.add(housing);
      } else {
        wallGeo = new THREE.PlaneGeometry(rig.ledWall.width, rig.ledWall.height);
        const wallMesh = new THREE.Mesh(wallGeo, ledMat);
        wallMesh.position.set(0, wallY, wallZ);
        this.rigGroup.add(wallMesh);

        // Dark rear structural frame behind flat LED wall
        const frame = new THREE.Mesh(
          new THREE.BoxGeometry(rig.ledWall.width + 0.5, rig.ledWall.height + 0.5, 0.35),
          this.mats.darkSteel
        );
        frame.position.set(0, wallY, wallZ - 0.22);
        this.rigGroup.add(frame);
      }

      // Optional Side IMAG Wings flanking the main stage
      if (rig.ledWall.sideWings) {
        const wingW = LED_WING_WIDTH;
        const wingH = rig.ledWall.height * 0.82;
        const wingMat = this.createLedMaterial(wingW / wingH);
        this.ledWallMats.push(wingMat);

        for (const side of [-1, 1]) {
          const wingGroup = new THREE.Group();
          const screen = new THREE.Mesh(new THREE.PlaneGeometry(wingW, wingH), wingMat);
          const backing = new THREE.Mesh(
            new THREE.BoxGeometry(wingW + 0.3, wingH + 0.3, 0.26),
            this.mats.darkSteel
          );
          backing.position.z = -0.16;
          wingGroup.add(screen, backing);
          wingGroup.position.set(
            side * (rig.ledWall.width / 2 + wingW / 2 + LED_WING_GAP),
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
      podGroup.position.set(pod.x, pod.baseY, pod.z);
      podGroup.rotation.y = pod.rotationY;

      const fixtureCount = pod.fixtures.reduce((count, group) => count + group.count, 0);
      const built = buildTrussGeometry(pod.shape, pod.width, this.mats, pod.path, fixtureCount);
      podGroup.add(built.group);

      // Attach CM Lodestar / Kinesys Chain Hoist Motors at every anchor point
      const hoists: { anchorLocal: THREE.Vector3; chainMesh: THREE.Mesh; root: THREE.Group }[] = [];
      for (const anchor of built.anchorPoints) {
        const hoist = createChainHoistUnit(this.mats);
        hoist.root.position.copy(anchor);
        podGroup.add(hoist.root);
        hoists.push({ anchorLocal: anchor.clone(), chainMesh: hoist.chainMesh, root: hoist.root });
      }

      // Interleave fixture families across the same bar and preserve their DMX order.
      const hung = pod.fixtures.flatMap(fg => Array.from({ length: fg.count }, (_, i) => ({
        fg, i, fraction: (i + 0.5) / fg.count,
      }))).sort((a, b) => a.fraction - b.fraction);
      hung.forEach(({ fg, i }, position) => {
        const slotIdx = Math.min(built.mountSlots.length - 1,
          Math.floor((position + 0.5) / hung.length * built.mountSlots.length));
        const slot = built.mountSlots[slotIdx];
        if (!slot) return;

        const start = patch.unitStart(fg, i);
        const buffer = fg.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
        if (fg.type === 'beam' || fg.type === 'wash') {
          const lateral = slot.pos.x * Math.cos(pod.rotationY) + slot.pos.z * Math.sin(pod.rotationY);
          const inst = this.createMovingFixture(
            fg.type,
            false,
            globalMovingIndex++,
            lateral / Math.max(2, pod.width / 2),
            fg.dmxUniverse,
            start
          );
          inst.root.position.copy(slot.pos);
          inst.root.rotation.y = slot.rotY;
          inst.mountYaw = pod.rotationY + slot.rotY;
          podGroup.add(inst.root);
          this.movingFixtures.push(inst);
        } else if (fg.type === 'laser') {
          const laser = this.createLaserProjector(
            globalLaserIndex++,
            false,
            fg.dmxUniverse,
            start
          );
          laser.root.position.copy(slot.pos).add(new THREE.Vector3(0, -0.1, 0.12));
          laser.root.rotation.y = pod.shape === 'circle' || pod.shape === 'path' ? -pod.rotationY : slot.rotY;
          podGroup.add(laser.root);
          this.laserUnits.push(laser);
        } else if (fg.type === 'strobe') {
          const st = this.createStrobeBar(globalStrobeIndex++);
          st.mesh.position.copy(slot.pos);
          st.mesh.rotation.y = slot.rotY;
          st.mesh.translateY(0.04).translateZ(0.24);
          podGroup.add(st.mesh);
          this.strobes.push({ lensMat: st.lensMat, index: st.index, buffer, start });
        } else if (fg.type === 'blinder') {
          const bl = this.createBlinderBank();
          bl.group.position.copy(slot.pos);
          bl.group.rotation.y = slot.rotY;
          bl.group.translateY(-0.04).translateZ(0.28);
          podGroup.add(bl.group);
          this.blinders.push({ lensMat: bl.lensMat, buffer, start });
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
      const count = Math.max(1, fx.count);
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : i / (count - 1);
        const px = fx.x + (count === 1 ? 0 : THREE.MathUtils.lerp(-fx.spread / 2, fx.spread / 2, t));
        const pz = fx.z;
        const py = stageSurfaceHeight(rig, px, pz);

        const start = patch.unitStart(fx, i);
        if (start && (fx.type === 'co2' || fx.type === 'smoke' || fx.type === 'hazer')) {
          this.atmosphereDmx.push({ type: fx.type, start, buffer: fx.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2 });
        }
        if (fx.type === 'co2') {
          const jet = this.createCo2JetUnit();
          jet.position.set(px, py, pz);
          this.rigGroup.add(jet);
          co2Emitters.push(new THREE.Vector3(px, py + 0.35, pz));
        } else if (fx.type === 'smoke') {
          const sm = this.createSmokeMachineUnit();
          sm.position.set(px, py, pz);
          this.rigGroup.add(sm);
          smokeEmitters.push(new THREE.Vector3(px, py + 0.32, pz));
        } else if (fx.type === 'hazer') {
          const hz = this.createHazerUnit();
          hz.position.set(px, py, pz);
          this.rigGroup.add(hz);
        } else if (fx.type === 'floor_laser') {
          const fl = this.createLaserProjector(
            globalLaserIndex++,
            true,
            fx.dmxUniverse,
            start
          );
          fl.root.position.set(px, py + 0.22, pz);
          this.rigGroup.add(fl.root);
          this.laserUnits.push(fl);
        } else if (fx.type === 'floor_beam') {
          const fb = this.createMovingFixture(
            'beam',
            true,
            globalMovingIndex++,
            px / Math.max(2, rig.stageWidth / 2),
            fx.dmxUniverse,
            start
          );
          fb.root.position.set(px, py + 0.08, pz);
          this.rigGroup.add(fb.root);
          this.movingFixtures.push(fb);
        }
      }
    }

    this.assignOpeningGroups(rig.stageWidth);
    this.particles.setEmitters(smokeEmitters, co2Emitters);
    this.beamPools = new BeamPools(this.movingFixtures.length, rig.stageWidth, rig.stageDepth, rig.stageHeight, rig.platforms);
    this.scene.add(this.beamPools.group);
    if (this.activeView === 'foh' && this.fitFohOnResize) this.setCameraPreset('foh');
    if (this.activeView === 'pa_closeup') this.setCameraPreset('pa_closeup');
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

  private createLedMaterial(aspect: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: LED_WALL_VERT,
      fragmentShader: LED_WALL_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMode: { value: 0 },
        uBrightness: { value: 0.85 },
        uSpeed: { value: 0.5 },
        uColorA: { value: new THREE.Color(0x00f0ff) },
        uColorB: { value: new THREE.Color(0xff00aa) },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uHigh: { value: 0 },
        uBeatPulse: { value: 0 },
        uCustomTex: { value: this.customTex || this.textTex },
        uTextTex: { value: this.textTex },
        uHasCustom: { value: this.customTex ? 1 : 0 },
        uAspect: { value: aspect },
      },
    });
  }

  private createMovingFixture(
    type: 'beam' | 'wash',
    isFloor: boolean,
    index: number,
    fanPosition: number,
    dmxUniverse: 1 | 2,
    dmxStart: number
  ): MovingFixtureInstance {
    const root = new THREE.Group();
    const dir = isFloor ? 1 : -1;

    // Base housing + truss clamp
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.16, 0.34), this.mats.fixtureBody);
    base.position.y = dir * 0.08;
    root.add(base);

    // Pan Yoke
    const yoke = new THREE.Group();
    yoke.position.y = dir * 0.18;
    root.add(yoke);

    const armH = 0.32;
    const armGeo = new THREE.BoxGeometry(0.06, armH, 0.12);
    const armL = new THREE.Mesh(armGeo, this.mats.fixtureBody);
    armL.position.set(-0.15, dir * (armH / 2), 0);
    const armR = armL.clone();
    armR.position.x = 0.15;
    yoke.add(armL, armR);

    // Tilt Head
    const head = new THREE.Group();
    head.position.y = dir * (armH - 0.04);
    yoke.add(head);

    const headR = type === 'wash' ? 0.16 : 0.13;
    const headBody = new THREE.Mesh(
      new THREE.CylinderGeometry(headR, headR * 0.88, 0.34, 14),
      this.mats.fixtureBody
    );
    head.add(headBody);

    // Glowing optical lens on emission end
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(headR * 0.82, 16), lensMat);
    lens.position.y = dir * 0.175;
    lens.rotation.x = isFloor ? -Math.PI / 2 : Math.PI / 2;
    head.add(lens);

    // Volumetric Light Cone (origin right at lens, extending along `dir * Y`)
    const { length: beamLen, nearRadius: topR, farRadius: botR } = MOVING_HEAD_OPTICS[type];
    const beamGeo = new THREE.CylinderGeometry(
      isFloor ? botR : topR,
      isFloor ? topR : botR,
      beamLen,
      20,
      1,
      true
    );
    // Shift so aperture is at y = 0 and beam shoots along `dir * Y`
    beamGeo.translate(0, dir * (beamLen / 2 + 0.17), 0);
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
        uColor: { value: new THREE.Color(0x00f0ff) },
        uIntensity: { value: 0.8 },
        uHaze: { value: 0.78 },
        uTime: { value: 0 },
        uPrism: { value: 0 },
        uSoftness: { value: type === 'wash' ? 2.4 : 1.55 },
        uSeed: { value: index * 0.731 },
      },
    });

    const beamMesh = new THREE.Mesh(beamGeo, beamMat);
    beamMesh.frustumCulled = false;
    head.add(beamMesh);

    return {
      type,
      isFloor,
      index,
      fanPosition,
      openingStep: DEMO_BLACKOUT_STEPS,
      directedDimmer: 0,
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
    };
  }

  private createLaserProjector(
    index: number,
    isFloor: boolean,
    dmxUniverse: 1 | 2,
    dmxStart: number
  ): LaserUnitInstance {
    const root = new THREE.Group();

    // KVANT Clubmax-style sleek black anodized laser projector chassis
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.28, 0.56), this.mats.fixtureBody);
    const frontBezel = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.24, 0.04), this.mats.darkSteel);
    frontBezel.position.z = 0.28;
    const warnStripe = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.03, 0.44), this.mats.hoistOrange);
    warnStripe.position.y = 0.11;

    const apertureMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
    const aperture = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.055), apertureMat);
    aperture.position.set(0, 0, 0.305);
    root.add(body, frontBezel, warnStripe, aperture);

    // 1. Volumetric Laser Sheet Geometry (pivoted cleanly at aperture, shooting +Z out over the arena!)
    const sheetLength = 38;
    const sheetGeo = new THREE.PlaneGeometry(16, sheetLength, 44, 24);
    // Remap vertices so uv.y = 0 is a tiny aperture width (0.14m) and uv.y = 1 fans out to 16m wide!
    const pos = sheetGeo.attributes.position;
    const uv = sheetGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i); // 0..1
      const v = uv.getY(i); // 0..1 (we'll map v=0 at projector, v=1 at far arena)
      const reach = 1 - v;
      uv.setY(i, reach);
      const fanWidth = THREE.MathUtils.lerp(0.14, 22.0, reach);
      const x = (u - 0.5) * fanWidth;
      const y = 0;
      const z = 0.31 + reach * sheetLength;
      pos.setXYZ(i, x, y, z);
    }
    sheetGeo.computeVertexNormals();

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

    // 2. Volumetric Laser Tunnel Cone (hollow expanding vortex aimed +Z out into the arena!)
    const coneLen = 38;
    const coneGeo = new THREE.CylinderGeometry(0.08, 7.8, coneLen, 48, 20, true);
    coneGeo.translate(0, -coneLen / 2, 0);
    coneGeo.rotateX(-Math.PI / 2); // now apex is at (0,0,0) and opens toward +Z!
    coneGeo.translate(0, 0, 0.31);

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
      dmxUniverse,
      dmxStart,
    };
  }

  private createStrobeBar(index: number) {
    const group = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.22, 0.16), this.mats.fixtureBody);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const tube = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.12), lensMat);
    tube.position.z = 0.085;
    group.add(housing, tube);
    return { mesh: group, lensMat, index };
  }

  private createBlinderBank() {
    const group = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.62, 0.22), this.mats.darkSteel);
    group.add(housing);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x181208 });
    for (const bx of [-0.16, 0.16]) {
      for (const by of [-0.14, 0.14]) {
        const pod = new THREE.Mesh(new THREE.CircleGeometry(0.115, 14), lensMat);
        pod.position.set(bx, by, 0.115);
        group.add(pod);
      }
    }
    return { group, lensMat };
  }

  private createCo2JetUnit(): THREE.Group {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.34), this.mats.darkSteel);
    base.position.y = 0.07;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.068, 0.36, 10), this.mats.chrome);
    barrel.position.set(0, 0.28, 0.04);
    barrel.rotation.x = 0.08;
    g.add(base, barrel);
    return g;
  }

  private createSmokeMachineUnit(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.26, 0.56), this.mats.fixtureBody);
    body.position.y = 0.13;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.18, 10), this.mats.aluminumTruss);
    nozzle.position.set(0, 0.28, 0.16);
    nozzle.rotation.x = 0.35;
    g.add(body, nozzle);
    return g;
  }

  private createHazerUnit(): THREE.Group {
    const g = new THREE.Group();
    const flightCase = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.44, 0.56), this.mats.darkSteel);
    flightCase.position.y = 0.22;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.04, 0.58), this.mats.aluminumTruss);
    trim.position.y = 0.43;
    g.add(flightCase, trim);
    return g;
  }

  private resolveLaserColors(mode: LaserColorMode, primary: THREE.Color, accent: THREE.Color): {
    cA: THREE.Color;
    cB: THREE.Color;
    modeNum: number;
  } {
    switch (mode) {
      case 'primary':
        return { cA: primary, cB: primary, modeNum: 0 };
      case 'dual':
        return { cA: primary, cB: accent, modeNum: 1 };
      case 'rainbow':
        return { cA: primary, cB: accent, modeNum: 2 };
      case 'cyan_magenta':
        return { cA: new THREE.Color(0x00f0ff), cB: new THREE.Color(0xff00aa), modeNum: 1 };
      case 'emerald_gold':
        return { cA: new THREE.Color(0x00ff66), cB: new THREE.Color(0xffcc00), modeNum: 1 };
      case 'crimson_ice':
        return { cA: new THREE.Color(0xff0044), cB: new THREE.Color(0x55d8ff), modeNum: 1 };
    }
  }

  private startLoop() {
    const animate = (now: number) => {
      this.rafId = requestAnimationFrame(animate);
      const elapsed = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 1 / 60;
      this.lastFrameTime = now;
      const dt = Math.min(0.08, elapsed);
      this.elapsed += dt;

      this.frameCounter++;
      this.fpsAccum += elapsed;
      if (this.fpsAccum >= 0.5) {
        this.currentFps = Math.round(this.frameCounter / this.fpsAccum);
        this.frameCounter = 0;
        this.fpsAccum = 0;
      }

      const audio = this.audioGetter(dt);
      if (this.updateScene(dt, audio)) this.composer.render();
      else this.clearStage();

      this.telemetryAccum += dt;
      if (this.onFrameTelemetry && this.telemetryAccum >= 0.05) {
        this.telemetryAccum = 0;
        this.onFrameTelemetry(audio, this.currentFps);
      }
    };
    this.rafId = requestAnimationFrame(animate);
  }

  private updateScene(dt: number, audio: AudioMetrics) {
    // The frame loop still clears the canvas and publishes telemetry while the desk is idle.
    if (this.standby) return false;
    const demo = this.currentState.autoDirector ? audio.demo : undefined;
    // Render opening fades on the audio clock, between the slower console readouts.
    const s = demo && demo.step < 224 ? applyDemoLighting(this.currentState, demo) : this.currentState;
    const b = this.currentBump;
    const t = this.elapsed;
    if (demo) this.directedStep = demo.step;
    const manualMix = demo ? 0 : this.manualFadeStart === undefined ? 1 : demoFade(t - this.manualFadeStart, 0, 0.8);
    if (manualMix === 1) {
      this.manualFadeStart = undefined;
      this.directedStep = undefined;
    }
    const openingStep = this.directedStep;

    // Effective master blackout / dimmer
    const darkOpening = demo && demo.step <= DEMO_BLACKOUT_STEPS;
    const master = s.blackout || darkOpening ? 0 : s.masterDimmer;
    const roomGain = openingStep === undefined ? 1 : THREE.MathUtils.lerp(demoFade(openingStep, 96, 208), 1, manualMix);
    this.houseAmbient.intensity = 0.36 * roomGain;
    this.scene.environmentIntensity = 0.55 * roomGain;
    (this.scene.background as THREE.Color).copy(this.backgroundColor).multiplyScalar(roomGain);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogColor).multiplyScalar(roomGain);
    for (const lamp of this.houseColors) lamp.color.copy(lamp.full).multiplyScalar(roomGain);
    const audioBoost = s.audioReactive && audio.playing ? audio.beatPulse * 0.45 + audio.bass * 0.35 : 0;
    const beatPulse = s.audioReactive && audio.playing ? audio.beatPulse : 0.15 * Math.max(0, Math.sin(t * (s.bpm / 60) * Math.PI));

    const primaryColor = new THREE.Color(s.primaryColor);
    const accentColor = new THREE.Color(s.accentColor);
    const tempCol = new THREE.Color();

    // Global Strobe gate
    const effectiveStrobe = b.strobe ? 0.92 : s.strobeRate;
    let strobeGate = 1.0;
    let strobeFlashOn = false;
    if (effectiveStrobe > 0.03) {
      const freq = 3.5 + effectiveStrobe * 24.0;
      strobeFlashOn = Math.sin(t * freq * Math.PI * 2) > 0.25;
      strobeGate = strobeFlashOn ? 1.35 : 0.06;
    }

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
      pod.currentY = THREE.MathUtils.lerp(pod.currentY, targetY, lerpRate);
      pod.currentTiltZ = THREE.MathUtils.lerp(pod.currentTiltZ, targetTiltZ, lerpRate);
      pod.currentTiltX = THREE.MathUtils.lerp(pod.currentTiltX, targetTiltX, lerpRate);

      pod.group.position.y = pod.currentY;
      pod.group.rotation.z = pod.currentTiltZ;
      pod.group.rotation.x = pod.currentTiltX;
      pod.group.updateMatrixWorld();

      // Update dynamic steel hoist chains so they stay vertical and locked straight to roofY!
      for (const h of pod.hoists) {
        const worldPos = new THREE.Vector3();
        h.root.getWorldPosition(worldPos);
        const chainLen = Math.max(0.5, this.roofY - worldPos.y - 0.32);
        h.chainMesh.scale.y = chainLen;
        // Counter-rotate chain slightly so steel hoist stays plumb vertical toward ceiling!
        h.root.rotation.z = -pod.currentTiltZ;
        h.root.rotation.x = -pod.currentTiltX;
      }
    });

    // 2. Update Moving Head Beams & Washes (Articulated Pan/Tilt + Volumetric Shaders)
    const moveSpd = 0.35 + s.movementSpeed * 3.1;
    const spread = 0.25 + s.movementSpread * 1.15;

    this.beamPools?.begin();
    for (const fx of this.movingFixtures) {
      const i = fx.index;
      const count = Math.max(1, this.movingFixtures.length);
      const norm = i / count;

      let targetPan = 0;
      let targetTilt = 0.28;

      switch (s.movementMode) {
        case 'manual':
          targetPan = s.manualPan * 1.45;
          targetTilt = s.manualTilt * 1.15;
          break;
        case 'fan':
          // Fan each bar symmetrically using its physical mounting position.
          targetPan = Math.PI * 0.5;
          targetTilt = -fx.fanPosition * (0.48 + Math.sin(t * moveSpd * 0.55) * 0.24) * spread;
          break;
        case 'sweep':
          targetPan = Math.sin(t * moveSpd + i * 0.22) * 1.1 * spread;
          targetTilt = 0.42 + Math.cos(t * moveSpd * 0.5) * 0.35 * spread;
          break;
        case 'circle':
          targetPan = Math.sin(t * moveSpd + i * 0.35) * 0.95 * spread;
          targetTilt = 0.45 + Math.cos(t * moveSpd + i * 0.35) * 0.48 * spread;
          break;
        case 'figure8':
          targetPan = Math.sin(t * moveSpd + i * 0.25) * 1.15 * spread;
          targetTilt = 0.4 + Math.sin(t * moveSpd * 2.0 + i * 0.25) * 0.42 * spread;
          break;
        case 'flyout':
          targetPan = ((i % 2 === 0 ? -1 : 1) * 0.4 + (norm - 0.5)) * spread;
          targetTilt = 0.1 + ((t * moveSpd * 0.55 + (i % 4) * 0.25) % 1.0) * 1.15;
          break;
        case 'wave':
          targetPan = (norm - 0.5) * 1.4 * spread;
          targetTilt = 0.42 + Math.sin(t * moveSpd * 1.4 - norm * 5.2) * 0.58 * spread;
          break;
        case 'ballyhoo':
          targetPan = Math.sin(t * moveSpd * 1.3 + i * 1.7) * 1.35 * spread;
          targetTilt = 0.35 + Math.cos(t * moveSpd * 1.7 + i * 2.3) * 0.65 * spread;
          break;
        case 'crowd_scan':
          targetPan = Math.sin(t * moveSpd * 0.9 + i * 0.4) * 0.85 * spread;
          targetTilt = 0.72 + Math.sin(t * moveSpd * 1.8 + i * 0.3) * 0.26 * spread;
          break;
      }

      // Pan is relative to the audience (+Z), even on a radial or rotated mount.
      // A ceiling head emits along local −Y, while its floor counterpart emits along +Y.
      targetPan -= fx.mountYaw;
      if (s.movementMode === 'fan') {
        if (fx.isFloor) targetTilt = -targetTilt;
      } else {
        if (!fx.isFloor) targetTilt = -targetTilt;
        else if (s.movementMode !== 'manual') targetTilt = Math.abs(targetTilt) * 0.65 + 0.15;
      }

      const moveFraction = Math.min(1, dt * 8);
      const turn = THREE.MathUtils.euclideanModulo(targetPan - fx.currentPan + Math.PI, 2 * Math.PI) - Math.PI;
      fx.currentPan += turn * moveFraction;
      if (Math.abs(fx.currentPan) > Math.PI) fx.currentPan -= Math.sign(fx.currentPan) * 2 * Math.PI;
      fx.currentTilt = THREE.MathUtils.lerp(fx.currentTilt, targetTilt, moveFraction);
      fx.yoke.rotation.y = fx.currentPan;
      fx.head.rotation.x = fx.currentTilt;

      // Fixture color resolution
      if (s.colorSplitMode === 'solid') {
        tempCol.copy(primaryColor);
      } else if (s.colorSplitMode === 'alternate') {
        tempCol.copy(i % 2 === 0 ? primaryColor : accentColor);
      } else if (s.colorSplitMode === 'gradient') {
        tempCol.copy(primaryColor).lerp(accentColor, norm);
      } else {
        tempCol.setHSL((norm + t * 0.12) % 1, 0.96, 0.55);
      }

      const firstPair = fx.openingStep === DEMO_BLACKOUT_STEPS;
      const groupGain = demo && !firstPair ? demoFade(demo.step, fx.openingStep, fx.openingStep + 12) : 1;
      let baseInt = fx.type === 'beam' ? s.beamIntensity : s.washIntensity;
      if (demo && firstPair && fx.type === 'wash' && demo.step < 128) {
        baseInt = THREE.MathUtils.lerp(s.beamIntensity, s.washIntensity, demoFade(demo.step, 96, 128));
      }
      // Release each lantern from its last rendered level, including fixtures still out.
      if (demo) fx.directedDimmer = groupGain * baseInt;
      const dimmer = manualMix < 1 ? THREE.MathUtils.lerp(fx.directedDimmer, baseInt, manualMix) : baseInt;
      const finalInt = Math.min(1.6, dimmer * master * strobeGate * (1.0 + audioBoost * 0.48));

      fx.beamMat.uniforms.uColor.value.copy(tempCol);
      fx.beamMat.uniforms.uIntensity.value = finalInt;
      fx.beamMat.uniforms.uHaze.value = s.atmo.hazeLevel;
      fx.beamMat.uniforms.uTime.value = t;
      fx.beamMat.uniforms.uPrism.value = s.goboPrism && fx.type === 'beam' ? 1.0 : 0.0;

      // Live Beam Zoom (narrow razor beam vs wide flood)
      const zoomScale = fx.type === 'wash' ? 0.75 + s.beamZoom * 0.85 : 0.42 + s.beamZoom * 1.35;
      fx.beamMesh.scale.set(zoomScale, 1, zoomScale);
      fx.beamMesh.visible = finalInt > 0.001;
      this.beamPools?.add(fx.beamMesh, fx.type, fx.isFloor, tempCol, finalInt);

      // Glowing optical fixture lens
      fx.lensMat.color.copy(tempCol).multiplyScalar(finalInt * 2.6);

      // Invalid or conflicting fixture footprints have start 0 and make no writes.
      const uBuf = fx.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
      const ch = fx.dmxStart - 1;
      if (ch >= 0) {
        uBuf[ch + 0] = Math.round(THREE.MathUtils.clamp((fx.currentPan / 3.14 + 0.5) * 255, 0, 255));
        uBuf[ch + 1] = Math.round(THREE.MathUtils.clamp((fx.currentTilt / 2.2 + 0.5) * 255, 0, 255));
        uBuf[ch + 2] = Math.round(THREE.MathUtils.clamp(finalInt * 255, 0, 255));
        uBuf[ch + 3] = Math.round(tempCol.r * 255);
        uBuf[ch + 4] = Math.round(tempCol.g * 255);
        uBuf[ch + 5] = Math.round(tempCol.b * 255);
        uBuf[ch + 6] = Math.round(s.beamZoom * 255);
        uBuf[ch + 7] = Math.round(effectiveStrobe * 255);
      }
    }

    this.beamPools?.finish();

    // 3. Update Volumetric RGB Laser Projectors
    const laserEnabled = (s.laser.enabled || b.laser) && master > 0.01;
    const laserInt = laserEnabled
      ? Math.min(1.5, (b.laser ? 1.0 : s.laser.intensity) * master * (1.0 + audioBoost * 0.38))
      : 0;
    const patIdx = PATTERN_INDEX[s.laser.pattern];
    const isConePattern = s.laser.pattern === 'tunnel' || s.laser.pattern === 'dual_cones';
    const laserColors = this.resolveLaserColors(s.laser.colorMode, primaryColor, accentColor);

    for (const l of this.laserUnits) {
      l.sheetMesh.visible = laserEnabled && !isConePattern;
      l.coneMesh.visible = laserEnabled && isConePattern;
      l.innerConeMesh.visible = laserEnabled && s.laser.pattern === 'dual_cones';

      // Laser pitch/tilt: audienceScan allows dipping into crowd, otherwise safely skims above crowd heads!
      const basePitch = l.isFloor ? -0.18 : s.laser.audienceScan ? 0.14 : -0.02;
      const userPitch = -s.laser.tilt * 0.34;
      const animPitch =
        s.laser.pattern === 'horizon'
          ? Math.sin(t * (0.8 + s.laser.speed * 2.2) + l.index * 0.5) * 0.18
          : 0;
      l.root.rotation.x = basePitch + userPitch + animPitch;

      // Subtle roll rotation on sheet patterns when rotation slider > 0
      const rollAngle = isConePattern
        ? 0
        : s.laser.pattern === 'matrix'
          ? (l.index % 2 === 0 ? 0.0 : Math.PI / 2) + t * s.laser.rotation * 0.65
          : Math.sin(t * s.laser.rotation * 1.4 + l.index) * s.laser.rotation * 0.55;
      l.sheetMesh.rotation.z = rollAngle;

      // Update sheet uniforms
      const su = l.sheetMat.uniforms;
      su.uColorA.value.copy(laserColors.cA);
      su.uColorB.value.copy(laserColors.cB);
      su.uColorMode.value = laserColors.modeNum;
      su.uIntensity.value = laserInt;
      su.uHaze.value = s.atmo.hazeLevel;
      su.uTime.value = t;
      su.uPattern.value = patIdx;
      su.uBeamCount.value = s.laser.beamCount;
      su.uSpeed.value = s.laser.speed;
      su.uSpreadX.value = s.laser.spreadX;
      su.uSpreadY.value = s.laser.spreadY;
      su.uStrobe.value = s.laser.strobe;
      su.uAudioPulse.value = beatPulse;

      // Update cone / dual cone uniforms
      for (const [cm, dirMult] of [
        [l.coneMat, 1],
        [l.innerConeMat, -1.45],
      ] as const) {
        const cu = cm.uniforms;
        cu.uColorA.value.copy(dirMult < 0 ? laserColors.cB : laserColors.cA);
        cu.uColorB.value.copy(dirMult < 0 ? laserColors.cA : laserColors.cB);
        cu.uColorMode.value = laserColors.modeNum;
        cu.uIntensity.value = laserInt;
        cu.uHaze.value = s.atmo.hazeLevel;
        cu.uTime.value = t;
        cu.uBeamCount.value = s.laser.beamCount;
        cu.uSpeed.value = s.laser.speed;
        cu.uSpreadX.value = s.laser.spreadX;
        cu.uSpreadY.value = s.laser.spreadY;
        cu.uRotation.value = s.laser.rotation * dirMult;
        cu.uStrobe.value = s.laser.strobe;
        cu.uAudioPulse.value = beatPulse;
      }

      l.apertureMat.color.copy(laserColors.cA).multiplyScalar(laserInt * 2.6);

      // Write Laser DMX Universe channels
      const uBuf = l.dmxUniverse === 1 ? this.dmxUniverse1 : this.dmxUniverse2;
      const ch = l.dmxStart - 1;
      if (ch >= 0) {
        uBuf[ch + 0] = Math.round(Math.min(1, laserInt) * 255);
        uBuf[ch + 1] = patIdx * 32;
        uBuf[ch + 2] = Math.round(s.laser.spreadX * 255);
        uBuf[ch + 3] = Math.round(s.laser.spreadY * 255);
        uBuf[ch + 4] = Math.round(s.laser.speed * 255);
        uBuf[ch + 5] = Math.round(s.laser.rotation * 255);
        uBuf[ch + 6] = Math.round((s.laser.beamCount / 32) * 255);
        uBuf[ch + 7] = Math.round(s.laser.strobe * 255);
      }
    }

    // 4. Update Audience Blinders & LED Strobes
    const effBlinder = (b.blinder ? 1.0 : s.blinderLevel) * master;
    const warmAmber = new THREE.Color(0xffbe55);
    for (const bl of this.blinders) {
      bl.lensMat.color.copy(warmAmber).multiplyScalar(effBlinder * 4.2);
      if (bl.start) bl.buffer[bl.start - 1] = Math.round(effBlinder * 255);
    }
    this.blinderLight.intensity = effBlinder * 75;

    const strobeBarBright =
      effectiveStrobe > 0.03 && strobeFlashOn
        ? 3.8 * master
        : s.audioReactive && audio.beat && master > 0.2
          ? 2.2 * master * (openingStep === undefined ? 1 : THREE.MathUtils.lerp(demoFade(openingStep, 256, 384), 1, manualMix))
          : 0;
    for (const st of this.strobes) {
      if (st.start) {
        st.buffer[st.start - 1] = Math.round(255 * strobeBarBright / 3.8);
        st.buffer[st.start] = Math.round(255 * effectiveStrobe);
      }
      st.lensMat.color
        .copy(strobeFlashOn ? new THREE.Color(0xffffff) : primaryColor)
        .multiplyScalar(strobeBarBright);
    }
    this.strobeLight.intensity = effectiveStrobe > 0.03 && strobeFlashOn ? 65 * master : 0;

    // 5. Update Concert LED Video Wall Shaders
    const ledBright = s.led.enabled ? s.led.brightness * master : 0;
    const ledModeNum = LED_MODE_INDEX[s.led.visualMode];
    for (const m of this.ledWallMats) {
      m.uniforms.uTime.value = t;
      m.uniforms.uMode.value = ledModeNum;
      m.uniforms.uBrightness.value = ledBright;
      m.uniforms.uSpeed.value = s.led.speed;
      m.uniforms.uColorA.value.copy(primaryColor);
      m.uniforms.uColorB.value.copy(accentColor);
      m.uniforms.uBass.value = s.audioReactive && audio.playing ? audio.bass : 0.35 + 0.2 * Math.sin(t * 3.1);
      m.uniforms.uMid.value = s.audioReactive && audio.playing ? audio.mid : 0.35 + 0.2 * Math.cos(t * 2.4);
      m.uniforms.uHigh.value = s.audioReactive && audio.playing ? audio.high : 0.28 + 0.2 * Math.sin(t * 4.5);
      m.uniforms.uBeatPulse.value = beatPulse;
    }

    // 6. Stage Dynamic Spill Lights & DJ Booth Strip
    const rigHasLight = this.movingFixtures.length > 0;
    const activeLightPower = ((rigHasLight ? s.beamIntensity * 0.55 + s.washIntensity * 0.72 : 0) +
      (this.laserUnits.length ? laserInt * 0.09 : 0)) * master * strobeGate * roomGain;
    this.stagePrimaryLight.color.copy(primaryColor);
    this.stagePrimaryLight.intensity = activeLightPower * (24 + beatPulse * 14);
    this.stageAccentLight.color.copy(accentColor);
    this.stageAccentLight.intensity = activeLightPower * (20 + beatPulse * 12);
    this.ledSpillLight.color.copy(primaryColor).lerp(accentColor, 0.5);
    this.ledSpillLight.intensity = this.ledWallMats.length ? ledBright * (16 + beatPulse * 10) : 0;
    this.scenicKey.intensity = activeLightPower * 168 + effBlinder * 80;
    for (const light of this.sideFills) light.intensity = activeLightPower * 113 + effBlinder * 70;
    this.deckTrim?.color.copy(accentColor).multiplyScalar(master * roomGain * 0.42);

    if (this.djStripMat) {
      this.djStripMat.color.copy(primaryColor).multiplyScalar(master * roomGain * (1.2 + beatPulse * 0.9));
    }

    for (const piece of this.scenicPieces.values()) {
      if (piece.air) {
        const travel = piece.kind === 'arch' ? 0.003 : 0.012;
        piece.air.rotation.z = Math.sin(t * 0.72 + piece.phase) * travel;
        piece.air.scale.z = 1 + Math.sin(t * 0.98 + piece.phase) * 0.007;
      }
      if (piece.lamps) piece.lamps.emissiveIntensity = master * roomGain * (1.35 + beatPulse * 0.38);
    }

    // 8. Animated Silhouetted Arena Crowd Bounce!
    if (this.crowdMesh && this.crowdBaseTransforms.length > 0) {
      const bounceAmp = (s.audioReactive && audio.playing ? 0.06 + audio.bass * 0.16 : 0.045) * (0.5 + master * 0.5);
      const bounceFreq = (s.bpm / 60) * Math.PI * 2;
      for (let i = 0; i < this.crowdBaseTransforms.length; i++) {
        const c = this.crowdBaseTransforms[i];
        const hop = Math.abs(Math.sin(t * bounceFreq * 0.5 + c.phase)) * bounceAmp;
        this.crowdDummy.position.set(c.x, hop, c.z);
        this.crowdDummy.scale.set(1, c.scaleY + hop * 0.25, 1);
        this.crowdDummy.rotation.set(0, c.rotY, Math.sin(t * 2.2 + c.phase) * 0.05);
        this.crowdDummy.updateMatrix();
        this.crowdMesh.setMatrixAt(i, this.crowdDummy.matrix);
      }
      this.crowdMesh.instanceMatrix.needsUpdate = true;
    }

    // 9. Smoke Machines, Haze, & CO2 Cryo Cannons
    const effSmoke = b.smoke ? 1.0 : s.atmo.smokeOutput;
    const effCo2 = b.co2 || s.atmo.co2Active || (s.atmo.co2AutoOnDrop && audio.drop && s.audioReactive);
    for (const fx of this.atmosphereDmx) {
      const output = fx.type === 'co2' ? Number(effCo2) : fx.type === 'smoke' ? effSmoke : s.atmo.hazeLevel;
      fx.buffer[fx.start - 1] = Math.round(output * 255);
    }
    const stageTint = primaryColor.clone().lerp(accentColor, 0.35);
    this.particles.group.visible = roomGain > 0 || b.smoke || b.co2;
    this.particles.update(dt, t, s.atmo.hazeLevel, effSmoke, effCo2, stageTint, activeLightPower);

    // Update arena fog slightly with haze density for rich depth
    (this.scene.fog as THREE.FogExp2).density = 0.008 + s.atmo.hazeLevel * 0.015;

    // 10. Camera Smooth Transitions & Arena Drone Orbit
    if (this.orbitAuto) {
      const radius = 29;
      const angle = t * 0.16;
      this.camera.position.x = Math.sin(angle) * radius;
      this.camera.position.z = Math.cos(angle) * radius * 0.72 + 12;
      this.camera.position.y = 7.5 + Math.sin(t * 0.28) * 3.4;
      this.controls.target.lerp(this.cameraTargetLook, dt * 3);
    } else if (this.cameraLerpActive) {
      this.camera.position.lerp(this.cameraTargetPos, Math.min(1, dt * 4.5));
      this.controls.target.lerp(this.cameraTargetLook, Math.min(1, dt * 4.5));
      if (this.camera.position.distanceTo(this.cameraTargetPos) < 0.08) {
        this.cameraLerpActive = false;
      }
    }
    this.controls.update();
    return master > 0;
  }

  public dispose() {
    this.mediaGeneration++;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.beamPools?.dispose();
    this.releaseGroup(this.rigGroup);
    for (const piece of this.scenicPieces.values()) this.releaseGroup(piece.root);
    this.scenicPieces.clear();
    const textures = new Set<THREE.Texture>();
    for (const material of Object.values(this.mats) as THREE.MeshStandardMaterial[]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
    textures.forEach(texture => texture.dispose());
    this.environmentTarget.dispose();
    this.composer.passes.forEach(pass => pass.dispose());
    this.composer.dispose();
    this.particles.dispose();
    this.textTex.dispose();
    if (this.customTex) this.customTex.dispose();
    if (this.customVideoEl) {
      this.customVideoEl.pause();
      this.customVideoEl.removeAttribute('src');
      this.customVideoEl.load();
    }
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
