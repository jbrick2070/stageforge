import React, { useEffect, useRef, useState } from 'react';
import {
  AudioLines, Camera, ChevronDown, DollarSign, DraftingCompass, Eye, EyeOff, Layers, Mic, Pause,
  Play, Radio, RotateCcw, SlidersHorizontal, Sparkles, Upload, Wrench, FolderOpen,
} from 'lucide-react';
import { AudioMetrics, CameraPreset, MusicRef } from '../types/show';
import { useLive, type LiveStore } from '../state/liveTelemetry';

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
  openingBar?: number;
  blackout: boolean;
  autoDirector: boolean;
  audioReactive: boolean;
  activeCamera: CameraPreset;
  rigDrawerOpen: boolean;
  dmxDrawerOpen: boolean;
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
  fpsStore, fixtureCount, laserCount, audioStore, getLinkedMusic, getTrackDuration, onSeekTrack, volume, bpm, openingBar, blackout, autoDirector, audioReactive,
  activeCamera, rigDrawerOpen, dmxDrawerOpen, costModalOpen, oneNightCostLabel,
  cinemaMode, onTogglePlay, onStartDemo, onDesignStage, onShowFiles, onUploadAudio, onToggleMic, onVolumeChange, onBpmChange,
  onToggleAutoDirector, onToggleAudioReactive, onSelectCamera, onToggleRigDrawer,
  onToggleDmxDrawer, onToggleCostModal, onToggleCinemaMode,
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
        <button className="transport-btn" aria-label="Cinema mode" title="Cinema mode (H)" onClick={onToggleCinemaMode}><EyeOff /></button>
      </nav>
    </header>
  );
};
