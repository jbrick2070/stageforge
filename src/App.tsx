import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StageEngine } from './engine/StageEngine';
import type { SecondaryScreenState } from './engine/StageScreens';
import {
  loadRenderSettings,
  parseRenderSettings,
  resolveEffectiveFullRateStrobe,
  resolveEffectiveLookOutput,
  saveRenderSettings,
  type RenderSettings,
} from './engine/renderSettings';
import { detectRenderTier } from './engine/hardwareMaterials';
import { AudioEngine } from './audio/AudioEngine';
import {
  analyzeFileBeatGrid,
  doubleTimeBpm,
  foldBpm,
  halfTimeBpm,
  LiveBpmStabilizer,
  nudgeBeatGrid,
  retimeBeatGrid,
  setBeatGridDownbeat,
  TapTempoTracker,
  type BeatGridStatus,
  type LiveBpmStatus,
} from './audio/tempoEngine';
import { CAMERAS, TopBar, type TempoControlProps } from './components/TopBar';
import { ShowOverlay } from './components/ShowOverlay';
import { ClockBadge } from './components/ClockBadge';
import { allows, createChaseTransportHandlers, type ClockMode } from './showControl/clockOwner';
import { useShowControl } from './showControl/useShowControl';
import { useShowGamepad } from './input/useShowGamepad';
import { BumpLedger, sameBumpState, type BumpSourceClass } from './input/bumpLedger';
import { applyTimelineLookPatch, cueLook, differsFromCue, isFullLookSnapshot } from './data/cueLook';
import { applyDemoLighting, DEMO_BLACKOUT_STEPS } from './data/demoLighting';
import { getDemoPosition } from './data/demoShow';
import {
  demoTrackMsForStep,
  fetchDemoTrackAudio,
  getDemoTrackPosition,
  probeDemoTrack,
  type AvailableDemoTrack,
} from './data/demoTrack';
import { normalizeDesign } from './data/stageDesign';
import { downloadRig, downloadStageFile, parseRigJson } from './data/rigImport';
import { makeShowFile, MAX_SHOW_JSON_BYTES, parseShowFile, pruneInterchangeFixtureSpecs, referencedFiles, type NativeStage, type ShowInterchange, type ShowTimeline } from './data/showFile';
import { hasCatalogFixtures } from './data/equipmentCatalog';
import { summarizePhysicalDrive } from './dmx/physicalDmx';
import { DEMO_ILDA_PRESETS, generateDemoIlda, ILDA_MAX_BYTES, parseIlda, type DemoIldaKind, type IldaClip } from './data/ilda';
import type { IldaRenderMode } from './engine/ildaRenderer';
import type { MusicRef, ScreenRef, TimelineEvent } from './data/showFile';
import type { BundleAsset } from './data/showBundle';
import { isCustomMainWall, MAX_WALL_CUE_MS, pruneNativeStage, removeSecondaryScreenEvent, upsertSecondaryScreenEvent, type SecondaryScreenEvent } from './data/studioGeometry';
import type { FileAction } from './components/ShowFiles';
import type { MvrReportRecord } from './components/MvrImportReport';
import type { MvrImport } from './interchange/mvr/importMvr';
import { useShowTimeline } from './input/useShowTimeline';
import { useWallClock } from './input/useWallClock';
import { patchCsv } from './data/patchCsv';
import { BottomConsole } from './components/BottomConsole';
import { EMPTY_AUDIO_MOD_TELEMETRY, type AudioModulationTelemetry } from './components/AudioMappingSection';
import { allowsNegativeAmount } from './engine/audioModulation';
import type { DmxSnapshot } from './components/DmxMonitorDrawer';
import { LiveDmxBadge } from './components/LiveDmxBadge';
import { AiProposalBanner } from './components/AiProposalBanner';
import { useAiBridge, type AiBridgeApi, type AiRevertSnapshot } from './aiBridge/useAiBridge';
import {
  AUDIENCE_SCAN_ERROR,
  cueEnablesAudienceScan,
  cueOrFollowChainEnablesAudienceScan,
  resolveAcceptedCueActiveId,
  timelineEnablesAudienceScan,
  type AiProposalCandidate,
} from './aiBridge/aiBridgeProtocol';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  DEFAULT_MEASURE_OVERLAY_OPTIONS,
  isMeasureOverlayActive,
  type MeasureOverlayOptions,
} from './engine/measureOverlay';
import { evaluateLaserZones, LASER_LSO_NOTICE, type MeasureSnapshot } from './data/measure';
import { LASER_SAFETY_DISCLAIMER } from './data/laserSafety';
import {
  EMPTY_PREFLIGHT_ACKS,
  evaluatePreflight,
  type PreflightAcknowledgementState,
  type PreflightRow,
} from './data/preflight';
import { computePowerReport, riggingPowerCsv } from './data/powerReport';
import { evaluateRigLoads } from './data/rigLoads';
import { loadShopStockState, saveShopStockState, type ShopStockState } from './data/shopStock';
import { useLiveDmxOutput } from './dmx/useLiveDmxOutput';
import {
  CapabilitiesProvider,
  capabilitiesForMode,
  isViewerUrlSearch,
  resolveGlobalHotkey,
  VIEWER_CAPABILITIES,
  EDITOR_CAPABILITIES,
} from './viewer/capabilities';
import { parseViewerSource, type ParsedViewerDocument } from './viewer/parseViewer';

const loadCostEstimatorModal = () => import('./components/CostEstimatorModal');
const createLazyCostEstimatorModal = () => lazy(loadCostEstimatorModal);
// Panels and drawers load on demand when opened (deferredComponent), keeping them out of the
// initial startup download and parse path. Their ErrorBoundaries catch any chunk load failure.
const ShowFiles = deferredComponent(() => import('./components/ShowFiles').then((m) => m.ShowFiles));
const PitchViewer = deferredComponent(() => import('./components/PitchViewer').then((m) => m.PitchViewer));
const MvrImportReportDialog = deferredComponent(() => import('./components/MvrImportReport').then((m) => m.MvrImportReport));
const CueListEditor = deferredComponent(() => import('./components/CueListEditor').then((m) => m.CueListEditor));
const StageDesigner = deferredComponent(() => import('./components/StageDesigner').then((m) => m.StageDesigner));
const RigBuilderDrawer = deferredComponent(() => import('./components/RigBuilderDrawer').then((m) => m.RigBuilderDrawer));
const DmxMonitorDrawer = deferredComponent(() => import('./components/DmxMonitorDrawer').then((m) => m.DmxMonitorDrawer));
const ShowControlDrawer = deferredComponent(() => import('./components/ShowControlDrawer').then((m) => m.ShowControlDrawer));
const MeasureOverlayHud = deferredComponent(() => import('./components/MeasureOverlayHud').then((m) => m.MeasureOverlayHud));
const PreflightPanel = deferredComponent(() => import('./components/PreflightPanel').then((m) => m.PreflightPanel));
import { createLiveStore } from './state/liveTelemetry';
import { deferredComponent } from './components/deferred';
import { INITIAL_SHOW_STATE, RIG_TEMPLATES, SHOW_CUES } from './data/presets';
import { calculateProductionEstimate, formatUSD } from './data/productionEstimator';
import { applyDeskPatch } from './data/movingGroups';
import {
  AudioMapConfig,
  AudioMetrics,
  AudioTargetGroup,
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

type WebXrPhase = 'disabled' | 'checking' | 'ready' | 'warning' | 'requesting' | 'active' | 'exiting';
type WebXrModule = typeof import('./xr/webXrAudience');

function webXrBlocksPhysicalOutput(phase: WebXrPhase): boolean {
  return phase === 'requesting' || phase === 'active' || phase === 'exiting';
}

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
  openingTotalBars: undefined as number | undefined,
  openingBeforeDownbeat: false,
};

function readSavedDesign(): RigConfig | null {
  try {
    const json = localStorage.getItem(SAVED_DESIGN_KEY);
    return json ? parseRigJson(json) : null;
  } catch {
    return null;
  }
}

interface DeskSessionSnapshot {
  rig: RigConfig;
  stage?: NativeStage;
  interchange?: ShowInterchange;
  mvrResources?: Map<string, Uint8Array>;
  cues: ShowCue[];
  activeCueId: string | null;
  cueModified: boolean;
  showState: ShowState;
  screen: ScreenRef;
  captureVideoPosition: boolean;
  activeCamera: CameraPreset;
  volume: number;
  timeline?: ShowTimeline;
  expectedMusic: MusicRef;
  assets: Map<string, { file: File; url?: string }>;
  mediaUrls: Set<string>;
  ildaClip: IldaClip | null;
  ildaMode: IldaRenderMode;
  ildaFps: number;
  lastMvrReport: MvrReportRecord | null;
  cinemaMode: boolean;
  takeMetaExplicit: boolean;
}

let viewerModeIpcQueue: Promise<unknown> = Promise.resolve();

function syncDesktopViewerMode(active: boolean): Promise<boolean> {
  const bridge = window.stageforgeDesktop;
  if (!bridge?.setViewerMode) return Promise.resolve(true);
  const task = viewerModeIpcQueue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await bridge.setViewerMode(active);
        return true;
      } catch {
        // Retry once in case the main-process IPC handler raced with startup or focus.
      }
    }
    return false;
  });
  viewerModeIpcQueue = task.catch(() => {});
  return task;
}

