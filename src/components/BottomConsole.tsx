import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Zap,
  Sparkles,
  Sliders,
  Wind,
  Power,
  Save,
  Tv,
  ArrowDown,
  Flame,
  Upload,
  ShieldAlert,
  ChevronDown,
  ChevronUp,
  Check,
} from 'lucide-react';
import {
  BumpState,
  ColorSplitMode,
  LaserColorMode,
  LaserPattern,
  LedVisualMode,
  MotorMode,
  MovementMode,
  RigConfig,
  ShowCue,
  ShowState,
} from '../types/show';
import { COLOR_PALETTES } from '../data/presets';
import { FOCUS_NUDGE_RANGE, focusMarks } from '../engine/focusAim';
import { timecode } from './ShowFiles';

type ConsoleTab = 'show' | 'dmx' | 'laser' | 'motors_fx';

interface BottomConsoleProps {
  state: ShowState;
  bump: BumpState;
  rig: RigConfig;
  cues: ShowCue[];
  activeCueId: string | null;
  cueModified: boolean;
  onPatchState: (patch: Partial<ShowState>) => void;
  onPatchLaser: (patch: Partial<ShowState['laser']>) => void;
  onPatchMotors: (patch: Partial<ShowState['motors']>) => void;
  onPatchAtmo: (patch: Partial<ShowState['atmo']>) => void;
  onPatchLed: (patch: Partial<ShowState['led']>) => void;
  onSetPodMotor: (podId: string, height: number, tilt: number) => void;
  onTriggerCue: (cue: ShowCue) => void;
  onSaveCue: (cueId: string) => void;
  onUploadScreen: (file: File) => void;
  screenName: string;
  captureVideoPosition: boolean;
  onCaptureVideoPosition: (capture: boolean) => void;
  videoPlaying: boolean;
  onToggleVideo: () => void;
  onEditCues: () => void;
  onGo: () => void;
  onResetCue: () => void;
  onHold: () => void;
  follow: number | 'held' | null;
  take: { mode: 'idle' | 'recording' | 'playing'; timeMs: number; hasTake: boolean; record: () => void; play: () => void; stop: () => void };
  onSetBump: (key: keyof BumpState, active: boolean) => void;
}

const MOVEMENT_MODES: { id: MovementMode; label: string }[] = [
  { id: 'sweep', label: 'Sweep' },
  { id: 'fan', label: 'Fan' },
  { id: 'circle', label: 'Circle' },
  { id: 'figure8', label: 'Fig-8' },
  { id: 'wave', label: 'Wave' },
  { id: 'flyout', label: 'Flyout' },
  { id: 'ballyhoo', label: 'Ballyhoo' },
  { id: 'crowd_scan', label: 'Crowd' },
  { id: 'manual', label: 'Position' },
];

// Free position ranges as rendered by StageEngine (radians at full fader travel).
const FREE_PAN_DEG = Math.round((1.45 * 180) / Math.PI);
const FREE_TILT_DEG = Math.round((1.15 * 180) / Math.PI);

const LASER_PATTERNS: { id: LaserPattern; label: string; desc: string }[] = [
  { id: 'liquid_sky', label: 'Liquid Sky', desc: 'Rolling wave canopy' },
  { id: 'tunnel', label: 'Laser Tunnel', desc: 'Hollow spinning cone' },
  { id: 'fan', label: 'Beam Fan', desc: 'Razor multi-ray fan' },
  { id: 'wave', label: 'Sine Wave', desc: 'Oscillating ribbon' },
  { id: 'matrix', label: 'Matrix Cage', desc: 'Cross-beam grid' },
  { id: 'starburst', label: 'Starburst', desc: 'Prism ray flashes' },
  { id: 'horizon', label: 'Horizon Scan', desc: 'Wide scanner plane' },
  { id: 'dual_cones', label: 'Dual Vortex', desc: 'Counter-spin cones' },
];

const LASER_COLORS: { id: LaserColorMode; label: string }[] = [
  { id: 'cyan_magenta', label: 'Cyan / Mag' },
  { id: 'emerald_gold', label: 'Emerald / Gold' },
  { id: 'crimson_ice', label: 'Crimson / Ice' },
  { id: 'rainbow', label: 'RGB Rainbow' },
  { id: 'dual', label: 'Show Dual' },
  { id: 'primary', label: 'Show Primary' },
];

