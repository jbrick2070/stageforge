import * as THREE from 'three';
import type { NativeStage } from '../data/showFile';

export type StageScreen = NativeStage['walls'][number];

export interface SecondaryScreenState {
  kind: 'video' | 'image' | 'none';
  name: string;
  url?: string | null;
  playing: boolean;
  offsetSeconds?: number;
  brightness?: number;
}

const EMPTY: SecondaryScreenState = { kind: 'none', name: '', playing: false };

export function createMissingMediaSlate(name: string): THREE.CanvasTexture {
  const slate = document.createElement('canvas');
  slate.width = 1024;
  slate.height = 512;
  const ctx = slate.getContext('2d')!;
  ctx.fillStyle = '#12171f';
  ctx.fillRect(0, 0, slate.width, slate.height);
  ctx.strokeStyle = '#ffbe50';
  ctx.lineWidth = 12;
  ctx.strokeRect(20, 20, 984, 472);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffbe50';
  ctx.font = 'bold 88px sans-serif';
  ctx.fillText('MISSING MEDIA', 512, 211, 920);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 50px sans-serif';
  let label = name;
  if (ctx.measureText(label).width > 900) {
    const characters = Array.from(name);
    let count = Math.ceil(characters.length / 2);
    do {
      count--;
      label = characters.slice(0, count).join('') + '…' + characters.slice(-count).join('');
    } while (count > 1 && ctx.measureText(label).width > 900);
  }
  ctx.fillText(label, 512, 322, 920);
  const texture = new THREE.CanvasTexture(slate);
  texture.name = name;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Each screen owns its decoder. Linked asset URLs remain owned by the desk. */
export class WallPlayer {
  private state: SecondaryScreenState = EMPTY;
  private anchoredAt = 0;
  private texture: THREE.Texture | null = null;
  private missingTex: THREE.CanvasTexture | null = null;
  private video: HTMLVideoElement | null = null;
  private playRequest?: Promise<void>;
  private generation = 0;
  private material?: THREE.ShaderMaterial;
  /** URL that failed to decode; show the slate until a different URL arrives. */
  private brokenUrl: string | null = null;
  private videoSrgbDecode = false;

  constructor(
    readonly id: string,
    private readonly fallbackTex: THREE.Texture,
    private readonly onError?: (message: string) => void,
  ) {}

  setVideoSrgbDecode(enabled: boolean) {
    this.videoSrgbDecode = Boolean(enabled);
    this.bindTexture();
  }

  bind(material: THREE.ShaderMaterial) {
    this.material = material;
    this.bindTexture();
  }

  private bindTexture() {
    if (!this.material) return;
    const active = this.texture ?? this.missingTex;
    this.material.uniforms.uCustomTex.value = active ?? this.fallbackTex;
    this.material.uniforms.uHasCustom.value = active ? 1 : 0;
    if (this.material.uniforms.uCustomTexDecode) {
      const isVideo = Boolean(this.texture && this.state.kind === 'video');
      this.material.uniforms.uCustomTexDecode.value = isVideo && this.videoSrgbDecode ? 1.0 : 0.0;
    }
  }

  private isMissing() {
    const { kind, url, name } = this.state;
    return kind !== 'none' && !!name && (!url || url === this.brokenUrl);
  }

  private syncSlate() {
    this.setMissing(this.isMissing() ? this.state.name : null);
  }

  private setMissing(name: string | null) {
    if ((this.missingTex?.name ?? null) === name) return;
    this.missingTex?.dispose();
    this.missingTex = name ? createMissingMediaSlate(name) : null;
    this.bindTexture();
  }

  apply(state = EMPTY) {
    const change = state.url !== this.state.url || state.kind !== this.state.kind;
    const previousPosition = this.video?.currentTime ?? 0;
    this.anchoredAt = performance.now();
    this.state = { ...state, offsetSeconds: state.offsetSeconds ?? (change ? 0 : previousPosition) };
    if (change) { this.brokenUrl = null; this.open(); }
    this.syncSlate();
    this.transport();
  }

  private open() {
    this.releaseMedia();
    const { url, kind, name } = this.state;
    if (!url || kind === 'none') return;
    const generation = this.generation;
    const failed = () => {
      if (this.generation !== generation) return;
      this.releaseMedia();
      this.brokenUrl = url;
      this.syncSlate();
      this.onError?.(`Could not open ${name} on ${this.id}.`);
    };
    if (kind === 'image') {
      new THREE.TextureLoader().load(url, texture => {
        if (this.generation !== generation) { texture.dispose(); return; }
        texture.colorSpace = THREE.SRGBColorSpace;
        this.texture = texture;
        this.bindTexture();
      }, undefined, failed);
      return;
    }
    const video = document.createElement('video');
    this.video = video;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => this.transport();
    video.onerror = failed;
    video.src = url;
    const texture = new THREE.VideoTexture(video);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.texture = texture;
    this.bindTexture();
  }

  private transport() {
    const video = this.video;
    if (!video || video.readyState < 1) return;
    const elapsed = this.state.playing ? (performance.now() - this.anchoredAt) / 1000 : 0;
    const offset = Math.max(0, this.state.offsetSeconds ?? 0) + elapsed;
    const target = Number.isFinite(video.duration) && video.duration > 0 ? offset % video.duration : offset;
    if (Math.abs(target - video.currentTime) > (this.state.playing ? 0.075 : 0.008)) video.currentTime = target;
    if (!this.state.playing) {
      video.pause();
      this.playRequest = undefined;
    } else if (video.paused && !this.playRequest) {
      const play = video.play();
      this.playRequest = play;
      void play.catch(error => {
        if (this.video === video && this.playRequest === play && error?.name !== 'AbortError')
          this.onError?.(`Could not play ${this.state.name} on ${this.id}.`);
      }).finally(() => { if (this.playRequest === play) this.playRequest = undefined; });
    }
  }

  setMaster(master: number) {
    if (!this.material) return;
    const level = THREE.MathUtils.clamp(this.state.brightness ?? 1, 0, 1);
    const active = this.texture ?? this.missingTex;
    this.material.uniforms.uBrightness.value = active ? master * level : 0;
  }

  diagnostics() {
    return { id: this.id, kind: this.state.kind, name: this.state.name,
      missing: this.isMissing(),
      playing: !!this.video && !this.video.paused, offsetSeconds: this.video?.currentTime ?? 0,
      width: this.video?.videoWidth ?? 0, height: this.video?.videoHeight ?? 0,
      brightness: this.material?.uniforms.uBrightness.value ?? 0,
      videoSrgbDecode: (this.material?.uniforms.uCustomTexDecode?.value ?? 0) > 0.5 };
  }

  private releaseMedia() {
    this.generation++;
    this.playRequest = undefined;
    if (this.video) {
      this.video.onerror = this.video.onloadedmetadata = null;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    this.texture?.dispose();
    this.texture = null;
    this.bindTexture();
  }

  dispose() {
    this.material = undefined;
    this.missingTex?.dispose();
    this.missingTex = null;
    this.releaseMedia();
  }
}