export const App: React.FC = () => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<StageEngine | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);

  const [viewerMode, setViewerMode] = useState<boolean>(() => isViewerUrlSearch(window.location.search));
  const viewerModeRef = useRef(viewerMode);
  viewerModeRef.current = viewerMode;

  // Device-local renderer preferences (Sprint 15: never serialized into show files)
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(() => loadRenderSettings());
  const renderSettingsRef = useRef(renderSettings);
  renderSettingsRef.current = renderSettings;
  const [webXrPhase, setWebXrPhase] = useState<WebXrPhase>('disabled');
  const webXrPhaseRef = useRef<WebXrPhase>('disabled');
  webXrPhaseRef.current = webXrPhase;
  const webXrModuleRef = useRef<WebXrModule | null>(null);
  const webXrRequestGenerationRef = useRef(0);
  const webXrWarningAcknowledgedRef = useRef(false);
  const renderTier = useMemo(() => detectRenderTier(), []);
  // Session-only opt-in for full-rate strobe preview (never persisted; always off under reduced motion / viewer / XR)
  const [fullRateStrobeOptIn, setFullRateStrobeOptIn] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );
  const [webglContextLost, setWebglContextLost] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    setPrefersReducedMotion(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const effectiveFullRateStrobe = resolveEffectiveFullRateStrobe({
    userOptIn: fullRateStrobeOptIn,
    prefersReducedMotion,
    xrPresenting: webXrBlocksPhysicalOutput(webXrPhase),
    viewerMode,
  });
  const effectiveFullRateStrobeRef = useRef(effectiveFullRateStrobe);
  effectiveFullRateStrobeRef.current = effectiveFullRateStrobe;
  const effectiveLookOutput = resolveEffectiveLookOutput(renderSettings, renderTier, prefersReducedMotion);

  useEffect(() => {
    let cancelled = false;
    const xr = navigator.xr;
    const eligible = renderSettings.webxrAudience && !viewerMode && !window.stageforgeDesktop && Boolean(xr?.isSessionSupported);
    if (!eligible || !xr) {
      const engine = engineRef.current;
      if (webXrBlocksPhysicalOutput(webXrPhaseRef.current) || engine?.isWebXrSessionActive()) {
        if (webXrPhaseRef.current === 'requesting') webXrRequestGenerationRef.current++;
        webXrPhaseRef.current = 'exiting';
        setWebXrPhase('exiting');
        if (engine?.isWebXrSessionActive()) void engine.exitWebXrSession();
        return;
      }
      webXrPhaseRef.current = 'disabled';
      setWebXrPhase('disabled');
      return;
    }
    // A slow session.end() remains fail-closed. Its completion callback chooses ready/disabled.
    if (webXrPhaseRef.current === 'exiting') return;
    webXrPhaseRef.current = 'checking';
    setWebXrPhase('checking');
    void xr.isSessionSupported('immersive-vr').then((supported) => {
      if (cancelled) return;
      const next: WebXrPhase = supported ? 'ready' : 'disabled';
      webXrPhaseRef.current = next;
      setWebXrPhase(next);
    }).catch(() => {
      if (cancelled) return;
      webXrPhaseRef.current = 'disabled';
      setWebXrPhase('disabled');
    });
    return () => { cancelled = true; };
  }, [renderSettings.webxrAudience, viewerMode]);

  const updateRenderSettings = useCallback((patch: Partial<RenderSettings>, persist = true) => {
    const next = parseRenderSettings({ ...renderSettingsRef.current, ...patch });
    renderSettingsRef.current = next;
    // Never write localStorage in read-only Pitch Viewer mode or from `?probe` test helpers.
    if (persist && !viewerModeRef.current) saveRenderSettings(next);
    engineRef.current?.setRenderSettings(next);
    setRenderSettings(next);
  }, []);

  // Clear the session-only full-rate opt-in whenever reduced-motion turns on or Pitch Viewer is entered
  // so leaving Pitch Viewer or disabling reduced-motion never silently re-arms full-rate flashing.
  useEffect(() => {
    if (prefersReducedMotion || viewerMode || webXrBlocksPhysicalOutput(webXrPhase)) {
      setFullRateStrobeOptIn(false);
    }
  }, [prefersReducedMotion, viewerMode, webXrPhase]);

  useEffect(() => {
    engineRef.current?.setFullRateStrobePreview(effectiveFullRateStrobe);
  }, [effectiveFullRateStrobe]);
  useEffect(() => {
    engineRef.current?.setPrefersReducedMotion(prefersReducedMotion);
  }, [prefersReducedMotion]);
  const capabilities = useMemo(() => capabilitiesForMode(viewerMode ? 'viewer' : 'editor'), [viewerMode]);
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const sessionEpochRef = useRef(0);
  const pendingViewerEntriesRef = useRef(0);
  const deskSnapshotRef = useRef<DeskSessionSnapshot | null>(null);

  const [savedDesign, setSavedDesign] = useState(readSavedDesign);
  const stopLiveOutputSyncRef = useRef<(reason: string) => void>(() => {});
  const nativeStage = useRef<NativeStage | undefined>(undefined);
  const interchangeRef = useRef<ShowInterchange | undefined>(undefined);
  const mvrResourcesRef = useRef<Map<string, Uint8Array> | undefined>(undefined);
  const [studioStage, setStudioStage] = useState<NativeStage>();
  const setStageDirect = (stage?: NativeStage) => {
    nativeStage.current = stage;
    setStudioStage(stage);
  };
  const installStage = (stage?: NativeStage) => {
    if (!capabilitiesRef.current.edit) return;
    const prevGeo = JSON.stringify({ walls: nativeStage.current?.walls ?? null, layout: nativeStage.current?.layout ?? null });
    const nextGeo = JSON.stringify({ walls: stage?.walls ?? null, layout: stage?.layout ?? null });
    if (prevGeo !== nextGeo) {
      stopLiveOutputSyncRef.current('Stage layout changed while live output was active — re-run pre-flight.');
    }
    setStageDirect(stage);
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
  const [rig, setRig] = useState<RigConfig>(() =>
    viewerMode ? structuredClone(RIG_TEMPLATES.arena_mainstage) : (savedDesign ?? structuredClone(RIG_TEMPLATES.arena_mainstage))
  );
  const rigRef = useRef(rig);
  rigRef.current = rig;
  const [showState, setShowState] = useState<ShowState>(() => structuredClone(INITIAL_SHOW_STATE));
  const showStateRef = useRef(showState);
  showStateRef.current = showState;
  const bumpLedgerRef = useRef(new BumpLedger());
  const bumpExpiryTimerRef = useRef<number | null>(null);
  const [liveBump, setLiveBump] = useState<BumpState>(EMPTY_BUMP);
  const liveBumpRef = useRef<BumpState>(EMPTY_BUMP);
  liveBumpRef.current = liveBump;
  const syncLiveBump = useCallback(() => {
    if (bumpExpiryTimerRef.current !== null) {
      window.clearTimeout(bumpExpiryTimerRef.current);
      bumpExpiryTimerRef.current = null;
    }
    const now = performance.now();
    const resolved = capabilitiesRef.current.edit
      ? bumpLedgerRef.current.resolve({ laserDeskEnabled: showStateRef.current.laser.enabled }, now).effective
      : EMPTY_BUMP;
    if (!sameBumpState(liveBumpRef.current, resolved)) {
      liveBumpRef.current = resolved;
      setLiveBump(resolved);
    }
    const nextExpiry = capabilitiesRef.current.edit ? bumpLedgerRef.current.nextExpiryMs(now) : null;
    if (nextExpiry !== null) {
      bumpExpiryTimerRef.current = window.setTimeout(() => {
        bumpExpiryTimerRef.current = null;
        syncLiveBump();
      }, Math.max(10, Math.ceil(nextExpiry - performance.now()) + 1));
    }
  }, []);
  const setSourceBump = useCallback((sourceId: string, sourceClass: BumpSourceClass, key: keyof BumpState, active: boolean) => {
    bumpLedgerRef.current.setHold(sourceId, sourceClass, key, active, performance.now());
    syncLiveBump();
  }, [syncLiveBump]);
  const clearSourceBumps = useCallback((prefix: string) => {
    if (bumpLedgerRef.current.clearSourcePrefix(prefix)) syncLiveBump();
  }, [syncLiveBump]);
  const clearAllBumps = useCallback(() => {
    if (bumpLedgerRef.current.clearAll()) syncLiveBump();
  }, [syncLiveBump]);
  useEffect(() => {
    syncLiveBump();
  }, [showState.laser.enabled, capabilities.edit, syncLiveBump]);
  useEffect(() => () => {
    if (bumpExpiryTimerRef.current !== null) window.clearTimeout(bumpExpiryTimerRef.current);
  }, []);
  const [cues, setCues] = useState<ShowCue[]>(() => structuredClone(SHOW_CUES));
  const [activeCueId, setActiveCueId] = useState<string | null>(null);
  const [cueModified, setCueModified] = useState(false);

  const live = useMemo(() => ({
    fps: createLiveStore(60),
    audio: createLiveStore<AudioMetrics>(EMPTY_AUDIO),
    audioMod: createLiveStore<AudioModulationTelemetry>(EMPTY_AUDIO_MOD_TELEMETRY),
    dmx: createLiveStore<DmxSnapshot>(EMPTY_DMX),
    measure: createLiveStore<MeasureSnapshot | null>(null),
  }), []);
  const [audioDiscrete, setAudioDiscrete] = useState(INITIAL_DISCRETE_AUDIO);
  const [volume, setVolume] = useState(0.72);
  const [activeCamera, setActiveCamera] = useState<CameraPreset>('foh');
  const activeCameraRef = useRef(activeCamera);
  activeCameraRef.current = activeCamera;
  const [rigDrawerOpen, setRigDrawerOpen] = useState(false);
  const [dmxDrawerOpen, setDmxDrawerOpen] = useState(false);
  const [showControlOpen, setShowControlOpen] = useState(false);
  const [costModalOpen, setCostModalOpen] = useState(false);
  const [costModalRetry, setCostModalRetry] = useState(0);
  const [measureOptions, setMeasureOptions] = useState<MeasureOverlayOptions>(DEFAULT_MEASURE_OVERLAY_OPTIONS);
  const measureOptionsRef = useRef(measureOptions);
  measureOptionsRef.current = measureOptions;
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [preflightAcks, setPreflightAcks] = useState<PreflightAcknowledgementState>(EMPTY_PREFLIGHT_ACKS);
  const [liveSafetyViolation, setLiveSafetyViolation] = useState<string | null>(null);
  const CostEstimatorModal = useMemo(() => createLazyCostEstimatorModal(), [costModalRetry]);
  // Probe once when idle for an optional demo/track.json map (~1 KB); never fetches audio on boot.
  // Skipped in read-only pitch viewer mode.
  useEffect(() => {
    if (viewerMode) return;
    const abort = new AbortController();
    let cancelled = false;
    let idleId: number | null = null;
    let timerId: number | null = null;
    const runProbe = () => {
      if (cancelled) return;
      void probeDemoTrack(import.meta.env.BASE_URL, document.baseURI, abort.signal).then((found) => {
        if (!cancelled && found) setAvailableDemoTrack(found);
      });
    };
    const scheduleProbe = () => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(runProbe, { timeout: 3000 });
      } else {
        timerId = window.setTimeout(runProbe, 1500);
      }
    };
    if (document.readyState === 'complete') {
      scheduleProbe();
    } else {
      window.addEventListener('load', scheduleProbe, { once: true });
    }
    return () => {
      cancelled = true;
      abort.abort();
      window.removeEventListener('load', scheduleProbe);
      if (idleId !== null && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [viewerMode]);
  // Notify desktop main process if booted directly in `?view` mode.
  useEffect(() => {
    if (viewerMode) {
      void syncDesktopViewerMode(true).then((ok) => {
        if (!ok) showToast('Warning: could not lock desktop menus for pitch viewer mode.');
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [shopStock, setShopStock] = useState<ShopStockState>(loadShopStockState);
  const updateShopStock = useCallback((next: ShopStockState) => {
    if (!capabilitiesRef.current.edit) return;
    setShopStock(next);
    saveShopStockState(next);
  }, []);
  const [ildaClip, setIldaClip] = useState<IldaClip | null>(null);
  const [ildaMode, setIldaMode] = useState<IldaRenderMode>('both');
  const [ildaFps, setIldaFps] = useState(30);
  const [beatGridStatus, setBeatGridStatus] = useState<BeatGridStatus>({ state: 'idle' });
  const [availableDemoTrack, setAvailableDemoTrack] = useState<AvailableDemoTrack | null>(null);
  const availableDemoTrackRef = useRef<AvailableDemoTrack | null>(null);
  availableDemoTrackRef.current = availableDemoTrack;
  const [demoTrackLoading, setDemoTrackLoading] = useState(false);
  const [demoTrackProgress, setDemoTrackProgress] = useState<number | null>(null);
  const demoTrackAbortRef = useRef<AbortController | null>(null);
  const replayDemoAbortRef = useRef<AbortController | null>(null);
  const demoTrackFilesRef = useRef(new WeakSet<File>());
  const cancelDemoTrackLoad = useCallback(() => {
    demoTrackAbortRef.current?.abort();
    demoTrackAbortRef.current = null;
    replayDemoAbortRef.current?.abort();
    replayDemoAbortRef.current = null;
    setDemoTrackLoading(false);
    setDemoTrackProgress(null);
  }, []);
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
  const [pendingMvr, setPendingMvr] = useState<{
    result: MvrImport;
    normalized: RigConfig;
    request: number;
    fileName: string;
  } | null>(null);
  const [lastMvrReport, setLastMvrReport] = useState<MvrReportRecord | null>(null);
  const [viewingMvrReport, setViewingMvrReport] = useState(false);
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

  const preflightRef = useRef<ReturnType<typeof evaluatePreflight> | null>(null);
  const aiBridgeRef = useRef<AiBridgeApi | null>(null);
  const [aiBridgeSuspendOutbound, setAiBridgeSuspendOutbound] = useState(false);
  const liveDmx = useLiveDmxOutput(
    engineRef,
    showToast,
    capabilities.liveOutput,
    clearAllBumps,
    () => {
      if (
        webXrBlocksPhysicalOutput(webXrPhaseRef.current) ||
        engineRef.current?.isWebXrPhysicalOutputInterlocked()
      ) {
        return {
          allowed: false,
          reason: 'Cannot arm physical output while VR is pending or active.',
        };
      }
      if (engineRef.current?.isContextLost() || engineRef.current?.isDisposed()) {
        return {
          allowed: false,
          reason: 'Cannot arm or start live DMX output while the 3D graphics context is lost.',
        };
      }
      const bridge = aiBridgeRef.current;
      if (bridge && (bridge.enabled || bridge.pendingProposals.length > 0)) {
        return {
          allowed: false,
          reason: 'Disable the AI bridge before arming or starting live DMX output.',
        };
      }
      const rep = preflightRef.current;
      if (!rep) return { allowed: false, reason: 'Run pre-flight check before starting live DMX output.' };
      return { allowed: rep.canArm, reason: rep.blockingReasons[0] };
    },
    rigRef,
  );
  const liveDmxRef = useRef(liveDmx);
  liveDmxRef.current = liveDmx;

  const beginWebXrRequest = useCallback((mod: WebXrModule) => {
    const dmx = liveDmxRef.current;
    if (dmx.armed || dmx.isLive) {
      showToast('VR is blocked while physical output is armed or live.');
      return;
    }
    if (webXrBlocksPhysicalOutput(webXrPhaseRef.current)) return;

    // Keep this request first after synchronous interlock checks: the warning-confirm click owns activation.
    const sessionPromise = mod.requestAudienceSession();
    engineRef.current?.setWebXrPhysicalOutputInterlock(true);
    const generation = ++webXrRequestGenerationRef.current;
    let sessionObtained = false;
    webXrWarningAcknowledgedRef.current = true;
    webXrPhaseRef.current = 'requesting';
    setWebXrPhase('requesting');
    setFullRateStrobeOptIn(false);
    engineRef.current?.setFullRateStrobePreview(false);

    void sessionPromise.then(async (session) => {
      sessionObtained = true;
      if (
        generation !== webXrRequestGenerationRef.current ||
        liveDmxRef.current.armed || liveDmxRef.current.isLive ||
        !renderSettingsRef.current.webxrAudience
      ) {
        try {
          await session.end();
        } catch {
          showToast('VR could not confirm that the session ended. Physical output remains blocked; reload after leaving VR.');
          return;
        }
        engineRef.current?.setWebXrPhysicalOutputInterlock(false);
        if (generation !== webXrRequestGenerationRef.current && webXrPhaseRef.current === 'exiting') {
          const next: WebXrPhase =
            renderSettingsRef.current.webxrAudience && !viewerModeRef.current && !window.stageforgeDesktop
              ? 'ready'
              : 'disabled';
          webXrPhaseRef.current = next;
          setWebXrPhase(next);
        }
        return;
      }
      const engine = engineRef.current;
      if (!engine) {
        try {
          await session.end();
        } catch {
          webXrPhaseRef.current = 'exiting';
          setWebXrPhase('exiting');
          showToast('VR could not confirm that the session ended. Reload after leaving VR.');
          return;
        }
        throw new Error('The 3D stage is still loading.');
      }
      await engine.enterWebXrSession(session, {
        referenceSpaceType: mod.WEBXR_REFERENCE_SPACE,
        framebufferScale: mod.WEBXR_FRAMEBUFFER_SCALE,
        foveation: mod.WEBXR_FOVEATION,
        onEnded: (reason) => {
          if (generation !== webXrRequestGenerationRef.current) return;
          const next: WebXrPhase =
            renderSettingsRef.current.webxrAudience && !viewerModeRef.current && !window.stageforgeDesktop
              ? 'ready'
              : 'disabled';
          webXrPhaseRef.current = next;
          setWebXrPhase(next);
          if (reason === 'system-exit') showToast('VR session ended by the headset.');
        },
      });
      if (generation !== webXrRequestGenerationRef.current) {
        await engine.exitWebXrSession();
        return;
      }
      webXrPhaseRef.current = 'active';
      setWebXrPhase('active');
    }).catch((error) => {
      const engine = engineRef.current;
      if (sessionObtained && engine?.isWebXrPhysicalOutputInterlocked()) {
        webXrPhaseRef.current = 'exiting';
        setWebXrPhase('exiting');
        showToast('VR could not confirm that the session ended. Physical output remains blocked; reload after leaving VR.');
        return;
      }
      if (!sessionObtained) engine?.setWebXrPhysicalOutputInterlock(false);
      if (generation !== webXrRequestGenerationRef.current) {
        if (webXrPhaseRef.current === 'exiting') {
          const next: WebXrPhase =
            renderSettingsRef.current.webxrAudience && !viewerModeRef.current && !window.stageforgeDesktop
              ? 'ready'
              : 'disabled';
          webXrPhaseRef.current = next;
          setWebXrPhase(next);
        }
        return;
      }
      const next: WebXrPhase = renderSettingsRef.current.webxrAudience ? 'ready' : 'disabled';
      webXrPhaseRef.current = next;
      setWebXrPhase(next);
      showToast(mod.webXrErrorMessage(error));
    });
  }, [showToast]);

  const handleWebXrEntry = useCallback(() => {
    if (liveDmxRef.current.armed || liveDmxRef.current.isLive) {
      showToast('VR is blocked while physical output is armed or live.');
      return;
    }
    const loaded = webXrModuleRef.current;
    if (loaded) {
      if (webXrWarningAcknowledgedRef.current) beginWebXrRequest(loaded);
      else {
        webXrPhaseRef.current = 'warning';
        setWebXrPhase('warning');
      }
      return;
    }
    void import('./xr/webXrAudience').then((mod) => {
      webXrModuleRef.current = mod;
      if (webXrPhaseRef.current !== 'ready') return;
      webXrPhaseRef.current = 'warning';
      setWebXrPhase('warning');
    }).catch(() => showToast('VR entry code could not be loaded.'));
  }, [beginWebXrRequest, showToast]);

  const cancelWebXrRequest = useCallback(() => {
    if (webXrPhaseRef.current !== 'requesting') return;
    webXrRequestGenerationRef.current++;
    // requestSession has no abort API: remain interlocked until the browser settles the promise.
    webXrPhaseRef.current = 'exiting';
    setWebXrPhase('exiting');
  }, []);

  const exitWebXr = useCallback(() => {
    if (webXrPhaseRef.current !== 'active') return;
    webXrPhaseRef.current = 'exiting';
    setWebXrPhase('exiting');
    void engineRef.current?.exitWebXrSession();
  }, []);

  // Synchronous fail-closed barrier (Codex qa-04 R1): detach StageEngine's DMX frame listener and initiate
  // emergency blackout/shutdown BEFORE any document/rig/stage/MVR/ILDA/cue/ack mutation touches StageEngine.
  const stopLiveOutputBeforeStructuralChange = useCallback(
    (reason: string) => {
      const dmx = liveDmxRef.current;
      if (dmx.isLive) {
        setLiveSafetyViolation(reason);
        clearAllBumps();
        engineRef.current?.setDmxFrameListener(undefined);
        void dmx.emergencyStopOnFault(`Output stopped: ${reason}`);
      } else if (dmx.armed) {
        dmx.disarm();
      }
    },
    [clearAllBumps],
  );
  stopLiveOutputSyncRef.current = stopLiveOutputBeforeStructuralChange;

  // Memoize heavy static rigging/power reports on rig + stage layout only so console faders never recompute them.
  const preflightLoads = useMemo(() => evaluateRigLoads(rig, studioStage, { applyD8Derate: true }), [rig, studioStage]);
  const preflightPower = useMemo(() => computePowerReport(rig, studioStage), [rig, studioStage]);
  // Only safety-relevant aim/laser fields feed pre-flight (using full output so dimming never hides a beam hazard).
  const preflightShowSnapshot = useMemo<ShowState>(
    () => ({
      ...INITIAL_SHOW_STATE,
      focusMarkId: showState.focusMarkId,
      movementMode: showState.movementMode,
      manualPan: showState.manualPan,
      manualTilt: showState.manualTilt,
      beamZoom: showState.beamZoom,
      movingGroups: showState.movingGroups,
      laser: showState.laser,
      beamIntensity: 1,
      washIntensity: 1,
      masterDimmer: 1,
      blackout: false,
    }),
    [
      showState.focusMarkId,
      showState.movementMode,
      showState.manualPan,
      showState.manualTilt,
      showState.beamZoom,
      showState.movingGroups,
      showState.laser,
    ],
  );

  // Evaluate pre-flight across EVERY fixture group and laser projector regardless of Measure overlay visibility.
  const preflightReport = useMemo(
    () =>
      evaluatePreflight({
        rig,
        stage: studioStage,
        cues,
        showState: preflightShowSnapshot,
        ildaClip,
        dmxSettings: liveDmx.settings,
        loads: preflightLoads,
        power: preflightPower,
        acks: preflightAcks,
      }),
    [rig, studioStage, cues, preflightShowSnapshot, ildaClip, liveDmx.settings, preflightLoads, preflightPower, preflightAcks],
  );
  preflightRef.current = preflightReport;

  // Session-sticky physical DMX 0 laser inhibit list (plus live fail-safe auto-inhibit for any laser
  // that becomes unassessed, breaching, audience-scanning, or unacknowledged while live DMX output is active).
  const effectiveInhibitedLasers = useMemo(() => {
    const keys = new Set<string>(preflightReport.inhibitedLaserKeys);
    if (liveDmx.isLive) {
      for (const row of preflightReport.rows) {
        if (!row.isLaser || !row.projectorKey) continue;
        const currentlyAcked =
          preflightReport.checked &&
          !preflightReport.stale &&
          !row.requiresLaserInhibit &&
          !row.hardBlock &&
          preflightAcks.acknowledgedLasers[row.projectorKey] === row.rowFingerprint;
        if (row.requiresLaserInhibit || row.hardBlock || !currentlyAcked) {
          keys.add(row.projectorKey);
        }
      }
    }
    return Array.from(keys);
  }, [preflightReport, preflightAcks.acknowledgedLasers, liveDmx.isLive]);
  const effectiveInhibitedLasersRef = useRef<readonly string[]>(effectiveInhibitedLasers);
  effectiveInhibitedLasersRef.current = effectiveInhibitedLasers;

  // Enforce session-inhibited laser physical DMX zeroing in StageEngine (no cue/bump bypass).
  useEffect(() => {
    engineRef.current?.setInhibitedLasers(effectiveInhibitedLasers);
  }, [effectiveInhibitedLasers]);

  // Sync lazy 3D Measure & Safety Zones overlay with StageEngine (zero GPU cost when all off).
  useEffect(() => {
    engineRef.current?.setMeasureOverlay(measureOptions);
    if (!isMeasureOverlayActive(measureOptions)) {
      live.measure.set(null);
    }
  }, [measureOptions, live.measure]);

  // Continuous live monitoring while physical DMX output is active (re-evaluates even when overlay is off).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const overlayOn = isMeasureOverlayActive(measureOptions);
    engine.setLiveSafetyMonitor(liveDmx.isLive);
    if (!overlayOn && !liveDmx.isLive) {
      engine.setMeasureListener(undefined);
      return;
    }
    engine.setMeasureListener((snap) => {
      if (isMeasureOverlayActive(measureOptionsRef.current)) {
        live.measure.set(snap);
      }
      if (liveDmxRef.current.isLive) {
        const rep = preflightRef.current;
        if (rep && !rep.canArm) {
          const reason =
            rep.blockingReasons[0] ?? 'Pre-flight safety check is no longer eligible while live output is active.';
          setLiveSafetyViolation(reason);
          clearAllBumps();
          void liveDmxRef.current.emergencyStopOnFault(`Output stopped: ${reason}`);
        } else if (snap.audienceBreachCount > 0) {
          setLiveSafetyViolation(
            `${snap.audienceBreachCount} beam(s) entered the audience keep-out volume (< 3.0 m) while output is live.`,
          );
        }
      }
    });
    return () => {
      engine.setMeasureListener(undefined);
    };
  }, [clearAllBumps, live.measure, liveDmx.isLive, measureOptions]);

  // Fail-closed live TOCTOU enforcement (SF-M1 & qa-04 R2): if `!preflightReport.canArm` becomes true for ANY reason
  // while output is live (stale revision, hard block, revoked warning ack, un-inhibited laser, audienceScan),
  // immediately blackout, stop, and disarm.
  useEffect(() => {
    if (!liveDmx.isLive) {
      setLiveSafetyViolation(null);
      return;
    }
    if (!preflightReport.canArm) {
      const reason =
        preflightReport.blockingReasons[0] ??
        'Pre-flight safety check is no longer eligible while live output is active.';
      setLiveSafetyViolation(reason);
      clearAllBumps();
      void liveDmxRef.current.emergencyStopOnFault(`Output stopped: ${reason}`);
    }
  }, [clearAllBumps, liveDmx.isLive, preflightReport]);

  const laserZonesForHud = useMemo(() => {
    if (!measureOptions.showLaserNohd) return [];
    return evaluateLaserZones(rig, { ...showState.laser, enabled: true, intensity: 1 }, {
      stage: studioStage,
      ildaClip,
    }).zones;
  }, [measureOptions.showLaserNohd, rig, showState.laser, studioStage, ildaClip]);

  const toggleMeasureOverlay = useCallback(() => {
    setMeasureOptions((prev) => {
      const nextEnabled = !prev.enabled;
      if (!nextEnabled) {
        return { ...DEFAULT_MEASURE_OVERLAY_OPTIONS };
      }
      return { ...prev, enabled: true };
    });
  }, []);

  const handleRunPreflightCheck = useCallback(() => {
    const rev = preflightRef.current?.configRevision ?? null;
    setPreflightAcks((prev) => {
      // Preserve still-valid per-row fingerprints while locking checkedRevision to current config.
      return {
        ...prev,
        checked: true,
        checkedRevision: rev,
      };
    });
    if (preflightRef.current && preflightRef.current.overallStatus !== 'blocked') {
      setLiveSafetyViolation(null);
    }
  }, []);

  const handleToggleRowAck = useCallback((row: PreflightRow, checked: boolean) => {
    if (!checked) {
      stopLiveOutputBeforeStructuralChange('Pre-flight warning acknowledgement was revoked while live output was active.');
    }
    setPreflightAcks((prev) => {
      const nextRows = { ...prev.acknowledgedRows };
      if (checked) nextRows[row.id] = row.rowFingerprint;
      else delete nextRows[row.id];
      return { ...prev, acknowledgedRows: nextRows };
    });
  }, [stopLiveOutputBeforeStructuralChange]);

  const handleToggleLaserAck = useCallback((projectorKey: string, checked: boolean) => {
    const row = preflightRef.current?.rows.find((r) => r.isLaser && r.projectorKey === projectorKey);
    if (!row) return;
    if (!checked) {
      stopLiveOutputBeforeStructuralChange('Laser pre-flight acknowledgement was revoked while live output was active.');
    }
    setPreflightAcks((prev) => {
      const nextLasers = { ...prev.acknowledgedLasers };
      if (checked) nextLasers[projectorKey] = row.rowFingerprint;
      else delete nextLasers[projectorKey];
      return { ...prev, acknowledgedLasers: nextLasers };
    });
  }, [stopLiveOutputBeforeStructuralChange]);

  const handleToggleLaserInhibit = useCallback((projectorKey: string, inhibited: boolean) => {
    const rev = preflightRef.current?.configRevision;
    if (!rev) return;
    if (!inhibited) {
      stopLiveOutputBeforeStructuralChange('Laser physical DMX inhibit was removed while live output was active.');
    }
    setPreflightAcks((prev) => {
      const nextInhibited = { ...prev.inhibitedLasers };
      const nextAcked = { ...prev.acknowledgedLasers };
      if (inhibited) {
        nextInhibited[projectorKey] = rev;
        delete nextAcked[projectorKey];
      } else {
        delete nextInhibited[projectorKey];
      }
      return { ...prev, inhibitedLasers: nextInhibited, acknowledgedLasers: nextAcked };
    });
  }, [stopLiveOutputBeforeStructuralChange]);

  useEffect(() => {
    engineRef.current?.setIldaSettings(ildaMode, ildaFps);
  }, [ildaMode, ildaFps]);

  const applyLoadedIlda = useCallback((clip: IldaClip) => {
    if (!capabilitiesRef.current.edit) return;
    stopLiveOutputBeforeStructuralChange('ILDA laser clip changed while live output was active — re-run pre-flight.');
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
    if (!capabilitiesRef.current.edit) return;
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
    if (!capabilitiesRef.current.edit) return;
    const epoch = sessionEpochRef.current;
    try {
      if (file.size > ILDA_MAX_BYTES) {
        throw new Error(`ILDA file is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB; limit is ${ILDA_MAX_BYTES / (1024 * 1024)} MB).`);
      }
      const buffer = await file.arrayBuffer();
      if (epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) return;
      const tier = engineRef.current?.getRenderTier() ?? 'high';
      const clip = parseIlda(buffer, { name: file.name, tier });
      applyLoadedIlda(clip);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not parse ILDA file.');
    }
  }, [applyLoadedIlda, showToast]);

  const handleClearIlda = useCallback(() => {
    if (!capabilitiesRef.current.edit) return;
    stopLiveOutputBeforeStructuralChange('ILDA laser clip changed while live output was active — re-run pre-flight.');
    setIldaClip(null);
    engineRef.current?.setIldaClip(null);
    showToast('Unloaded ILDA clip (back to procedural laser patterns).');
  }, [showToast, stopLiveOutputBeforeStructuralChange]);

  // Revoke after a grace period so a renderer still holding the old URL can swap first.
  const releaseUrl = (url: string, urlSet = mediaUrls.current) => {
    urlSet.delete(url);
    window.setTimeout(() => { if (!urlSet.has(url)) URL.revokeObjectURL(url); }, 5000);
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
    if (deskSnapshotRef.current) {
      deskSnapshotRef.current.mediaUrls.forEach(url => URL.revokeObjectURL(url));
      deskSnapshotRef.current.mediaUrls.clear();
      deskSnapshotRef.current.assets.clear();
      deskSnapshotRef.current = null;
    }
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
    const epoch = sessionEpochRef.current;
    cancelDemoTrackLoad();
    const available = availableDemoTrackRef.current;
    const cachedFile = assets.current.get('file:' + ref.name)?.file;
    // Only treat a cached file as the mapped demo track if it was actually fetched as the demo track
    // (never hijack a user-uploaded file that happens to share the filename).
    const cachedIsDemoTrack = !!cachedFile && demoTrackFilesRef.current.has(cachedFile);
    const shouldFetchDemoTrack = !cachedFile && ref.kind === 'file' && !!available && ref.name === available.map.file;
    const isMappedDemoFile = cachedIsDemoTrack || shouldFetchDemoTrack;
    const replayAbort = shouldFetchDemoTrack ? new AbortController() : null;
    if (replayAbort) replayDemoAbortRef.current = replayAbort;
    const run = async () => {
      let file = cachedFile;
      if (shouldFetchDemoTrack && available) {
        file = await fetchDemoTrackAudio(available, replayAbort?.signal);
        if (replayAbort?.signal.aborted || epoch !== sessionEpochRef.current) return;
        demoTrackFilesRef.current.add(file);
        registerAsset('file', file);
      }
      await audioEngineRef.current?.restoreTimelineMusic(
        ref,
        file,
        replayLook.current.bpm,
        lateMs,
        isMappedDemoFile && available ? available.map : undefined,
      );
      if (epoch !== sessionEpochRef.current) audioEngineRef.current?.stopAll();
    };
    void run().catch(e => {
      if (!replayAbort?.signal.aborted && epoch === sessionEpochRef.current && e?.name !== 'AbortError') {
        showToast(e instanceof Error ? e.message : 'Audio could not play.');
      }
    }).finally(() => {
      if (replayAbort && replayDemoAbortRef.current === replayAbort) {
        replayDemoAbortRef.current = null;
      }
    });
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
      const fullLook = !!(event.look && isFullLookSnapshot(event.look));
      if (event.look || event.screen) {
        const merged = event.look ? applyTimelineLookPatch(replayLook.current, event.look) : replayLook.current;
        const next = wallLook(merged, replayScreen.current);
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
      if (event.bump) {
        bumpLedgerRef.current.clearAll();
        for (const k of Object.keys(event.bump) as (keyof BumpState)[]) {
          if (event.bump[k]) bumpLedgerRef.current.setHold('replay', 'local', k, true);
        }
        syncLiveBump();
        engine?.setBumpState(event.bump);
      }
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
      clearAllBumps();
    },
    () => nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0,
  );

  const flushDesign = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    if (!capabilitiesRef.current.autosave) {
      pendingDesign.current = null;
      return;
    }
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

  const followInitiatedByAiRef = useRef(false);

  // Trigger a show cue cleanly preserving user's custom media/text/master
  const triggerCue = useCallback((cue: ShowCue, automatic = false, source: 'manual' | 'autoLD' | 'follow' | 'ai' | 'osc' | 'msc' = automatic ? 'autoLD' : 'manual') => {
    const mode = clockModeRef.current;
    if (automatic && !allows(mode, source, source === 'follow' ? 'cue_follow' : 'auto_ld')) {
      if (source !== 'follow') followInitiatedByAiRef.current = false;
      return;
    }
    if (!automatic && !allows(mode, source, 'go')) {
      if (source !== 'follow') followInitiatedByAiRef.current = false;
      return;
    }
    if (!automatic) {
      previewRig();
      engineRef.current?.releaseDirector(false);
      autoDirRef.current = false;
    }
    const index = cuesRef.current.findIndex(c => c.id === cue.id);
    const allowFollow = !automatic && allows(mode, 'follow', 'cue_follow');
    const armingFollow = Boolean(allowFollow && cue.followSeconds && index >= 0 && index + 1 < cuesRef.current.length);
    if (source === 'ai') {
      followInitiatedByAiRef.current = armingFollow;
    } else if (source !== 'follow') {
      followInitiatedByAiRef.current = false;
    }
    setFollow(armingFollow
      ? performance.now() + cue.followSeconds! * 1000 : null);
    if (cue.screen) setScreen({ ...cue.screen });
    if (cue.state.bpm !== undefined) audioEngineRef.current?.setBpm(cue.state.bpm);
    activeCueIdRef.current = cue.id;
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
    if (follow === null) {
      followInitiatedByAiRef.current = false;
      return;
    }
    if (typeof follow !== 'number' || !followingCue || replaying.current || !allows(clockModeRef.current, 'follow', 'cue_follow')) return;
    const id = window.setTimeout(() => {
      if (!replaying.current && allows(clockModeRef.current, 'follow', 'cue_follow')) {
        // Re-check audienceScan if this follow chain was initiated by an AI run command (H1).
        if (followInitiatedByAiRef.current && cueEnablesAudienceScan(followingCue)) {
          followInitiatedByAiRef.current = false;
          setFollow(null);
          showToast(AUDIENCE_SCAN_ERROR);
          return;
        }
        triggerCue(followingCue, false, followInitiatedByAiRef.current ? 'ai' : 'manual');
      }
    }, Math.max(0, follow - performance.now()));
    return () => window.clearTimeout(id);
  }, [follow, followingCue, showToast, triggerCue]);

  const applyDeskBpm = useCallback((nextBpm: number) => {
    if (!capabilitiesRef.current.edit) return;
    if (audioEngineRef.current?.isDemoTrackActive()) return;
    const clamped = Math.round(Math.max(70, Math.min(180, nextBpm)) * 10) / 10;
    setCueModified(true);
    setShowState((s) => ({ ...s, bpm: clamped }));
    audioEngineRef.current?.setBpm(clamped);
    const currentGrid = audioEngineRef.current?.getBeatGrid();
    if (currentGrid) {
      const updated = retimeBeatGrid(currentGrid, clamped);
      audioEngineRef.current?.setBeatGrid(updated);
      setBeatGridStatus({ state: 'ready', grid: updated });
    }
  }, []);

  const handleTapTempo = useCallback(() => {
    if (!capabilitiesRef.current.edit) return;
    if (audioEngineRef.current?.isDemoTrackActive()) {
      showToast('Tempo is locked to the demo track map.');
      return;
    }
    const { bpm: tapped } = tapTrackerRef.current.tap(performance.now());
    if (tapped !== null) {
      applyDeskBpm(tapped);
      showToast(`Tap tempo: ${tapped} BPM`);
    }
  }, [applyDeskBpm, showToast]);

  const handleHalfTime = useCallback(() => {
    if (!capabilitiesRef.current.edit) return;
    if (audioEngineRef.current?.isDemoTrackActive()) return;
    const next = halfTimeBpm(bpmRef.current);
    if (next !== null) applyDeskBpm(next);
  }, [applyDeskBpm]);

  const handleDoubleTime = useCallback(() => {
    if (!capabilitiesRef.current.edit) return;
    if (audioEngineRef.current?.isDemoTrackActive()) return;
    const next = doubleTimeBpm(bpmRef.current);
    if (next !== null) applyDeskBpm(next);
  }, [applyDeskBpm]);

  const handleNudgeGrid = useCallback((deltaMs: number) => {
    if (!capabilitiesRef.current.edit) return;
    if (audioEngineRef.current?.isDemoTrackActive()) return;
    const current = audioEngineRef.current?.getBeatGrid();
    if (!current) return;
    const nudged = nudgeBeatGrid(current, deltaMs);
    audioEngineRef.current?.setBeatGrid(nudged);
    setBeatGridStatus({ state: 'ready', grid: nudged });
  }, []);

  const handleSetDownbeat = useCallback(() => {
    if (!capabilitiesRef.current.edit) return;
    if (audioEngineRef.current?.isDemoTrackActive()) return;
    const current = audioEngineRef.current?.getBeatGrid();
    if (!current || !audioEngineRef.current) return;
    const anchored = setBeatGridDownbeat(current, audioEngineRef.current.getPlaybackMs());
    audioEngineRef.current.setBeatGrid(anchored);
    setBeatGridStatus({ state: 'ready', grid: anchored });
    showToast(`Downbeat set (${anchored.offsetMs.toFixed(0)} ms)`);
  }, [showToast]);

  const handleToggleFollowLiveBpm = useCallback(() => {
    if (!capabilitiesRef.current.edit) return;
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
        if (!capabilitiesRef.current.edit) return;
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

  const pendingOscAmountsRef = useRef<Map<string, number>>(new Map());
  const oscAmountRafRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (oscAmountRafRef.current !== null) cancelAnimationFrame(oscAmountRafRef.current);
  }, []);

  const chaseHeldMediaRef = useRef<{ audio: boolean; screen: boolean }>({ audio: false, screen: false });
  const chaseTransportHandlers = createChaseTransportHandlers({
    held: chaseHeldMediaRef.current,
    getEndMs: () => Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0),
    setReplaying: (running) => { replaying.current = running; },
    clearFollow: () => setFollow(null),
    prepareSeek: () => {
      replayLook.current = showState;
      engineRef.current?.releaseDirector(false);
      previewRig();
    },
    chaseSeekTimeline: (takeMs, running) => timeline.chaseSeek(takeMs, running),
    chaseAdvanceTimeline: (takeMs) => timeline.chaseAdvance(takeMs),
    resolveTimelineFrame: (takeMs) => timeline.resolveFrameAt(takeMs, true),
    restoreTimelineMusic: (music) => {
      expectedMusic.current = music as MusicRef;
      replayMusicClock.current = performance.now();
      restoreReplayMusic(music as MusicRef, 0);
    },
    restoreTimelineScreen: (screen) => {
      replayScreen.current = screen as ScreenRef;
      replayScreenClock.current = performance.now();
      engineRef.current?.restoreScreenTransport(true, screen.offsetSeconds ?? 0);
    },
    isAudioPlaying: () => Boolean(audioEngineRef.current?.getStatus().playing),
    pauseAudio: () => { audioEngineRef.current?.pausePlayback(); },
    resumeAudio: () => { audioEngineRef.current?.togglePlayPause(); },
    stopAudio: () => { audioEngineRef.current?.stopAll(); },
    isScreenVideoPlaying: () => {
      const s = readScreen();
      return s.kind === 'video' && s.playing;
    },
    setScreenPlaying: (playing) => { engineRef.current?.restoreScreenTransport(playing); },
    setWallClock: (posMs, running, endMs) => wallClock.set(posMs, running, endMs),
    getWallClockPos: () => wallClock.position(),
    clearReplayBumps: () => {
      bumpLedgerRef.current.clearSource('replay');
      syncLiveBump();
    },
  });

  const stopDeskPlayback = () => {
    setFollow(null);
    followInitiatedByAiRef.current = false;
    // Disarm Auto-LD unconditionally even when no recorded take is running so stopping demo
    // playback never enters the automatic cue-cycling branch (Codex review-04 R4).
    directorArmed.current = false;
    if (autoDirRef.current) {
      engineRef.current?.releaseDirector(true);
      autoDirRef.current = false;
      setShowState(s => (s.autoDirector ? { ...s, autoDirector: false } : s));
    }
    // Call timeline.stop() unconditionally (not gated on React `mode` state which can lag a render; QA M4).
    timelineRef.current.stop();
    replaying.current = false;
    wallClock.set(timelineRef.current.playhead(), false);
    audioEngineRef.current?.stopAll();
    engineRef.current?.restoreScreenTransport(false);
  };

  const showControl = useShowControl({
    getCues: () => cuesRef.current,
    getActiveCueId: () => activeCueIdRef.current,
    getTakePlayheadMs: () => timeline.playhead(),
    isTakePlaying: () => timeline.mode === 'playing',
    onModeReset: (nextMode) => {
      clockModeRef.current = nextMode;
      chaseHeldMediaRef.current = { audio: false, screen: false };
      setFollow(null);
      clearAllBumps();
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
      stopDeskPlayback();
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
    onSetBump: (key, active, sourceId) => {
      setSourceBump(sourceId ?? 'osc:default', 'remote', key, active);
    },
    onClearBumpSource: (prefix) => {
      clearSourceBumps(prefix);
    },
    onTempoTap: handleTapTempo,
    onTempoSetBpm: (raw) => {
      const folded = foldBpm(raw);
      if (folded !== null) applyDeskBpm(folded);
    },
    onTempoHalf: handleHalfTime,
    onTempoDouble: handleDoubleTime,
    onSetAudioReactive: (active) => {
      if (!capabilitiesRef.current.edit) return;
      if (showStateRef.current.audioReactive === active) return;
      previewRig();
      setCueModified(true);
      setShowState((s) => (s.audioReactive === active ? s : { ...s, audioReactive: active }));
    },
    onSetAudioMappingAmount: (mappingId, amount) => {
      if (!capabilitiesRef.current.edit) return;
      const curList = showStateRef.current.audioMap?.mappings;
      if (!curList) return;
      const existing = curList.find((m) => m.id === mappingId);
      if (!existing) return;
      const min = allowsNegativeAmount(existing.target.group, existing.target.param) ? -1 : 0;
      const clamped = Math.max(min, Math.min(1, amount));
      if (Math.abs(existing.amount - clamped) < 1e-6 && !pendingOscAmountsRef.current.has(mappingId)) return;
      pendingOscAmountsRef.current.set(mappingId, clamped);
      if (oscAmountRafRef.current !== null) return;
      oscAmountRafRef.current = requestAnimationFrame(() => {
        oscAmountRafRef.current = null;
        if (!capabilitiesRef.current.edit || pendingOscAmountsRef.current.size === 0) {
          pendingOscAmountsRef.current.clear();
          return;
        }
        const batch = new Map(pendingOscAmountsRef.current);
        pendingOscAmountsRef.current.clear();
        const latestList = showStateRef.current.audioMap?.mappings;
        if (!latestList) return;
        let changed = false;
        const nextMappings = latestList.map((m) => {
          const rawNext = batch.get(m.id);
          if (rawNext === undefined) return m;
          const mMin = allowsNegativeAmount(m.target.group, m.target.param) ? -1 : 0;
          const nextClamped = Math.max(mMin, Math.min(1, rawNext));
          if (Math.abs(m.amount - nextClamped) < 1e-6) return m;
          changed = true;
          return { ...m, amount: nextClamped };
        });
        if (!changed) return;
        previewRig();
        setCueModified(true);
        setShowState((s) => (s.audioMap ? { ...s, audioMap: { mappings: nextMappings } } : s));
      });
    },
    onChaseSeek: chaseTransportHandlers.onChaseSeek,
    onChaseAdvance: chaseTransportHandlers.onChaseAdvance,
    onChaseHold: chaseTransportHandlers.onChaseHold,
    onChaseStop: chaseTransportHandlers.onChaseStop,
    onUpdateTakeMeta: (meta) => {
      if (!capabilitiesRef.current.edit) return;
      takeMetaExplicitRef.current = true;
      timeline.setMetadata(meta);
    },
    onToast: showToast,
  }, capabilities.showControl, aiBridgeSuspendOutbound);
  const showControlRef = useRef(showControl);
  showControlRef.current = showControl;
  clockModeRef.current = showControl.clockMode;

  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;

  // Send optional OSC state feedback whenever active cue, BPM, or clock mode changes.
  useEffect(() => {
    if (!capabilities.showControl) return;
    const activeCue = cues.find((c) => c.id === activeCueId);
    showControl.sendFeedback({
      cue: activeCue ? activeCue.name : '',
      bpm: showState.bpm,
      clock: showControl.clockMode,
    });
  }, [capabilities.showControl, activeCueId, cues, showState.bpm, showControl.clockMode, showControl.sendFeedback]);

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
            idleMetrics.trackName !== metrics.trackName || idleMetrics.demo?.step !== metrics.demo?.step ||
            idleMetrics.demo?.beforeDownbeat !== metrics.demo?.beforeDownbeat ||
            idleMetrics.demo?.finished !== metrics.demo?.finished) {
            live.audio.set({ ...metrics, spectrum: new Float32Array(metrics.spectrum) });
          }
          idleMetrics = metrics.playing ? undefined : metrics;
          const openingBeforeDownbeat = !!metrics.demo?.beforeDownbeat;
          const openingBlack = !!metrics.demo && (openingBeforeDownbeat || metrics.demo.openingStep < DEMO_BLACKOUT_STEPS);
          const openingBar = openingBlack && !openingBeforeDownbeat ? metrics.demo!.bar + 1 : undefined;
          const openingTotalBars = openingBlack && !openingBeforeDownbeat ? metrics.demo!.openingBlackoutBars : undefined;
          setAudioDiscrete(prev =>
            prev.source === metrics.source && prev.playing === metrics.playing &&
            prev.openingBlack === openingBlack && prev.openingBar === openingBar &&
            prev.openingTotalBars === openingTotalBars && prev.openingBeforeDownbeat === openingBeforeDownbeat
              ? prev
              : { source: metrics.source, playing: metrics.playing, openingBlack, openingBar, openingTotalBars, openingBeforeDownbeat }
          );
          if (dmxOpenRef.current) {
            live.dmx.set({
              u1: new Uint8Array(engine.dmxUniverse1),
              u2: new Uint8Array(engine.dmxUniverse2),
              physU1: new Uint8Array(engine.physicalDmxU1),
              physU2: new Uint8Array(engine.physicalDmxU2),
            });
          }
          const modSnap = engine.getAudioModulationSnapshot();
          if (modSnap.active || live.audioMod.get().active) {
            live.audioMod.set(modSnap);
          }
          if (replaying.current || !directorArmed.current || !allows(clockModeRef.current, 'autoLD', 'auto_ld')) return;
          if (metrics.demo) {
            const position = metrics.demo;
            const tick = position.beforeDownbeat ? -2 : Math.floor(position.step / 2);
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
        showToast,
        {
          renderSettings: renderSettingsRef.current,
          fullRateStrobePreview: effectiveFullRateStrobeRef.current,
          prefersReducedMotion,
          onContextLossChange: (lost) => {
            setWebglContextLost(lost);
            if (lost) {
              clearAllBumps();
              void liveDmxRef.current.emergencyStopOnFault('Output stopped: graphics context lost');
            } else {
              showToast('Graphics context restored');
            }
          },
        },
      );
    } catch (error) {
      audio.dispose();
      audioEngineRef.current = null;
      throw error;
    }
    engineRef.current = engine;
    // Apply initial safety & overlay bindings immediately after engine construction (effects above run before mount).
    engine.setInhibitedLasers(effectiveInhibitedLasersRef.current);
    engine.setMeasureOverlay(measureOptionsRef.current);
    engine.setLiveSafetyMonitor(liveDmxRef.current.isLive);
    // Read-only probe for browser tests: `?probe` exposes each head's beam axis & render metrics.
    const probe = new URLSearchParams(window.location.search).has('probe');
    if (probe) (window as unknown as { stageforgeProbe?: unknown }).stageforgeProbe = {
      beamAxes: () => engine.beamAxes(),
      measureSnapshot: () => engine.getMeasureSnapshot(false),
      preflightReport: () => preflightRef.current,
      audioModulation: () => engine.getAudioModulationSnapshot(),
      fixtureParams: (group?: AudioTargetGroup) => engine.getFixtureParams(group),
      dmxSnapshot: () => ({ u1: Array.from(engine.dmxUniverse1), u2: Array.from(engine.dmxUniverse2) }),
      physicalDmxSnapshot: () => ({ u1: Array.from(engine.physicalDmxU1), u2: Array.from(engine.physicalDmxU2) }),
      audioPlaybackTime: () => (audioEngineRef.current?.getPlaybackMs() ?? 0) / 1000,
      demoPosition: () => live.audio.get().demo ?? null,
      demoTrackAvailable: () => availableDemoTrackRef.current?.map ?? null,
      seekTrack: (seconds: number) => handleSeekTrackRef.current(seconds),
      jumpDemoSection: (delta: -1 | 1) => handleJumpDemoSectionRef.current(delta),
      screens: () => engine.screenDiagnostics(),
      setSecondaryScreenStates: (states: Readonly<Record<string, SecondaryScreenState>>) =>
        engine.syncSecondaryScreens(states),
      primaryScreen: () => engine.screenTransport(),
      setPrimaryScreenTransport: (playing: boolean, offsetSeconds?: number) =>
        engine.restoreScreenTransport(playing, offsetSeconds),
      hangs: () => engine.hangDiagnostics(),
      renderStats: () => engine.renderStats(),
      graphicsProbe: () => engine.graphicsProbe(),
      measureFrames: (options?: { warmupFrames?: number; sampleFrames?: number; gpu?: boolean }) =>
        engine.measureFrames(options),
      setRenderSettings: (patch: Partial<RenderSettings>) => updateRenderSettings(patch, false),
      setPrefersReducedMotion: (enabled: boolean) => engine.setPrefersReducedMotion(Boolean(enabled)),
      setFullRateStrobePreview: (enabled: boolean) => {
        const nextOptIn = Boolean(enabled);
        setFullRateStrobeOptIn(nextOptIn);
        const eff = resolveEffectiveFullRateStrobe({
          userOptIn: nextOptIn,
          prefersReducedMotion: typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
            : false,
          xrPresenting: webXrBlocksPhysicalOutput(webXrPhaseRef.current),
          viewerMode: viewerModeRef.current,
        });
        effectiveFullRateStrobeRef.current = eff;
        engine.setFullRateStrobePreview(eff);
      },
      resetParticles: (seed?: number) => engine.resetParticles(seed),
      stepAndReadLuminance: (dtMs: number) => engine.stepAndReadLuminance(dtMs),
      patchShowState: (patch: Partial<ShowState>) => {
        const prev = showStateRef.current;
        const next: ShowState = {
          ...prev,
          ...patch,
          laser: patch.laser ? { ...prev.laser, ...patch.laser } : prev.laser,
          led: patch.led ? { ...prev.led, ...patch.led } : prev.led,
          atmo: patch.atmo ? { ...prev.atmo, ...patch.atmo } : prev.atmo,
          motors: patch.motors ? { ...prev.motors, ...patch.motors } : prev.motors,
        };
        showStateRef.current = next;
        engine.setShowState(next);
        setShowState(next);
      },
      setProbeBump: (patch: Partial<BumpState>) => {
        engine.setBumpState({
          blinder: Boolean(patch.blinder),
          strobe: Boolean(patch.strobe),
          co2: Boolean(patch.co2),
          smoke: Boolean(patch.smoke),
          laser: Boolean(patch.laser),
          motorDrop: Boolean(patch.motorDrop),
        });
      },
      loadIldaClip: (clip: IldaClip | null) => engine.setIldaClip(clip),
      rig: () => structuredClone(rigRef.current),
      capabilities: () => ({ ...capabilitiesRef.current }),
      viewerMode: () => viewerModeRef.current,
      activeCueId: () => activeCueIdRef.current,
      camera: () => activeCameraRef.current,
      showStateSummary: () => ({
        blackout: showStateRef.current.blackout,
        masterDimmer: showStateRef.current.masterDimmer,
        bpm: showStateRef.current.bpm,
        primaryColor: showStateRef.current.primaryColor,
        accentColor: showStateRef.current.accentColor,
        beamIntensity: showStateRef.current.beamIntensity,
        washIntensity: showStateRef.current.washIntensity,
        movementMode: showStateRef.current.movementMode,
      }),
      takeState: () => {
        const tl = timelineRef.current;
        const durationMs = Math.max(tl.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
        return { mode: tl.mode, timeMs: tl.playhead(), durationMs };
      },
      dmxLive: () => liveDmxRef.current.isLive,
      showControlActive: () => {
        const sc = showControlRef.current;
        return (
          sc.clockMode !== 'master' ||
          sc.runtime.oscRxEnabled ||
          sc.runtime.oscTxActive ||
          sc.runtime.oscWsState === 'connected' ||
          sc.runtime.midiMtcRxEnabled ||
          sc.runtime.midiMscRxEnabled ||
          sc.runtime.midiMtcTxEnabled ||
          sc.runtime.artnetTcRxEnabled ||
          sc.runtime.artnetTcTxEnabled
        );
      },
      setBatching: (enabled: boolean, options?: { proxies?: boolean }) => engine.setBatching(enabled, options),
      setCameraPose: (pos: [number, number, number], target: [number, number, number]) =>
        engine.setProbeCameraPose(pos, target),
      redrawAndCapture: (options?: { hideBeams?: boolean; hidePools?: boolean }) => engine.redrawAndCapture(options),
      rebuildRig: () => engine.forceRebuildCurrentRig(),
      controlLoopHealth: () => engine.getControlLoopHealth(),
      webXr: () => ({ phase: webXrPhaseRef.current, ...engine.webXrDiagnostics() }),
      attemptWebXrDmxListener: () => {
        engine.setDmxFrameListener(() => {});
        return engine.webXrDiagnostics();
      },
      simulateContextLoss: (lost: boolean) => engine.simulateContextLossForTest(Boolean(lost)),
    };

    return () => {
      demoTrackAbortRef.current?.abort();
      replayDemoAbortRef.current?.abort();
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
  const hotkeyHandlerRef = useRef<{
    toggleViewerPlay: () => void;
    go: () => void;
    back: () => void;
    camera: (cam: CameraPreset) => void;
  }>({
    toggleViewerPlay: () => {},
    go: () => {},
    back: () => {},
    camera: () => {},
  });

  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.isContentEditable || !!target.closest(
        'textarea,input:not([type=range]):not([type=color]):not([type=checkbox]):not([type=button])'
      ));

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('dialog[open],[aria-modal=true]')) return;
      if (e.target instanceof Element && e.target.closest('select,[role=listbox],[role=combobox]')) return;
      if (e.code === 'Space' && e.target instanceof Element && e.target.closest('button,summary,input[type=color],input[type=checkbox],a')) return;
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'PageUp' || e.code === 'PageDown') &&
        e.target instanceof Element && e.target.closest('input[type=range],[role=slider],[aria-label="Take markers"]')) return;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;

      const action = resolveGlobalHotkey(e.code, capabilitiesRef.current);
      if (!action) return;

      switch (action.type) {
        case 'blackout':
          e.preventDefault();
          previewRig();
          setCueModified(true);
          setShowState((s) => ({ ...s, blackout: !s.blackout }));
          break;
        case 'bump':
          setSourceBump('keyboard', 'local', action.key, true);
          break;
        case 'tapTempo':
          handleTapTempo();
          break;
        case 'measure':
          toggleMeasureOverlay();
          break;
        case 'cinema':
          setCinemaMode((v) => !v);
          break;
        case 'camera':
          hotkeyHandlerRef.current.camera(action.preset);
          break;
        case 'playPause':
          e.preventDefault();
          hotkeyHandlerRef.current.toggleViewerPlay();
          break;
        case 'go':
          e.preventDefault();
          hotkeyHandlerRef.current.go();
          break;
        case 'back':
          e.preventDefault();
          hotkeyHandlerRef.current.back();
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const action = resolveGlobalHotkey(e.code, capabilitiesRef.current);
      if (action?.type === 'bump') {
        setSourceBump('keyboard', 'local', action.key, false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const releaseBumps = () => clearAllBumps();
    window.addEventListener('blur', releaseBumps);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseBumps);
    };
  }, [clearAllBumps, handleTapTempo, previewRig, setSourceBump, toggleMeasureOverlay]);

  const handleCamera = (cam: CameraPreset) => {
    previewRig();
    setActiveCamera(cam);
    engineRef.current?.setCameraPreset(cam);
  };

  const startDemo = () => {
    if (!capabilitiesRef.current.edit) return;
    const ae = audioEngineRef.current;
    if (!ae) return;
    cancelDemoTrackLoad();
    beatGridAbortRef.current?.abort();
    beatGridAbortRef.current = null;
    setBeatGridStatus({ state: 'idle' });
    directorArmed.current = true; expectedMusic.current = NO_MUSIC; setFollow(null);
    ae.startDemoSynth(showState.bpm);
    const demo = getDemoPosition(0);
    const opening = applyDemoLighting({ ...showState, autoDirector: true }, demo);
    engineRef.current?.beginDemo(opening, demo.openingStep);
    autoDirRef.current = true;
    clearAllBumps();
    lastDemoTick.current = -1;
    setActiveCueId(null);
    setShowState(opening);
    live.audio.set({ ...EMPTY_AUDIO, playing: true, source: 'synth', trackName: ae.getStatus().trackName, demo });
    setAudioDiscrete({
      source: 'synth',
      playing: true,
      openingBlack: demo.openingStep < DEMO_BLACKOUT_STEPS,
      openingBar: demo.bar + 1,
      openingTotalBars: demo.openingBlackoutBars,
      openingBeforeDownbeat: false,
    });
    setToast(null);
  };

  const startDemoTrack = async () => {
    if (!capabilitiesRef.current.edit) return;
    const ae = audioEngineRef.current;
    const available = availableDemoTrackRef.current;
    if (!ae || !available) return;
    const epoch = sessionEpochRef.current;
    // Unlock audio element synchronously inside the user gesture via a CSP-safe silent blob: WAV.
    const prepared = ae.preparePlaybackGesture();
    cancelDemoTrackLoad();
    const abort = new AbortController();
    demoTrackAbortRef.current = abort;
    setDemoTrackLoading(true);
    setDemoTrackProgress(null);
    try {
      const cachedCandidate = assets.current.get('file:' + available.map.file)?.file;
      const cached = cachedCandidate && demoTrackFilesRef.current.has(cachedCandidate) ? cachedCandidate : undefined;
      const file = cached ?? await fetchDemoTrackAudio(available, abort.signal, (loaded, total) => {
        if (demoTrackAbortRef.current === abort) {
          setDemoTrackProgress(total ? Math.min(1, loaded / total) : null);
        }
      });
      if (abort.signal.aborted || demoTrackAbortRef.current !== abort || epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) {
        prepared.cleanup();
        return;
      }
      demoTrackFilesRef.current.add(file);
      registerAsset('file', file);
      const loadResult = await ae.loadDemoTrack(file, available.map, prepared);
      if (abort.signal.aborted || demoTrackAbortRef.current !== abort || epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) {
        ae.stopAll();
        return;
      }
      // Abort any prior upload's beat-grid analysis only once the demo track has taken over.
      beatGridAbortRef.current?.abort();
      beatGridAbortRef.current = null;
      const map = available.map;
      const grid = { bpm: map.bpm, offsetMs: map.firstDownbeatMs, source: 'manual' as const };
      setBeatGridStatus({ state: 'ready', grid });
      directorArmed.current = true;
      expectedMusic.current = { kind: 'file', name: file.name, playing: loadResult.playing, offsetSeconds: 0 };
      setFollow(null);
      const demo = getDemoTrackPosition(map, ae.getPlaybackMs(), false);
      const opening = applyDemoLighting({ ...showStateRef.current, bpm: map.bpm, autoDirector: true }, demo);
      engineRef.current?.beginDemo(opening, demo.beforeDownbeat ? 0 : demo.openingStep);
      autoDirRef.current = true;
      clearAllBumps();
      lastDemoTick.current = demo.beforeDownbeat ? -2 : Math.floor(demo.step / 2);
      setActiveCueId(null);
      setShowState(opening);
      live.audio.set({ ...EMPTY_AUDIO, playing: loadResult.playing, source: 'file', trackName: loadResult.trackName, demoTrackTitle: map.title, demo });
      const openingBeforeDownbeat = !!demo.beforeDownbeat;
      const openingBlack = openingBeforeDownbeat || demo.openingStep < DEMO_BLACKOUT_STEPS;
      setAudioDiscrete({
        source: 'file',
        playing: loadResult.playing,
        openingBlack,
        openingBar: openingBlack && !openingBeforeDownbeat ? demo.bar + 1 : undefined,
        openingTotalBars: openingBlack && !openingBeforeDownbeat ? demo.openingBlackoutBars : undefined,
        openingBeforeDownbeat,
      });
      setToast(loadResult.autoplayBlocked ? 'Demo track ready — tap Play track to start.' : null);
    } catch (error) {
      prepared.cleanup();
      if (abort.signal.aborted || demoTrackAbortRef.current !== abort || epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit || (error instanceof DOMException && error.name === 'AbortError')) return;
      const reason = error instanceof Error ? error.message : 'Could not load demo track.';
      // Codex Sprint 10 amendment: fall back to the built-in synth demo with a toast when fetch or decode fails.
      startDemo();
      showToast(`${reason} Falling back to built-in synth demo.`);
    } finally {
      if (demoTrackAbortRef.current === abort) {
        demoTrackAbortRef.current = null;
        setDemoTrackLoading(false);
        setDemoTrackProgress(null);
      }
    }
  };

  const handleSeekTrack = useCallback((seconds: number) => {
    const ae = audioEngineRef.current;
    if (!ae) return;
    const currentMusic = readMusic();
    if (currentMusic.kind !== 'file') return;
    ae.seekTrack(seconds);
    const actualSec = ae.getPlaybackMs() / 1000;
    expectedMusic.current = { ...currentMusic, offsetSeconds: actualSec };
    const metrics = ae.getMetrics(0);
    live.audio.set({ ...metrics, spectrum: new Float32Array(metrics.spectrum) });
    if (metrics.demo) {
      const position = metrics.demo;
      const openingBeforeDownbeat = !!position.beforeDownbeat;
      const openingBlack = openingBeforeDownbeat || position.openingStep < DEMO_BLACKOUT_STEPS;
      const openingBar = openingBlack && !openingBeforeDownbeat ? position.bar + 1 : undefined;
      const openingTotalBars = openingBlack && !openingBeforeDownbeat ? position.openingBlackoutBars : undefined;
      setAudioDiscrete(prev => ({
        ...prev,
        source: metrics.source,
        playing: metrics.playing,
        openingBlack,
        openingBar,
        openingTotalBars,
        openingBeforeDownbeat,
      }));
      if (autoDirRef.current && !replaying.current && directorArmed.current && allows(clockModeRef.current, 'autoLD', 'auto_ld')) {
        lastDemoTick.current = position.beforeDownbeat ? -2 : Math.floor(position.step / 2);
        setActiveCueId(null);
        setShowState(s => (s.autoDirector ? applyDemoLighting(s, position) : s));
      }
    }
  }, [live]);

  const handleJumpDemoSection = useCallback((delta: -1 | 1) => {
    const ae = audioEngineRef.current;
    const map = ae?.getActiveDemoTrackMap();
    if (!ae || !map) return;
    const pos = getDemoTrackPosition(map, ae.getPlaybackMs(), false);
    const sections = map.timeline.sections;
    if (delta > 0 && !pos.beforeDownbeat && pos.sectionIndex >= sections.length - 1) return;
    if (delta < 0 && (pos.beforeDownbeat || (pos.sectionIndex === 0 && pos.stepInSection < 16))) return;
    const targetIdx = pos.beforeDownbeat
      ? 0
      : Math.max(0, Math.min(sections.length - 1, pos.sectionIndex + delta));
    // +30 ms clears MP3 frame-quantized seek boundaries (~26 ms per 44.1 kHz frame).
    const targetMs = demoTrackMsForStep(map, sections[targetIdx].startStep) + 30;
    handleSeekTrack(targetMs / 1000);
  }, [handleSeekTrack]);

  const handleSeekTrackRef = useRef(handleSeekTrack);
  handleSeekTrackRef.current = handleSeekTrack;
  const handleJumpDemoSectionRef = useRef(handleJumpDemoSection);
  handleJumpDemoSectionRef.current = handleJumpDemoSection;

  const handleTogglePlay = () => {
    const ae = audioEngineRef.current;
    if (!ae) return;
    const status = ae.getStatus();
    if (status.source === 'none' && expectedMusic.current.kind === 'demo') {
      if (!viewerModeRef.current) directorArmed.current = true;
      void ae.restoreTimelineMusic({ ...expectedMusic.current, playing: true }, undefined, showState.bpm, 0)
        .catch(e => showToast(e instanceof Error ? e.message : 'Could not resume the score.'));
      return;
    }
    if (status.source === 'none' && expectedMusic.current.kind === 'live') {
      showToast(viewerModeRef.current
        ? 'Live microphone input is disabled in pitch viewer mode.'
        : 'Select Mic in Audio settings to use the live input.');
      return;
    }
    if (status.source === 'none' && expectedMusic.current.kind === 'file') {
      const ref = expectedMusic.current;
      const file = assets.current.get('file:' + ref.name)?.file;
      if (!file) {
        if (viewerModeRef.current) showToast(`Missing audio file (${ref.name}) · use Relink.`);
        else setFilesOpen(true);
        return;
      }
      const mappedDemo = demoTrackFilesRef.current.has(file) ? availableDemoTrackRef.current?.map : undefined;
      void ae.restoreTimelineMusic({ ...ref, playing: true }, file, showState.bpm, 0, mappedDemo)
        .catch(e => showToast(e instanceof Error ? e.message : 'Could not play linked music.'));
      return;
    }
    if (status.source === 'none' || status.demoFinished) {
      if (viewerModeRef.current) {
        showToast('No audio track or recorded take in this show.');
        return;
      }
      startDemo();
      return;
    }
    if (status.demoTrackFinished) {
      lastDemoTick.current = -1;
    }
    const playing = ae.togglePlayPause();
    showToast(playing ? `Playing: ${ae.getStatus().trackName}` : 'Audio Paused');
  };

  const handleUploadAudio = async (file: File) => {
    if (!capabilitiesRef.current.edit) return;
    const ae = audioEngineRef.current;
    if (!ae) return;
    const epoch = sessionEpochRef.current;
    demoTrackAbortRef.current?.abort();
    demoTrackAbortRef.current = null;
    setDemoTrackLoading(false);
    setDemoTrackProgress(null);
    beatGridAbortRef.current?.abort();
    beatGridAbortRef.current = null;
    try {
      const name = await ae.loadAudioFile(file);
      if (epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) {
        ae.stopAll();
        return;
      }
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
        if (abort.signal.aborted || beatGridAbortRef.current !== abort || epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) return;
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
        if (!abort.signal.aborted && beatGridAbortRef.current === abort && epoch === sessionEpochRef.current) {
          setBeatGridStatus({ state: 'unavailable', reason: 'Beat grid analysis failed.' });
        }
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      showToast('Could not play audio file');
    }
  };

  const handleToggleMic = async () => {
    if (!capabilitiesRef.current.edit) return;
    const ae = audioEngineRef.current;
    if (!ae) return;
    cancelDemoTrackLoad();
    if (live.audio.get().source === 'mic') {
      ae.stopAll();
      expectedMusic.current = NO_MUSIC;
      showToast('Live Mic Stopped');
      return;
    }
    const epoch = sessionEpochRef.current;
    try {
      await ae.startMicInput();
      if (epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) {
        ae.stopAll();
        return;
      }
      previewRig();
      showToast('Live Mic / Room Audio Sync Active');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      showToast('Microphone permission denied');
    }
  };

  const handleSaveCue = (cueId: string) => {
    if (!capabilitiesRef.current.edit) return;
    stopLiveOutputBeforeStructuralChange('Cue list changed while live output was active — re-run pre-flight.');
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
    if (!capabilitiesRef.current.edit) return;
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
    if (!capabilitiesRef.current.edit) return;
    previewRig();
    setCueModified(true);
    if (autoDirRef.current) engineRef.current?.releaseDirector(true);
    autoDirRef.current = false;
    setShowState(s => s.autoDirector ? { ...s, autoDirector: false } : s);
  };
  const applyRig = useCallback((next: RigConfig, saveNow = false) => {
    if (!capabilitiesRef.current.edit) return;
    stopLiveOutputBeforeStructuralChange('Rig or patch changed while live output was active — re-run pre-flight.');
    // Loading a preset leaves storage alone, but the first edit to one becomes the saved design,
    // as long as that doesn't replace a design already saved in the single slot.
    if (next.schemaVersion !== 1 && !savedDesign && !isPristinePreset(next)) next = { ...next, schemaVersion: 1 };
    setRig(next);
    if (!capabilitiesRef.current.autosave || next.schemaVersion !== 1) return;
    setSavedDesign(next);
    pendingDesign.current = next;
    window.clearTimeout(saveTimer.current);
    if (saveNow) flushDesign();
    else saveTimer.current = window.setTimeout(flushDesign, 250);
  }, [savedDesign, flushDesign, stopLiveOutputBeforeStructuralChange]);

  // Always-fresh ref mirror for snapshot fields so async viewer entry never captures stale render-closure state (H1).
  const deskLiveStateRef = useRef({
    cueModified,
    screen,
    captureVideoPosition,
    volume,
    ildaClip,
    ildaMode,
    ildaFps,
    lastMvrReport,
    cinemaMode,
  });
  deskLiveStateRef.current = {
    cueModified,
    screen,
    captureVideoPosition,
    volume,
    ildaClip,
    ildaMode,
    ildaFps,
    lastMvrReport,
    cinemaMode,
  };

  const captureDeskSession = (deskTimeline: ShowTimeline | undefined): DeskSessionSnapshot => {
    const liveDesk = deskLiveStateRef.current;
    return {
      rig: structuredClone(rigRef.current),
      stage: nativeStage.current ? structuredClone(nativeStage.current) : undefined,
      interchange: interchangeRef.current ? structuredClone(interchangeRef.current) : undefined,
      mvrResources: mvrResourcesRef.current ? new Map(mvrResourcesRef.current) : undefined,
      cues: structuredClone(cuesRef.current),
      activeCueId: activeCueIdRef.current,
      cueModified: liveDesk.cueModified,
      showState: structuredClone(showStateRef.current),
      screen: { ...liveDesk.screen },
      captureVideoPosition: liveDesk.captureVideoPosition,
      activeCamera: activeCameraRef.current,
      volume: liveDesk.volume,
      timeline: deskTimeline ? structuredClone(deskTimeline) : undefined,
      expectedMusic: { ...expectedMusic.current },
      // Keep the desk's live Map & Set intact; viewer receives fresh empty containers so prune/revoke never touches desk media.
      assets: assets.current,
      mediaUrls: mediaUrls.current,
      ildaClip: liveDesk.ildaClip,
      ildaMode: liveDesk.ildaMode,
      ildaFps: liveDesk.ildaFps,
      lastMvrReport: liveDesk.lastMvrReport,
      cinemaMode: liveDesk.cinemaMode,
      takeMetaExplicit: takeMetaExplicitRef.current,
    };
  };

  const restoreDeskSession = (snap: DeskSessionSnapshot) => {
    assets.current = snap.assets;
    mediaUrls.current = snap.mediaUrls;
    setLinkedVersion(v => v + 1);
    setStageDirect(snap.stage);
    installInterchange(snap.interchange, snap.mvrResources);
    takeMetaExplicitRef.current = snap.takeMetaExplicit;
    const pausedMusic: MusicRef = { ...snap.expectedMusic, playing: false };
    const pausedScreen: ScreenRef = snap.screen.kind === 'video' ? { ...snap.screen, playing: false } : { ...snap.screen };
    expectedMusic.current = pausedMusic;
    timeline.replace(snap.timeline, {
      look: snap.showState, cueId: snap.activeCueId, camera: snap.activeCamera,
      volume: snap.volume, bump: EMPTY_BUMP, screen: pausedScreen, music: pausedMusic,
    });
    wallClock.set(0, false);
    setFollow(null);
    replaying.current = false;
    directorArmed.current = false;
    autoDirRef.current = snap.showState.autoDirector;
    replayLook.current = snap.showState;
    replayScreen.current = pausedScreen;
    replayScreenClock.current = 0;
    replayMusicClock.current = 0;
    live.audio.set(EMPTY_AUDIO);
    setAudioDiscrete(INITIAL_DISCRETE_AUDIO);
    clearAllBumps();
    setRig(snap.rig);
    setCues(snap.cues);
    setActiveCueId(snap.activeCueId);
    setCueModified(snap.cueModified);
    setShowState(snap.showState);
    setScreen(pausedScreen);
    setCaptureVideoPosition(snap.captureVideoPosition);
    setActiveCamera(snap.activeCamera);
    setVolume(snap.volume);
    setIldaClip(snap.ildaClip);
    setIldaMode(snap.ildaMode);
    setIldaFps(snap.ildaFps);
    setLastMvrReport(snap.lastMvrReport);
    setCinemaMode(snap.cinemaMode);
    audioEngineRef.current?.setBpm(snap.showState.bpm);
    audioEngineRef.current?.setVolume(snap.volume);
    engineRef.current?.setIldaClip(snap.ildaClip);
    engineRef.current?.setIldaSettings(snap.ildaMode, snap.ildaFps);
    engineRef.current?.releaseDirector(false);
    engineRef.current?.setShowState(snap.showState);
    engineRef.current?.setBumpState(EMPTY_BUMP);
    engineRef.current?.setCameraPreset(snap.activeCamera);
    if (pausedScreen.kind === 'video') {
      engineRef.current?.restoreScreenTransport(false, pausedScreen.offsetSeconds);
    }
    previewRig();
  };

  const revokeViewerMediaNow = () => {
    for (const url of mediaUrls.current) URL.revokeObjectURL(url);
    mediaUrls.current.clear();
    assets.current.clear();
  };

  const applyViewerDocument = (doc: ParsedViewerDocument) => {
    timeline.stop();
    audioEngineRef.current?.stopAll();
    demoTrackAbortRef.current?.abort();
    demoTrackAbortRef.current = null;
    setDemoTrackLoading(false);
    setDemoTrackProgress(null);
    beatGridAbortRef.current?.abort();
    beatGridAbortRef.current = null;
    setBeatGridStatus({ state: 'idle' });
    setFollow(null);
    replaying.current = false;
    directorArmed.current = false;
    autoDirRef.current = false;
    stopLiveOutputBeforeStructuralChange('Entered Pitch Viewer while live output was active.');
    clearAllBumps();
    setIldaClip(null);
    engineRef.current?.setIldaClip(null);
    live.audio.set(EMPTY_AUDIO);
    setAudioDiscrete(INITIAL_DISCRETE_AUDIO);
    revokeViewerMediaNow();

    if (doc.kind === 'rig') {
      setStageDirect(undefined);
      installInterchange(undefined, undefined);
      expectedMusic.current = NO_MUSIC;
      const look = structuredClone(INITIAL_SHOW_STATE);
      look.autoDirector = false;
      timeline.replace(undefined);
      wallClock.set(0, false);
      setRig(doc.rig);
      setCues([]);
      setActiveCueId(null);
      setCueModified(false);
      setShowState(look);
      setScreen(NO_SCREEN);
      setActiveCamera('foh');
      setVolume(0.72);
      setLinkedVersion(v => v + 1);
      audioEngineRef.current?.setBpm(look.bpm);
      audioEngineRef.current?.setVolume(0.72);
      engineRef.current?.releaseDirector(false);
      engineRef.current?.setShowState(look);
      engineRef.current?.setBumpState(EMPTY_BUMP);
      engineRef.current?.setCameraPreset('foh');
      previewRig();
      showToast(`Viewing ${doc.rig.name} (read-only).`);
      return;
    }

    const { file, nextRig, bundledMedia } = doc;
    const referenced = referencedFiles(file.media, file.cues, file.timeline, file.stage);
    const wall = file.media?.screen ?? NO_SCREEN;
    for (const { kind, file: medium } of bundledMedia) registerAsset(kind, medium);
    const look = { ...wallLook(file.look, wall), autoDirector: false };
    const camera = file.controls?.camera ?? 'foh';
    const vol = file.controls?.volume ?? 0.72;
    const music = file.media?.music ?? NO_MUSIC;
    timeline.replace(file.timeline, {
      look, cueId: file.activeCueId, camera, volume: vol, bump: EMPTY_BUMP, screen: wall, music,
    });
    setStageDirect(file.stage);
    installInterchange(undefined, undefined);
    wallClock.set(0, false);
    expectedMusic.current = music;
    replayLook.current = look;
    replayScreen.current = wall;
    replayScreenClock.current = 0;
    replayMusicClock.current = 0;
    setRig(nextRig);
    setCues(file.cues);
    setActiveCueId(file.activeCueId);
    setCueModified(false);
    setShowState(look);
    setScreen(wall);
    setCaptureVideoPosition(false);
    setVolume(vol);
    setActiveCamera(camera);
    setLinkedVersion(v => v + 1);
    audioEngineRef.current?.setBpm(look.bpm);
    audioEngineRef.current?.setVolume(vol);
    engineRef.current?.releaseDirector(false);
    engineRef.current?.setShowState(look);
    engineRef.current?.setBumpState(EMPTY_BUMP);
    previewRig();
    if (wall.kind === 'video') engineRef.current?.restoreScreenTransport(wall.playing, wall.offsetSeconds);
    engineRef.current?.setCameraPreset(camera);
    const missingCount = [...referenced].filter(key => !assets.current.has(key)).length;
    const warning = missingCount ? ` · ${missingCount} missing media ${missingCount === 1 ? 'file' : 'files'}` : '';
    showToast(`Viewing ${file.rig.name} · ${file.cues.length} cues${warning}`);
  };

  const openViewerPayload = async (source: File | string | Uint8Array) => {
    const request = ++openRequestRef.current;
    const startEpoch = sessionEpochRef.current;
    // Parse and verify purely in memory before entering viewer mode or touching the desk.
    const parsed = await parseViewerSource(source);
    if (request !== openRequestRef.current || startEpoch !== sessionEpochRef.current) return;

    if (!viewerModeRef.current) {
      // Stop any live/armed physical DMX output synchronously BEFORE locking menus or applying viewer state (qa-07 R1).
      stopLiveOutputBeforeStructuralChange('Entered Pitch Viewer while live output was active.');
      // Lock desktop main-process menus & output gates BEFORE switching renderer state (fail-closed, H2 & L3).
      // Track in-flight viewer entries + serialize IPC so overlapping opens never unlock a newer viewer open.
      pendingViewerEntriesRef.current++;
      let locked = false;
      try {
        locked = await syncDesktopViewerMode(true);
      } finally {
        pendingViewerEntriesRef.current = Math.max(0, pendingViewerEntriesRef.current - 1);
      }
      if (!locked) {
        throw new Error('Could not lock desktop menus and outputs for pitch viewer mode.');
      }
      if (request !== openRequestRef.current || startEpoch !== sessionEpochRef.current || viewerModeRef.current) {
        if (!viewerModeRef.current && pendingViewerEntriesRef.current === 0) {
          void syncDesktopViewerMode(false);
        }
        return;
      }

      // Flush any pending legitimate desk edit before viewer disables autosave.
      flushDesign();
      const deskTimeline = timelineRef.current.snapshot();
      timelineRef.current.stop();
      audioEngineRef.current?.stopAll();
      demoTrackAbortRef.current?.abort();
      demoTrackAbortRef.current = null;
      setDemoTrackLoading(false);
      setDemoTrackProgress(null);
      beatGridAbortRef.current?.abort();
      beatGridAbortRef.current = null;
      audioEngineRef.current?.setLiveBpmAnalysis(false);
      setFollowLiveBpm(false);
      followLiveBpmRef.current = false;
      setLiveBpmStatus({ state: 'off' });
      setBeatGridStatus({ state: 'idle' });
      deskSnapshotRef.current = captureDeskSession(deskTimeline);
      // Swap in fresh isolated asset containers so viewer media never touches or revokes desk URLs.
      assets.current = new Map();
      mediaUrls.current = new Set();
      // Close every editor drawer/modal and clear momentary bumps.
      setRigDrawerOpen(false);
      setDmxDrawerOpen(false);
      setShowControlOpen(false);
      setCostModalOpen(false);
      setPreflightOpen(false);
      setMeasureOptions(DEFAULT_MEASURE_OVERLAY_OPTIONS);
      setFilesOpen(false);
      setCueEditor(false);
      setDesignerRig(null);
      setPendingMvr(null);
      setViewingMvrReport(false);
      setCinemaMode(false);
      clearAllBumps();
      sessionEpochRef.current++;
      viewerModeRef.current = true;
      capabilitiesRef.current = VIEWER_CAPABILITIES;
      setViewerMode(true);
    } else {
      sessionEpochRef.current++;
    }

    applyViewerDocument(parsed);
  };

  const exitViewer = () => {
    if (!viewerModeRef.current) return;
    sessionEpochRef.current++;
    openRequestRef.current++;
    timeline.stop();
    audioEngineRef.current?.stopAll();
    beatGridAbortRef.current?.abort();
    beatGridAbortRef.current = null;
    revokeViewerMediaNow();
    void syncDesktopViewerMode(false).then((ok) => {
      if (!ok) showToast('Could not unlock desktop menus — reload the window to restore File menu items.');
    });

    // Strip `?view` from the URL bar without triggering a reload (preserving `?probe` etc.).
    const params = new URLSearchParams(window.location.search);
    if (params.has('view')) {
      params.delete('view');
      const qs = params.toString();
      const nextUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      try { window.history.replaceState(null, '', nextUrl); } catch { /* ignore */ }
    }

    viewerModeRef.current = false;
    capabilitiesRef.current = EDITOR_CAPABILITIES;
    setViewerMode(false);

    const snap = deskSnapshotRef.current;
    deskSnapshotRef.current = null;
    if (snap) {
      restoreDeskSession(snap);
      showToast('Returned to StageForge desk.');
      return;
    }

    // Booted directly via `?view`: hydrate the editor desk read-only from storage or default preset.
    assets.current = new Map();
    mediaUrls.current = new Set();
    setLinkedVersion(v => v + 1);
    const stored = readSavedDesign();
    setSavedDesign(stored);
    const nextRig = stored ?? structuredClone(RIG_TEMPLATES.arena_mainstage);
    const freshLook = structuredClone(INITIAL_SHOW_STATE);
    setStageDirect(undefined);
    installInterchange(undefined, undefined);
    expectedMusic.current = NO_MUSIC;
    timeline.replace(undefined);
    wallClock.set(0, false);
    setFollow(null);
    replaying.current = false;
    directorArmed.current = true;
    autoDirRef.current = freshLook.autoDirector;
    live.audio.set(EMPTY_AUDIO);
    setAudioDiscrete(INITIAL_DISCRETE_AUDIO);
    clearAllBumps();
    setRig(nextRig);
    setCues(structuredClone(SHOW_CUES));
    setActiveCueId(null);
    setCueModified(false);
    setShowState(freshLook);
    setScreen(NO_SCREEN);
    setActiveCamera('foh');
    setVolume(0.72);
    setCinemaMode(false);
    audioEngineRef.current?.setBpm(freshLook.bpm);
    audioEngineRef.current?.setVolume(0.72);
    engineRef.current?.setIldaClip(null);
    engineRef.current?.releaseDirector(false);
    engineRef.current?.setShowState(freshLook);
    engineRef.current?.setBumpState(EMPTY_BUMP);
    engineRef.current?.setCameraPreset('foh');
    previewRig();
    showToast('Returned to StageForge desk.');
  };

  const openDocument = (rawJson: string, bundledMedia: BundleAsset[] = []) => {
    if (!capabilitiesRef.current.edit) return;
    const json = rawJson.charCodeAt(0) === 0xfeff ? rawJson.slice(1) : rawJson;
    if (json.length > MAX_SHOW_JSON_BYTES || new TextEncoder().encode(json).length > MAX_SHOW_JSON_BYTES) {
      throw new Error('This JSON file exceeds the 32 MiB limit.');
    }
    let object: unknown;
    try { object = JSON.parse(json); } catch { throw new Error('Choose a valid StageForge JSON file.'); }
    if (!object || typeof object !== 'object' || !('format' in object)) {
      const next = normalizeDesign(parseRigJson(json));
      stopLiveOutputBeforeStructuralChange('Opened a new rig while live output was active — re-run pre-flight.');
      setPendingMvr(null);
      aiBridgeRef.current?.notifyDocumentChanged();
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

    stopLiveOutputBeforeStructuralChange('Opened a show file while live output was active — re-run pre-flight.');
    setPendingMvr(null);
    aiBridgeRef.current?.notifyDocumentChanged();
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
    demoTrackAbortRef.current?.abort();
    demoTrackAbortRef.current = null;
    setDemoTrackLoading(false);
    setDemoTrackProgress(null);
    beatGridAbortRef.current?.abort();
    setBeatGridStatus({ state: 'idle' });
    wallClock.set(0, false);
    setFollow(null); directorArmed.current = false;
    audioEngineRef.current?.stopAll();
    live.audio.set(EMPTY_AUDIO);
    setAudioDiscrete(INITIAL_DISCRETE_AUDIO);
    clearAllBumps();
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
    if (!capabilitiesRef.current.edit) return;
    const epoch = sessionEpochRef.current;
    const { MAX_BUNDLE_BYTES, openShowBundle } = await import('./data/showBundle');
    if (bytes.byteLength > MAX_BUNDLE_BYTES) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
    // Fully verified (hashes, paths, schema) before any desk state changes.
    const bundle = await openShowBundle(bytes);
    if (epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) return;
    if (request !== undefined && request !== openRequestRef.current) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    openDocument(JSON.stringify(bundle.show), bundle.files);
  };
  // MVR (DIN SPEC 15801) rigs from StageForge or other tools. Parse purely first; clean
  // StageForge round trips commit directly, while foreign MVRs or StageForge MVRs with
  // merge/loss findings open the preflight dialog so nothing changes silently.
  const commitMvr = (pending: { result: MvrImport; normalized: RigConfig; request: number; fileName: string }) => {
    if (!capabilitiesRef.current.edit) return;
    if (pending.request !== openRequestRef.current) {
      setPendingMvr(null);
      showToast('This MVR import was superseded by a newer file open.');
      return;
    }
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    stopLiveOutputBeforeStructuralChange('Imported an MVR scene while live output was active — re-run pre-flight.');
    setPendingMvr(null);
    aiBridgeRef.current?.notifyDocumentChanged();
    const { rig: next, stage, interchange, resources, report } = pending.result;
    installStage(stage);
    installInterchange(interchange, resources);
    wallClock.set(0, false);
    timeline.stop();
    const lastWallMs = stage?.screenEvents.at(-1)?.atMs ?? 0;
    timeline.syncWallDuration(lastWallMs, (stage?.screenEvents.length ?? 0) > 0, true);
    applyRig(pending.normalized, true); previewRig();
    setLastMvrReport({
      fileName: pending.fileName,
      rigName: next.name,
      report,
      importedAt: new Date().toISOString(),
    });
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    // Keep the toast readable: a hostile or huge file can produce long names and many notes.
    const notes = report.notes.join(' ');
    const brief = notes.length > 240 ? `${[...notes].slice(0, 239).join('').trimEnd()}…` : notes;
    showToast(`Opened ${next.name} from MVR · ${count(report.fixtures, 'fixture', 'fixtures')} · ${count(report.trusses, 'truss', 'trusses')}${brief ? ' · ' + brief : ''}`);
  };
  const openMvrBytes = async (bytes: Uint8Array, request?: number, fileName = 'scene.mvr') => {
    if (!capabilitiesRef.current.edit) return;
    const epoch = sessionEpochRef.current;
    const { importMvr } = await import('./interchange/mvr/importMvr');
    const result = importMvr(bytes);
    const normalized = normalizeDesign(result.rig);
    const req = request ?? openRequestRef.current;
    if (epoch !== sessionEpochRef.current || !capabilitiesRef.current.edit) return;
    if (request !== undefined && request !== openRequestRef.current) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    const pending = { result, normalized, request: req, fileName };
    if (result.report.source === 'stageforge' && result.report.findings.length === 0) {
      commitMvr(pending);
      return;
    }
    setViewingMvrReport(false);
    setPendingMvr(pending);
  };
  const openFile = async (file: File) => {
    if (!capabilitiesRef.current.edit) return;
    const epoch = sessionEpochRef.current;
    const request = ++openRequestRef.current;
    setPendingMvr(null);
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.mvr')) {
      const { MAX_ARCHIVE_BYTES } = await import('./interchange/mvr/archive');
      if (file.size > MAX_ARCHIVE_BYTES) throw new Error('This MVR file exceeds the 512 MiB limit.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (epoch !== sessionEpochRef.current || request !== openRequestRef.current || !capabilitiesRef.current.edit) return;
      if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
      return openMvrBytes(bytes, request, file.name);
    }
    if (!lower.endsWith('.zip')) {
      if (file.size > MAX_SHOW_JSON_BYTES) throw new Error('This JSON file exceeds the 32 MiB limit.');
      const text = await file.text();
      if (epoch !== sessionEpochRef.current || request !== openRequestRef.current || !capabilitiesRef.current.edit) return;
      if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
      return openDocument(text);
    }
    const { MAX_BUNDLE_BYTES } = await import('./data/showBundle');
    if (file.size > MAX_BUNDLE_BYTES) throw new Error('This show exceeds the 512 MiB in-memory bundle limit.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (epoch !== sessionEpochRef.current || request !== openRequestRef.current || !capabilitiesRef.current.edit) return;
    if (designerOpenRef.current) { showToast('Close the stage plan before opening a file.'); return; }
    await openBundleBytes(bytes, request);
  };
  const saveDocument = async (action: FileAction) => {
    if (!capabilitiesRef.current.save) return;
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
      downloadStageFile(rig.name, 'rigging-power.csv', new Blob([riggingPowerCsv(rig, studioStage)], { type: 'text/csv;charset=utf-8' }));
    } else if (action === 'patchSheetCsv') {
      const { buildShowPaperwork, patchSheetCsv } = await import('./data/showPaperwork');
      const pw = buildShowPaperwork(rig, studioStage, cues, timeline.snapshot());
      downloadStageFile(rig.name, 'patch-sheet.csv', new Blob([patchSheetCsv(pw)], { type: 'text/csv;charset=utf-8' }));
    } else if (action === 'instrumentScheduleCsv') {
      const { buildShowPaperwork, instrumentScheduleCsv } = await import('./data/showPaperwork');
      const pw = buildShowPaperwork(rig, studioStage, cues, timeline.snapshot());
      downloadStageFile(rig.name, 'instrument-schedule.csv', new Blob([instrumentScheduleCsv(pw)], { type: 'text/csv;charset=utf-8' }));
    } else if (action === 'channelHookupCsv') {
      const { buildShowPaperwork, channelHookupCsv } = await import('./data/showPaperwork');
      const pw = buildShowPaperwork(rig, studioStage, cues, timeline.snapshot());
      downloadStageFile(rig.name, 'channel-hookup.csv', new Blob([channelHookupCsv(pw)], { type: 'text/csv;charset=utf-8' }));
    } else if (action === 'cueSheetCsv') {
      const { buildShowPaperwork, cueSheetCsv } = await import('./data/showPaperwork');
      const pw = buildShowPaperwork(rig, studioStage, cues, timeline.snapshot());
      downloadStageFile(rig.name, 'cue-sheet.csv', new Blob([cueSheetCsv(pw)], { type: 'text/csv;charset=utf-8' }));
    } else {
      downloadStageFile(rig.name, 'patch.csv', new Blob([patchCsv(rig)], { type: 'text/csv;charset=utf-8' }));
    }
  };
  const openExample = async (name: 'amber-walk-on' | 'split-rig') => {
    if (!capabilitiesRef.current.edit) return;
    const epoch = sessionEpochRef.current;
    const request = ++openRequestRef.current;
    setPendingMvr(null);
    const folder = import.meta.env.BASE_URL + 'examples/';
    const [show, video] = await Promise.all([fetch(folder + name + '.stageforge.show.json'), fetch(folder + 'amber-clouds.mp4')]);
    if (!show.ok || !video.ok) throw new Error('The example files could not be opened.');
    const [json, videoBlob] = await Promise.all([show.text(), video.blob()]);
    if (epoch !== sessionEpochRef.current || request !== openRequestRef.current || !capabilitiesRef.current.edit) return;
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
  const fileCommand = React.useEffectEvent(async (command: 'open' | 'openBundle' | 'openMvr' | 'openViewer' | 'export' | FileAction, source?: string | Uint8Array) => {
    if (command === 'openViewer') {
      if (source === undefined) return;
      if (designerOpenRef.current) {
        window.alert('Apply or cancel the open stage plan before opening a show in the viewer.');
        return;
      }
      try {
        await openViewerPayload(source);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Could not open this show in the pitch viewer.');
      }
      return;
    }
    // Ignore all mutating/saving/exporting desktop menu commands while in pitch viewer mode.
    if (viewerModeRef.current || !capabilitiesRef.current.edit) return;
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
    setPendingMvr(null);
    try {
      if (command === 'openMvr' && typeof source !== 'string') {
        setFilesOpen(false);
        await openMvrBytes(source, request, 'MVR scene');
      }
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
    enabled: capabilities.controllers && !costModalOpen && !designerRig && !filesOpen && !pendingMvr && !viewingMvrReport && !cueEditor && timeline.mode !== 'playing',
    command: action => {
      if (!capabilitiesRef.current.controllers) return;
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
        case 'audioReactive':
          if (!capabilitiesRef.current.edit) break;
          previewRig();
          setCueModified(true);
          setShowState(s => {
            const next = !s.audioReactive;
            showToast(next ? 'Beat sync on' : 'Beat sync off');
            return { ...s, audioReactive: next };
          });
          break;
      }
    },
    hold: (key, active) => {
      if (!capabilitiesRef.current.controllers) return;
      setSourceBump('gamepad', 'gamepad', key, active);
    },
    orbit: (x, y) => {
      if (!capabilitiesRef.current.controllers) return;
      engineRef.current?.orbitBy(x, y);
    },
  });

  const demoOpeningBlack = showState.autoDirector && audioDiscrete.openingBlack;
  useEffect(() => {
    if (cinemaMode || designerRig || costModalOpen || viewerMode) clearAllBumps();
  }, [cinemaMode, designerRig, costModalOpen, viewerMode, clearAllBumps]);
  // Every cue the take fires; the console draws them all as scrubber markers.
  const takeCues = useMemo(() => (timeline.timeline?.events ?? [])
    .filter((e): e is TimelineEvent & { cueId: string } => typeof e.cueId === 'string')
    .map(e => ({ atMs: e.atMs, cueId: e.cueId, name: cues.find(c => c.id === e.cueId)?.name ?? e.cueId })),
  [timeline.timeline, cues]);

  const takeDurationMs = Math.max(timeline.timeline?.durationMs ?? 0, studioStage?.screenEvents.at(-1)?.atMs ?? 0);
  const hasTake = !!timeline.timeline && (timeline.timeline.events.length > 0 || timeline.timeline.durationMs > 0);

  const playTake = () => {
    if (!allows(clockModeRef.current, 'internal', 'take_play')) {
      showToast(`Replay is disabled in ${clockModeRef.current} mode.`);
      return;
    }
    if (missing.length) showToast(viewerModeRef.current
      ? `Playing with missing media (${missing.join(', ')}) · use Relink.`
      : `Playing with missing media. Relink ${missing.join(', ')} in Files.`);
    cancelDemoTrackLoad();
    const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
    setFollow(null); replaying.current = true; replayLook.current = showState; replayScreen.current = NO_SCREEN; replayMusicClock.current = 0;
    engineRef.current?.releaseDirector(false); previewRig(); timeline.play(false);
    wallClock.set(0, true, endMs);
  };
  const resumeTake = () => {
    if (!allows(clockModeRef.current, 'internal', 'take_play')) {
      showToast(`Replay is disabled in ${clockModeRef.current} mode.`);
      return;
    }
    cancelDemoTrackLoad();
    if (missing.length) showToast(viewerModeRef.current
      ? `Playing with missing media (${missing.join(', ')}) · use Relink.`
      : `Playing with missing media. Relink ${missing.join(', ')} in Files.`);
    const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
    setFollow(null); replaying.current = true; replayLook.current = showState; replayMusicClock.current = 0;
    engineRef.current?.releaseDirector(false); previewRig(); timeline.play(true);
    wallClock.set(timeline.playhead(), true, endMs);
  };
  const pauseTake = () => {
    timeline.pause();
    replaying.current = false;
    const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
    wallClock.set(timeline.playhead(), false, endMs);
  };
  const seekTake = (ms: number) => {
    const endMs = Math.max(timeline.timeline?.durationMs ?? 0, nativeStage.current?.screenEvents.at(-1)?.atMs ?? 0);
    const clamped = Math.max(0, Math.min(endMs, Math.round(ms)));
    const keepPlaying = timeline.mode === 'playing' && clamped < endMs;
    setFollow(null); replaying.current = keepPlaying;
    engineRef.current?.releaseDirector(false); previewRig();
    timeline.seek(clamped);
    wallClock.set(clamped, keepPlaying, endMs);
  };
  const stopTake = () => {
    timeline.stop();
    replaying.current = false;
    wallClock.set(timeline.playhead(), false);
  };

  // Always-fresh desk refs for AI bridge tool execution and transactional proposal snapshots.
  const aiDeskRefs = useRef({
    rig,
    studioStage,
    cues,
    showState,
    activeCueId,
    activeCamera,
    volume,
    audioDiscrete,
    playTake,
    pauseTake,
    seekTake,
    stopTake,
    resumeTake,
  });
  aiDeskRefs.current = {
    rig,
    studioStage,
    cues,
    showState,
    activeCueId,
    activeCamera,
    volume,
    audioDiscrete,
    playTake,
    pauseTake,
    seekTake,
    stopTake,
    resumeTake,
  };

  const applyAiCandidate = useCallback((candidate: AiProposalCandidate): boolean => {
    if (!capabilitiesRef.current.edit) return false;
    if (candidate.kind === 'propose_show' && candidate.show) {
      const file = candidate.show;
      const nextRig = normalizeDesign(file.rig);
      const wall = file.media?.screen ?? NO_SCREEN;
      // Preserve existing asset blob URLs so Revert AI changes can restore media intact.
      const look = wallLook(file.look, wall);
      timelineRef.current.replace(file.timeline, {
        look: file.look,
        cueId: file.activeCueId,
        camera: file.controls?.camera ?? 'foh',
        volume: file.controls?.volume ?? 0.72,
        bump: EMPTY_BUMP,
        screen: wall,
        music: file.media?.music ?? NO_MUSIC,
      });
      installStage(file.stage);
      installInterchange(file.interchange);
      takeMetaExplicitRef.current = file.timeline?.frameRate !== undefined || file.timeline?.timecodeOffsetMs !== undefined;
      showControlRef.current.syncFromShowTimeline(file.timeline);
      wallClock.set(0, false);
      setFollow(null);
      followInitiatedByAiRef.current = false;
      directorArmed.current = false;
      replaying.current = false;
      audioEngineRef.current?.stopAll();
      clearAllBumps();
      expectedMusic.current = file.media?.music ?? NO_MUSIC;
      applyRig(nextRig, true);
      cuesRef.current = file.cues;
      activeCueIdRef.current = file.activeCueId;
      setCues(file.cues);
      setActiveCueId(file.activeCueId);
      setCueModified(differsFromCue(look, file.cues.find((c) => c.id === file.activeCueId), wall));
      setShowState(look);
      autoDirRef.current = look.autoDirector;
      setScreen(wall);
      setVolume(file.controls?.volume ?? 0.72);
      setActiveCamera(file.controls?.camera ?? 'foh');
      audioEngineRef.current?.setBpm(look.bpm);
      audioEngineRef.current?.setVolume(file.controls?.volume ?? 0.72);
      engineRef.current?.releaseDirector(false);
      engineRef.current?.setShowState(look);
      engineRef.current?.setCameraPreset(file.controls?.camera ?? 'foh');
      previewRig();
      aiDeskRefs.current = {
        ...aiDeskRefs.current,
        rig: nextRig,
        studioStage: file.stage,
        cues: file.cues,
        showState: look,
        activeCueId: file.activeCueId,
        activeCamera: file.controls?.camera ?? 'foh',
        volume: file.controls?.volume ?? 0.72,
      };
      return true;
    }
    if ((candidate.kind === 'propose_look' || candidate.kind === 'propose_audio_mapping') && candidate.look) {
      const next = structuredClone(candidate.look);
      takeDesk();
      setShowState(next);
      autoDirRef.current = next.autoDirector;
      engineRef.current?.setShowState(next);
      audioEngineRef.current?.setBpm(next.bpm);
      aiDeskRefs.current = { ...aiDeskRefs.current, showState: next };
      return true;
    }
    if (candidate.kind === 'propose_cue' && candidate.cues) {
      const nextCues = structuredClone(candidate.cues);
      const prevOrder = cuesRef.current.map((c) => c.id).join('\0');
      const nextOrder = nextCues.map((c) => c.id).join('\0');
      const nextActiveId = resolveAcceptedCueActiveId(activeCueIdRef.current, nextCues);
      if (nextActiveId !== activeCueIdRef.current || prevOrder !== nextOrder) {
        setFollow(null);
        followInitiatedByAiRef.current = false;
      }
      cuesRef.current = nextCues;
      setCues(nextCues);
      activeCueIdRef.current = nextActiveId;
      setActiveCueId(nextActiveId);
      aiDeskRefs.current = {
        ...aiDeskRefs.current,
        cues: nextCues,
        activeCueId: nextActiveId,
      };
      return true;
    }
    if (candidate.kind === 'propose_take' && candidate.timeline) {
      const nextTake = structuredClone(candidate.timeline);
      const cur = aiDeskRefs.current;
      timelineRef.current.replace(nextTake, {
        look: cur.showState,
        cueId: cur.activeCueId,
        camera: cur.activeCamera,
        volume: cur.volume,
        bump: EMPTY_BUMP,
        screen: readScreen(),
        music: readMusic(),
      });
      showControlRef.current.syncFromShowTimeline(nextTake);
      return true;
    }
    if (candidate.kind === 'propose_wall_cue' && candidate.stage) {
      const nextStage = structuredClone(candidate.stage);
      installStage(nextStage);
      const nextEvents = nextStage.screenEvents ?? [];
      if (candidate.timeline) {
        const cur = aiDeskRefs.current;
        timelineRef.current.replace(structuredClone(candidate.timeline), {
          look: cur.showState,
          cueId: cur.activeCueId,
          camera: cur.activeCamera,
          volume: cur.volume,
          bump: EMPTY_BUMP,
          screen: readScreen(),
          music: readMusic(),
        });
      } else {
        timelineRef.current.syncWallDuration(nextEvents.at(-1)?.atMs ?? 0, nextEvents.length > 0, true);
      }
      aiDeskRefs.current = { ...aiDeskRefs.current, studioStage: nextStage };
      previewRig();
      return true;
    }
    return false;
  }, [applyRig, clearAllBumps, installInterchange, installStage, previewRig, takeDesk, wallClock]);

  const restoreAiRevertSnapshot = useCallback((snap: AiRevertSnapshot) => {
    if (!capabilitiesRef.current.edit) return;
    const nextRig = normalizeDesign(snap.rig);
    const nextScreen = snap.screen ? structuredClone(snap.screen) : NO_SCREEN;
    const nextMusic = snap.music ? structuredClone(snap.music) : NO_MUSIC;
    const nextExpectedMusic = snap.expectedMusic ? structuredClone(snap.expectedMusic) : nextMusic;
    const nextLook = wallLook(structuredClone(snap.look), nextScreen);
    timelineRef.current.stop();
    replaying.current = false;
    setFollow(null);
    followInitiatedByAiRef.current = false;
    wallClock.set(0, false);
    audioEngineRef.current?.stopAll();
    engineRef.current?.restoreScreenTransport(false);
    clearAllBumps();
    installStage(snap.stage);
    installInterchange(snap.interchange, snap.mvrResources ? new Map(snap.mvrResources) : undefined);
    takeMetaExplicitRef.current = Boolean(snap.takeMetaExplicit);
    expectedMusic.current = nextExpectedMusic;
    timelineRef.current.replace(snap.timeline, {
      look: nextLook,
      cueId: snap.activeCueId,
      camera: snap.camera,
      volume: snap.volume,
      bump: EMPTY_BUMP,
      screen: { ...nextScreen, playing: false },
      music: { ...nextMusic, playing: false },
    });
    showControlRef.current.syncFromShowTimeline(snap.timeline);
    applyRig(nextRig, true);
    cuesRef.current = snap.cues;
    activeCueIdRef.current = snap.activeCueId;
    setCues(snap.cues);
    setActiveCueId(snap.activeCueId);
    setCueModified(false);
    setShowState(nextLook);
    autoDirRef.current = nextLook.autoDirector;
    setScreen({ ...nextScreen, playing: false });
    setActiveCamera(snap.camera);
    setVolume(snap.volume);
    audioEngineRef.current?.setBpm(nextLook.bpm);
    audioEngineRef.current?.setVolume(snap.volume);
    engineRef.current?.releaseDirector(false);
    engineRef.current?.setShowState(nextLook);
    engineRef.current?.setCameraPreset(snap.camera);
    previewRig();
    aiDeskRefs.current = {
      ...aiDeskRefs.current,
      rig: nextRig,
      studioStage: snap.stage,
      cues: snap.cues,
      showState: nextLook,
      activeCueId: snap.activeCueId,
      activeCamera: snap.camera,
      volume: snap.volume,
    };
  }, [applyRig, clearAllBumps, installInterchange, installStage, previewRig, wallClock]);

  const aiBridge = useAiBridge(
    {
      getDeskSnapshot: () => {
        const cur = aiDeskRefs.current;
        return {
          rig: cur.rig,
          stage: cur.studioStage,
          interchange: interchangeRef.current,
          mvrResources: mvrResourcesRef.current,
          cues: cur.cues,
          look: cur.showState,
          activeCueId: cur.activeCueId,
          timeline: timelineRef.current.timeline,
          camera: cur.activeCamera,
          volume: cur.volume,
          screen: readScreen(),
          music: readMusic(),
          expectedMusic: expectedMusic.current,
          takeMetaExplicit: takeMetaExplicitRef.current,
          clockMode: clockModeRef.current,
          audioStatus: {
            playing: cur.audioDiscrete.playing,
            source: cur.audioDiscrete.source,
            trackName: live.audio.get().trackName,
            bpm: cur.showState.bpm,
          },
        };
      },
      getSafetyReport: () => preflightRef.current,
      getAudioLevels: () => live.audio.get(),
      captureFrame: async (maxWidth?: number) => {
        const engine = engineRef.current;
        if (!engine) throw new Error('StageEngine is not ready.');
        return engine.captureJpeg({ maxWidth: maxWidth ?? 1280, quality: 0.8 });
      },
      applyCandidate: applyAiCandidate,
      restoreSnapshot: restoreAiRevertSnapshot,
      onGo: () => {
        // Single authoritative lookup + follow-chain audienceScan check (H1 + M4).
        const list = aiDeskRefs.current.cues;
        if (!list.length) return { ok: false, activeCueId: aiDeskRefs.current.activeCueId, message: 'No cues exist.' };
        const idx = list.findIndex((c) => c.id === aiDeskRefs.current.activeCueId);
        const targetIdx = idx >= 0 ? (idx + 1) % list.length : 0;
        if (cueOrFollowChainEnablesAudienceScan(list, targetIdx)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        const target = list[targetIdx];
        cuesRef.current = list;
        triggerCue(target, false, 'ai');
        aiDeskRefs.current = { ...aiDeskRefs.current, activeCueId: target.id };
        return { ok: true, activeCueId: target.id };
      },
      onBack: () => {
        const list = aiDeskRefs.current.cues;
        if (!list.length) return { ok: false, activeCueId: aiDeskRefs.current.activeCueId, message: 'No cues exist.' };
        const idx = list.findIndex((c) => c.id === aiDeskRefs.current.activeCueId);
        const targetIdx = idx > 0 ? idx - 1 : list.length - 1;
        if (cueOrFollowChainEnablesAudienceScan(list, targetIdx)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        const target = list[targetIdx];
        cuesRef.current = list;
        triggerCue(target, false, 'ai');
        aiDeskRefs.current = { ...aiDeskRefs.current, activeCueId: target.id };
        return { ok: true, activeCueId: target.id };
      },
      onStop: () => {
        stopDeskPlayback();
      },
      onResume: () => {
        // Guard take resume against audienceScan events (M3).
        if (timelineRef.current.canResume) {
          if (timelineEnablesAudienceScan(timelineRef.current.timeline)) {
            return { isError: true, message: AUDIENCE_SCAN_ERROR };
          }
          aiDeskRefs.current.resumeTake();
          return { ok: true };
        }
        if (!audioEngineRef.current?.getStatus().playing) {
          audioEngineRef.current?.togglePlayPause();
        }
        return { ok: true };
      },
      onTriggerCue: ({ cueId, index }) => {
        const list = aiDeskRefs.current.cues;
        const targetIdx = cueId
          ? list.findIndex((c) => c.id === cueId)
          : index !== undefined && index >= 1 && index <= list.length
            ? index - 1
            : -1;
        if (targetIdx < 0) return { isError: true, message: 'Requested cue was not found.' };
        if (cueOrFollowChainEnablesAudienceScan(list, targetIdx)) {
          return { isError: true, message: AUDIENCE_SCAN_ERROR };
        }
        const target = list[targetIdx];
        cuesRef.current = list;
        triggerCue(target, false, 'ai');
        aiDeskRefs.current = { ...aiDeskRefs.current, activeCueId: target.id };
        return { ok: true, activeCueId: target.id };
      },
      onPlayTake: () => {
        const tl = timelineRef.current.timeline;
        if (!tl || (tl.events.length === 0 && tl.durationMs <= 0)) {
          return { ok: false, message: 'No playable take timeline is loaded.' };
        }
        aiDeskRefs.current.playTake();
        return { ok: true };
      },
      onPauseTake: () => {
        aiDeskRefs.current.pauseTake();
        return { ok: true };
      },
      onSeekTake: (positionMs: number) => {
        const tl = timelineRef.current.timeline;
        if (!tl || (tl.events.length === 0 && tl.durationMs <= 0)) {
          return { ok: false, message: 'No playable take timeline is loaded.' };
        }
        aiDeskRefs.current.seekTake(positionMs);
        return { ok: true };
      },
      onSetBlackout: (active?: boolean) => {
        // Pure state updater: apply engine + ref updates outside React setShowState updater (L9).
        const prev = aiDeskRefs.current.showState;
        const nextVal = active !== undefined ? active : !prev.blackout;
        const next = { ...prev, blackout: nextVal };
        previewRig();
        setCueModified(true);
        aiDeskRefs.current = { ...aiDeskRefs.current, showState: next };
        engineRef.current?.setShowState(next);
        setShowState((s) => ({ ...s, blackout: nextVal }));
        return nextVal;
      },
      onSetMaster: (value: number) => {
        const clamped = Math.max(0, Math.min(1, value));
        const next = { ...aiDeskRefs.current.showState, masterDimmer: clamped };
        previewRig();
        setCueModified(true);
        aiDeskRefs.current = { ...aiDeskRefs.current, showState: next };
        engineRef.current?.setShowState(next);
        setShowState((s) => ({ ...s, masterDimmer: clamped }));
        return clamped;
      },
      onSetBpm: (bpm: number) => {
        if (audioEngineRef.current?.isDemoTrackActive()) {
          return { ok: false, bpm: bpmRef.current, message: 'Tempo is locked to the demo track map.' };
        }
        applyDeskBpm(bpm);
        const clamped = Math.round(Math.max(70, Math.min(180, bpm)) * 10) / 10;
        return { ok: true, bpm: clamped };
      },
      onToast: showToast,
    },
    {
      capabilityAllowed: capabilities.edit && !viewerMode,
      outputBlocking: liveDmx.armed || liveDmx.isLive,
    },
  );
  aiBridgeRef.current = aiBridge;
  const aiBridgeBlocking = aiBridge.enabled || aiBridge.pendingProposals.length > 0;
  useEffect(() => {
    setAiBridgeSuspendOutbound(aiBridge.enabled);
  }, [aiBridge.enabled]);

  const handleViewerTogglePlayback = () => {
    if (hasTake && takeDurationMs > 0) {
      if (timeline.mode === 'playing') pauseTake();
      else if (timeline.canResume) resumeTake();
      else playTake();
      return;
    }
    handleTogglePlay();
  };

  hotkeyHandlerRef.current = {
    toggleViewerPlay: handleViewerTogglePlayback,
    go: () => { if (timeline.mode !== 'playing' && nextCue) triggerCue(nextCue); },
    back: () => { if (timeline.mode !== 'playing' && previousCue) triggerCue(previousCue); },
    camera: handleCamera,
  };

  return (
    <CapabilitiesProvider value={capabilities}>
    <main data-cinema={cinemaMode} data-viewer={viewerMode} data-demo-blackout={demoOpeningBlack} className="stage-workstation relative w-screen h-screen bg-black overflow-hidden">
      {/* Full-Viewport HQ 3D WebGL2 Canvas */}
      <div ref={viewportRef} className="stage-viewport w-full h-full cursor-grab active:cursor-grabbing" />
      <ShowOverlay audioStore={live.audio} controller={controller} cinema={cinemaMode} showControllerGuide={capabilities.controllers} />

      {viewerMode ? (
        <PitchViewer
          showName={rig.name}
          fixtureCount={counts.fixtures}
          laserCount={counts.lasers}
          fpsStore={live.fps}
          audioStore={live.audio}
          blackout={showState.blackout}
          activeCamera={activeCamera}
          cinemaMode={cinemaMode}
          cues={cues}
          activeCueId={activeCueId}
          follow={follow}
          stage={studioStage}
          mainScreen={media.screen}
          missingMedia={missing}
          take={{
            mode: timeline.mode,
            timeMs: timeline.timeMs,
            durationMs: takeDurationMs,
            hasTake,
            canResume: timeline.canResume,
            cues: takeCues,
            play: playTake,
            resume: resumeTake,
            pause: pauseTake,
            seek: seekTake,
            stop: stopTake,
          }}
          onSelectCamera={handleCamera}
          onToggleCinemaMode={() => setCinemaMode((v) => !v)}
          onTogglePlayback={handleViewerTogglePlayback}
          onGo={() => { if (timeline.mode !== 'playing' && nextCue) triggerCue(nextCue); }}
          onBack={() => { if (timeline.mode !== 'playing' && previousCue) triggerCue(previousCue); }}
          onTriggerCue={(cue) => {
            if (timeline.mode === 'playing') return;
            triggerCue(cue);
            showToast(`Cue: ${cue.name}`);
          }}
          onHoldFollow={() => setFollow('held')}
          onOpenShow={openViewerPayload}
          onRelinkMedia={onRelink}
          onError={showToast}
          onExitViewer={exitViewer}
          displaySettings={{
            settings: renderSettings,
            onChangeSettings: updateRenderSettings,
            fullRateOptIn: fullRateStrobeOptIn,
            effectiveFullRate: effectiveFullRateStrobe,
            prefersReducedMotion,
            viewerMode: true,
            showWebXrSetting: false,
            effectiveReducedEffects: effectiveLookOutput.reducedEffects,
            reducedEffectsReason: effectiveLookOutput.reducedReason,
            onSetFullRateOptIn: setFullRateStrobeOptIn,
          }}
        />
      ) : (
      <>
      {/* Top Transport, Audio, Cameras & Tools Bar */}
      <TopBar
        fpsStore={live.fps}
        fixtureCount={counts.fixtures}
        laserCount={counts.lasers}
        audioStore={live.audio}
        getLinkedMusic={readMusic}
        getTrackDuration={() => audioEngineRef.current?.trackDuration() ?? 0}
        onSeekTrack={handleSeekTrack}
        volume={volume}
        bpm={showState.bpm}
        tempo={tempoProps}
        openingBar={demoOpeningBlack ? audioDiscrete.openingBar : undefined}
        openingTotalBars={demoOpeningBlack ? audioDiscrete.openingTotalBars : undefined}
        openingBeforeDownbeat={demoOpeningBlack ? audioDiscrete.openingBeforeDownbeat : undefined}
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
        measureEnabled={isMeasureOverlayActive(measureOptions)}
        preflightLabel={preflightReport.badgeLabel}
        preflightStatus={preflightReport.overallStatus}
        availableDemoTrackTitle={availableDemoTrack?.map.title ?? null}
        demoTrackSectionCount={availableDemoTrack?.map.sections.length ?? 0}
        demoTrackLoading={demoTrackLoading}
        demoTrackProgress={demoTrackProgress}
        onTogglePlay={handleTogglePlay}
        onStartDemo={startDemo}
        onStartDemoTrack={() => void startDemoTrack()}
        onJumpDemoSection={handleJumpDemoSection}
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
          if (!capabilitiesRef.current.edit) return;
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
        onToggleMeasure={toggleMeasureOverlay}
        onOpenPreflight={() => setPreflightOpen(true)}
        displaySettings={{
          settings: renderSettings,
          onChangeSettings: updateRenderSettings,
          fullRateOptIn: fullRateStrobeOptIn,
          effectiveFullRate: effectiveFullRateStrobe,
          prefersReducedMotion,
          viewerMode: false,
          showWebXrSetting: !window.stageforgeDesktop,
          effectiveReducedEffects: effectiveLookOutput.reducedEffects,
          reducedEffectsReason: effectiveLookOutput.reducedReason,
          onSetFullRateOptIn: setFullRateStrobeOptIn,
        }}
      />

      {/* Live Status Toast & Blackout Pill */}
      {missing.length > 0 && <button type="button" className="media-relink-alert" onClick={() => setFilesOpen(true)}>
        {missing.length} missing media {missing.length === 1 ? 'file' : 'files'} · Relink
      </button>}
      {filesOpen && <ErrorBoundary label="Show files" onReset={() => setFilesOpen(false)} onExportRig={() => downloadRig(rig)}><ShowFiles name={rig.name} media={media} stage={studioStage} timeline={timeline.timeline} missing={missing} cueNames={new Map(cues.map(c => [c.id, c.name]))}
        lastMvrSummary={lastMvrReport ? {
          fileName: lastMvrReport.fileName,
          warnings: lastMvrReport.report.findings.filter(f => f.severity === 'warn').length,
          blocks: lastMvrReport.report.findings.filter(f => f.severity === 'block').length,
        } : undefined}
        onViewMvrReport={() => setViewingMvrReport(true)}
        onOpen={openFile} onOpenInViewer={openViewerPayload} onExample={openExample} onSave={saveDocument} onRelink={onRelink} onError={showToast} onClose={() => setFilesOpen(false)}/></ErrorBoundary>}
      {pendingMvr && !filesOpen && <ErrorBoundary label="MVR import preflight" onReset={() => setPendingMvr(null)} onExportRig={() => downloadRig(rig)}><MvrImportReportDialog
        key={pendingMvr.request}
        mode="preflight"
        fileName={pendingMvr.fileName}
        rigName={pendingMvr.result.rig.name}
        report={pendingMvr.result.report}
        onImport={() => commitMvr(pendingMvr)}
        onCancel={() => setPendingMvr(null)}/></ErrorBoundary>}
      {viewingMvrReport && lastMvrReport && !pendingMvr && !filesOpen && <ErrorBoundary label="MVR import report" onReset={() => setViewingMvrReport(false)} onExportRig={() => downloadRig(rig)}><MvrImportReportDialog
        mode="view"
        fileName={lastMvrReport.fileName}
        rigName={lastMvrReport.rigName}
        report={lastMvrReport.report}
        importedAt={lastMvrReport.importedAt}
        onClose={() => setViewingMvrReport(false)}/></ErrorBoundary>}
      {cueEditor && <ErrorBoundary label="Cue list editor" onReset={() => setCueEditor(false)} onExportRig={() => downloadRig(rig)}><CueListEditor cues={cues} capture={() => ({ id: crypto.randomUUID(), name: 'New look',
        tag: 'USER', accent: showState.primaryColor, state: structuredClone(showState), screen: cueScreen() })}
        onApply={next => {
          if (!capabilitiesRef.current.edit) return;
          stopLiveOutputBeforeStructuralChange('Cue list changed while live output was active — re-run pre-flight.');
          const index = next.findIndex(c => c.id === activeCueId);
          if (index < 0) { setActiveCueId(null); setCueModified(false); }
          if (index < 0 || !next[index + 1] || next[index].followSeconds !== cues[currentIndex]?.followSeconds) setFollow(null);
          setCues(next);
        }}
        onClose={() => setCueEditor(false)}/></ErrorBoundary>}
      {/* Always-visible safety badge whenever live DMX output is enabled or stopped on heartbeat loss (including cinema mode) */}
      <LiveDmxBadge
        banner={liveDmx.banner}
        busy={liveDmx.busy}
        hasCatalogFixtures={hasCatalogFixtures(rig)}
        hasSimulationOnly={summarizePhysicalDrive(rig).hasSimulationOnly}
        preflightLabel={preflightReport.badgeLabel}
        preflightStatus={preflightReport.overallStatus}
        liveViolationMessage={liveSafetyViolation}
        onOpenPreflight={() => {
          setCinemaMode(false);
          setPreflightOpen(true);
        }}
        onStop={() => {
          clearAllBumps();
          void liveDmx.disable();
        }}
        onDismissNotice={liveDmx.dismissStoppedNotice}
        onOpenOutput={() => {
          setCinemaMode(false);
          setDmxDrawerOpen(true);
        }}
      />

      {webXrPhase !== 'disabled' && webXrPhase !== 'checking' && (
        <div className="fixed top-16 right-3 z-50">
          {webXrPhase === 'ready' && (
            <button
              type="button"
              data-testid="webxr-enter"
              onClick={handleWebXrEntry}
              disabled={liveDmx.armed || liveDmx.isLive}
              title={liveDmx.armed || liveDmx.isLive ? 'Exit or disarm physical output before VR' : 'Enter immersive VR audience preview'}
              className="rounded-lg border border-cyan-400/70 bg-cyan-950/90 px-3 py-2 font-mono-tech text-xs font-bold text-cyan-100 shadow-2xl disabled:cursor-not-allowed disabled:opacity-45"
            >
              Enter VR
            </button>
          )}
          {webXrPhase === 'requesting' && (
            <button
              type="button"
              data-testid="webxr-cancel-request"
              onClick={cancelWebXrRequest}
              className="rounded-lg border border-amber-400/70 bg-amber-950/90 px-3 py-2 font-mono-tech text-xs font-bold text-amber-100 shadow-2xl"
            >
              Cancel VR request
            </button>
          )}
          {webXrPhase === 'active' && (
            <button
              type="button"
              data-testid="webxr-exit"
              onClick={exitWebXr}
              className="rounded-lg border border-cyan-400/70 bg-cyan-950/90 px-3 py-2 font-mono-tech text-xs font-bold text-cyan-100 shadow-2xl"
            >
              Exit VR
            </button>
          )}
          {webXrPhase === 'exiting' && (
            <span data-testid="webxr-exiting" className="rounded-lg border border-white/20 bg-black/85 px-3 py-2 font-mono-tech text-xs text-zinc-300 shadow-2xl">
              Exiting VR…
            </span>
          )}
        </div>
      )}

      {webXrPhase === 'warning' && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="webxr-warning-title"
          aria-describedby="webxr-warning-description"
          data-testid="webxr-warning"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4"
        >
          <div className="w-full max-w-lg space-y-3 rounded-xl border border-amber-400/70 bg-zinc-950 p-5 shadow-2xl">
            <h2 id="webxr-warning-title" className="text-base font-bold text-amber-200">Before entering immersive VR</h2>
            <div id="webxr-warning-description" className="space-y-2 text-xs leading-relaxed text-zinc-200">
              <p>Immersive motion, bright concert lighting, haze, strobes, and rapid colour changes may cause motion sickness, disorientation, or photosensitive reactions. Stop immediately if you feel unwell.</p>
              <p>The preview flash limiter will be forced on for VR. Keep the play area clear and follow your headset’s guardian and safety guidance.</p>
              <p>{LASER_SAFETY_DISCLAIMER} {LASER_LSO_NOTICE}</p>
              <p className="text-amber-200">VR is a simulated visualization only. It does not prove laser safety, visibility, performance, comfort, or regulatory compliance.</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                data-testid="webxr-warning-cancel"
                onClick={() => {
                  webXrPhaseRef.current = 'ready';
                  setWebXrPhase('ready');
                }}
                className="rounded border border-white/20 bg-white/10 px-3 py-1.5 text-xs text-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="webxr-warning-confirm"
                onClick={() => beginWebXrRequest(webXrModuleRef.current!)}
                className="rounded border border-cyan-400/60 bg-cyan-500/20 px-3 py-1.5 text-xs font-bold text-cyan-100"
              >
                I understand — enter VR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Always-visible Full-Rate Strobe Preview warning badge (even in cinema mode) */}
      {effectiveFullRateStrobe && (
        <div
          role="status"
          aria-live="polite"
          data-testid="full-rate-strobe-badge"
          className="fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-lg border border-amber-400/80 bg-amber-950/95 px-2.5 py-1.5 shadow-2xl font-mono-tech text-[11px] text-amber-100"
        >
          <span className="font-bold tracking-wider">FULL-RATE STROBE</span>
          <button
            type="button"
            data-testid="full-rate-strobe-disable-badge"
            onClick={() => setFullRateStrobeOptIn(false)}
            className="rounded border border-amber-300/60 bg-amber-500/25 hover:bg-amber-500/40 px-2 py-0.5 text-[10px] font-bold text-amber-50 cursor-pointer"
          >
            Limit ≤ 3/s
          </button>
        </div>
      )}

      {/* WebGL context-loss notice */}
      {webglContextLost && (
        <div
          role="alert"
          data-testid="webgl-context-lost-banner"
          className="fixed top-16 left-1/2 -translate-x-1/2 z-[75] rounded-lg border border-rose-400/80 bg-rose-950/95 px-3 py-2 shadow-2xl font-mono-tech text-xs text-rose-100"
        >
          Graphics context lost — rendering paused while the browser recovers.
        </div>
      )}

      {/* Lazy Measure & Safety Zones HUD (mounted only while Measure or a zone toggle is active) */}
      {!cinemaMode && isMeasureOverlayActive(measureOptions) && (
        <ErrorBoundary label="Measure overlay" onReset={() => setMeasureOptions(DEFAULT_MEASURE_OVERLAY_OPTIONS)} onExportRig={() => downloadRig(rig)}>
          <MeasureOverlayHud
            options={measureOptions}
            measureStore={live.measure}
            laserZones={laserZonesForHud}
            onChangeOptions={(patch) => setMeasureOptions((prev) => ({ ...prev, ...patch }))}
            onClose={() => setMeasureOptions(DEFAULT_MEASURE_OVERLAY_OPTIONS)}
          />
        </ErrorBoundary>
      )}

      {/* Visible Pre-flight Safety Gate Panel */}
      {preflightOpen && (
        <ErrorBoundary label="Pre-flight check" onReset={() => setPreflightOpen(false)} onExportRig={() => downloadRig(rig)}>
          <PreflightPanel
            open={preflightOpen}
            report={preflightReport}
            acks={preflightAcks}
            liveViolationMessage={liveSafetyViolation}
            onRunCheck={handleRunPreflightCheck}
            onToggleRowAck={handleToggleRowAck}
            onToggleLaserAck={handleToggleLaserAck}
            onToggleLaserInhibit={handleToggleLaserInhibit}
            onClose={() => setPreflightOpen(false)}
          />
        </ErrorBoundary>
      )}

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

      {/* Slide-Over Rig Builder */}
      {!cinemaMode && rigDrawerOpen && (
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
              if (!capabilitiesRef.current.edit) return;
              interchangeRef.current = pruneInterchangeFixtureSpecs(interchangeRef.current, podId, groupId);
            }}
            onChangeRig={(next, replacing) => {
              if (!capabilitiesRef.current.edit) return;
              if (replacing && !confirmDiscardStage()) return;
              if (replacing) {
                installStage();
                installInterchange();
              }
              applyRig(next);
            }}
            onChangeStage={(next) => {
              if (!capabilitiesRef.current.edit) return;
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
      {!cinemaMode && dmxDrawerOpen && (
        <ErrorBoundary label="DMX Monitor" onReset={() => setDmxDrawerOpen(false)} onExportRig={() => downloadRig(rig)}>
          <DmxMonitorDrawer
            open={dmxDrawerOpen}
            rig={rig}
            dmxStore={live.dmx}
            liveOutput={liveDmx}
            preflight={preflightReport}
            liveViolationMessage={liveSafetyViolation}
            aiBridgeBlocking={aiBridgeBlocking}
            webXrBlocking={webXrBlocksPhysicalOutput(webXrPhase)}
            onOpenPreflight={() => setPreflightOpen(true)}
            onClose={() => setDmxDrawerOpen(false)}
          />
        </ErrorBoundary>
      )}

      {/* Slide-Over Show Control & Sync Drawer */}
      {!cinemaMode && showControlOpen && (
        <ErrorBoundary label="Show Control" onReset={() => setShowControlOpen(false)} onExportRig={() => downloadRig(rig)}>
          <ShowControlDrawer
            open={showControlOpen}
            control={showControl}
            aiBridge={aiBridge}
            onClose={() => setShowControlOpen(false)}
          />
        </ErrorBoundary>
      )}

      {/* Floating AI Proposal Review Banner */}
      {!viewerMode && <AiProposalBanner bridge={aiBridge} />}

      {/* Real-World Production Cost & Crew Labor Estimator Modal */}
      {designerRig && (
        <ErrorBoundary label="Stage Designer" onReset={() => setDesignerRig(null)} onExportRig={() => downloadRig(rig)}>
          <StageDesigner rig={designerRig} stage={studioStage} laserState={showState.laser} ildaClip={ildaClip} onClose={() => setDesignerRig(null)} onChange={(design, stage, replacing) => {
            if (!capabilitiesRef.current.edit) return;
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
              cues={cues}
              timeline={timeline.timeline}
              preflight={preflightReport}
              preflightAcks={preflightAcks}
              shopStock={shopStock}
              onChangeShopStock={updateShopStock}
              onChangeRig={(next) => {
                if (!capabilitiesRef.current.edit) return;
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
            if (!capabilitiesRef.current.edit) return;
            if (Object.keys(patch).some(key => key !== 'masterDimmer' && key !== 'blackout' && key !== 'bloomStrength')) takeDesk();
            else { previewRig(); setCueModified(true); }
            setShowState((s) => applyDeskPatch(s, patch));
          }}
          onPatchLaser={(patch) => {
            if (!capabilitiesRef.current.edit) return;
            takeDesk();
            setShowState((s) => ({ ...s, laser: { ...s.laser, ...patch } }));
          }}
          onPatchMotors={(patch) => {
            if (!capabilitiesRef.current.edit) return;
            takeDesk();
            setShowState((s) => ({ ...s, motors: { ...s.motors, ...patch } }));
          }}
          onPatchAtmo={(patch) => {
            if (!capabilitiesRef.current.edit) return;
            takeDesk();
            setShowState((s) => ({ ...s, atmo: { ...s.atmo, ...patch } }));
          }}
          onPatchLed={(patch) => {
            if (!capabilitiesRef.current.edit) return;
            takeDesk();
            setShowState((s) => ({ ...s, led: { ...s.led, ...patch } }));
          }}
          onSetPodMotor={(podId, height, tilt) => {
            if (!capabilitiesRef.current.edit) return;
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
            if (!capabilitiesRef.current.edit) return;
            const kind = file.type.startsWith('video/') || (!file.type && VIDEO_EXT.test(file.name)) ? 'video' : 'image';
            const asset = registerAsset(kind, file);
            takeDesk(); setCaptureVideoPosition(false); setScreen({ target: 'main-led', kind, name: file.name, playing: kind === 'video', offsetSeconds: 0 });
            setShowState(s => ({ ...s, led: { ...s.led, brightness: s.led.brightness <= 0.05 ? 1 : s.led.brightness,
              customMediaUrl: asset.url!, customMediaType: kind, visualMode: 'custom', enabled: true } }));
          }}
          screenName={media.screen.name} videoPlaying={media.screen.playing}
          captureVideoPosition={captureVideoPosition} onCaptureVideoPosition={setCaptureVideoPosition}
          onToggleVideo={() => {
            if (!capabilitiesRef.current.edit) return;
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
            if (!capabilitiesRef.current.edit) return;
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
            if (!capabilitiesRef.current.edit) return;
            const nextStage = removeSecondaryScreenEvent(rig, nativeStage.current, target, atMs);
            installStage(nextStage);
            const nextEvents = nextStage?.screenEvents ?? [];
            timeline.syncWallDuration(nextEvents.at(-1)?.atMs ?? 0, nextEvents.length > 0, true);
            wallClock.refresh();
          }}
          take={{
            mode: timeline.mode,
            timeMs: timeline.timeMs,
            durationMs: takeDurationMs,
            hasTake,
            canResume: timeline.canResume,
            cues: takeCues,
            playhead: () => timeline.playhead(),
            record: () => {
              if (!capabilitiesRef.current.edit) return;
              if (!timeline.timeline?.events.length || window.confirm('Replace the recorded take in this session?')) {
                const stampMeta = takeMetaExplicitRef.current || showControl.clockMode === 'chase';
                timeline.record(stampMeta ? {
                  frameRate: showControl.settings.frameRate,
                  timecodeOffsetMs: showControl.settings.timecodeOffsetMs,
                } : undefined);
                wallClock.set(0, true);
              }
            },
            play: playTake,
            resume: resumeTake,
            pause: pauseTake,
            seek: seekTake,
            stop: stopTake,
          }}
          clockMode={showControl.clockMode}
          tempo={tempoProps}
          audioStore={live.audio}
          audioModStore={live.audioMod}
          onToggleAudioReactive={() => {
            if (!capabilitiesRef.current.edit) return;
            previewRig();
            setCueModified(true);
            setShowState((s) => ({ ...s, audioReactive: !s.audioReactive }));
          }}
          onChangeAudioMap={(next?: AudioMapConfig) => {
            if (!capabilitiesRef.current.edit) return;
            takeDesk();
            setShowState((s) => {
              const copy = { ...s };
              if (next && next.mappings.length > 0) {
                copy.audioMap = next;
              } else {
                delete copy.audioMap;
              }
              return copy;
            });
          }}
          onUploadAudio={(file) => { void handleUploadAudio(file); }}
          onToggleMic={() => { void handleToggleMic(); }}
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
          onSetBump={(key, active) => {
            if (!capabilitiesRef.current.edit) return;
            setSourceBump('ui', 'local', key, active);
          }}
          measureEnabled={isMeasureOverlayActive(measureOptions)}
          onToggleMeasure={toggleMeasureOverlay}
        />
      )}
      </>
      )}

      {toast && (
        <div role="status" aria-live="polite" className="fixed top-16 left-1/2 -translate-x-1/2 z-50 glass-panel px-4 py-1.5 rounded-full text-xs font-mono-tech text-cyan-200 border-cyan-400/50 shadow-lg pointer-events-none">
          {toast}
        </div>
      )}

      {showState.blackout && !demoOpeningBlack && (
        <div role="alert" className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none px-5 py-2 rounded-xl bg-rose-950/80 border border-rose-500/70 font-mono-tech text-sm tracking-widest text-rose-200 shadow-[0_0_30px_rgba(244,63,94,0.45)]">
          {capabilities.mutatingHotkeys ? 'STAGE BLACKOUT — PRESS [SPACE] TO RESTORE' : 'STAGE BLACKOUT'}
        </div>
      )}
    </main>
    </CapabilitiesProvider>
  );
};
export default App;
