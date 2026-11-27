import * as THREE from 'three';
import {
  XR_ARENA_EMULATOR_BUDGET,
  consumeInputEdge,
  createInputEdgeState,
  menuHitTest,
  offsetPoseForDesiredHead,
  snapYaw,
  viewpointHeadPose,
  type XrEyeMode,
  type XrInputEdgeState,
  type XrMenuHit,
  type XrMenuRect,
  type XrPoint3,
  type XrPose,
  type XrQualityProfile,
  type XrViewpoint,
  type XrViewpointId,
} from './audienceExperience';

export interface XrAudienceStatus {
  cueLabel: string;
  hazeLevel: number;
  demoPlaying: boolean;
  muted: boolean;
  limiterOverride: boolean;
  preflightLabel: string;
  laserLabel: string;
}

/** Deliberately preview-only capability surface: no physical output, files, AI, or generic mutation. */
export interface XrAudienceActions {
  goCue: () => void;
  backCue: () => void;
  setHaze: (level: number) => void;
  toggleDemo: () => void;
  toggleMute: () => void;
  setLimiterOverride: (enabled: boolean) => void;
  setQualityProfile: (profile: XrQualityProfile) => void;
  getStatus: () => XrAudienceStatus;
  requestExit: () => void;
}

export interface XrAudienceSceneConfig {
  viewpoints: readonly XrViewpoint[];
  eyeMode: XrEyeMode;
  qualityProfile: XrQualityProfile;
  actions: XrAudienceActions;
}

interface Button extends XrMenuRect {
  label: string;
}

const CANVAS_SIZE = 1024;
const MENU_WIDTH_M = 1.25;
const MENU_HEIGHT_M = 1.25;
const BLINK_SECONDS = 0.12;

const buttons: Button[] = [
  ...(['stage-front', 'floor', 'mezzanine', 'balcony', 'foh'] as const).map((id, index) => ({
    id: `seat:${id}`,
    label: id === 'stage-front' ? 'STAGE FRONT' : id.toUpperCase(),
    x: 32 + index * 194,
    y: 170,
    width: 180,
    height: 82,
  })),
  { id: 'snap:left', label: 'SNAP -30°', x: 32, y: 278, width: 220, height: 76 },
  { id: 'reset', label: 'RESET VIEW', x: 270, y: 278, width: 220, height: 76 },
  { id: 'snap:right', label: 'SNAP +30°', x: 508, y: 278, width: 220, height: 76 },
  { id: 'vignette', label: 'VIGNETTE', x: 746, y: 278, width: 246, height: 76 },
  { id: 'cue:back', label: 'CUE BACK', x: 32, y: 382, width: 180, height: 76 },
  { id: 'cue:go', label: 'CUE GO', x: 226, y: 382, width: 180, height: 76 },
  { id: 'haze:down', label: 'HAZE -', x: 420, y: 382, width: 140, height: 76 },
  { id: 'haze:up', label: 'HAZE +', x: 574, y: 382, width: 140, height: 76 },
  { id: 'demo', label: 'DEMO PLAY', x: 728, y: 382, width: 126, height: 76 },
  { id: 'mute', label: 'MUTE', x: 868, y: 382, width: 124, height: 76 },
  { id: 'eye:seated', label: 'SEATED 1.2 m', x: 32, y: 486, width: 220, height: 76 },
  { id: 'eye:standing', label: 'STANDING 1.6 m', x: 270, y: 486, width: 220, height: 76 },
  { id: 'limiter', label: 'LIMIT ≤3/s', x: 508, y: 486, width: 484, height: 76 },
  { id: 'quality:standalone-low', label: 'STANDALONE LOW · NEXT ENTRY', x: 32, y: 590, width: 470, height: 76 },
  { id: 'quality:pc-link-high', label: 'PC LINK HIGH · NEXT ENTRY', x: 522, y: 590, width: 470, height: 76 },
  { id: 'menu:close', label: 'HIDE MENU · TRIGGER OR GRIP TO REOPEN', x: 32, y: 730, width: 960, height: 76 },
  { id: 'exit', label: 'EXIT VR', x: 32, y: 872, width: 960, height: 92 },
];

