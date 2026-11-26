import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  FolderOpen,
  LogOut,
  Pause,
  Play,
  Square,
} from 'lucide-react';
import { CAMERAS } from './TopBar';
import { DeskDialog } from './ShowFiles';
import { DisplaySettingsPopover, type DisplaySettingsPopoverProps } from './DisplaySettingsPopover';
import { useLive, type LiveStore } from '../state/liveTelemetry';
import { useCapabilities } from '../viewer/capabilities';
import type { AudioMetrics, CameraPreset, ShowCue } from '../types/show';
import type { NativeStage, ScreenRef } from '../data/showFile';
import {
  cueMarkers,
  layoutTicks,
  screenGlances,
  scrubPosition,
  timecode,
  wallMarkers,
  type ScreenGlanceState,
} from '../data/transportGlance';

export interface PitchViewerTakeControls {
  mode: 'idle' | 'recording' | 'playing';
  timeMs: number;
  durationMs: number;
  hasTake: boolean;
  canResume: boolean;
  cues: Array<{ atMs: number; cueId: string; name: string }>;
  play: () => void;
  resume: () => void;
  pause: () => void;
  seek: (ms: number) => void;
  stop: () => void;
}

export interface PitchViewerProps {
  showName: string;
  fixtureCount: number;
  laserCount: number;
  fpsStore: LiveStore<number>;
  audioStore: LiveStore<AudioMetrics>;
  blackout: boolean;
  activeCamera: CameraPreset;
  cinemaMode: boolean;
  cues: ShowCue[];
  activeCueId: string | null;
  follow: number | 'held' | null;
  stage?: NativeStage;
  mainScreen?: Pick<ScreenRef, 'kind' | 'name' | 'playing'>;
  missingMedia: readonly string[];
  take: PitchViewerTakeControls;
  onSelectCamera: (cam: CameraPreset) => void;
  onToggleCinemaMode: () => void;
  onTogglePlayback: () => void;
  onGo: () => void;
  onBack: () => void;
  onTriggerCue: (cue: ShowCue) => void;
  onHoldFollow: () => void;
  onOpenShow: (file: File) => Promise<void>;
  onRelinkMedia: (files: File[]) => string;
  onError: (msg: string) => void;
  onExitViewer: () => void;
  displaySettings?: DisplaySettingsPopoverProps;
}

const GLANCE_LABEL: Record<ScreenGlanceState, string> = { play: 'Play', hold: 'Hold', missing: 'Missing', none: 'Empty' };
const GLANCE_STYLE: Record<ScreenGlanceState, string> = {
  play: 'bg-emerald-500/25 border-emerald-400/50 text-emerald-200',
  hold: 'bg-amber-500/20 border-amber-400/40 text-amber-200',
  missing: 'bg-rose-500/25 border-rose-400/60 text-rose-200',
  none: 'bg-white/5 border-white/10 text-zinc-400',
};

