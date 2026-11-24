import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StageEngine } from './engine/StageEngine';
import { AudioEngine } from './audio/AudioEngine';
import {
  analyzeFileBeatGrid,
  doubleTimeBpm,
  foldBpm,
  halfTimeBpm,
  LiveBpmStabilizer,
  nudgeBeatGrid,
  setBeatGridDownbeat,
  TapTempoTracker,
  type BeatGridStatus,
  type LiveBpmStatus,
} from './audio/tempoEngine';
import { CAMERAS, TopBar, type TempoControlProps } from './components/TopBar';
import { ShowOverlay } from './components/ShowOverlay';
import { ClockBadge } from './components/ClockBadge';
import { allows, type ClockMode } from './showControl/clockOwner';
import { useShowControl } from './showControl/useShowControl';
import { useShowGamepad } from './input/useShowGamepad';
import { cueLook, differsFromCue } from './data/cueLook';
import { applyDemoLighting, DEMO_BLACKOUT_STEPS } from './data/demoLighting';
import { getDemoPosition } from './data/demoShow';
import { normalizeDesign } from './data/stageDesign';
import { downloadRig, downloadStageFile, parseRigJson } from './data/rigImport';
import { makeShowFile, MAX_SHOW_JSON_BYTES, parseShowFile, pruneInterchangeFixtureSpecs, referencedFiles, type NativeStage, type ShowInterchange } from './data/showFile';
import { hasCatalogFixtures } from './data/equipmentCatalog';
import { DEMO_ILDA_PRESETS, generateDemoIlda, ILDA_MAX_BYTES, parseIlda, type DemoIldaKind, type IldaClip } from './data/ilda';
import type { IldaRenderMode } from './engine/ildaRenderer';
import type { MusicRef, ScreenRef, TimelineEvent } from './data/showFile';
import type { BundleAsset } from './data/showBundle';
import { isCustomMainWall, MAX_WALL_CUE_MS, pruneNativeStage, removeSecondaryScreenEvent, upsertSecondaryScreenEvent, type SecondaryScreenEvent } from './data/studioGeometry';
import type { FileAction } from './components/ShowFiles';
import { useShowTimeline } from './input/useShowTimeline';
import { useWallClock } from './input/useWallClock';
import { patchCsv } from './data/patchCsv';
import { BottomConsole } from './components/BottomConsole';
import type { DmxSnapshot } from './components/DmxMonitorDrawer';
import { LiveDmxBadge } from './components/LiveDmxBadge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadShopStockState, saveShopStockState, type ShopStockState } from './data/shopStock';
import { useLiveDmxOutput } from './dmx/useLiveDmxOutput';

const loadCostEstimatorModal = () => import('./components/CostEstimatorModal');
const createLazyCostEstimatorModal = () => lazy(loadCostEstimatorModal);
// Panels and drawers load right after first paint (see preloadPanels), keeping them out of the first
// download. Their ErrorBoundaries also catch a chunk that fails to load.
const ShowFiles = deferredComponent(() => import('./components/ShowFiles').then((m) => m.ShowFiles));
const CueListEditor = deferredComponent(() => import('./components/CueListEditor').then((m) => m.CueListEditor));
const StageDesigner = deferredComponent(() => import('./components/StageDesigner').then((m) => m.StageDesigner));
const RigBuilderDrawer = deferredComponent(() => import('./components/RigBuilderDrawer').then((m) => m.RigBuilderDrawer));
const DmxMonitorDrawer = deferredComponent(() => import('./components/DmxMonitorDrawer').then((m) => m.DmxMonitorDrawer));
const ShowControlDrawer = deferredComponent(() => import('./components/ShowControlDrawer').then((m) => m.ShowControlDrawer));
const preloadPanels = () => {
  for (const panel of [RigBuilderDrawer, DmxMonitorDrawer, ShowControlDrawer, ShowFiles, CueListEditor, StageDesigner]) {
    panel.preload().catch(() => { /* the panel's ErrorBoundary reports it when opened */ });
  }
};
import { createLiveStore } from './state/liveTelemetry';
import { deferredComponent } from './components/deferred';
import { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } from './data/presets';
import { calculateProductionEstimate, formatUSD } from './data/productionEstimator';
import { applyDeskPatch } from './data/movingGroups';
import {
  AudioMetrics,
  BumpState,
  CameraPreset,
  RigConfig,
  ShowCue,
  ShowState,
} from './types/show';

const EMPTY_AUDIO: AudioMetrics = {
  playing: false,
  source: 'none',
  trackName: 'No Audio Loaded',
  energy: 0,
  bass: 0,
  mid: 0,
  high: 0,
  beat: false,
  beatPulse: 0,
  drop: false,
  spectrum: new Float32Array(32),
};

const EMPTY_BUMP: BumpState = {
  blinder: false,
  strobe: false,
  co2: false,
  smoke: false,
  laser: false,
  motorDrop: false,
};

const SAVED_DESIGN_KEY = 'stageforge.design.v1';
const NO_MUSIC: MusicRef = { kind: 'none', name: '', playing: false };
const NO_SCREEN: ScreenRef = { target: 'main-led', kind: 'none', name: '', playing: false };

const PRESET_JSON = new Set(Object.values(RIG_TEMPLATES).map((t) => JSON.stringify(t)));
const isPristinePreset = (rig: RigConfig) => PRESET_JSON.has(JSON.stringify(rig));

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i;
const EMPTY_DMX: DmxSnapshot = { u1: new Uint8Array(512), u2: new Uint8Array(512) };
const INITIAL_DISCRETE_AUDIO = {
  source: EMPTY_AUDIO.source as AudioMetrics['source'],
  playing: false,
  openingBlack: false,
  openingBar: undefined as number | undefined,
};

function readSavedDesign(): RigConfig | null {
  try {
    const json = localStorage.getItem(SAVED_DESIGN_KEY);
    return json ? parseRigJson(json) : null;
  } catch {
    return null;
  }
}

