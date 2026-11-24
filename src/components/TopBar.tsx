import React, { useEffect, useRef, useState } from 'react';
import {
  AudioLines, Camera, ChevronDown, Clock, DollarSign, DraftingCompass, Eye, EyeOff, Layers, Mic, Pause,
  Play, Radio, RotateCcw, SlidersHorizontal, Sparkles, Upload, Wrench, FolderOpen,
} from 'lucide-react';
import { AudioMetrics, CameraPreset, MusicRef } from '../types/show';
import { useLive, type LiveStore } from '../state/liveTelemetry';
import type { BeatGridStatus, LiveBpmStatus } from '../audio/tempoEngine';
import type { ClockMode } from '../showControl/clockOwner';

export interface TempoControlProps {
  canHalfTime: boolean;
  canDoubleTime: boolean;
  onTapTempo: () => void;
  onHalfTime: () => void;
  onDoubleTime: () => void;
  beatGridStatus: BeatGridStatus;
  onNudgeGrid: (deltaMs: number) => void;
  onSetDownbeat: () => void;
  liveBpmStatus: LiveBpmStatus;
  followLiveBpm: boolean;
  onToggleFollowLiveBpm: () => void;
}

interface TopBarProps {
  fpsStore: LiveStore<number>;
  fixtureCount: number;
  laserCount: number;
  audioStore: LiveStore<AudioMetrics>;
  getLinkedMusic: () => MusicRef;
  getTrackDuration: () => number;
  onSeekTrack: (seconds: number) => void;
  volume: number;
  bpm: number;
  tempo: TempoControlProps;
  openingBar?: number;
  blackout: boolean;
  autoDirector: boolean;
  audioReactive: boolean;
  activeCamera: CameraPreset;
  rigDrawerOpen: boolean;
  dmxDrawerOpen: boolean;
  showControlOpen: boolean;
  clockMode: ClockMode;
  costModalOpen: boolean;
  oneNightCostLabel: string;
  cinemaMode: boolean;
  onTogglePlay: () => void;
  onStartDemo: () => void;
  onDesignStage: () => void;
  onShowFiles: () => void;
  onUploadAudio: (file: File) => void;
  onToggleMic: () => void;
  onVolumeChange: (v: number) => void;
  onBpmChange: (bpm: number) => void;
  onToggleAutoDirector: () => void;
  onToggleAudioReactive: () => void;
  onSelectCamera: (cam: CameraPreset) => void;
  onToggleRigDrawer: () => void;
  onToggleDmxDrawer: () => void;
  onToggleShowControl: () => void;
  onToggleCostModal: () => void;
  onToggleCinemaMode: () => void;
}

export const CAMERAS: { id: CameraPreset; label: string }[] = [
  { id: 'foh', label: 'Front of house' },
  { id: 'front_row', label: 'Front row' },
  { id: 'wide_arena', label: 'Wide arena' },
  { id: 'stage_side', label: 'Stage side' },
  { id: 'overhead', label: 'Overhead' },
  { id: 'orbit', label: 'Orbit' },
  { id: 'pa_closeup', label: 'PA close-up' },
];

function clockTime(seconds: number) {
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}