export const PitchViewer: React.FC<PitchViewerProps> = ({
  showName,
  fixtureCount,
  laserCount,
  fpsStore,
  audioStore,
  blackout,
  activeCamera,
  cinemaMode,
  cues,
  activeCueId,
  follow,
  stage,
  mainScreen,
  missingMedia,
  take,
  onSelectCamera,
  onToggleCinemaMode,
  onTogglePlayback,
  onGo,
  onBack,
  onTriggerCue,
  onHoldFollow,
  onOpenShow,
  onRelinkMedia,
  onError,
  onExitViewer,
  displaySettings,
}) => {
  const capabilities = useCapabilities();
  const fps = useLive(fpsStore);
  const audio = useLive(audioStore);
  const openInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [relinkNote, setRelinkNote] = useState('');
  const [opening, setOpening] = useState(false);
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-height: 500px)').matches
  );

  // Coalesce scrubber drags to one seek per animation frame.
  const seekFrame = useRef(0);
  const seekTarget = useRef(0);
  const latestTake = useRef(take);
  latestTake.current = take;
  const scrub = (ms: number) => {
    seekTarget.current = ms;
    if (seekFrame.current) return;
    seekFrame.current = requestAnimationFrame(() => {
      seekFrame.current = 0;
      latestTake.current.seek(seekTarget.current);
    });
  };
  useEffect(() => () => cancelAnimationFrame(seekFrame.current), []);

  const seekNow = (ms: number) => {
    cancelAnimationFrame(seekFrame.current);
    seekFrame.current = 0;
    take.seek(ms);
  };

  const { max: scrubMax, value: scrubValue } = scrubPosition(take.timeMs, take.durationMs);
  const ticks = useMemo(
    () => layoutTicks([...cueMarkers(take.cues), ...wallMarkers(stage)], take.durationMs, { rangeMs: scrubMax }),
    [take.cues, stage, take.durationMs, scrubMax],
  );
  const glanceMs = Math.min(take.timeMs, take.durationMs);
  const wallsRunning = take.mode === 'playing' && take.timeMs < take.durationMs;
  const glances = useMemo(
    () => screenGlances(stage, glanceMs, wallsRunning, mainScreen, missingMedia),
    [stage, glanceMs, wallsRunning, mainScreen, missingMedia],
  );

  const currentIndex = cues.findIndex((c) => c.id === activeCueId);
  const cueLabel = (idx: number) => (cues[idx] ? `${String(idx + 1).padStart(2, '0')} ${cues[idx].name}` : '—');
  const isPlaying = take.hasTake ? take.mode === 'playing' : audio.playing;

  const handleOpenFile = async (file: File) => {
    setOpening(true);
    try {
      await onOpenShow(file);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not open show in viewer.');
    } finally {
      setOpening(false);
    }
  };

  const fileInputs = (
    <>
      <input
        ref={openInputRef}
        type="file"
        hidden
        accept=".json,.zip,application/json,application/zip"
        aria-label="Open show in viewer"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handleOpenFile(f);
        }}
      />
      <input
        ref={relinkInputRef}
        type="file"
        hidden
        multiple
        accept="audio/*,video/*,image/*"
        aria-label="Relink media files"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (!list.length) return;
          try {
            setRelinkNote(onRelinkMedia(list));
          } catch (err) {
            setRelinkNote(err instanceof Error ? err.message : 'Could not relink media files.');
          }
        }}
      />
    </>
  );

  const relinkDialog = relinkOpen && (
    <DeskDialog title="Relink media (session only)" onClose={() => setRelinkOpen(false)}>
      <p>Files linked here stay in memory for this viewing session only and are never saved to this device.</p>
      {missingMedia.length > 0 ? (
        <p>Missing files: {missingMedia.join(', ')}</p>
      ) : (
        <p>All referenced media files are linked for this session.</p>
      )}
      <div className="file-actions">
        <button type="button" disabled={!missingMedia.length} onClick={() => relinkInputRef.current?.click()}>
          Choose media files…
        </button>
      </div>
      {relinkNote && <p role="status">{relinkNote}</p>}
    </DeskDialog>
  );

  if (cinemaMode) {
    return (
      <>
        {fileInputs}
        {missingMedia.length > 0 && (
          <button
            type="button"
            className="media-relink-alert"
            onClick={() => {
              setRelinkNote('');
              setRelinkOpen(true);
            }}
          >
            {missingMedia.length} missing media {missingMedia.length === 1 ? 'file' : 'files'} · Relink
          </button>
        )}
        {relinkDialog}
        <div className="cinema-tools" role="group" aria-label="Pitch viewer cinema controls">
          <button type="button" className="transport-btn play-btn" onClick={onTogglePlayback}>
            {isPlaying ? <Pause /> : <Play />} {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button type="button" className="transport-btn" onClick={onToggleCinemaMode} title="Show viewer controls (H)">
            <Eye /> Show controls
          </button>
          <button type="button" className="transport-btn" onClick={onExitViewer}>
            <LogOut /> Exit viewer
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {fileInputs}
      {/* Minimal Pitch Viewer Top Bar */}
      <header className="stage-transport pitch-viewer-bar" data-readonly={!capabilities.edit}>
        <div className="transport-brand min-w-0">
          <span className="viewer-badge" aria-label="Read-only viewer">VIEW ONLY</span>
          <div className="min-w-0">
            <h1 className="truncate" title={showName}>{showName}</h1>
            <p>
              {blackout
                ? 'Master blackout'
                : <>{fixtureCount} fixtures <i>·</i> {laserCount} lasers <i>·</i> {fps} fps</>}
            </p>
          </div>
        </div>
        <nav className="transport-tools" aria-label="Pitch viewer actions">
          <button
            type="button"
            className="transport-btn"
            disabled={opening}
            onClick={() => openInputRef.current?.click()}
          >
            <FolderOpen /><span>Open show…</span>
          </button>
          <label className="camera-select" title="Camera view (keys 1–7)">
            <Camera />
            <select
              aria-label="Camera view"
              value={activeCamera}
              onChange={(e) => onSelectCamera(e.target.value as CameraPreset)}
            >
              {CAMERAS.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <ChevronDown />
          </label>
          {displaySettings && <DisplaySettingsPopover {...displaySettings} />}
          <button
            type="button"
            className="transport-btn"
            aria-label="Cinema mode"
            title="Cinema mode (H)"
            onClick={onToggleCinemaMode}
          >
            <EyeOff />
          </button>
          <button
            type="button"
            className="transport-btn viewer-exit-btn"
            onClick={onExitViewer}
          >
            <LogOut /><span>Exit viewer</span>
          </button>
        </nav>
      </header>

      {/* Missing-media relink banner (session-only) */}
      {missingMedia.length > 0 && (
        <button
          type="button"
          className="media-relink-alert"
          onClick={() => {
            setRelinkNote('');
            setRelinkOpen(true);
          }}
        >
          {missingMedia.length} missing media {missingMedia.length === 1 ? 'file' : 'files'} · Relink
        </button>
      )}
      {relinkDialog}

      {/* Minimal Playback & Cue Dock (no edit tabs, no DMX/show-control/rig controls) */}
      <section aria-label="Pitch viewer controls" className="stage-dock pitch-viewer-dock">
        <div className="desk-tabs">
          <div className="flex items-center gap-2 min-w-0 py-1.5">
            <button
              type="button"
              className="transport-btn play-btn"
              onClick={onTogglePlayback}
              aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
            >
              {isPlaying ? <Pause /> : <Play />}
              <span>{take.hasTake ? (take.mode === 'playing' ? 'Pause' : take.canResume ? 'Resume' : 'Play take') : (audio.playing ? 'Pause' : 'Play')}</span>
            </button>
            <button
              type="button"
              className="transport-btn"
              disabled={!cues.length || take.mode === 'playing'}
              onClick={onBack}
              aria-label="Previous cue"
              title="Previous cue (←)"
            >
              <ChevronLeft /><span>Back</span>
            </button>
            <button
              type="button"
              className="transport-btn viewer-go-btn"
              disabled={!cues.length || take.mode === 'playing'}
              onClick={onGo}
              aria-label="Next cue"
              title="Next cue (→)"
            >
              <span>GO</span><ChevronRight />
            </button>
            <span className="font-mono-tech text-[11px] text-zinc-300 truncate min-w-0" role="status">
              Now: <strong className="text-zinc-100">{cueLabel(currentIndex)}</strong>
            </span>
            {follow === 'held' && (
              <span className="cue-countdown text-[10px]">Follow held</span>
            )}
            {typeof follow === 'number' && (
              <button type="button" className="transport-btn" onClick={onHoldFollow}>
                Hold follow
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {take.hasTake && take.durationMs > 0 && (
              <output className="font-mono-tech text-[11px] text-emerald-200 whitespace-nowrap">
                {timecode(take.timeMs)} / {timecode(take.durationMs)}
              </output>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="p-1 rounded bg-white/5 hover:bg-white/10 text-zinc-300 cursor-pointer"
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand viewer controls' : 'Collapse viewer controls'}
              title={collapsed ? 'Expand viewer controls' : 'Collapse viewer controls'}
            >
              {collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {!collapsed && (
          <div className="desk-body space-y-2.5">
            {take.hasTake && take.durationMs > 0 && (
              <div className="space-y-1.5">
                <div className="cue-actions take-actions">
                  {take.mode === 'playing' ? (
                    <>
                      <button type="button" onClick={take.pause}>Pause replay</button>
                      <button type="button" onClick={take.stop}><Square className="inline w-3 h-3 mr-1" />Stop replay</button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={take.play}>Replay take</button>
                      {take.canResume && <button type="button" onClick={take.resume}>Resume take</button>}
                    </>
                  )}
                  <span aria-hidden="true" className="font-mono-tech text-[11px] text-[#b2c8c3]">{timecode(take.timeMs)} / {timecode(take.durationMs)}</span>
                </div>
                <div>
                  <input
                    type="range"
                    aria-label="Take position"
                    min={0}
                    max={scrubMax}
                    step={50}
                    value={scrubValue}
                    aria-valuetext={`${timecode(Math.min(take.timeMs, take.durationMs))} of ${timecode(take.durationMs)}`}
                    onChange={(e) => scrub(e.currentTarget.valueAsNumber)}
                    className="console-slider w-full"
                  />
                  {ticks.length > 0 && (
                    <div role="toolbar" aria-label="Take markers" aria-orientation="horizontal" className="relative h-3.5 mt-1">
                      <span aria-hidden="true" className="absolute left-[5px] right-[5px] top-1/2 h-px bg-white/10" />
                      {ticks.map((tick) => {
                        const merged = tick.count > 1;
                        const mark = tick.kind === 'cue'
                          ? `h-full rounded-full ${merged ? 'w-[3px] bg-cyan-100' : 'w-0.5 bg-cyan-300'}`
                          : `${merged ? 'w-[6px] h-[6px] bg-fuchsia-200' : 'w-[5px] h-[5px] bg-fuchsia-400'} rotate-45 rounded-[1px]`;
                        return (
                          <button
                            key={tick.key}
                            type="button"
                            aria-label={tick.label}
                            title={tick.label}
                            data-kind={tick.kind}
                            data-at-ms={tick.atMs}
                            onClick={() => seekNow(tick.atMs)}
                            className={`group absolute ${tick.kind === 'cue' ? 'top-0 items-start' : 'bottom-0 items-center'} h-[7px] w-2.5 -translate-x-1/2 flex justify-center cursor-pointer before:absolute before:content-[''] before:inset-y-0 before:-inset-x-[5px]`}
                            style={{ left: `calc(5px + (100% - 10px) * ${tick.position})` }}
                          >
                            <span aria-hidden="true" className={`block ${mark} group-hover:bg-white`} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {glances.length > 0 && (
                  <ul aria-label="Screen status" className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-1">
                    {glances.map((g) => {
                      const text = `${g.label}: ${g.name || 'no clip'}, ${GLANCE_LABEL[g.state]}`;
                      return (
                        <li
                          key={g.id}
                          data-screen={g.id}
                          data-state={g.state}
                          aria-label={text}
                          title={text}
                          className="flex items-center gap-1 min-w-0 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 font-mono-tech text-[9px] leading-tight"
                        >
                          <span className="shrink-0 max-w-[45%] truncate text-zinc-400">{g.label}</span>
                          <span className={`min-w-0 flex-1 truncate ${g.state === 'none' ? 'text-zinc-500' : 'text-zinc-100'}`}>{g.name || '—'}</span>
                          <span className={`shrink-0 rounded border px-1 uppercase tracking-wider ${GLANCE_STYLE[g.state]}`}>{GLANCE_LABEL[g.state]}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {cues.length > 0 ? (
              <ol className="cue-list" aria-label="Numbered show cues">
                {cues.map((cue, idx) => {
                  const isActive = activeCueId === cue.id;
                  return (
                    <li key={cue.id}>
                    <button
                      type="button"
                      disabled={take.mode === 'playing'}
                      onClick={() => onTriggerCue(cue)}
                      className="cue-list-row"
                      aria-pressed={isActive}
                      aria-label={`Cue ${idx + 1}, ${cue.name}, fade ${cue.fadeSeconds ?? 0} seconds, ${cue.followSeconds ? `follow ${cue.followSeconds} seconds` : 'manual follow'}`}
                      style={{
                        '--cue-a': cue.state.primaryColor || cue.accent,
                        '--cue-b': cue.state.accentColor || cue.accent,
                      } as React.CSSProperties}
                    >
                      <span className="cue-number">{idx + 1}</span>
                      <strong>{cue.name}</strong>
                      <span className="cue-timing"><span>Fade {cue.fadeSeconds ?? 0}s</span><span aria-label={cue.followSeconds ? `Follow after ${cue.followSeconds} seconds` : 'Manual GO'}>{cue.followSeconds ? `Follow ${cue.followSeconds}s` : 'Manual'}</span></span>
                      <span className="cue-tag">{isActive ? <Check aria-hidden="true" /> : cue.tag}</span>
                    </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-xs text-zinc-400 font-mono-tech">
                No cues in this file. Open a StageForge show or bundle to run cues and playback.
              </p>
            )}
          </div>
        )}
      </section>
    </>
  );
};