export const App: React.FC = () => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<StageEngine | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);

  const [savedDesign, setSavedDesign] = useState(readSavedDesign);
  const nativeStage = useRef<NativeStage | undefined>(undefined);
  const interchangeRef = useRef<ShowInterchange | undefined>(undefined);
  const mvrResourcesRef = useRef<Map<string, Uint8Array> | undefined>(undefined);
  const [studioStage, setStudioStage] = useState<NativeStage>();
  const installStage = (stage?: NativeStage) => {
    nativeStage.current = stage;
    setStudioStage(stage);
  };
  const installInterchange = (interchange?: ShowInterchange, resources?: Map<string, Uint8Array>) => {
    interchangeRef.current = interchange;
    mvrResourcesRef.current = resources;
  };
  // Replacing the rig drops authored walls, hangs and wall cues; never do that silently.
  const confirmDiscardStage = () => {
    const stage = pruneNativeStage(nativeStage.current);
    if (!stage) return true;
    const parts = [
      stage.walls.some(w => w.id !== 'main-led') && 'secondary screens',
      stage.screenEvents.length && `${stage.screenEvents.length} wall cues`,
      stage.layout?.hangs && 'aimed speaker hangs',
      (stage.layout?.trusses?.length || stage.layout?.props?.length) && 'authored trusses and props',
    ].filter(Boolean);
    return window.confirm(`Replacing the rig discards ${parts.length ? parts.join(', ') : 'the authored stage layout'}. Continue?`);
  };
  const [rig, setRig] = useState<RigConfig>(() => savedDesign ?? structuredClone(RIG_TEMPLATES.arena_mainstage));
  const [showState, setShowState] = useState<ShowState>(() => structuredClone(INITIAL_SHOW_STATE));
  const [bump, setBump] = useState<BumpState>(EMPTY_BUMP);
  const [controllerBump, setControllerBump] = useState<BumpState>(EMPTY_BUMP);
  const liveBump = useMemo(() => {
    const result = { ...bump };
    for (const key of Object.keys(controllerBump) as (keyof BumpState)[]) result[key] ||= controllerBump[key];
    return result;
  }, [bump, controllerBump]);
  const [cues, setCues] = useState<ShowCue[]>(() => structuredClone(SHOW_CUES));
  const [activeCueId, setActiveCueId] = useState<string | null>(null);
  const [cueModified, setCueModified] = useState(false);

  const live = useMemo(() => ({
    fps: createLiveStore(60),
    audio: createLiveStore<AudioMetrics>(EMPTY_AUDIO),
    dmx: createLiveStore<DmxSnapshot>(EMPTY_DMX),
  }), []);
  const [audioDiscrete, setAudioDiscrete] = useState(INITIAL_DISCRETE_AUDIO);
  const [volume, setVolume] = useState(0.72);
  const [activeCamera, setActiveCamera] = useState<CameraPreset>('foh');
  const [rigDrawerOpen, setRigDrawerOpen] = useState(false);
  const [dmxDrawerOpen, setDmxDrawerOpen] = useState(false);
  const [showControlOpen, setShowControlOpen] = useState(false);
  const [costModalOpen, setCostModalOpen] = useState(false);
  const [costModalRetry, setCostModalRetry] = useState(0);
  const CostEstimatorModal = useMemo(() => createLazyCostEstimatorModal(), [costModalRetry]);
  // Fetch the panels' code right after first paint, so they open instantly.
  useEffect(preloadPanels, []);
  const [shopStock, setShopStock] = useState<ShopStockState>(loadShopStockState);
  const updateShopStock = useCallback((next: ShopStockState) => {
    setShopStock(next);
    saveShopStockState(next);
  }, []);
  const [ildaClip, setIldaClip] = useState<IldaClip | null>(null);
  const [ildaMode, setIldaMode] = useState<IldaRenderMode>('both');
  const [ildaFps, setIldaFps] = useState(30);
  const [beatGridStatus, setBeatGridStatus] = useState<BeatGridStatus>({ state: 'idle' });
  const [liveBpmStatus, setLiveBpmStatus] = useState<LiveBpmStatus>({ state: 'off' });
  const [followLiveBpm, setFollowLiveBpm] = useState(false);
  const followLiveBpmRef = useRef(false);
  followLiveBpmRef.current = followLiveBpm;
  const tapTrackerRef = useRef(new TapTempoTracker());
  const liveBpmStabilizerRef = useRef(new LiveBpmStabilizer());
  const beatGridAbortRef = useRef<AbortController | null>(null);
  const takeMetaExplicitRef = useRef(false);
  const bpmRef = useRef(showState.bpm);
  bpmRef.current = showState.bpm;
  const activeCueIdRef = useRef(activeCueId);
  activeCueIdRef.current = activeCueId;
  const clockModeRef = useRef<ClockMode>('master');
  const [designerRig, setDesignerRig] = useState<RigConfig | null>(null);
  const designerOpenRef = useRef(false);
  designerOpenRef.current = !!designerRig;
  const openRequestRef = useRef(0);
  const [filesOpen, setFilesOpen] = useState(false);
  const [cueEditor, setCueEditor] = useState(false);
  const [follow, setFollow] = useState<number | 'held' | null>(null);
  const [screen, setScreen] = useState<ScreenRef>(NO_SCREEN);
  const [captureVideoPosition, setCaptureVideoPosition] = useState(false);
  const [linkedVersion, setLinkedVersion] = useState(0);
  const assets = useRef(new Map<string, { file: File; url?: string }>());
  const wallClock = useWallClock(engineRef, nativeStage, assets);
  const mediaUrls = useRef(new Set<string>());
  const expectedMusic = useRef<MusicRef>(NO_MUSIC);
  const replaying = useRef(false);
  const directorArmed = useRef(true);
  const replayLook = useRef(showState);
  const replayScreen = useRef<ScreenRef>(NO_SCREEN);
  const replayScreenClock = useRef(0);
  const replayMusicClock = useRef(0);
  const pendingDesign = useRef<RigConfig | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const [cinemaMode, setCinemaMode] = useState(() =>
    window.matchMedia('(pointer: coarse) and (max-width: 700px), (pointer: coarse) and (max-height: 500px)').matches
  );
  const [toast, setToast] = useState<string | null>(null);

  const dmxOpenRef = useRef(false);
  dmxOpenRef.current = dmxDrawerOpen;

  const autoDirRef = useRef(false);
  autoDirRef.current = showState.autoDirector;
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const autoCueIndexRef = useRef(0);
  const lastAutoSwitchRef = useRef(0);
  const lastDemoTick = useRef(-1);
  const previewRig = useCallback(() => engineRef.current?.previewRig(), []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  const liveDmx = useLiveDmxOutput(engineRef, showToast);

  useEffect(() => {
    engineRef.current?.setIldaSettings(ildaMode, ildaFps);
  }, [ildaMode, ildaFps]);

  const applyLoadedIlda = useCallback((clip: IldaClip) => {
    setIldaClip(clip);
    engineRef.current?.setIldaClip(clip);
    previewRig();
    setShowState((s) => ({
      ...s,
      laser: {
        ...s.laser,
        enabled: true,
        intensity: s.laser.intensity < 0.2 ? 0.9 : s.laser.intensity,
      },
    }));
    const warnSuffix = clip.warnings.length ? ` (${clip.warnings[0]})` : '';
    showToast(`Loaded ILDA: ${clip.name} (${clip.frames.length} frames)${warnSuffix}`);
  }, [previewRig, showToast]);

  const handleLoadDemoIlda = useCallback((kind: DemoIldaKind) => {
    try {
      const preset = DEMO_ILDA_PRESETS.find((p) => p.id === kind);
      const bytes = generateDemoIlda(kind);
      const tier = engineRef.current?.getRenderTier() ?? 'high';
      const clip = parseIlda(bytes, { name: preset?.label ?? kind, tier });
      applyLoadedIlda(clip);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load demo ILDA clip.');
    }
  }, [applyLoadedIlda, showToast]);

  const handleUploadIlda = useCallback(async (file: File) => {
    try {
      if (file.size > ILDA_MAX_BYTES) {
        throw new Error(`ILDA file is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB; limit is ${ILDA_MAX_BYTES / (1024 * 1024)} MB).`);
      }
      const buffer = await file.arrayBuffer();
      const tier = engineRef.current?.getRenderTier() ?? 'high';
      const clip = parseIlda(buffer, { name: file.name, tier });
      applyLoadedIlda(clip);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not parse ILDA file.');
    }
  }, [applyLoadedIlda, showToast]);

  const handleClearIlda = useCallback(() => {
    setIldaClip(null);
    engineRef.current?.setIldaClip(null);
    showToast('Unloaded ILDA clip (back to procedural laser patterns).');
  }, [showToast]);

  // Revoke after a grace period so a renderer still holding the old URL can swap first.
  const releaseUrl = (url: string) => {
    mediaUrls.current.delete(url);
    window.setTimeout(() => { if (!mediaUrls.current.has(url)) URL.revokeObjectURL(url); }, 5000);
  };
  /** Drop linked media the incoming show never references (e.g. a previous bundle's clips). */
  const pruneAssets = (keep: Set<string>) => {
    for (const [key, asset] of assets.current) {
      if (keep.has(key)) continue;
      assets.current.delete(key);
      if (asset.url) releaseUrl(asset.url);
    }
  };
  const registerAsset = (kind: 'file' | 'image' | 'video', file: File) => {
    const key = kind + ':' + file.name;
    const previous = assets.current.get(key);
    if (previous?.file === file) return previous;
    const url = kind === 'file' ? undefined : URL.createObjectURL(file);
    if (url) mediaUrls.current.add(url);
    const asset = { file, url };
    assets.current.set(key, asset);
    if (previous?.url) {
      // Keep the main LED wall on the replacement file instead of a soon-revoked URL.
      if (kind !== 'file' && screen.kind === kind && screen.name === file.name)
        setShowState(s => s.led.customMediaUrl === previous.url ? { ...s, led: { ...s.led, customMediaUrl: url! } } : s);
      releaseUrl(previous.url);
    }
    setLinkedVersion(v => v + 1);
    return asset;
  };
  useEffect(() => () => {
    mediaUrls.current.forEach(url => URL.revokeObjectURL(url));
    mediaUrls.current.clear();
    assets.current.clear();
  }, []);
  const wallLook = (look: ShowState, ref: ScreenRef): ShowState => ({
    ...look, led: { ...look.led, customMediaUrl: assets.current.get(ref.kind + ':' + ref.name)?.url ?? null,
      customMediaType: ref.kind === 'none' ? null : ref.kind },
  });
  const readMusic = (): MusicRef => {
    const actual = audioEngineRef.current?.timelineMusic();
    return actual && actual.kind !== 'none' ? actual : { ...expectedMusic.current, playing: false };
  };
  const readScreen = (): ScreenRef => {
    if (screen.kind !== 'video' || !showState.led.customMediaUrl) return screen;
    const hasWall = rig.ledWall.enabled || isCustomMainWall(nativeStage.current?.walls.find(w => w.id === 'main-led'));
    const active = showState.led.enabled && showState.led.visualMode === 'custom' && hasWall;
    const transport = engineRef.current?.screenTransport();
    return { ...screen, ...transport, playing: !!(active && transport?.playing) };
  };
  const cueScreen = (): ScreenRef => {
    const ref = readScreen();
    return ref.kind === 'video' && !captureVideoPosition ? { ...ref, offsetSeconds: 0 } : ref;
  };
  const replayScreenOffset = () => (replayScreen.current.offsetSeconds ?? 0) +
    (replayScreen.current.playing ? (performance.now() - replayScreenClock.current) / 1000 : 0);
  const restoreReplayMusic = (ref: MusicRef, lateMs: number) => {
    void audioEngineRef.current?.restoreTimelineMusic(ref, assets.current.get('file:' + ref.name)?.file, replayLook.current.bpm, lateMs)
      .catch(e => { if (e?.name !== 'AbortError') showToast(e instanceof Error ? e.message : 'Audio could not play.'); });
  };
  const timeline = useShowTimeline(
    () => ({ look: showState, cueId: activeCueId, cueModified: !!activeCueId && cueModified,
      camera: activeCamera, volume, bump: liveBump, music: readMusic(), screen: readScreen() }),
    (event: TimelineEvent, lateMs) => {
      const ae = audioEngineRef.current, engine = engineRef.current;
      if (event.screen) {
        replayScreen.current = event.screen;
        replayScreenClock.current = performance.now() - lateMs;
        setScreen(event.screen);
      }
      const fullLook = !!(event.look?.motors && event.look.masterDimmer !== undefined);
      if (event.look || event.screen) {
        const prior = fullLook ? event.look as ShowState : replayLook.current;
        const next = wallLook(fullLook ? prior : { ...prior, ...event.look }, replayScreen.current);
        replayLook.current = next; autoDirRef.current = next.autoDirector;
        setShowState(next); engine?.setShowState(next); ae?.setBpm(next.bpm);
      }
      if (event.screen) engine?.restoreScreenTransport(event.screen.playing, replayScreenOffset());
      if (event.music) {
        expectedMusic.current = event.music;
        replayMusicClock.current = performance.now() - lateMs;
        restoreReplayMusic(event.music, lateMs);
      }
      if (event.cueId !== undefined) {
        setActiveCueId(event.cueId);
        const cue = cues.find(c => c.id === event.cueId);
        // Full frames (the take's first event, or a seek/resume reconstruction) can land
        // on a cue whose look was edited after it fired; partial cue events cannot.
        setCueModified(fullLook && differsFromCue(replayLook.current, cue, replayScreen.current));
      } else if (event.look) setCueModified(true);
      if (event.bump) { setBump(event.bump); setControllerBump(EMPTY_BUMP); engine?.setBumpState(event.bump); }
      if (event.camera) { setActiveCamera(event.camera); engine?.setCameraPreset(event.camera); }
      if (event.volume !== undefined) { setVolume(event.volume); ae?.setVolume(event.volume); }
    },
    () => {
      wallClock.set(wallClock.position(), false);
      replaying.current = false; directorArmed.current = false;
      const music = readMusic();
      expectedMusic.current = { ...music, playing: false };
      audioEngineRef.current?.stopAll();
      engineRef.current?.restoreScreenTransport(false);
      const ref = replayScreen.current;
      if (ref.kind === 'video') {
        const linked = assets.current.has('video:' + ref.name);
        const offsetSeconds = linked ? engineRef.current?.screenTransport().offsetSeconds : replayScreenOffset();
        setScreen({ ...ref, playing: false, offsetSeconds });
      }
      setBump(EMPTY_BUMP); setControllerBump(EMPTY_BUMP);
    },
    () => nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0,
  );

  const flushDesign = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const design = pendingDesign.current;
    if (!design) return;
    pendingDesign.current = null;
    try {
      localStorage.setItem(SAVED_DESIGN_KEY, JSON.stringify(design));
    } catch {
      showToast('Design applied. Export the rig to keep a copy on this device.');
    }
  }, [showToast]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) flushDesign();
    };
    window.addEventListener('pagehide', flushDesign);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushDesign);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushDesign();
    };
  }, [flushDesign]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Trigger a show cue cleanly preserving user's custom media/text/master
  const triggerCue = useCallback((cue: ShowCue, automatic = false, source: 'manual' | 'autoLD' | 'follow' | 'osc' | 'msc' = automatic ? 'autoLD' : 'manual') => {
    const mode = clockModeRef.current;
    if (automatic && !allows(mode, source, source === 'follow' ? 'cue_follow' : 'auto_ld')) return;
    if (!automatic && !allows(mode, source, 'go')) return;
    if (!automatic) {
      previewRig();
      engineRef.current?.releaseDirector(false);
      autoDirRef.current = false;
    }
    const index = cuesRef.current.findIndex(c => c.id === cue.id);
    const allowFollow = !automatic && allows(mode, 'follow', 'cue_follow');
    setFollow(allowFollow && cue.followSeconds && index >= 0 && index + 1 < cuesRef.current.length
      ? performance.now() + cue.followSeconds * 1000 : null);
    if (cue.screen) setScreen({ ...cue.screen });
    if (cue.state.bpm !== undefined) audioEngineRef.current?.setBpm(cue.state.bpm);
    setActiveCueId(cue.id);
    setCueModified(false);
    setShowState((prev) => {
      const next = cueLook(prev, cue, automatic);
      return cue.screen ? wallLook(next, cue.screen) : next;
    });
  }, [previewRig]);
  const currentIndex = cues.findIndex(c => c.id === activeCueId);
  const followingCue = cues[currentIndex + 1];
  const nextCue = followingCue ?? cues[0];
  const previousCue = cues[currentIndex > 0 ? currentIndex - 1 : cues.length - 1];
  useEffect(() => {
    if (typeof follow !== 'number' || !followingCue || replaying.current || !allows(clockModeRef.current, 'follow', 'cue_follow')) return;
    const id = window.setTimeout(() => {
      if (!replaying.current && allows(clockModeRef.current, 'follow', 'cue_follow')) triggerCue(followingCue, false, 'manual');
    }, Math.max(0, follow - performance.now()));
    return () => window.clearTimeout(id);
  }, [follow, followingCue, triggerCue]);

  const applyDeskBpm = useCallback((nextBpm: number) => {
    const clamped = Math.round(Math.max(70, Math.min(180, nextBpm)) * 10) / 10;
    setCueModified(true);
    setShowState((s) => ({ ...s, bpm: clamped }));
    audioEngineRef.current?.setBpm(clamped);
    const currentGrid = audioEngineRef.current?.getBeatGrid();
    if (currentGrid) {
      const updated = { ...currentGrid, bpm: clamped };
      audioEngineRef.current?.setBeatGrid(updated);
      setBeatGridStatus({ state: 'ready', grid: updated });
    }
  }, []);

  const handleTapTempo = useCallback(() => {
    const { bpm: tapped } = tapTrackerRef.current.tap(performance.now());
    if (tapped !== null) {
      applyDeskBpm(tapped);
      showToast(`Tap tempo: ${tapped} BPM`);
    }
  }, [applyDeskBpm, showToast]);

  const handleHalfTime = useCallback(() => {
    const next = halfTimeBpm(bpmRef.current);
    if (next !== null) applyDeskBpm(next);
  }, [applyDeskBpm]);

  const handleDoubleTime = useCallback(() => {
    const next = doubleTimeBpm(bpmRef.current);
    if (next !== null) applyDeskBpm(next);
  }, [applyDeskBpm]);

  const handleNudgeGrid = useCallback((deltaMs: number) => {
    const current = audioEngineRef.current?.getBeatGrid();
    if (!current) return;
    const nudged = nudgeBeatGrid(current, deltaMs);
    audioEngineRef.current?.setBeatGrid(nudged);
    setBeatGridStatus({ state: 'ready', grid: nudged });
  }, []);

  const handleSetDownbeat = useCallback(() => {
    const current = audioEngineRef.current?.getBeatGrid();
    if (!current || !audioEngineRef.current) return;
    const anchored = setBeatGridDownbeat(current, audioEngineRef.current.getPlaybackMs());
    audioEngineRef.current.setBeatGrid(anchored);
    setBeatGridStatus({ state: 'ready', grid: anchored });
    showToast(`Downbeat set (${anchored.offsetMs.toFixed(0)} ms)`);
  }, [showToast]);

  const handleToggleFollowLiveBpm = useCallback(() => {
    const next = !followLiveBpmRef.current;
    followLiveBpmRef.current = next;
    setFollowLiveBpm(next);
    liveBpmStabilizerRef.current.reset();
    if (!next) {
      audioEngineRef.current?.setLiveBpmAnalysis(false);
      setLiveBpmStatus({ state: 'off' });
      return;
    }
    setLiveBpmStatus({ state: 'starting' });
    audioEngineRef.current?.setLiveBpmAnalysis(true, {
      onReading: (rawBpm, locked) => {
        const { medianBpm, applyBpm } = liveBpmStabilizerRef.current.observe(
          rawBpm,
          bpmRef.current,
          followLiveBpmRef.current,
          Date.now(),
        );
        if (medianBpm !== null) {
          setLiveBpmStatus(locked
            ? { state: 'locked', candidateBpm: medianBpm }
            : { state: 'listening', candidateBpm: medianBpm });
        }
        if (applyBpm !== null) {
          applyDeskBpm(applyBpm);
        }
      },
      onUnavailable: (reason) => {
        setLiveBpmStatus({ state: 'unavailable', reason });
        setFollowLiveBpm(false);
        followLiveBpmRef.current = false;
        showToast(reason);
      },
    });
  }, [applyDeskBpm, showToast]);

  const showControl = useShowControl({
    getCues: () => cuesRef.current,
    getActiveCueId: () => activeCueIdRef.current,
    getTakePlayheadMs: () => timeline.playhead(),
    isTakePlaying: () => timeline.mode === 'playing',
    onModeReset: (nextMode) => {
      clockModeRef.current = nextMode;
      setFollow(null);
      // Unconditionally clear chase/replay state & freeze wallClock when switching modes (H3).
      if (timeline.mode === 'playing') {
        timeline.stop();
      }
      timeline.resetChase();
      replaying.current = false;
      wallClock.set(timeline.playhead(), false);
      if (nextMode !== 'master' && autoDirRef.current) {
        engineRef.current?.releaseDirector(true);
        autoDirRef.current = false;
        setShowState((s) => (s.autoDirector ? { ...s, autoDirector: false } : s));
      }
    },
    onTriggerCue: (cue) => {
      setFollow(null);
      triggerCue(cue, false, 'osc');
    },
    onNextCue: () => {
      const list = cuesRef.current;
      if (!list.length) return;
      const idx = list.findIndex((c) => c.id === activeCueIdRef.current);
      const next = list[idx + 1] ?? list[0];
      if (next) {
        setFollow(null);
        triggerCue(next, false, 'osc');
      }
    },
    onPrevCue: () => {
      const list = cuesRef.current;
      if (!list.length) return;
      const idx = list.findIndex((c) => c.id === activeCueIdRef.current);
      const prev = list[idx > 0 ? idx - 1 : list.length - 1];
      if (prev) {
        setFollow(null);
        triggerCue(prev, false, 'osc');
      }
    },
    onResetCue: () => {
      if (cuesRef.current[0]) {
        setFollow(null);
        triggerCue(cuesRef.current[0], false, 'osc');
      }
    },
    onStopPlayback: () => {
      setFollow(null);
      if (timeline.mode === 'playing') {
        timeline.stop();
        replaying.current = false;
        wallClock.set(timeline.playhead(), false);
      }
      audioEngineRef.current?.stopAll();
    },
    onResumePlayback: () => {
      if (audioEngineRef.current && !audioEngineRef.current.getStatus().playing) {
        audioEngineRef.current.togglePlayPause();
      }
    },
    onSetBlackout: (active) => {
      previewRig();
      setCueModified(true);
      setShowState((s) => (s.blackout === active ? s : { ...s, blackout: active }));
    },
    onSetMaster: (value) => {
      const clamped = Math.max(0, Math.min(1, value));
      previewRig();
      setCueModified(true);
      setShowState((s) => ({ ...s, masterDimmer: clamped }));
    },
    onSetBump: (key, active) => {
      setBump((b) => ({ ...b, [key]: active }));
    },
    onTempoTap: handleTapTempo,
    onTempoSetBpm: (raw) => {
      const folded = foldBpm(raw);
      if (folded !== null) applyDeskBpm(folded);
    },
    onTempoHalf: handleHalfTime,
    onTempoDouble: handleDoubleTime,
    onChaseSeek: (takeMs, running, _resyncMusic) => {
      const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
      setFollow(null);
      replaying.current = running;
      replayLook.current = showState;
      engineRef.current?.releaseDirector(false);
      previewRig();
      timeline.chaseSeek(takeMs, running);
      wallClock.set(Math.min(takeMs, endMs), running && takeMs < endMs, endMs);
    },
    onChaseAdvance: (takeMs) => {
      replaying.current = true;
      timeline.chaseAdvance(takeMs);
    },
    onChaseStop: () => {
      replaying.current = false;
      wallClock.set(wallClock.position(), false);
      audioEngineRef.current?.stopAll();
    },
    onUpdateTakeMeta: (meta) => {
      takeMetaExplicitRef.current = true;
      timeline.setMetadata(meta);
    },
    onToast: showToast,
  });
  clockModeRef.current = showControl.clockMode;

  // Send optional OSC state feedback whenever active cue, BPM, or clock mode changes.
  useEffect(() => {
    const activeCue = cues.find((c) => c.id === activeCueId);
    showControl.sendFeedback({
      cue: activeCue ? activeCue.name : '',
      bpm: showState.bpm,
      clock: showControl.clockMode,
    });
  }, [activeCueId, cues, showState.bpm, showControl.clockMode, showControl.sendFeedback]);

  const tempoProps: TempoControlProps = useMemo(() => ({
    canHalfTime: halfTimeBpm(showState.bpm) !== null,
    canDoubleTime: doubleTimeBpm(showState.bpm) !== null,
    onTapTempo: handleTapTempo,
    onHalfTime: handleHalfTime,
    onDoubleTime: handleDoubleTime,
    beatGridStatus,
    onNudgeGrid: handleNudgeGrid,
    onSetDownbeat: handleSetDownbeat,
    liveBpmStatus,
    followLiveBpm,
    onToggleFollowLiveBpm: handleToggleFollowLiveBpm,
  }), [
    showState.bpm,
    handleTapTempo,
    handleHalfTime,
    handleDoubleTime,
    beatGridStatus,
    handleNudgeGrid,
    handleSetDownbeat,
    liveBpmStatus,
    followLiveBpm,
    handleToggleFollowLiveBpm,
  ]);

  // Mount Three.js StageEngine + AudioEngine once
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;

    const audio = new AudioEngine();
    audioEngineRef.current = audio;
    let idleMetrics: AudioMetrics | undefined;

    let engine: StageEngine;
    try {
      engine = new StageEngine(
        container,
        rig,
        showState,
        (dt) => audio.getMetrics(dt),
        (metrics, curFps) => {
          live.fps.set(curFps);
          if (metrics.playing || !idleMetrics || idleMetrics.source !== metrics.source ||
            idleMetrics.trackName !== metrics.trackName || idleMetrics.demo?.step !== metrics.demo?.step) {
            live.audio.set({ ...metrics, spectrum: new Float32Array(metrics.spectrum) });
          }
          idleMetrics = metrics.playing ? undefined : metrics;
          const openingBlack = !!metrics.demo && metrics.demo.step < DEMO_BLACKOUT_STEPS;
          const openingBar = openingBlack ? metrics.demo!.bar + 1 : undefined;
          setAudioDiscrete(prev =>
            prev.source === metrics.source && prev.playing === metrics.playing &&
            prev.openingBlack === openingBlack && prev.openingBar === openingBar
              ? prev
              : { source: metrics.source, playing: metrics.playing, openingBlack, openingBar }
          );
          if (dmxOpenRef.current) {
            live.dmx.set({
              u1: new Uint8Array(engine.dmxUniverse1),
              u2: new Uint8Array(engine.dmxUniverse2),
            });
          }
          if (replaying.current || !directorArmed.current || !allows(clockModeRef.current, 'autoLD', 'auto_ld')) return;
          if (metrics.demo) {
            const position = metrics.demo;
            const tick = Math.floor(position.step / 2);
            if (autoDirRef.current && (metrics.playing || position.finished) && tick !== lastDemoTick.current) {
              lastDemoTick.current = tick;
              setActiveCueId(null);
              setShowState(s => s.autoDirector ? applyDemoLighting(s, position) : s);
            }
          } else if (autoDirRef.current && cuesRef.current.length > 0) {
            const now = performance.now();
            const intervalMs = metrics.playing ? 7500 : 6500;
            if (now - lastAutoSwitchRef.current > intervalMs && (!metrics.playing || metrics.beat || now - lastAutoSwitchRef.current > intervalMs + 2000)) {
              lastAutoSwitchRef.current = now;
              autoCueIndexRef.current = (autoCueIndexRef.current + 1) % cuesRef.current.length;
              triggerCue(cuesRef.current[autoCueIndexRef.current], true);
            }
          }
        },
        showToast
      );
    } catch (error) {
      audio.dispose();
      audioEngineRef.current = null;
      throw error;
    }
    engineRef.current = engine;
    // Read-only probe for browser tests: `?probe` exposes each head's beam axis & render metrics.
    const probe = new URLSearchParams(window.location.search).has('probe');
    if (probe) (window as unknown as { stageforgeProbe?: unknown }).stageforgeProbe = {
      beamAxes: () => engine.beamAxes(),
      screens: () => engine.screenDiagnostics(),
      primaryScreen: () => engine.screenTransport(),
      hangs: () => engine.hangDiagnostics(),
      renderStats: () => engine.renderStats(),
      setBatching: (enabled: boolean) => engine.setBatching(enabled),
      rebuildRig: () => engine.forceRebuildCurrentRig(),
    };

    return () => {
      if (probe) delete (window as unknown as { stageforgeProbe?: unknown }).stageforgeProbe;
      engine.dispose();
      audio.dispose();
      engineRef.current = null;
      audioEngineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync show state to Three.js engine every change
  useEffect(() => {
    engineRef.current?.setShowState(showState);
  }, [showState]);

  useEffect(() => {
    const missingScreen = screen.kind !== 'none' && !assets.current.has(screen.kind + ':' + screen.name);
    engineRef.current?.setMissingScreen(missingScreen ? screen.name : null);
  }, [screen, linkedVersion]);

  useEffect(() => {
    if (replaying.current) return;
    if (screen.kind === 'video' && showState.led.enabled && showState.led.visualMode === 'custom') {
      engineRef.current?.restoreScreenTransport(screen.playing, screen.offsetSeconds);
    }
  }, [screen, showState.led.customMediaUrl]);

  // Sync momentary bump overrides
  useEffect(() => {
    engineRef.current?.setBumpState(liveBump);
  }, [liveBump]);

  // Rebuild 3D rig whenever user edits stage/trusses/fixtures/templates
  const firstRigMount = useRef(true);
  useEffect(() => {
    if (firstRigMount.current) {
      firstRigMount.current = false;
      return;
    }
    engineRef.current?.setStageScreens(studioStage?.walls);
    engineRef.current?.rebuildRig(rig, studioStage);
    wallClock.refresh();
  }, [rig, studioStage, wallClock.refresh]);
  useEffect(() => { wallClock.refresh(); }, [linkedVersion, wallClock.refresh]);

  // Global keyboard live show hotkeys (when not typing in a text box)
  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || !!target.closest(
        'textarea,input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=button])'
      ));

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('dialog[open],[aria-modal=true]')) return;
      if (e.target instanceof Element && e.target.closest('select,[role=listbox],[role=combobox]')) return;
      if (e.code === 'Space' && e.target instanceof Element && e.target.closest('button,summary,input[type=color],input[type=checkbox]')) return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          previewRig();
          setCueModified(true);
          setShowState((s) => ({ ...s, blackout: !s.blackout }));
          break;
        case 'KeyB':
          setBump((b) => ({ ...b, blinder: true }));
          break;
        case 'KeyS':
          setBump((b) => ({ ...b, strobe: true }));
          break;
        case 'KeyC':
          setBump((b) => ({ ...b, co2: true }));
          break;
        case 'KeyF':
          setBump((b) => ({ ...b, smoke: true }));
          break;
        case 'KeyL':
          setBump((b) => ({ ...b, laser: true }));
          break;
        case 'KeyD':
          setBump((b) => ({ ...b, motorDrop: true }));
          break;
        case 'KeyT':
          handleTapTempo();
          break;
        case 'KeyH':
          setCinemaMode((v) => !v);
          break;
        case 'Digit1':
          handleCamera('foh');
          break;
        case 'Digit2':
          handleCamera('front_row');
          break;
        case 'Digit3':
          handleCamera('wide_arena');
          break;
        case 'Digit4':
          handleCamera('stage_side');
          break;
        case 'Digit5':
          handleCamera('overhead');
          break;
        case 'Digit6':
          handleCamera('orbit');
          break;
        case 'Digit7':
          handleCamera('pa_closeup');
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyB':
          setBump((b) => ({ ...b, blinder: false }));
          break;
        case 'KeyS':
          setBump((b) => ({ ...b, strobe: false }));
          break;
        case 'KeyC':
          setBump((b) => ({ ...b, co2: false }));
          break;
        case 'KeyF':
          setBump((b) => ({ ...b, smoke: false }));
          break;
        case 'KeyL':
          setBump((b) => ({ ...b, laser: false }));
          break;
        case 'KeyD':
          setBump((b) => ({ ...b, motorDrop: false }));
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const releaseBumps = () => setBump(EMPTY_BUMP);
    window.addEventListener('blur', releaseBumps);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseBumps);
    };
  }, [handleTapTempo]);

  const handleCamera = (cam: CameraPreset) => {
    previewRig();
    setActiveCamera(cam);
    engineRef.current?.setCameraPreset(cam);
  };

  const startDemo = () => {
    const ae = audioEngineRef.current;
    if (!ae) return;
    directorArmed.current = true; expectedMusic.current = NO_MUSIC; setFollow(null);
    ae.startDemoSynth(showState.bpm);
    const demo = getDemoPosition(0);
    const opening = applyDemoLighting({ ...showState, autoDirector: true }, demo);
    engineRef.current?.beginDemo(opening);
    autoDirRef.current = true;
    setBump(EMPTY_BUMP);
    setControllerBump(EMPTY_BUMP);
    lastDemoTick.current = -1;
    setActiveCueId(null);
    setShowState(opening);
    live.audio.set({ ...EMPTY_AUDIO, playing: true, source: 'synth', trackName: ae.getStatus().trackName, demo });
    setAudioDiscrete({ source: 'synth', playing: true, openingBlack: demo.step < DEMO_BLACKOUT_STEPS, openingBar: demo.bar + 1 });
    setToast(null);
  };

  const handleTogglePlay = () => {
    const ae = audioEngineRef.current;
    if (!ae) return;
    const status = ae.getStatus();
    if (status.source === 'none' && expectedMusic.current.kind === 'demo') {
      directorArmed.current = true;
      void ae.restoreTimelineMusic({ ...expectedMusic.current, playing: true }, undefined, showState.bpm, 0)
        .catch(e => showToast(e instanceof Error ? e.message : 'Could not resume the score.'));
      return;
    }
    if (status.source === 'none' && expectedMusic.current.kind === 'live') {
      showToast('Select Mic in Audio settings to use the live input.');
      return;
    }
    if (status.source === 'none' && expectedMusic.current.kind === 'file') {
      const ref = expectedMusic.current;
      const file = assets.current.get('file:' + ref.name)?.file;
      if (!file) { setFilesOpen(true); return; }
      void ae.restoreTimelineMusic({ ...ref, playing: true }, file, showState.bpm, 0)
        .catch(e => showToast(e instanceof Error ? e.message : 'Could not play linked music.'));
      return;
    }
    if (status.source === 'none' || status.demoFinished) {
      startDemo();
      return;
    }
    const playing = ae.togglePlayPause();
    showToast(playing ? `Playing: ${ae.getStatus().trackName}` : 'Audio Paused');
  };

  const handleUploadAudio = async (file: File) => {
    const ae = audioEngineRef.current;
    if (!ae) return;
    beatGridAbortRef.current?.abort();
    beatGridAbortRef.current = null;
    try {
      const name = await ae.loadAudioFile(file);
      registerAsset('file', file);
      expectedMusic.current = { kind: 'file', name: file.name, playing: true };
      previewRig();
      showToast(`Loaded Track: ${name}`);
      // Compute offline beat grid asynchronously with size/duration caps; cancel on track change.
      const abort = new AbortController();
      beatGridAbortRef.current = abort;
      const uploadBpm = bpmRef.current;
      const uploadedName = file.name;
      setBeatGridStatus({ state: 'analyzing', trackName: name });
      void analyzeFileBeatGrid(file, abort.signal).then((result) => {
        if (abort.signal.aborted || beatGridAbortRef.current !== abort) return;
        const currentMusic = audioEngineRef.current?.timelineMusic();
        if (!currentMusic || currentMusic.kind !== 'file' || currentMusic.name !== uploadedName) return;
        setBeatGridStatus(result);
        if (result.state === 'ready') {
          const grid = bpmRef.current === uploadBpm ? result.grid : { ...result.grid, bpm: bpmRef.current };
          audioEngineRef.current?.setBeatGrid(grid);
          // Only update desk BPM if the user hasn't manually tapped/edited BPM during analysis (M11),
          // and skip marking the cue modified if BPM is already identical.
          if (bpmRef.current === uploadBpm && result.grid.bpm !== bpmRef.current) {
            applyDeskBpm(result.grid.bpm);
          }
          showToast(`Beat grid ready: ${result.grid.bpm} BPM`);
        }
      }).catch(() => {
        if (!abort.signal.aborted && beatGridAbortRef.current === abort) {
          setBeatGridStatus({ state: 'unavailable', reason: 'Beat grid analysis failed.' });
        }
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      showToast('Could not play audio file');
    }
  };

  const handleToggleMic = async () => {
    const ae = audioEngineRef.current;
    if (!ae) return;
    if (live.audio.get().source === 'mic') {
      ae.stopAll();
      expectedMusic.current = NO_MUSIC;
      showToast('Live Mic Stopped');
      return;
    }
    try {
      await ae.startMicInput();
      previewRig();
      showToast('Live Mic / Room Audio Sync Active');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      showToast('Microphone permission denied');
    }
  };

  const handleSaveCue = (cueId: string) => {
    previewRig();
    setCues((prev) =>
      prev.map((c) =>
        c.id === cueId
          ? {
              ...c,
              tag: 'USER',
              accent: showState.primaryColor,
              state: structuredClone(showState),
              screen: cueScreen(),
            }
          : c
      )
    );
    setActiveCueId(cueId);
    setCueModified(false);
    if (cueId !== activeCueId) setFollow(null);
    showToast(`Saved current rig look to cue pad!`);
  };

  const counts = useMemo(() => {
    let fixtures = 0;
    let lasers = 0;
    for (const p of rig.trussPods) {
      for (const f of p.fixtures) {
        fixtures += f.count;
        if (f.type === 'laser') lasers += f.count;
      }
    }
    for (const fx of rig.floorFx) {
      fixtures += fx.count;
      if (fx.type === 'floor_laser') lasers += fx.count;
    }
    return { fixtures, lasers };
  }, [rig]);

  const oneNightCostLabel = useMemo(() => {
    const est = calculateProductionEstimate(rig, studioStage);
    return `${formatUSD(est.oneNightShowTotal)}/NT`;
  }, [rig, studioStage]);

  const toggleDirector = () => {
    if (!allows(clockModeRef.current, 'autoLD', 'auto_ld')) {
      showToast(`Auto-LD is disabled in ${clockModeRef.current} mode.`);
      return;
    }
    directorArmed.current = true; setFollow(null);
    previewRig();
    const next = !autoDirRef.current;
    if (!next) engineRef.current?.releaseDirector(true);
    autoDirRef.current = next;
    lastDemoTick.current = -1;
    lastAutoSwitchRef.current = performance.now();
    const position = live.audio.get().demo;
    if (next && position) setActiveCueId(null);
    setShowState(s => next && position ? applyDemoLighting({ ...s, autoDirector: true }, position) : { ...s, autoDirector: next });
    showToast(next ? 'Auto-LD on' : 'Manual lighting control');
  };
  const takeDesk = () => {
    previewRig();
    setCueModified(true);
    if (autoDirRef.current) engineRef.current?.releaseDirector(true);
    autoDirRef.current = false;
    setShowState(s => s.autoDirector ? { ...s, autoDirector: false } : s);
  };
  const applyRig = useCallback((next: RigConfig, saveNow = false) => {
    // Loading a preset leaves storage alone, but the first edit to one becomes the saved design,
    // as long as that doesn't replace a design already saved in the single slot.
    if (next.schemaVersion !== 1 && !savedDesign && !isPristinePreset(next)) next = { ...next, schemaVersion: 1 };
    setRig(next);
    if (next.schemaVersion !== 1) return;
    setSavedDesign(next);
    pendingDesign.current = next;
    window.clearTimeout(saveTimer.current);
    if (saveNow) flushDesign();
    else saveTimer.current = window.setTimeout(flushDesign, 250);
  }, [savedDesign, flushDesign]);
  const openDocument = (rawJson: string, bundledMedia: BundleAsset[] = []) => {
    const json = rawJson.charCodeAt(0) === 0xfeff ? rawJson.slice(1) : rawJson;
    if (json.length > MAX_SHOW_JSON_BYTES || new TextEncoder().encode(json).length > MAX_SHOW_JSON_BYTES) {
      throw new Error('This JSON file exceeds the 32 MiB limit.');
    }
    let object: unknown;
    try { object = JSON.parse(json); } catch { throw new Error('Choose a valid StageForge JSON file.'); }
    if (!object || typeof object !== 'object' || !('format' in object)) {
      const next = normalizeDesign(parseRigJson(json));
      installStage();
      installInterchange();
      wallClock.set(0, false);
      timeline.stop();
      timeline.syncWallDuration(0, false, true);
      applyRig(next, true); previewRig(); showToast(`Opened ${next.name}.`); return;
    }
    // Parse and normalize everything fallible before mutating any live desk state or assets.
    const file = parseShowFile(json);
    const nextRig = normalizeDesign(file.rig);
    const referenced = referencedFiles(file.media, file.cues, file.timeline, file.stage);
    const wall = file.media?.screen ?? NO_SCREEN;

    pruneAssets(referenced);
    for (const { kind, file: medium } of bundledMedia) registerAsset(kind, medium);
    const look = wallLook(file.look, wall);
    timeline.replace(file.timeline, {
      look: file.look, cueId: file.activeCueId, camera: file.controls?.camera ?? 'foh',
      volume: file.controls?.volume ?? 0.72, bump: EMPTY_BUMP,
      screen: wall, music: file.media?.music ?? NO_MUSIC,
    });
    installStage(file.stage);
    installInterchange(file.interchange);
    takeMetaExplicitRef.current = file.timeline?.frameRate !== undefined || file.timeline?.timecodeOffsetMs !== undefined;
    showControl.syncFromShowTimeline(file.timeline);
    beatGridAbortRef.current?.abort();
    setBeatGridStatus({ state: 'idle' });
    wallClock.set(0, false);
    setFollow(null); directorArmed.current = false;
    audioEngineRef.current?.stopAll();
    live.audio.set(EMPTY_AUDIO);
    setAudioDiscrete(INITIAL_DISCRETE_AUDIO);
    setControllerBump(EMPTY_BUMP); setBump(EMPTY_BUMP);
    expectedMusic.current = file.media?.music ?? NO_MUSIC;
    applyRig(nextRig, true);
    setCues(file.cues); setActiveCueId(file.activeCueId);
    setCueModified(differsFromCue(look, file.cues.find(c => c.id === file.activeCueId), wall));
    setShowState(look); autoDirRef.current = look.autoDirector;
    setScreen(wall); setCaptureVideoPosition(false); setVolume(file.controls?.volume ?? 0.72); setActiveCamera(file.controls?.camera ?? 'foh');
    audioEngineRef.current?.setBpm(look.bpm); audioEngineRef.current?.setVolume(file.controls?.volume ?? 0.72);
    engineRef.current?.releaseDirector(false); engineRef.current?.setShowState(look); previewRig();
    if (wall.kind === 'video') engineRef.current?.restoreScreenTransport(wall.playing, wall.offsetSeconds);
    engineRef.current?.setCameraPreset(file.controls?.camera ?? 'foh');
    const missingCount = [...referenced].filter(key => !assets.current.has(key)).length;
    const warning = missingCount ? ` · ${missingCount} missing media ${missingCount === 1 ? 'file' : 'files'}` : '';
    showToast(`Opened ${file.rig.name} · ${file.cues.length} cues${warning}.`);
  };
  const openBundleBytes = async (bytes: Uint8Array, request?: number) => {
    const { MAX_BUNDLE_BYTES, openShowBundle } = await import('./data/showBundle');
    if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
    // Fully verified (hashes, paths, schema) before any desk state changes.
    const bundle = await openShowBundle(bytes);
    if (request !== undefined && request !== openRequestRef.current) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    openDocument(JSON.stringify(bundle.show), bundle.files);
  };
  // MVR (DIN SPEC 15801) rigs from StageForge or other tools. A StageForge export restores
  // exactly; other files become trusses, fixtures, screens and props, with notes on what changed.
  const openMvrBytes = async (bytes: Uint8Array, request?: number) => {
    const { importMvr } = await import('./interchange/mvr/importMvr');
    const { rig: next, stage, interchange, resources, report } = importMvr(bytes);
    const normalized = normalizeDesign(next);
    if (request !== undefined && request !== openRequestRef.current) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    installStage(stage);
    installInterchange(interchange, resources);
    wallClock.set(0, false);
    timeline.stop();
    const lastWallMs = stage?.screenEvents.at(-1)?.atMs ?? 0;
    timeline.syncWallDuration(lastWallMs, (stage?.screenEvents.length ?? 0) > 0, true);
    applyRig(normalized, true); previewRig();
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    // Keep the toast readable: a hostile or huge file can produce long names and many notes.
    const notes = report.notes.join(' ');
    const brief = notes.length > 240 ? `${[...notes].slice(0, 239).join('').trimEnd()}…` : notes;
    showToast(`Opened ${next.name} from MVR · ${count(report.fixtures, 'fixture', 'fixtures')} · ${count(report.trusses, 'truss', 'trusses')}${brief ? ' · ' + brief : ''}`);
  };
  const openFile = async (file: File) => {
    const request = ++openRequestRef.current;
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.mvr')) {
      const { MAX_ARCHIVE_BYTES } = await import('./interchange/mvr/archive');
      if (file.size > MAX_ARCHIVE_BYTES) throw new Error('This MVR file exceeds the 512 MiB limit.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (request !== openRequestRef.current) return;
      if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
      return openMvrBytes(bytes, request);
    }
    if (!lower.endsWith('.zip')) {
      if (file.size > MAX_SHOW_JSON_BYTES) throw new Error('This JSON file exceeds the 32 MiB limit.');
      const text = await file.text();
      if (request !== openRequestRef.current) return;
      if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
      return openDocument(text);
    }
    const { MAX_BUNDLE_BYTES } = await import('./data/showBundle');
    if (file.size > MAX_BUNDLE_BYTES) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (request !== openRequestRef.current) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    await openBundleBytes(bytes, request);
  };
  const saveDocument = async (action: FileAction) => {
    if (action === 'rig') return downloadRig(rig);
    if (action === 'show' || action === 'bundle') {
      const validActiveCue = cues.some(c => c.id === activeCueId) ? activeCueId : null;
      const file = makeShowFile(rig, cues, showState, validActiveCue, { camera: activeCamera, volume }, timeline.snapshot(),
        { music: readMusic(), screen: readScreen() }, nativeStage.current, interchangeRef.current);
      if (action === 'bundle') {
        const { createShowBundle } = await import('./data/showBundle');
        downloadStageFile(rig.name, 'stageforge.zip', await createShowBundle(file, assets.current));
      } else {
        downloadStageFile(rig.name, 'stageforge.show.json', new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
      }
    } else if (action === 'glb') {
      if (!engineRef.current) throw new Error('The 3D stage is still loading.');
      downloadStageFile(rig.name, 'glb', await engineRef.current.exportCurrentStageGlb());
    } else if (action === 'mvr') {
      const [{ exportMvrDocument }, { version }] = await Promise.all([import('./interchange/mvr/exportMvr'), import('../package.json')]);
      const prev = interchangeRef.current;
      const exported = exportMvrDocument(rig, nativeStage.current, version, prev, mvrResourcesRef.current);
      // Persist emitted UUIDs while keeping any prior passthrough intact (never silently prune it on export).
      interchangeRef.current = prev?.mvr?.passthrough
        ? { mvr: { ...exported.interchange.mvr, passthrough: prev.mvr.passthrough } }
        : exported.interchange;
      downloadStageFile(rig.name, 'mvr', new Blob([exported.bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
      if (exported.notes.length) showToast(`Exported MVR · ${exported.notes.join(' ')}`);
    } else if (action === 'dxf') {
      const { exportStageDxf } = await import('./data/stageDxf');
      downloadStageFile(rig.name, 'dxf', new Blob([exportStageDxf(rig, studioStage)], { type: 'application/dxf' }));
    } else if (action === 'inventoryCsv') {
      const { equipmentInventoryCsv } = await import('./data/equipmentInventory');
      downloadStageFile(rig.name, 'equipment.csv', new Blob([equipmentInventoryCsv(rig, studioStage, shopStock)], { type: 'text/csv;charset=utf-8' }));
    } else if (action === 'riggingPowerCsv') {
      const { riggingPowerCsv } = await import('./data/powerReport');
      downloadStageFile(rig.name, 'rigging-power.csv', new Blob([riggingPowerCsv(rig, studioStage)], { type: 'text/csv;charset=utf-8' }));
    } else {
      downloadStageFile(rig.name, 'patch.csv', new Blob([patchCsv(rig)], { type: 'text/csv;charset=utf-8' }));
    }
  };
  const openExample = async (name: 'amber-walk-on' | 'split-rig') => {
    const request = ++openRequestRef.current;
    const folder = import.meta.env.BASE_URL + 'examples/';
    const [show, video] = await Promise.all([fetch(folder + name + '.stageforge.show.json'), fetch(folder + 'amber-clouds.mp4')]);
    if (!show.ok || !video.ok) throw new Error('The example files could not be opened.');
    const [json, videoBlob] = await Promise.all([show.text(), video.blob()]);
    if (request !== openRequestRef.current) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    openDocument(json, [{ kind: 'video', file: new File([videoBlob], 'amber-clouds.mp4', { type: 'video/mp4' }) }]);
  };
  const media = { music: readMusic(), screen: readScreen() };
  const referencedMedia = useMemo(() => referencedFiles(media, cues, timeline.timeline, studioStage),
    [studioStage, cues, timeline.timeline, media.music.name, media.music.kind, media.screen.name, media.screen.kind]);
  const missing = useMemo(() => [...referencedMedia].filter(k => !assets.current.has(k)).map(k => k.slice(k.indexOf(':') + 1)), [referencedMedia, linkedVersion]);
  const onRelink = (files: File[]) => {
    let count = 0;
    for (const f of files) {
      for (const kind of ['file','video','image'] as const) {
        const key = kind + ':' + f.name;
        if (!referencedMedia.has(key) || assets.current.has(key)) continue;
        const asset = registerAsset(kind, f);
        if (replaying.current && replayMusicClock.current > 0 && kind === 'file' && expectedMusic.current.kind === 'file' && expectedMusic.current.name === f.name) {
          restoreReplayMusic(expectedMusic.current, performance.now() - replayMusicClock.current);
        } else if (replaying.current && kind === replayScreen.current.kind && replayScreen.current.name === f.name) {
          const ref = replayScreen.current;
          const look = wallLook(replayLook.current, ref);
          replayLook.current = look;
          setShowState(look);
          engineRef.current?.setShowState(look);
          engineRef.current?.restoreScreenTransport(ref.playing, replayScreenOffset());
        } else if (kind !== 'file' && kind === screen.kind && screen.name === f.name) {
          const next = { ...showState, led: { ...showState.led, customMediaType: kind, customMediaUrl: asset.url! } };
          setShowState(next);
          engineRef.current?.setShowState(next);
          if (kind === 'video') engineRef.current?.restoreScreenTransport(screen.playing, screen.offsetSeconds);
        }
        count++;
      }
    }
    if (count) wallClock.refresh();
    return count ? `Relinked ${count} media reference${count === 1 ? '' : 's'}.` : 'Choose media with the filenames listed in this show.';
  };
  const fileCommand = React.useEffectEvent(async (command: 'open' | 'openBundle' | 'openMvr' | 'export' | FileAction, source?: string | Uint8Array) => {
    if (designerOpenRef.current) {
      window.alert('Apply or cancel the open stage plan before opening or exporting a rig.');
      return;
    }
    if (command !== 'open' && command !== 'openBundle' && command !== 'openMvr') {
      void saveDocument(command === 'export' ? 'rig' : command).catch(e => window.alert(e.message));
      return;
    }
    if (source === undefined) return;
    const request = ++openRequestRef.current;
    try {
      if (command === 'openMvr' && typeof source !== 'string') await openMvrBytes(source, request);
      else if (command === 'openBundle' && typeof source !== 'string') await openBundleBytes(source, request);
      else if (typeof source === 'string') openDocument(source);
    } catch (error) {
      if (request === openRequestRef.current) {
        window.alert(error instanceof Error ? error.message : 'Could not open this StageForge rig.');
      }
    }
  });
  useEffect(() => window.stageforgeDesktop?.onRigCommand(fileCommand), []);

  const controller = useShowGamepad({
    enabled: !costModalOpen && !designerRig && !filesOpen && !cueEditor && timeline.mode !== 'playing',
    command: action => {
      switch (action) {
        case 'play':
          if (!live.audio.get().playing && navigator.userActivation && !navigator.userActivation.hasBeenActive) {
            showToast('Click Play once to enable browser audio.');
          } else handleTogglePlay();
          break;
        case 'prevCue':
        case 'nextCue': {
          const cue = action === 'nextCue' ? nextCue : previousCue;
          if (!cue) break;
          triggerCue(cue);
          showToast(cue.name);
          break;
        }
        case 'prevCamera':
        case 'nextCamera': {
          const index = CAMERAS.findIndex(c => c.id === activeCamera);
          const next = (index + (action === 'nextCamera' ? 1 : -1) + CAMERAS.length) % CAMERAS.length;
          handleCamera(CAMERAS[next].id);
          break;
        }
        case 'masterUp':
        case 'masterDown':
          previewRig();
          setCueModified(true);
          setShowState(s => ({ ...s, masterDimmer: Math.max(0, Math.min(1, s.masterDimmer + (action === 'masterUp' ? 0.05 : -0.05))) }));
          break;
        case 'auto': toggleDirector(); break;
        case 'cinema': setCinemaMode(v => !v); break;
      }
    },
    hold: (key, active) => setControllerBump(s => ({ ...s, [key]: active })),
    orbit: (x, y) => engineRef.current?.orbitBy(x, y),
  });

  const demoOpeningBlack = showState.autoDirector && audioDiscrete.openingBlack;
  useEffect(() => {
    if (cinemaMode || designerRig || costModalOpen) setBump(EMPTY_BUMP);
  }, [cinemaMode, designerRig, costModalOpen]);
  // Every cue the take fires; the console draws them all as scrubber markers.
  const takeCues = useMemo(() => (timeline.timeline?.events ?? [])
    .filter((e): e is TimelineEvent & { cueId: string } => typeof e.cueId === 'string')
    .map(e => ({ atMs: e.atMs, cueId: e.cueId, name: cues.find(c => c.id === e.cueId)?.name ?? e.cueId })),
  [timeline.timeline, cues]);
  return (
    <main data-cinema={cinemaMode} data-demo-blackout={demoOpeningBlack} className="stage-workstation relative w-screen h-screen bg-black overflow-hidden">
      {/* Full-Viewport HQ 3D WebGL2 Canvas */}
      <div ref={viewportRef} className="stage-viewport w-full h-full cursor-grab active:cursor-grabbing" />
      <ShowOverlay audioStore={live.audio} controller={controller} cinema={cinemaMode} />

      {/* Top Transport, Audio, Cameras & Tools Bar */}
      <TopBar
        fpsStore={live.fps}
        fixtureCount={counts.fixtures}
        laserCount={counts.lasers}
        audioStore={live.audio}
        getLinkedMusic={readMusic}
        getTrackDuration={() => audioEngineRef.current?.trackDuration() ?? 0}
        onSeekTrack={seconds => {
          const currentMusic = readMusic();
          if (currentMusic.kind !== 'file') return;
          expectedMusic.current = { ...currentMusic, offsetSeconds: seconds };
          audioEngineRef.current?.seekTrack(seconds);
          live.audio.set({ ...live.audio.get() });
        }}
        volume={volume}
        bpm={showState.bpm}
        tempo={tempoProps}
        openingBar={demoOpeningBlack ? audioDiscrete.openingBar : undefined}
        blackout={showState.blackout}
        autoDirector={showState.autoDirector}
        audioReactive={showState.audioReactive}
        activeCamera={activeCamera}
        rigDrawerOpen={rigDrawerOpen}
        dmxDrawerOpen={dmxDrawerOpen}
        showControlOpen={showControlOpen}
        clockMode={showControl.clockMode}
        costModalOpen={costModalOpen}
        oneNightCostLabel={oneNightCostLabel}
        cinemaMode={cinemaMode}
        onTogglePlay={handleTogglePlay}
        onStartDemo={startDemo}
        onDesignStage={() => setDesignerRig(rig)}
        onShowFiles={() => setFilesOpen(true)}
        onUploadAudio={handleUploadAudio}
        onToggleMic={handleToggleMic}
        onVolumeChange={(v) => {
          setVolume(v);
          audioEngineRef.current?.setVolume(v);
        }}
        onBpmChange={(nextBpm) => applyDeskBpm(nextBpm)}
        onToggleAutoDirector={toggleDirector}
        onToggleAudioReactive={() => {
          setCueModified(true);
          setShowState((s) => ({ ...s, audioReactive: !s.audioReactive }));
        }}
        onSelectCamera={handleCamera}
        onToggleRigDrawer={() => {
          previewRig();
          if (window.matchMedia('(max-width: 779px)').matches) {
            setDmxDrawerOpen(false);
            setShowControlOpen(false);
          }
          setRigDrawerOpen((v) => !v);
        }}
        onToggleDmxDrawer={() => {
          setShowControlOpen(false);
          if (window.matchMedia('(max-width: 779px)').matches) {
            setRigDrawerOpen(false);
          }
          setDmxDrawerOpen((v) => !v);
        }}
        onToggleShowControl={() => {
          setDmxDrawerOpen(false);
          if (window.matchMedia('(max-width: 779px)').matches) {
            setRigDrawerOpen(false);
          }
          setShowControlOpen((v) => !v);
        }}
        onToggleCostModal={() => setCostModalOpen((v) => !v)}
        onToggleCinemaMode={() => setCinemaMode((v) => !v)}
      />

      {/* Live Status Toast & Blackout Pill */}
      {missing.length > 0 && <button type="button" className="media-relink-alert" onClick={() => setFilesOpen(true)}>
        {missing.length} missing media {missing.length === 1 ? 'file' : 'files'} · Relink
      </button>}
      {filesOpen && <ErrorBoundary label="Show files" onReset={() => setFilesOpen(false)} onExportRig={() => downloadRig(rig)}><ShowFiles name={rig.name} media={media} stage={studioStage} timeline={timeline.timeline} missing={missing} cueNames={new Map(cues.map(c => [c.id, c.name]))}
        onOpen={openFile} onExample={openExample} onSave={saveDocument} onRelink={onRelink} onError={showToast} onClose={() => setFilesOpen(false)}/></ErrorBoundary>}
      {cueEditor && <ErrorBoundary label="Cue list editor" onReset={() => setCueEditor(false)} onExportRig={() => downloadRig(rig)}><CueListEditor cues={cues} capture={() => ({ id: crypto.randomUUID(), name: 'New look',
        tag: 'USER', accent: showState.primaryColor, state: structuredClone(showState), screen: cueScreen() })}
        onApply={next => {
          const index = next.findIndex(c => c.id === activeCueId);
          if (index < 0) { setActiveCueId(null); setCueModified(false); }
          if (index < 0 || !next[index + 1] || next[index].followSeconds !== cues[currentIndex]?.followSeconds) setFollow(null);
          setCues(next);
        }}
        onClose={() => setCueEditor(false)}/></ErrorBoundary>}
      {toast && !demoOpeningBlack && (
        <div role="status" aria-live="polite" className="fixed top-16 left-1/2 -translate-x-1/2 z-50 glass-panel px-4 py-1.5 rounded-full text-xs font-mono-tech text-cyan-200 border-cyan-400/50 shadow-lg pointer-events-none">
          {toast}
        </div>
      )}

      {/* Always-visible safety badge whenever live DMX output is enabled (including cinema mode) */}
      <LiveDmxBadge
        banner={liveDmx.banner}
        busy={liveDmx.busy}
        hasCatalogFixtures={hasCatalogFixtures(rig)}
        onStop={() => void liveDmx.disable()}
        onOpenOutput={() => {
          setCinemaMode(false);
          setDmxDrawerOpen(true);
        }}
      />

      {/* Clock-ownership indicator when chasing external timecode or driven by external cue caller */}
      <ClockBadge
        clockMode={showControl.clockMode}
        lockState={showControl.lockState}
        tcStore={showControl.tcStore}
        liveDmxActive={liveDmx.banner.active}
        onReturnToMaster={() => showControl.setClockMode('master')}
        onOpenShowControl={() => {
          setCinemaMode(false);
          setShowControlOpen(true);
        }}
      />

      {showState.blackout && !demoOpeningBlack && (
        <div role="alert" className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none px-5 py-2 rounded-xl bg-rose-950/80 border border-rose-500/70 font-mono-tech text-sm tracking-widest text-rose-200 shadow-[0_0_30px_rgba(244,63,94,0.45)]">
          STAGE BLACKOUT — PRESS [SPACE] TO RESTORE
        </div>
      )}

      {/* Slide-Over Rig Builder */}
      {!cinemaMode && (
        <ErrorBoundary label="Rig Builder" onReset={() => setRigDrawerOpen(false)} onExportRig={() => downloadRig(rig)}>
          <RigBuilderDrawer
            open={rigDrawerOpen}
            rig={rig}
            stage={studioStage}
            shopStock={shopStock}
            onChangeShopStock={updateShopStock}
            onOpenInventory={() => setCostModalOpen(true)}
            onClose={() => setRigDrawerOpen(false)}
            onDesignStage={() => setDesignerRig(rig)}
            onOpenSavedDesign={savedDesign ? () => setDesignerRig(savedDesign) : undefined}
            onNotify={showToast}
            onModelChanged={(podId, groupId) => {
              interchangeRef.current = pruneInterchangeFixtureSpecs(interchangeRef.current, podId, groupId);
            }}
            onChangeRig={(next, replacing) => {
              if (replacing && !confirmDiscardStage()) return;
              if (replacing) {
                installStage();
                installInterchange();
              }
              applyRig(next);
            }}
            onChangeStage={(next) => {
              const hadEvents = (nativeStage.current?.screenEvents.length ?? 0) > 0;
              installStage(next);
              const nextEvents = next?.screenEvents ?? [];
              if (hadEvents || nextEvents.length) timeline.syncWallDuration(nextEvents.at(-1)?.atMs ?? 0, nextEvents.length > 0, true);
              previewRig();
            }}
          />
        </ErrorBoundary>
      )}

      {/* Slide-Over DMX512 Live Monitor */}
      {!cinemaMode && (
        <ErrorBoundary label="DMX Monitor" onReset={() => setDmxDrawerOpen(false)} onExportRig={() => downloadRig(rig)}>
          <DmxMonitorDrawer
            open={dmxDrawerOpen}
            rig={rig}
            dmxStore={live.dmx}
            liveOutput={liveDmx}
            onClose={() => setDmxDrawerOpen(false)}
          />
        </ErrorBoundary>
      )}

      {/* Slide-Over Show Control & Sync Drawer */}
      {!cinemaMode && (
        <ErrorBoundary label="Show Control" onReset={() => setShowControlOpen(false)} onExportRig={() => downloadRig(rig)}>
          <ShowControlDrawer
            open={showControlOpen}
            control={showControl}
            onClose={() => setShowControlOpen(false)}
          />
        </ErrorBoundary>
      )}

      {/* Real-World Production Cost & Crew Labor Estimator Modal */}
      {designerRig && (
        <ErrorBoundary label="Stage Designer" onReset={() => setDesignerRig(null)} onExportRig={() => downloadRig(rig)}>
          <StageDesigner rig={designerRig} stage={studioStage} onClose={() => setDesignerRig(null)} onChange={(design, stage, replacing) => {
            const next = normalizeDesign(design);
            // A new blank design replaces the authored overlay and its wall cues, even if the user then
            // drew new screens or hangs; ask first, and keep the designer open if they decline.
            if (replacing && !confirmDiscardStage()) return false;
            if (replacing) installInterchange();
            // The designer edits walls, hangs and layout alongside the rig; its stage keeps existing wall cues.
            const hadEvents = (nativeStage.current?.screenEvents.length ?? 0) > 0;
            installStage(stage);
            const nextEvents = stage?.screenEvents ?? [];
            if (hadEvents || nextEvents.length) timeline.syncWallDuration(nextEvents.at(-1)?.atMs ?? 0, nextEvents.length > 0, true);
            applyRig(next, true);
            previewRig();
            setDesignerRig(null);
          }} />
        </ErrorBoundary>
      )}
      {costModalOpen && (
        <ErrorBoundary
          label="Gear & Production"
          onReset={() => {
            setCostModalRetry((n) => n + 1);
            setCostModalOpen(false);
          }}
          onExportRig={() => downloadRig(rig)}
        >
          <Suspense fallback={null}>
            <CostEstimatorModal
              rig={rig}
              stage={studioStage}
              shopStock={shopStock}
              onChangeShopStock={updateShopStock}
              onChangeRig={(next) => {
                previewRig();
                applyRig(next);
              }}
              onClose={() => setCostModalOpen(false)}
              onDeployRig={() => showToast('Virtual Crew Load-In Approved ($0.00) — Show Live!')}
              onNotify={showToast}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Bottom FOH DMX Console & Laser Visuals Deck */}
      {!cinemaMode && (
        <BottomConsole
          state={showState}
          bump={liveBump}
          rig={rig}
          cues={cues}
          activeCueId={activeCueId}
          cueModified={cueModified}
          onPatchState={(patch) => {
            if (Object.keys(patch).some(key => key !== 'masterDimmer' && key !== 'blackout' && key !== 'bloomStrength')) takeDesk();
            else { previewRig(); setCueModified(true); }
            setShowState((s) => applyDeskPatch(s, patch));
          }}
          onPatchLaser={(patch) => {
            takeDesk();
            setShowState((s) => ({ ...s, laser: { ...s.laser, ...patch } }));
          }}
          onPatchMotors={(patch) => {
            takeDesk();
            setShowState((s) => ({ ...s, motors: { ...s.motors, ...patch } }));
          }}
          onPatchAtmo={(patch) => {
            takeDesk();
            setShowState((s) => ({ ...s, atmo: { ...s.atmo, ...patch } }));
          }}
          onPatchLed={(patch) => {
            takeDesk();
            setShowState((s) => ({ ...s, led: { ...s.led, ...patch } }));
          }}
          onSetPodMotor={(podId, height, tilt) => {
            takeDesk();
            setShowState((s) => ({
              ...s,
              motors: {
                ...s.motors,
                mode: 'manual',
                podTargets: {
                  ...s.motors.podTargets,
                  [podId]: { height, tilt },
                },
              },
            }));
          }}
          onTriggerCue={(cue) => {
            triggerCue(cue);
            showToast(`Cue Triggered: ${cue.name}`);
          }}
          onSaveCue={handleSaveCue}
          onUploadScreen={file => {
            const kind = file.type.startsWith('video/') || (!file.type && VIDEO_EXT.test(file.name)) ? 'video' : 'image';
            const asset = registerAsset(kind, file);
            takeDesk(); setCaptureVideoPosition(false); setScreen({ target: 'main-led', kind, name: file.name, playing: kind === 'video', offsetSeconds: 0 });
            setShowState(s => ({ ...s, led: { ...s.led, brightness: s.led.brightness <= 0.05 ? 1 : s.led.brightness,
              customMediaUrl: asset.url!, customMediaType: kind, visualMode: 'custom', enabled: true } }));
          }}
          screenName={media.screen.name} videoPlaying={media.screen.playing}
          captureVideoPosition={captureVideoPosition} onCaptureVideoPosition={setCaptureVideoPosition}
          onToggleVideo={() => {
            if (missing.includes(screen.name)) { setFilesOpen(true); return; }
            takeDesk();
            const next = { ...readScreen(), playing: !media.screen.playing };
            setScreen(next);
            if (next.playing) setShowState(s => ({ ...s, led: { ...s.led, enabled: true, visualMode: 'custom' } }));
          }}
          onEditCues={() => setCueEditor(true)}
          onGo={() => { if (nextCue) triggerCue(nextCue); }}
          onResetCue={() => { if (cues[0]) triggerCue(cues[0]); }}
          onHold={() => setFollow('held')}
          follow={follow}
          stage={studioStage}
          mainScreen={media.screen}
          missingMedia={missing}
          onApplyWallCue={(event: SecondaryScreenEvent, file?: File) => {
            const clampedAtMs = Math.max(0, Math.min(MAX_WALL_CUE_MS, Math.round(event.atMs)));
            const nextStage = upsertSecondaryScreenEvent(rig, nativeStage.current, event);
            // upsert rejects unknown walls and unnamed media; leave the desk untouched then.
            if (!nextStage.screenEvents.some(e => e.target === event.target && e.atMs === clampedAtMs)) return;
            if (file && event.kind !== 'none') registerAsset(event.kind, file);
            installStage(nextStage);
            const lastWallMs = nextStage.screenEvents.at(-1)?.atMs ?? 0;
            timeline.syncWallDuration(lastWallMs, nextStage.screenEvents.length > 0);
            previewRig();
            const endMs = Math.max(timeline.timeline?.durationMs ?? 0, lastWallMs);
            // While a take records or replays, keep the walls on the shared clock;
            // when idle, preview the edited cue at its own time.
            if (timeline.mode === 'idle') wallClock.set(clampedAtMs, false, endMs);
            else wallClock.set(wallClock.position(), true, timeline.mode === 'recording' ? Infinity : endMs);
          }}
          onRemoveWallCue={(target, atMs) => {
            const nextStage = removeSecondaryScreenEvent(rig, nativeStage.current, target, atMs);
            installStage(nextStage);
            const nextEvents = nextStage?.screenEvents ?? [];
            timeline.syncWallDuration(nextEvents.at(-1)?.atMs ?? 0, nextEvents.length > 0, true);
            wallClock.refresh();
          }}
          take={{
            mode: timeline.mode,
            timeMs: timeline.timeMs,
            durationMs: Math.max(timeline.timeline?.durationMs ?? 0, studioStage?.screenEvents.at(-1)?.atMs ?? 0),
            hasTake: !!timeline.timeline && (timeline.timeline.events.length > 0 || timeline.timeline.durationMs > 0),
            canResume: timeline.canResume,
            cues: takeCues,
            playhead: () => timeline.playhead(),
            record: () => {
              if (!timeline.timeline?.events.length || window.confirm('Replace the recorded take in this session?')) {
                const stampMeta = takeMetaExplicitRef.current || showControl.clockMode === 'chase';
                timeline.record(stampMeta ? {
                  frameRate: showControl.settings.frameRate,
                  timecodeOffsetMs: showControl.settings.timecodeOffsetMs,
                } : undefined);
                wallClock.set(0, true);
              }
            },
            play: () => {
              if (!allows(clockModeRef.current, 'internal', 'take_play')) {
                showToast(`Replay is disabled in ${clockModeRef.current} mode.`);
                return;
              }
              if (missing.length) showToast(`Playing with missing media. Relink ${missing.join(', ')} in Files.`);
              const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
              setFollow(null); replaying.current = true; replayLook.current = showState; replayScreen.current = NO_SCREEN; replayMusicClock.current = 0;
              engineRef.current?.releaseDirector(false); previewRig(); timeline.play(false);
              wallClock.set(0, true, endMs);
            },
            resume: () => {
              if (!allows(clockModeRef.current, 'internal', 'take_play')) {
                showToast(`Replay is disabled in ${clockModeRef.current} mode.`);
                return;
              }
              if (missing.length) showToast(`Playing with missing media. Relink ${missing.join(', ')} in Files.`);
              const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
              setFollow(null); replaying.current = true; replayLook.current = showState; replayMusicClock.current = 0;
              engineRef.current?.releaseDirector(false); previewRig(); timeline.play(true);
              wallClock.set(timeline.playhead(), true, endMs);
            },
            pause: () => {
              timeline.pause();
              replaying.current = false;
              const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
              wallClock.set(timeline.playhead(), false, endMs);
            },
            seek: (ms: number) => {
              const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
              const clamped = Math.max(0, Math.min(endMs, Math.round(ms)));
              const keepPlaying = timeline.mode === 'playing' && clamped < endMs;
              setFollow(null); replaying.current = keepPlaying;
              engineRef.current?.releaseDirector(false); previewRig();
              timeline.seek(clamped);
              wallClock.set(clamped, keepPlaying, endMs);
            },
            stop: () => {
              timeline.stop();
              replaying.current = false;
              wallClock.set(timeline.playhead(), false);
            },
          }}
          clockMode={showControl.clockMode}
          tempo={tempoProps}
          ilda={{
            clip: ildaClip,
            mode: ildaMode,
            fps: ildaFps,
            onLoadDemo: handleLoadDemoIlda,
            onUploadFile: (file) => { void handleUploadIlda(file); },
            onClear: handleClearIlda,
            onChangeMode: setIldaMode,
            onChangeFps: setIldaFps,
          }}
          onSetBump={(key, active) => setBump((b) => ({ ...b, [key]: active }))}
        />
      )}
    </main>
  );
};
export default App;