export const TopBar: React.FC<TopBarProps> = ({
  fpsStore, fixtureCount, laserCount, audioStore, getLinkedMusic, getTrackDuration, onSeekTrack, volume, bpm, tempo, openingBar, blackout, autoDirector, audioReactive,
  activeCamera, rigDrawerOpen, dmxDrawerOpen, showControlOpen, clockMode, costModalOpen, oneNightCostLabel,
  cinemaMode, onTogglePlay, onStartDemo, onDesignStage, onShowFiles, onUploadAudio, onToggleMic, onVolumeChange, onBpmChange,
  onToggleAutoDirector, onToggleAudioReactive, onSelectCamera, onToggleRigDrawer,
  onToggleDmxDrawer, onToggleShowControl, onToggleCostModal, onToggleCinemaMode,
}) => {
  const fps = useLive(fpsStore);
  const audio = useLive(audioStore);
  const linkedMusic = getLinkedMusic();
  const trackDuration = getTrackDuration();
  const safeTrackDuration = Number.isFinite(trackDuration) && trackDuration > 0 ? trackDuration : 0;
  const fileRef = useRef<HTMLInputElement>(null);
  const audioPanelRef = useRef<HTMLDivElement>(null);
  const audioButtonRef = useRef<HTMLButtonElement>(null);
  const [audioOpen, setAudioOpen] = useState(false);
  useEffect(() => {
    if (!audioOpen) return;
    const closeOutside = (e: PointerEvent) => {
      if (e.target instanceof Node && !audioPanelRef.current?.contains(e.target)) setAudioOpen(false);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAudioOpen(false);
        audioButtonRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [audioOpen]);

  const playLabel = audio.playing ? 'Pause' : audio.demo?.finished ? 'Replay demo' :
    audio.source === 'synth' || (linkedMusic.kind === 'demo' && (linkedMusic.demoStep ?? 0) > 0) ? 'Resume demo' :
    audio.source === 'file' || linkedMusic.kind === 'file' ? 'Play track' : linkedMusic.kind === 'live' ? 'Live input' : 'Play demo';
  const playButton = (
    <button type="button" className="transport-btn play-btn" onClick={onTogglePlay}>
      {audio.playing ? <Pause /> : <Play />} {playLabel}
    </button>
  );

  if (cinemaMode) {
    return (
      <div className="cinema-tools">
        {playButton}
        <button onClick={onToggleCinemaMode} className="transport-btn" title="Show desk (H)">
          <Eye /> Show desk
        </button>
      </div>
    );
  }

  return (
    <header className="stage-transport">
      <div className="transport-brand">
        <Layers aria-hidden="true" />
        <div>
          <h1>Stageforge <span>3D</span></h1>
          <p>{blackout ? 'Master blackout' : openingBar ? `Opening blackout · Bar ${openingBar} of 2` :
            <>{fixtureCount} fixtures <i>·</i> {laserCount} lasers <i>·</i> {fps} fps</>}</p>
        </div>
      </div>
      <div className="transport-playback">
        {playButton}
        <button type="button" className="transport-btn" aria-label="Design stage" title="Design stage" onClick={onDesignStage}>
          <DraftingCompass /><span className="transport-extra-label">Design stage</span>
        </button>
        <button type="button" className="transport-btn" aria-label="Show files" title="Show files" onClick={onShowFiles}>
          <FolderOpen/><span className="transport-extra-label">Files</span>
        </button>
        <div ref={audioPanelRef}>
          <button ref={audioButtonRef} type="button" className="transport-btn" aria-label="Audio settings"
            title="Audio settings" aria-controls="sound-settings" aria-expanded={audioOpen}
            onClick={() => setAudioOpen(!audioOpen)}>
            <SlidersHorizontal /><span className="transport-extra-label">Audio</span>
          </button>
          {audioOpen && (
            <section id="sound-settings" aria-label="Audio settings" className="audio-popover">
              <div className="audio-source">
                <AudioLines /><strong>{audio.source === 'none' ? linkedMusic.kind === 'file' ? linkedMusic.name : 'Demo synth' : audio.trackName}</strong>
                <div className="audio-meter" aria-hidden="true">
                  {Array.from({ length: 12 }, (_, i) => (
                    <i key={i} style={{ height: `${Math.max(2, (audio.spectrum[i * 2] || 0) * 22)}px` }} />
                  ))}
                </div>
              </div>
              <div className="audio-options">
                <button className="transport-btn" onClick={() => fileRef.current?.click()}><Upload /> Load track</button>
                <button className="transport-btn" onClick={onToggleMic} aria-pressed={audio.source === 'mic'}><Mic /> Mic input</button>
              </div>
              {linkedMusic.kind === 'file' && <>
                {safeTrackDuration > 0 && <label className="audio-level"><span>Position</span>
                  <input aria-label="Track position" type="range" min={0} max={safeTrackDuration} step={0.1}
                    value={Math.min(safeTrackDuration, Math.max(0, linkedMusic.offsetSeconds ?? 0))} onChange={e => onSeekTrack(Number(e.target.value))} />
                  <output>{clockTime(linkedMusic.offsetSeconds ?? 0)} / {clockTime(safeTrackDuration)}</output>
                </label>}
                <button className="transport-btn" onClick={() => onSeekTrack(0)}><RotateCcw /> Restart 0:00</button>
              </>}
              {audio.source !== 'none' && <button className="transport-btn" onClick={() => {
                setAudioOpen(false);
                onStartDemo();
                audioButtonRef.current?.focus();
              }}><Play /> {audio.source === 'synth' ? 'Restart demo' : 'Return to demo'}</button>}
              <label className="audio-level"><span>Volume</span><input aria-label="Audio volume" type="range" min={0} max={1} step={0.02} value={volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))} /><output>{Math.round(volume * 100)}%</output></label>
              <div className="audio-tempo">
                <span>Demo tempo</span>
                <button aria-label="Decrease tempo" onClick={() => onBpmChange(bpm - 2)}>−</button>
                <output>{bpm} BPM</output>
                <button aria-label="Increase tempo" onClick={() => onBpmChange(bpm + 2)}>+</button>
              </div>
              <div className="flex items-center gap-1" role="group" aria-label="Tap and scale tempo">
                <button type="button" className="transport-btn flex-1 justify-center" onClick={tempo.onTapTempo} title="Tap tempo (key T)">Tap</button>
                <button
                  type="button"
                  className="transport-btn"
                  aria-label="Half time"
                  aria-disabled={!tempo.canHalfTime}
                  title={tempo.canHalfTime ? 'Halve BPM' : 'Half time would fall below 70 BPM'}
                  onClick={() => { if (tempo.canHalfTime) tempo.onHalfTime(); }}
                >½×</button>
                <button
                  type="button"
                  className="transport-btn"
                  aria-label="Double time"
                  aria-disabled={!tempo.canDoubleTime}
                  title={tempo.canDoubleTime ? 'Double BPM' : 'Double time would exceed 180 BPM'}
                  onClick={() => { if (tempo.canDoubleTime) tempo.onDoubleTime(); }}
                >2×</button>
              </div>
              {tempo.beatGridStatus.state !== 'idle' && (
                <div className="rounded border border-white/10 bg-black/40 p-1.5 space-y-1 text-[10px] font-mono-tech">
                  <div className="flex items-center justify-between text-zinc-300">
                    <span>Beat grid</span>
                    <span className="text-cyan-300">
                      {tempo.beatGridStatus.state === 'analyzing' && 'Analysing…'}
                      {tempo.beatGridStatus.state === 'ready' && `${tempo.beatGridStatus.grid.bpm.toFixed(1)} BPM · ${tempo.beatGridStatus.grid.offsetMs.toFixed(0)} ms`}
                      {tempo.beatGridStatus.state === 'too_long' && 'Too long'}
                      {tempo.beatGridStatus.state === 'unavailable' && 'Unavailable'}
                    </span>
                  </div>
                  {tempo.beatGridStatus.state === 'ready' && (
                    <div className="flex items-center gap-1">
                      <button type="button" className="px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-200 cursor-pointer" onClick={() => tempo.onNudgeGrid(-50)}>−50</button>
                      <button type="button" className="px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-200 cursor-pointer" onClick={() => tempo.onNudgeGrid(-10)}>−10</button>
                      <button type="button" className="px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-200 cursor-pointer" onClick={() => tempo.onNudgeGrid(10)}>+10</button>
                      <button type="button" className="px-1 py-0.5 rounded bg-white/10 hover:bg-white/20 text-zinc-200 cursor-pointer" onClick={() => tempo.onNudgeGrid(50)}>+50</button>
                      <button type="button" className="ml-auto px-1.5 py-0.5 rounded bg-cyan-500/25 border border-cyan-400/50 text-cyan-200 cursor-pointer" onClick={tempo.onSetDownbeat}>Downbeat</button>
                    </div>
                  )}
                </div>
              )}
              <button className="transport-btn" aria-pressed={tempo.followLiveBpm} onClick={tempo.onToggleFollowLiveBpm}>
                <Clock /> Live BPM <strong>
                  {tempo.liveBpmStatus.state === 'unavailable'
                    ? 'N/A'
                    : tempo.followLiveBpm
                      ? (tempo.liveBpmStatus.state === 'locked'
                        ? `${tempo.liveBpmStatus.candidateBpm.toFixed(0)}`
                        : 'On')
                      : 'Off'}
                </strong>
              </button>
              <button className="transport-btn" aria-pressed={audioReactive} onClick={onToggleAudioReactive}>
                <AudioLines /> Beat sync <strong>{audioReactive ? 'On' : 'Off'}</strong>
              </button>
            </section>
          )}
        </div>
        <input ref={fileRef} type="file" accept="audio/*" className="hidden" aria-label="Load audio file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadAudio(f); e.target.value = ''; }} />
        <button className="transport-btn" aria-label="Auto-LD" title="Auto-LD runs show cues automatically"
          aria-pressed={autoDirector} onClick={onToggleAutoDirector}><Sparkles /><span>Auto-LD</span></button>
      </div>
      <nav className="transport-tools" aria-label="View and production tools">
        <label className="camera-select" title="Camera view (keys 1–7)">
          <Camera />
          <select aria-label="Camera view" value={activeCamera} onChange={(e) => onSelectCamera(e.target.value as CameraPreset)}>
            {CAMERAS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <ChevronDown />
        </label>
        <button className="transport-btn" aria-label="Rig builder" aria-expanded={rigDrawerOpen} onClick={onToggleRigDrawer}><Wrench /><span>Rig<span className="tool-name-detail"> builder</span></span></button>
        <button className="transport-btn" aria-label="DMX monitor" aria-expanded={dmxDrawerOpen} onClick={onToggleDmxDrawer}><Radio /><span>DMX</span></button>
        <button className="transport-btn" aria-label="Cost and crew" aria-expanded={costModalOpen} title={`Cost and crew · ${oneNightCostLabel}`} onClick={onToggleCostModal}><DollarSign /><span>Cost<span className="tool-name-detail"> &amp; crew</span></span></button>
        <button className="transport-btn" aria-label="Show control" aria-expanded={showControlOpen} title={`Show control · ${clockMode}`} onClick={onToggleShowControl}><Clock /><span>Sync</span></button>
        <button className="transport-btn" aria-label="Cinema mode" title="Cinema mode (H)" onClick={onToggleCinemaMode}><EyeOff /></button>
      </nav>
    </header>
  );
};