function poseFromTransform(transform: XRRigidTransform): XrPose {
  return {
    position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
    orientation: {
      x: transform.orientation.x,
      y: transform.orientation.y,
      z: transform.orientation.z,
      w: transform.orientation.w,
    },
  };
}

export class WebXrAudienceScene {
  private readonly root = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly menuMaterial: THREE.MeshBasicMaterial;
  private readonly menu: THREE.Mesh;
  private readonly fadeMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
  private readonly fade: THREE.Mesh;
  private readonly vignetteMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.72, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  private readonly vignette: THREE.Mesh;
  private readonly rayGeometry: THREE.BufferGeometry;
  private readonly rayMaterial = new THREE.LineBasicMaterial({ color: 0x55e7ff, transparent: true, opacity: 0.85 });
  private readonly reticleGeometry = new THREE.RingGeometry(0.008, 0.014, 20);
  private readonly reticleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false });
  private readonly controllers: Array<{ group: THREE.Group; ray: THREE.Line; reticle: THREE.Mesh; cleanups: Array<() => void> }> = [];
  private readonly edgeState: XrInputEdgeState = createInputEdgeState();
  private readonly overlayForward = new THREE.Vector3();
  private readonly controllerWorldOrigin = new THREE.Vector3();
  private readonly controllerWorldEnd = new THREE.Vector3();
  private readonly controllerLocalOrigin = new THREE.Vector3();
  private readonly controllerLocalEnd = new THREE.Vector3();
  private readonly menuHitScratch: XrMenuHit = { id: '', pixelX: 0, pixelY: 0, distance: 0 };
  private baseHeadPose: XrPose | null = null;
  private currentViewpoint: XrViewpoint;
  private eyeMode: XrEyeMode;
  private yawOffset = 0;
  private vignetteEnabled = false;
  private limiterConfirmArmed = false;
  private nextQuality: XrQualityProfile;
  private dirty = true;
  private lastStatusDraw = -Infinity;
  private frameSerial = 0;
  private inputEnabled = false;
  private blink: 'out' | 'in' | null = 'out';
  private blinkStarted = 0;
  private teleportPending = true;
  private optionalFrames = 0;
  private visible = true;
  private readonly blockedSeatButtons: ReadonlySet<string>;
  private readonly interactiveButtons: readonly Button[];
  private menuOpen = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly session: XRSession,
    private readonly baseReferenceSpace: XRReferenceSpace,
    private readonly config: XrAudienceSceneConfig,
  ) {
    const initial = config.viewpoints.find((seat) => seat.id === 'floor' && !seat.blocked)
      ?? config.viewpoints.find((seat) => !seat.blocked);
    if (!initial) throw new Error('VR audience mode has no clear viewpoints.');
    this.blockedSeatButtons = new Set(config.viewpoints.filter((seat) => seat.blocked).map((seat) => `seat:${seat.id}`));
    this.interactiveButtons = buttons.filter((button) => !this.blockedSeatButtons.has(button.id));
    this.currentViewpoint = initial;
    this.eyeMode = config.eyeMode;
    this.nextQuality = config.qualityProfile;

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('VR menu canvas is unavailable.');
    this.context = context;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.menuMaterial = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide, depthTest: true });
    this.menu = new THREE.Mesh(new THREE.PlaneGeometry(MENU_WIDTH_M, MENU_HEIGHT_M), this.menuMaterial);
    this.menu.name = 'VR preview menu';
    this.root.add(this.menu);

    this.fade = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), this.fadeMaterial);
    this.fade.renderOrder = 10_000;
    this.fade.frustumCulled = false;
    this.root.add(this.fade);
    this.vignette = new THREE.Mesh(new THREE.RingGeometry(0.10, 0.95, 48), this.vignetteMaterial);
    this.vignette.renderOrder = 9_999;
    this.vignette.frustumCulled = false;
    this.vignette.visible = false;
    this.root.add(this.vignette);

    this.rayGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -4)]);
    for (let i = 0; i < 2; i++) this.addController(i);
    this.scene.add(this.root);
    this.placeMenu();
    this.drawMenu();
  }

  private addController(index: number) {
    const group = this.renderer.xr.getController(index);
    const ray = new THREE.Line(this.rayGeometry, this.rayMaterial);
    ray.name = `VR controller ray ${index + 1}`;
    const reticle = new THREE.Mesh(this.reticleGeometry, this.reticleMaterial);
    reticle.position.z = -2;
    reticle.visible = false;
    group.add(ray, reticle);
    this.scene.add(group);
    const cleanups: Array<() => void> = [];
    for (const kind of ['select', 'squeeze'] as const) {
      const start = () => this.handleInput(index, kind, true);
      const end = () => this.handleInput(index, kind, false);
      group.addEventListener(`${kind}start`, start);
      group.addEventListener(`${kind}end`, end);
      cleanups.push(() => group.removeEventListener(`${kind}start`, start));
      cleanups.push(() => group.removeEventListener(`${kind}end`, end));
    }
    this.controllers.push({ group, ray, reticle, cleanups });
  }

  private handleInput(index: number, kind: 'select' | 'squeeze', pressed: boolean) {
    const accepted = consumeInputEdge(this.edgeState, `controller-${index}`, kind, pressed, this.frameSerial);
    if (!accepted || !this.inputEnabled || !this.visible) return;
    if (!this.menuOpen) {
      const camera = this.renderer.xr.getCamera();
      const position = camera.getWorldPosition(new THREE.Vector3());
      const orientation = camera.getWorldQuaternion(new THREE.Quaternion());
      this.placeMenu({ position, orientation });
      this.setMenuOpen(true);
      return;
    }
    const hit = this.controllerHit(this.controllers[index]);
    if (hit) this.activate(hit);
  }

  private controllerHit(controller: { group: THREE.Group }): string | null {
    if (!this.menuOpen) return null;
    this.menu.updateWorldMatrix(true, false);
    controller.group.updateWorldMatrix(true, false);
    const worldOrigin = this.controllerWorldOrigin.setFromMatrixPosition(controller.group.matrixWorld);
    const worldEnd = this.controllerWorldEnd.set(0, 0, -1).applyMatrix4(controller.group.matrixWorld);
    const localOrigin = this.menu.worldToLocal(this.controllerLocalOrigin.copy(worldOrigin));
    const localEnd = this.menu.worldToLocal(this.controllerLocalEnd.copy(worldEnd));
    const hit = menuHitTest(
      { x: localOrigin.x / MENU_WIDTH_M, y: localOrigin.y / MENU_HEIGHT_M, z: localOrigin.z },
      {
        x: (localEnd.x - localOrigin.x) / MENU_WIDTH_M,
        y: (localEnd.y - localOrigin.y) / MENU_HEIGHT_M,
        z: localEnd.z - localOrigin.z,
      },
      CANVAS_SIZE,
      CANVAS_SIZE,
      this.interactiveButtons,
      this.menuHitScratch,
    );
    return hit?.id ?? null;
  }

  private beginTeleport(viewpoint = this.currentViewpoint) {
    this.currentViewpoint = viewpoint;
    this.inputEnabled = false;
    this.teleportPending = true;
    this.blink = 'out';
    this.blinkStarted = performance.now() / 1000;
    this.fade.visible = true;
    this.dirty = true;
  }

  private applyTeleport(frame: XRFrame) {
    const pose = frame.getViewerPose(this.baseReferenceSpace);
    if (!pose) return false;
    const baseHead = poseFromTransform(pose.transform);
    this.baseHeadPose = baseHead;
    const desired = viewpointHeadPose(this.currentViewpoint, this.eyeMode, this.yawOffset);
    const offset = offsetPoseForDesiredHead(baseHead, desired);
    const referenceSpace = this.baseReferenceSpace.getOffsetReferenceSpace(new XRRigidTransform(
      offset.position,
      offset.orientation,
    ));
    this.renderer.xr.setReferenceSpace(referenceSpace);
    this.teleportPending = false;
    this.placeMenu();
    return true;
  }

  private placeMenu(pose = viewpointHeadPose(this.currentViewpoint, this.eyeMode, this.yawOffset)) {
    const q = new THREE.Quaternion(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    this.menu.position.set(pose.position.x, pose.position.y, pose.position.z).addScaledVector(forward, 1.45);
    this.menu.quaternion.copy(q);
    this.menu.updateMatrixWorld(true);
  }

  private setMenuOpen(open: boolean) {
    this.menuOpen = open;
    this.menu.visible = open;
    for (const { ray, reticle } of this.controllers) {
      ray.visible = open;
      reticle.visible = false;
    }
    if (!open) {
      this.limiterConfirmArmed = false;
      this.config.actions.setLimiterOverride(false);
    }
    this.dirty = true;
  }

  private activate(id: string) {
    const seatId = id.startsWith('seat:') ? id.slice(5) as XrViewpointId : null;
    if (seatId) {
      const viewpoint = this.config.viewpoints.find((seat) => seat.id === seatId);
      if (viewpoint && !viewpoint.blocked) {
        this.yawOffset = 0;
        this.beginTeleport(viewpoint);
      }
      return;
    }
    switch (id) {
      case 'snap:left': this.yawOffset = snapYaw(this.yawOffset, -1); this.beginTeleport(); break;
      case 'snap:right': this.yawOffset = snapYaw(this.yawOffset, 1); this.beginTeleport(); break;
      case 'reset': this.yawOffset = 0; this.beginTeleport(); break;
      case 'vignette': this.vignetteEnabled = !this.vignetteEnabled; this.vignette.visible = this.vignetteEnabled; break;
      case 'cue:back': this.config.actions.backCue(); break;
      case 'cue:go': this.config.actions.goCue(); break;
      case 'haze:down': this.config.actions.setHaze(Math.max(0, this.config.actions.getStatus().hazeLevel - 0.1)); break;
      case 'haze:up': this.config.actions.setHaze(Math.min(1, this.config.actions.getStatus().hazeLevel + 0.1)); break;
      case 'demo': this.config.actions.toggleDemo(); break;
      case 'mute': this.config.actions.toggleMute(); break;
      case 'eye:seated': this.eyeMode = 'seated'; this.beginTeleport(); break;
      case 'eye:standing': this.eyeMode = 'standing'; this.beginTeleport(); break;
      case 'limiter': {
        const active = this.config.actions.getStatus().limiterOverride;
        if (active) {
          this.config.actions.setLimiterOverride(false);
          this.limiterConfirmArmed = false;
        } else if (this.limiterConfirmArmed) {
          this.config.actions.setLimiterOverride(true);
          this.limiterConfirmArmed = false;
        } else {
          this.limiterConfirmArmed = true;
        }
        break;
      }
      case 'quality:standalone-low': this.nextQuality = 'standalone-low'; this.config.actions.setQualityProfile(this.nextQuality); break;
      case 'quality:pc-link-high': this.nextQuality = 'pc-link-high'; this.config.actions.setQualityProfile(this.nextQuality); break;
      case 'menu:close': this.setMenuOpen(false); break;
      case 'exit': this.config.actions.requestExit(); break;
    }
    this.dirty = true;
    if (this.menuOpen) this.drawMenu();
  }

  private drawMenu() {
    const ctx = this.context;
    const status = this.config.actions.getStatus();
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = 'rgba(5, 10, 20, 0.94)';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.strokeStyle = '#37d9ff';
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, CANVAS_SIZE - 20, CANVAS_SIZE - 20);
    ctx.fillStyle = '#d9f8ff';
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText('STAGEFORGE · VR PREVIEW', 32, 58);
    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#a8cbd6';
    ctx.fillText(`${status.cueLabel}  ·  Haze ${Math.round(status.hazeLevel * 100)}%  ·  ${status.demoPlaying ? 'Demo playing' : 'Demo paused'}${status.muted ? ' · MUTED' : ''}`, 32, 98);
    ctx.fillStyle = status.preflightLabel.toLowerCase().includes('blocked') ? '#ff9a9a' : '#ffe08a';
    ctx.fillText(`Pre-flight: ${status.preflightLabel}`, 32, 132);
    ctx.fillStyle = '#ffcc85';
    ctx.fillText(status.laserLabel, 500, 132);
    for (const button of buttons) {
      const blocked = this.blockedSeatButtons.has(button.id);
      let label = blocked ? `${button.label} · BLOCKED` : button.label;
      const selected =
        (button.id === `seat:${this.currentViewpoint.id}`) ||
        (button.id === `eye:${this.eyeMode}`) ||
        (button.id === 'vignette' && this.vignetteEnabled) ||
        (button.id === `quality:${this.nextQuality}`);
      if (button.id === 'demo') label = status.demoPlaying ? 'DEMO PAUSE' : 'DEMO PLAY';
      if (button.id === 'mute') label = status.muted ? 'UNMUTE' : 'MUTE';
      if (button.id === 'limiter') {
        label = status.limiterOverride
          ? 'FULL-RATE PREVIEW · TAP TO LIMIT ≤3/s'
          : this.limiterConfirmArmed
            ? 'TAP AGAIN: ALLOW FULL-RATE PREVIEW'
            : 'PREVIEW LIMIT ≤3/s · TAP TO OVERRIDE';
      }
      ctx.fillStyle = selected ? '#134d63' : '#162333';
      ctx.fillRect(button.x, button.y, button.width, button.height);
      ctx.strokeStyle = selected ? '#63e7ff' : '#4f6b7c';
      ctx.lineWidth = selected ? 4 : 2;
      ctx.strokeRect(button.x, button.y, button.width, button.height);
      ctx.fillStyle = blocked ? '#99aab7' : '#e8fbff';
      ctx.font = `bold ${button.id === 'limiter' ? 22 : 20}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, button.x + button.width / 2, button.y + button.height / 2, button.width - 14);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#99aab7';
    ctx.font = '20px sans-serif';
    ctx.fillText('Fixed viewpoints · trigger or grip selects a highlighted control', 32, 699, CANVAS_SIZE - 64);
    ctx.fillText('Quality applies on next entry · device caps scenery, particles and lasers', 32, 722, CANVAS_SIZE - 64);
    ctx.fillText('Simulation preview only · headset safety, comfort and performance require hardware checks', 32, 832, CANVAS_SIZE - 64);
    ctx.fillText('Mezzanine and balcony may use virtual viewpoints depending on the venue', 32, 856, CANVAS_SIZE - 64);
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.lastStatusDraw = performance.now();
  }

  public setVisible(visible: boolean) {
    this.visible = visible;
    this.root.visible = visible;
    for (const controller of this.controllers) controller.group.visible = visible;
    if (!visible) {
      this.inputEnabled = false;
      this.edgeState.held.clear();
      this.limiterConfirmArmed = false;
      this.config.actions.setLimiterOverride(false);
      this.dirty = true;
    } else if (!this.blink) {
      this.inputEnabled = true;
      this.dirty = true;
    }
  }

  public update(frame: XRFrame | undefined, timeSeconds: number, xrCamera: THREE.ArrayCamera) {
    this.frameSerial++;
    if (!this.visible || !frame) return;
    this.optionalFrames++;
    const forward = this.overlayForward.set(0, 0, -0.11).applyQuaternion(xrCamera.quaternion);
    this.fade.position.copy(xrCamera.position).add(forward);
    this.fade.quaternion.copy(xrCamera.quaternion);
    this.vignette.position.copy(xrCamera.position).add(forward);
    this.vignette.quaternion.copy(xrCamera.quaternion);
    if (this.blink === 'out') {
      const p = Math.min(1, (timeSeconds - this.blinkStarted) / BLINK_SECONDS);
      this.fadeMaterial.opacity = p;
      if (p >= 1 && this.teleportPending && this.applyTeleport(frame)) {
        this.blink = 'in';
        this.blinkStarted = timeSeconds;
      }
    } else if (this.blink === 'in') {
      const p = Math.min(1, (timeSeconds - this.blinkStarted) / BLINK_SECONDS);
      this.fadeMaterial.opacity = 1 - p;
      if (p >= 1) {
        this.blink = null;
        this.fade.visible = false;
        this.inputEnabled = true;
      }
    }
    for (const controller of this.controllers) {
      const hit = this.controllerHit(controller);
      controller.reticle.visible = Boolean(hit) && this.inputEnabled;
    }
    if (this.menuOpen && (this.dirty || performance.now() - this.lastStatusDraw > 500)) this.drawMenu();
  }

  public activateForTest(id: string) {
    if (!buttons.some((button) => button.id === id)) throw new Error(`Unknown VR menu action: ${id}`);
    this.activate(id);
  }

  public diagnostics() {
    const status = this.config.actions.getStatus();
    return {
      currentViewpoint: this.currentViewpoint.id,
      menuOpen: this.menuOpen,
      blockedViewpoints: this.config.viewpoints.filter((seat) => seat.blocked).map((seat) => seat.id),
      eyeMode: this.eyeMode,
      yawOffsetDeg: Math.round(this.yawOffset * 180 / Math.PI),
      vignette: this.vignetteEnabled,
      limiterConfirmArmed: this.limiterConfirmArmed,
      nextQuality: this.nextQuality,
      currentQuality: this.config.qualityProfile,
      smoothLocomotion: false,
      inputEnabled: this.inputEnabled,
      blink: this.blink,
      optionalFrames: this.optionalFrames,
      ownedTextures: 1,
      controllerCount: this.controllers.length,
      buttons: buttons.map((button) => button.id),
      status,
      emulatorBudget: XR_ARENA_EMULATOR_BUDGET,
      baseHeadPose: this.baseHeadPose,
      desiredHeadPose: viewpointHeadPose(this.currentViewpoint, this.eyeMode, this.yawOffset),
      menuPose: {
        position: { x: this.menu.position.x, y: this.menu.position.y, z: this.menu.position.z },
        orientation: { x: this.menu.quaternion.x, y: this.menu.quaternion.y, z: this.menu.quaternion.z, w: this.menu.quaternion.w },
      },
    };
  }

  public dispose() {
    this.config.actions.setLimiterOverride(false);
    for (const controller of this.controllers) {
      controller.cleanups.forEach((cleanup) => cleanup());
      controller.group.remove(controller.ray, controller.reticle);
      this.scene.remove(controller.group);
    }
    this.controllers.length = 0;
    this.scene.remove(this.root);
    this.menu.geometry.dispose();
    this.menuMaterial.dispose();
    this.texture.dispose();
    this.fade.geometry.dispose();
    this.fadeMaterial.dispose();
    this.vignette.geometry.dispose();
    this.vignetteMaterial.dispose();
    this.rayGeometry.dispose();
    this.rayMaterial.dispose();
    this.reticleGeometry.dispose();
    this.reticleMaterial.dispose();
  }
}