const MOTOR_MODES: { id: MotorMode; label: string }[] = [
  { id: 'high', label: 'High Roof' },
  { id: 'low', label: 'Low Intimate' },
  { id: 'v_tilt', label: 'V-Chevron' },
  { id: 'wave', label: 'Kinetic Wave' },
  { id: 'breathe', label: 'Breathe' },
  { id: 'drop', label: 'THE DROP' },
  { id: 'manual', label: 'Manual Hoists' },
];

const LED_MODES: { id: LedVisualMode; label: string }[] = [
  { id: 'tunnel', label: 'Tunnel' },
  { id: 'cybergrid', label: 'Cyber Grid' },
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'plasma', label: 'Plasma' },
  { id: 'strobe_bars', label: 'Chevrons' },
  { id: 'mandala', label: 'Mandala' },
  { id: 'tour_text', label: 'Tour Text' },
  { id: 'custom', label: 'Custom Media' },
];

function FollowCountdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="cue-countdown">Follow in {(Math.max(0, deadline - now) / 1000).toFixed(1)} s</span>;
}

export const BottomConsole: React.FC<BottomConsoleProps> = ({
  state,
  bump,
  rig,
  cues,
  activeCueId,
  cueModified,
  onPatchState,
  onPatchLaser,
  onPatchMotors,
  onPatchAtmo,
  onPatchLed,
  onSetPodMotor,
  onTriggerCue,
  onSaveCue,
  captureVideoPosition, onCaptureVideoPosition,
  onUploadScreen, screenName, videoPlaying, onToggleVideo, onEditCues, onGo, onResetCue, onHold, follow, take,
  onSetBump,
}) => {
  const [tab, setTab] = useState<ConsoleTab>('show');
  const marks = useMemo(() => focusMarks(rig), [rig]);
  const focusMark = marks.find((m) => m.id === state.focusMarkId);
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-height: 500px)').matches);
  const [storeMode, setStoreMode] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);

  const handleMediaUpload = onUploadScreen;
  const currentIndex = cues.findIndex(cue => cue.id === activeCueId);
  const nextIndex = currentIndex + 1 < cues.length ? currentIndex + 1 : 0;
  const cueLabel = (index: number) => cues[index] ? `${String(index + 1).padStart(2, '0')} ${cues[index].name}` : '—';

  return (
    <section aria-label="Lighting desk" className="stage-dock">
      {/* Console Tab Header + Persistent Quick Status */}
      <div className="desk-tabs">
        <div className="desk-tabs-scroll">
          <TabBtn active={tab === 'show'} onClick={() => { setTab('show'); setCollapsed(false); }} icon={<Sparkles className="w-3.5 h-3.5" />} label="Show cues" accent="cyan" />
          <TabBtn active={tab === 'dmx'} onClick={() => { setTab('dmx'); setCollapsed(false); }} icon={<Sliders className="w-3.5 h-3.5" />} label="Lighting" accent="purple" />
          <TabBtn active={tab === 'laser'} onClick={() => { setTab('laser'); setCollapsed(false); }} icon={<Zap className="w-3.5 h-3.5" />} label="Lasers" accent="emerald" />
          <TabBtn active={tab === 'motors_fx'} onClick={() => { setTab('motors_fx'); setCollapsed(false); }} icon={<Wind className="w-3.5 h-3.5" />} label="Motors & FX" accent="amber" />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="p-1 rounded bg-white/5 hover:bg-white/10 text-zinc-300 cursor-pointer"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand console' : 'Minimize console'}
            title={collapsed ? 'Expand Console' : 'Minimize Console'}
          >
            {collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main Console Deck Body */}
      {!collapsed && (
        <div className="desk-body grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_234px] gap-3">
          {/* LEFT WORKSPACE: Active Tab */}
          <div className="min-w-0">
            {tab === 'show' && (
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4">
                {/* 8 Cue Executor Pads */}
                <div>
                  <div className="cue-stack" role="group" aria-label="Cue stack">
                    <div className="cue-stack-position" role="status">
                      <span><small>Now</small> <strong>{cueLabel(currentIndex)}</strong>
                        {currentIndex >= 0 && cueModified && <em>Modified</em>}</span>
                      <span><small>Next</small> <strong>{cueLabel(nextIndex)}</strong>
                        {currentIndex >= 0 && nextIndex === 0 && <em>Wrap</em>}</span>
                    </div>
                    {typeof follow === 'number' && <div className="cue-actions cue-follow">
                      <FollowCountdown key={follow} deadline={follow}/>
                      <button onClick={onHold}>Hold follow</button>
                    </div>}
                    {follow === 'held' && <span className="cue-countdown">Follow held · manual GO</span>}
                  </div>
                  <div className="cue-actions">
                    <button className="cue-go" disabled={!cues.length || take.mode === 'playing'} onClick={onGo}>GO</button>
                    <button onClick={onResetCue} disabled={!cues.length || take.mode === 'playing'}>Reset to cue 1</button>
                    <button onClick={onEditCues} disabled={take.mode !== 'idle'}>Edit cue list</button>
                    <button
                      disabled={take.mode === 'playing'}
                      onClick={() => setStoreMode((s) => !s)}
                      className={`px-2 py-0.5 rounded text-[10px] font-mono-tech flex items-center gap-1 border cursor-pointer transition ${
                        storeMode
                          ? 'bg-rose-500/30 border-rose-400 text-rose-200 animate-pulse'
                          : 'bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10'
                      }`}
                      title="Click then choose a pad to store your current lighting, laser & motor look"
                    >
                      <Save className="w-3 h-3" />
                      {storeMode ? 'Choose a cue pad' : 'Store cue'}
                    </button>
                  </div>
                  <div className="cue-actions take-actions">
                    {take.mode === 'idle' ? <>
                      <button onClick={take.record}>{take.hasTake ? 'Record new take' : 'Record take'}</button>
                      <button onClick={take.play} disabled={!take.hasTake}>Replay take</button>
                    </> : <button onClick={take.stop}>{take.mode === 'recording' ? 'Stop recording' : 'Stop replay'}</button>}
                    {(take.mode !== 'idle' || take.hasTake) && <output>{timecode(take.timeMs)}</output>}
                  </div>
                  <div className="cue-bank">
                    {cues.map((cue, idx) => {
                      const isActive = activeCueId === cue.id;
                      return (
                        <button
                          key={cue.id}
                          disabled={take.mode === 'playing'}
                          onClick={() => {
                            if (storeMode) {
                              onSaveCue(cue.id);
                              setStoreMode(false);
                            } else {
                              onTriggerCue(cue);
                            }
                          }}
                          className="cue-pad"
                          aria-pressed={isActive}
                          aria-label={`Cue ${idx + 1}, ${cue.name}`}
                          style={{
                            '--cue-a': cue.state.primaryColor || cue.accent,
                            '--cue-b': cue.state.accentColor || cue.accent,
                          } as React.CSSProperties}
                        >
                          <span className="cue-meta">
                            <span>{String(idx + 1).padStart(2, '0')}</span>
                            {cue.followSeconds && <span aria-label={`Follow after ${cue.followSeconds} seconds`}>↻ {cue.followSeconds}s</span>}
                            {isActive ? <Check aria-hidden="true" /> : <span>{cue.tag}</span>}
                          </span>
                          <strong>{cue.name}</strong>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Color Palettes + Quick Master Sliders */}
                <div className="flex flex-col justify-between gap-2 md:border-l border-white/10 md:pl-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono-tech text-[10px] tracking-widest text-zinc-400">
                        Fixture palette
                      </span>
                      <div className="flex items-center gap-1">
                        {(['solid', 'alternate', 'gradient', 'rainbow'] as ColorSplitMode[]).map((m) => (
                          <button
                            key={m}
                            aria-label={m + ' color split'}
                            title={m}
                            aria-pressed={state.colorSplitMode === m}
                            onClick={() => onPatchState({ colorSplitMode: m })}
                            className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech uppercase cursor-pointer ${
                              state.colorSplitMode === m
                                ? 'bg-cyan-500/30 text-cyan-200 border border-cyan-400/50'
                                : 'bg-white/5 text-zinc-400 hover:text-white'
                            }`}
                          >
                            {{ solid: 'Solid', alternate: 'Alt', gradient: 'Grad', rainbow: 'RGB' }[m]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="palette-bank">
                      {COLOR_PALETTES.map((pal) => (
                        <button
                          key={pal.name}
                          onClick={() =>
                            onPatchState({ primaryColor: pal.primary, accentColor: pal.accent })
                          }
                          className="palette-key"
                          style={{
                            '--cue-a': pal.primary,
                            '--cue-b': pal.accent,
                          } as React.CSSProperties}
                          title={pal.name}
                          aria-label={pal.name}
                          aria-pressed={state.primaryColor === pal.primary && state.accentColor === pal.accent}
                        >
                          <span className="palette-colors" aria-hidden="true" />
                          <span>{pal.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Quick Master Mix Row */}
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    <InlineSlider label="MASTER" value={state.masterDimmer} onChange={(v) => onPatchState({ masterDimmer: v })} color="#00f0ff" />
                    <InlineSlider label="HAZE" value={state.atmo.hazeLevel} onChange={(v) => onPatchAtmo({ hazeLevel: v })} color="#94a3b8" />
                    <InlineSlider label="LASER" value={state.laser.intensity} onChange={(v) => onPatchLaser({ intensity: v, enabled: v > 0.01 })} color="#00ff88" />
                    <InlineSlider label="BLOOM" value={state.bloomStrength / 1.2} display={`${Math.round((state.bloomStrength / 1.2) * 100)}%`} onChange={(v) => onPatchState({ bloomStrength: v * 1.2 })} color="#e879f9" />
                  </div>
                </div>
              </div>
            )}

            {tab === 'dmx' && (
              <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-4">
                {/* Vertical grandMA-style DMX Channel Fader Bank */}
                <div className="flex items-center justify-around bg-black/40 border border-white/10 rounded-lg px-2 py-2 gap-1">
                  <VerticalDmxFader label="MAST" value={state.masterDimmer} onChange={(v) => onPatchState({ masterDimmer: v })} />
                  <VerticalDmxFader label="BEAM" value={state.beamIntensity} onChange={(v) => onPatchState({ beamIntensity: v })} />
                  <VerticalDmxFader label="WASH" value={state.washIntensity} onChange={(v) => onPatchState({ washIntensity: v })} />
                  <VerticalDmxFader label="ZOOM" value={state.beamZoom} onChange={(v) => onPatchState({ beamZoom: v })} />
                  <VerticalDmxFader label="SPEED" value={state.movementSpeed} onChange={(v) => onPatchState({ movementSpeed: v })} />
                  <VerticalDmxFader label="SPREAD" value={state.movementSpread} onChange={(v) => onPatchState({ movementSpread: v })} />
                  <VerticalDmxFader label="STROBE" value={state.strobeRate} onChange={(v) => onPatchState({ strobeRate: v })} />
                  <VerticalDmxFader label="BLIND" value={state.blinderLevel} onChange={(v) => onPatchState({ blinderLevel: v })} />
                </div>

                {/* Movement Choreography + Custom Colors + Prism */}
                <div className="flex flex-col justify-between gap-2">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono-tech text-[10px] tracking-widest text-zinc-400">
                        MOVING HEAD CHOREOGRAPHY
                      </span>
                      <button
                        onClick={() => onPatchState({ goboPrism: !state.goboPrism })}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono-tech border cursor-pointer ${
                          state.goboPrism
                            ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200'
                            : 'bg-white/5 border-white/10 text-zinc-400'
                        }`}
                      >
                        8-FACET PRISM {state.goboPrism ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {MOVEMENT_MODES.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => onPatchState({ movementMode: m.id })}
                          className={`py-1 px-1.5 rounded text-[10px] font-mono-tech border cursor-pointer transition ${
                            state.movementMode === m.id
                              ? 'bg-purple-500/30 border-purple-400 text-purple-100'
                              : 'bg-black/40 border-white/10 text-zinc-400 hover:text-white'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Manual Pan/Tilt OR Custom Dual Color Pickers */}
                  {state.movementMode === 'manual' ? (
                    <div className="flex flex-col gap-1.5 bg-black/40 p-2 rounded-lg border border-white/10">
                      <div role="group" aria-label="Focus point" className="flex items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
                        <span className="shrink-0 font-mono-tech text-[9px] tracking-widest text-zinc-500 mr-0.5">FOCUS</span>
                        {[{ id: null, name: 'Free' }, ...marks].map((m) => {
                          const active = (focusMark?.id ?? null) === m.id;
                          return (
                            <button
                              key={m.id ?? 'free'}
                              aria-pressed={active}
                              title={m.id ? `Converge every moving head on ${m.name}` : 'Raw pan/tilt for the whole rig'}
                              onClick={() => onPatchState({ focusMarkId: m.id, manualPan: 0, manualTilt: m.id ? 0 : 0.2 })}
                              className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono-tech border cursor-pointer truncate max-w-[7.5rem] ${
                                active
                                  ? 'bg-purple-500/30 border-purple-400 text-purple-100'
                                  : 'bg-black/40 border-white/10 text-zinc-400 hover:text-white'
                              }`}
                            >
                              {m.name}
                            </button>
                          );
                        })}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <InlineSlider
                          label={focusMark ? 'OFFSET X' : 'PAN'}
                          value={(state.manualPan + 1) / 2}
                          display={focusMark
                            ? `${(state.manualPan * FOCUS_NUDGE_RANGE).toFixed(1)} m`
                            : `${Math.round(state.manualPan * FREE_PAN_DEG)}°`}
                          onChange={(v) => onPatchState({ manualPan: v * 2 - 1 })}
                          color="#a855f7"
                        />
                        <InlineSlider
                          label={focusMark ? 'OFFSET Z' : 'TILT'}
                          value={(state.manualTilt + 1) / 2}
                          display={focusMark
                            ? `${(state.manualTilt * FOCUS_NUDGE_RANGE).toFixed(1)} m`
                            : `${Math.round(state.manualTilt * FREE_TILT_DEG)}°`}
                          onChange={(v) => onPatchState({ manualTilt: v * 2 - 1 })}
                          color="#a855f7"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between bg-black/40 px-2.5 py-1.5 rounded-lg border border-white/10">
                      <label className="flex items-center gap-2 text-[11px] font-mono-tech text-zinc-300 cursor-pointer">
                        PRIMARY
                        <input
                          type="color"
                          value={state.primaryColor}
                          onChange={(e) => onPatchState({ primaryColor: e.target.value })}
                          className="w-7 h-5 bg-transparent border-0 cursor-pointer"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-[11px] font-mono-tech text-zinc-300 cursor-pointer">
                        ACCENT
                        <input
                          type="color"
                          value={state.accentColor}
                          onChange={(e) => onPatchState({ accentColor: e.target.value })}
                          className="w-7 h-5 bg-transparent border-0 cursor-pointer"
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'laser' && (
              <div className="grid grid-cols-1 md:grid-cols-[1.25fr_1fr] gap-3">
                {/* Laser Visuals Pattern Matrix (QuickShow / Beyond style!) */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-mono-tech text-[10px] tracking-widest text-emerald-400">
                      LASER VISUALS ENGINE
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onPatchLaser({ audienceScan: !state.laser.audienceScan })}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono-tech flex items-center gap-1 border cursor-pointer ${
                          state.laser.audienceScan
                            ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                            : 'bg-white/5 border-white/10 text-zinc-400'
                        }`}
                        title="Allow lasers to dip low into the arena crowd vs overhead canopy"
                      >
                        <ShieldAlert className="w-3 h-3" />
                        CROWD SCAN {state.laser.audienceScan ? 'ON' : 'OFF'}
                      </button>
                      <button
                        onClick={() => onPatchLaser({ enabled: !state.laser.enabled })}
                        className={`px-2.5 py-0.5 rounded text-[10px] font-mono-tech font-bold border cursor-pointer ${
                          state.laser.enabled
                            ? 'bg-emerald-500/30 border-emerald-400 text-emerald-200 shadow-[0_0_10px_rgba(16,185,129,0.35)]'
                            : 'bg-rose-500/20 border-rose-500/40 text-rose-300'
                        }`}
                      >
                        {state.laser.enabled ? 'LASER ARMED' : 'LASER OFF'}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {LASER_PATTERNS.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => onPatchLaser({ pattern: p.id, enabled: true })}
                        className={`p-1.5 rounded-lg border text-left transition cursor-pointer ${
                          state.laser.pattern === p.id && state.laser.enabled
                            ? 'bg-emerald-500/25 border-emerald-400 text-white shadow-[0_0_12px_rgba(16,185,129,0.28)]'
                            : 'bg-black/45 border-white/10 text-zinc-300 hover:border-white/25'
                        }`}
                      >
                        <div className="text-[11px] font-semibold leading-tight">{p.label}</div>
                        <div className="text-[9px] text-zinc-400 truncate mt-0.5">{p.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Laser Scanner Encoders & Color Engine */}
                <div className="flex flex-col justify-between gap-2 md:border-l border-white/10 md:pl-3">
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    <InlineSlider label="POWER" value={state.laser.intensity} onChange={(v) => onPatchLaser({ intensity: v })} color="#10b981" />
                    <InlineSlider
                      label="RAYS"
                      value={(state.laser.beamCount - 4) / 28}
                      display={`${state.laser.beamCount}`}
                      onChange={(v) => onPatchLaser({ beamCount: Math.round(4 + v * 28) })}
                      color="#10b981"
                    />
                    <InlineSlider label="X-SPREAD" value={state.laser.spreadX} onChange={(v) => onPatchLaser({ spreadX: v })} color="#00f0ff" />
                    <InlineSlider label="Y-WAVE" value={state.laser.spreadY} onChange={(v) => onPatchLaser({ spreadY: v })} color="#00f0ff" />
                    <InlineSlider label="SCAN SPD" value={state.laser.speed} onChange={(v) => onPatchLaser({ speed: v })} color="#a855f7" />
                    <InlineSlider label="ROTATE" value={state.laser.rotation} onChange={(v) => onPatchLaser({ rotation: v })} color="#a855f7" />
                    <InlineSlider
                      label="PITCH"
                      value={(state.laser.tilt + 1) / 2}
                      display={`${Math.round(state.laser.tilt * 45)}°`}
                      onChange={(v) => onPatchLaser({ tilt: v * 2 - 1 })}
                      color="#f59e0b"
                    />
                    <InlineSlider label="BLANKING" value={state.laser.strobe} onChange={(v) => onPatchLaser({ strobe: v })} color="#f43f5e" />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {LASER_COLORS.map((cm) => (
                      <button
                        key={cm.id}
                        onClick={() => onPatchLaser({ colorMode: cm.id })}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech border cursor-pointer ${
                          state.laser.colorMode === cm.id
                            ? 'bg-emerald-500/30 border-emerald-400 text-emerald-100'
                            : 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {cm.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {tab === 'motors_fx' && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Kinetic Chain Hoist Motors */}
                <div className="bg-black/40 border border-white/10 rounded-lg p-2">
                  <div className="font-mono-tech text-[10px] tracking-widest text-amber-400 mb-1.5">
                    KINETIC CHAIN MOTORS
                  </div>
                  <div className="grid grid-cols-2 gap-1 mb-2">
                    {MOTOR_MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => onPatchMotors({ mode: m.id })}
                        className={`py-1 px-1.5 rounded text-[10px] font-mono-tech border cursor-pointer ${
                          state.motors.mode === m.id
                            ? 'bg-amber-500/30 border-amber-400 text-amber-100'
                            : 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {state.motors.mode === 'manual' ? (
                    <div className="space-y-1 max-h-20 overflow-y-auto pr-1">
                      {rig.trussPods.filter((p) => p.motorized).map((pod) => {
                        const target = state.motors.podTargets[pod.id] || { height: 0.65, tilt: 0 };
                        return (
                          <InlineSlider
                            key={pod.id}
                            label={pod.name.slice(0, 10)}
                            value={target.height}
                            onChange={(v) => onSetPodMotor(pod.id, v, target.tilt)}
                            color="#f59e0b"
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <InlineSlider label="HOIST SPD" value={state.motors.speed} onChange={(v) => onPatchMotors({ speed: v })} color="#f59e0b" />
                  )}
                </div>

                {/* Smoke, Haze & CO2 Atmospherics */}
                <div className="bg-black/40 border border-white/10 rounded-lg p-2 flex flex-col justify-between">
                  <div>
                    <div className="font-mono-tech text-[10px] tracking-widest text-sky-400 mb-1.5">
                      SMOKE, HAZE & CO2 CRYO
                    </div>
                    <div className="space-y-2">
                      <InlineSlider label="ARENA HAZE" value={state.atmo.hazeLevel} onChange={(v) => onPatchAtmo({ hazeLevel: v })} color="#38bdf8" />
                      <InlineSlider label="SMOKE JETS" value={state.atmo.smokeOutput} onChange={(v) => onPatchAtmo({ smokeOutput: v })} color="#94a3b8" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 mt-2">
                    <button
                      onClick={() => onPatchAtmo({ co2Active: !state.atmo.co2Active })}
                      className={`py-1.5 rounded text-[10px] font-mono-tech font-bold border cursor-pointer ${
                        state.atmo.co2Active
                          ? 'bg-sky-500/35 border-sky-300 text-white shadow-[0_0_12px_rgba(56,189,248,0.4)]'
                          : 'bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10'
                      }`}
                    >
                      CO2 LATCH {state.atmo.co2Active ? 'ON' : 'OFF'}
                    </button>
                    <button
                      onClick={() => onPatchAtmo({ co2AutoOnDrop: !state.atmo.co2AutoOnDrop })}
                      className={`py-1.5 rounded text-[10px] font-mono-tech border cursor-pointer ${
                        state.atmo.co2AutoOnDrop
                          ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200'
                          : 'bg-white/5 border-white/10 text-zinc-400'
                      }`}
                    >
                      DROP CO2 {state.atmo.co2AutoOnDrop ? 'AUTO' : 'OFF'}
                    </button>
                  </div>
                </div>

                {/* Giant LED Video Wall Controller */}
                <div className="bg-black/40 border border-white/10 rounded-lg p-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-mono-tech text-[10px] tracking-widest text-fuchsia-400 flex items-center gap-1">
                        <Tv className="w-3 h-3" /> LED VIDEO WALL
                      </span>
                      <button
                        onClick={() => onPatchLed({ enabled: !state.led.enabled })}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech border cursor-pointer ${
                          state.led.enabled
                            ? 'bg-fuchsia-500/30 border-fuchsia-400 text-fuchsia-100'
                            : 'bg-white/5 border-white/10 text-zinc-400'
                        }`}
                      >
                        {state.led.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div className="grid grid-cols-4 gap-1 mb-1.5">
                      {LED_MODES.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => onPatchLed({ visualMode: m.id, enabled: true })}
                          className={`py-1 px-1 rounded text-[9px] font-mono-tech border truncate cursor-pointer ${
                            state.led.visualMode === m.id
                              ? 'bg-fuchsia-500/30 border-fuchsia-400 text-white'
                              : 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
                          }`}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {state.led.visualMode === 'tour_text' && (
                      <input
                        type="text"
                        value={state.led.tourText}
                        onChange={(e) => onPatchLed({ tourText: e.target.value })}
                        placeholder="ARTIST // TOUR NAME"
                        className="w-full px-2 py-1 rounded bg-black/70 border border-white/15 text-[11px] font-mono-tech text-white focus:border-fuchsia-400 outline-none"
                      />
                    )}
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <InlineSlider label="BRIGHT" value={state.led.brightness} onChange={(v) => onPatchLed({ brightness: v })} color="#e879f9" />
                      </div>
                      {screenName && <span className="max-w-28 truncate text-xs" title={screenName}>{screenName}</span>}
                      {state.led.customMediaType === 'video' && <button className="transport-btn" onClick={onToggleVideo}>
                        {videoPlaying ? 'Pause video' : 'Play video'}
                      </button>}
                      <input
                        aria-label="Load screen media"
                        ref={mediaInputRef}
                        type="file"
                        accept="image/*,video/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleMediaUpload(f);
                          e.target.value = '';
                        }}
                      />
                      <button
                        onClick={() => mediaInputRef.current?.click()}
                        className="px-2 py-1 rounded bg-fuchsia-500/20 hover:bg-fuchsia-500/30 border border-fuchsia-400/50 text-[10px] font-mono-tech text-fuchsia-200 flex items-center gap-1 shrink-0 cursor-pointer"
                        title="Upload custom video or image onto the concert LED wall"
                      >
                        <Upload className="w-3 h-3" /> MEDIA
                      </button>
                    </div>
                    {state.led.customMediaType === 'video' && <label className="capture-video-position">
                      <input type="checkbox" checked={captureVideoPosition} onChange={e => onCaptureVideoPosition(e.target.checked)} />
                      Store cues at current video position
                    </label>}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT WORKSPACE: Always-Live Momentary Flash / Bump Bank */}
          <div className="bump-bank border-t lg:border-t-0 lg:border-l border-white/10 pt-2 lg:pt-0 lg:pl-2.5 flex flex-col justify-between gap-1.5">
            <button
              onClick={() => onPatchState({ blackout: !state.blackout })}
              className={`w-full py-2 rounded-lg font-mono-tech font-bold text-xs tracking-wider border flex items-center justify-center gap-2 transition cursor-pointer ${
                state.blackout
                  ? 'bg-rose-600 text-white border-rose-300 shadow-[0_0_20px_rgba(244,63,94,0.65)] animate-pulse'
                  : 'bg-rose-950/50 text-rose-300 border-rose-500/40 hover:bg-rose-900/60'
              }`}
            >
              <Power className="w-4 h-4" />
              {state.blackout ? 'BLACKOUT ACTIVE [SPACE]' : 'BLACKOUT [SPACE]'}
            </button>

            <div className="grid grid-cols-2 gap-1.5 flex-1">
              <BumpButton
                label="BLINDERS"
                hotkey="B"
                active={bump.blinder}
                accent="amber"
                icon={<Flame className="w-3.5 h-3.5" />}
                onDown={() => onSetBump('blinder', true)}
                onUp={() => onSetBump('blinder', false)}
              />
              <BumpButton
                label="STROBE"
                hotkey="S"
                active={bump.strobe}
                accent="white"
                icon={<Zap className="w-3.5 h-3.5" />}
                onDown={() => onSetBump('strobe', true)}
                onUp={() => onSetBump('strobe', false)}
              />
              <BumpButton
                label="CO2 CRYO"
                hotkey="C"
                active={bump.co2}
                accent="sky"
                icon={<Wind className="w-3.5 h-3.5" />}
                onDown={() => onSetBump('co2', true)}
                onUp={() => onSetBump('co2', false)}
              />
              <BumpButton
                label="SMOKE"
                hotkey="F"
                active={bump.smoke}
                accent="slate"
                icon={<Wind className="w-3.5 h-3.5" />}
                onDown={() => onSetBump('smoke', true)}
                onUp={() => onSetBump('smoke', false)}
              />
              <BumpButton
                label="LASER HIT"
                hotkey="L"
                active={bump.laser}
                accent="emerald"
                icon={<Sparkles className="w-3.5 h-3.5" />}
                onDown={() => onSetBump('laser', true)}
                onUp={() => onSetBump('laser', false)}
              />
              <BumpButton
                label="RIG DROP"
                hotkey="D"
                active={bump.motorDrop}
                accent="fuchsia"
                icon={<ArrowDown className="w-3.5 h-3.5" />}
                onDown={() => onSetBump('motorDrop', true)}
                onUp={() => onSetBump('motorDrop', false)}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

const TabBtn: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  accent: 'cyan' | 'purple' | 'emerald' | 'amber';
}> = ({ active, onClick, icon, label, accent }) => {
  const styles = {
    cyan: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/60',
    purple: 'bg-purple-500/20 text-purple-200 border-purple-400/60',
    emerald: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/60',
    amber: 'bg-amber-500/20 text-amber-200 border-amber-400/60',
  }[accent];

  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`desk-tab px-2.5 py-1 rounded-md text-[11px] font-mono-tech font-semibold flex items-center gap-1.5 border transition cursor-pointer ${
        active ? styles : 'bg-transparent border-transparent text-zinc-400 hover:text-white hover:bg-white/5'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

const InlineSlider: React.FC<{
  label: string;
  value: number;
  display?: string;
  color: string;
  onChange: (v: number) => void;
}> = ({ label, value, display, color, onChange }) => (
  <div className="flex flex-col gap-0.5">
    <div className="flex justify-between items-center font-mono-tech text-[9px]">
      <span className="text-zinc-400 uppercase">{label}</span>
      <span style={{ color }}>{display ?? `${Math.round(value * 100)}%`}</span>
    </div>
    <input
      type="range"
      aria-label={label}
      aria-valuetext={display ?? `${Math.round(value * 100)} percent`}
      min={0}
      max={1}
      step={0.01}
      value={Math.max(0, Math.min(1, value))}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="console-slider w-full"
    />
  </div>
);

const VerticalDmxFader: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex flex-col items-center gap-1">
    <span className="font-mono-tech text-[9px] text-cyan-300">{Math.round(value * 255)}</span>
    <input
      type="range"
      min={0}
      max={1}
      step={0.01}
      aria-label={label}
      aria-valuetext={String(Math.round(value * 255))}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="vertical-fader"
    />
    <span className="font-mono-tech text-[9px] font-bold text-zinc-200 leading-none">{label}</span>
  </div>
);

const BumpButton: React.FC<{
  label: string;
  hotkey: string;
  active: boolean;
  accent: 'amber' | 'white' | 'sky' | 'slate' | 'emerald' | 'fuchsia';
  icon: React.ReactNode;
  onDown: () => void;
  onUp: () => void;
}> = ({ label, hotkey, active, accent, icon, onDown, onUp }) => {
  const activeMap = {
    amber: 'bg-amber-400 text-black border-amber-200 shadow-[0_0_18px_rgba(251,191,36,0.7)]',
    white: 'bg-white text-black border-white shadow-[0_0_20px_rgba(255,255,255,0.85)]',
    sky: 'bg-sky-400 text-black border-sky-200 shadow-[0_0_18px_rgba(56,189,248,0.75)]',
    slate: 'bg-slate-300 text-black border-white shadow-[0_0_14px_rgba(203,213,225,0.6)]',
    emerald: 'bg-emerald-400 text-black border-emerald-200 shadow-[0_0_18px_rgba(16,185,129,0.75)]',
    fuchsia: 'bg-fuchsia-400 text-black border-fuchsia-200 shadow-[0_0_18px_rgba(232,121,249,0.75)]',
  }[accent];

  return (
    <button
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) onDown();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onUp();
        }
      }}
      onBlur={() => { if (active) onUp(); }}
      aria-pressed={active}
      className={`bump-btn rounded-lg border px-2 py-1.5 font-mono-tech text-[10px] font-bold flex items-center justify-between transition cursor-pointer ${
        active
          ? activeMap
          : 'bg-black/50 border-white/15 text-zinc-200 hover:bg-white/10 hover:border-white/30'
      }`}
    >
      <span className="flex items-center gap-1">
        {icon}
        {label}
      </span>
      <span className="opacity-65 text-[9px]">[{hotkey}]</span>
    </button>
  );
};
