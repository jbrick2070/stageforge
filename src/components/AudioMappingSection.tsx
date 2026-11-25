import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Mic, Plus, ShieldAlert, Trash2, Upload } from 'lucide-react';
import type {
  AudioMapConfig,
  AudioMapping,
  AudioMappingCurve,
  AudioMappingSource,
  AudioMetrics,
  AudioTargetGroup,
  AudioTargetParam,
  RigConfig,
} from '../types/show';
import type { LiveStore } from '../state/liveTelemetry';
import {
  allowsNegativeAmount,
  AUDIO_CURVES,
  AUDIO_MAPPING_PRESETS,
  AUDIO_SOURCES,
  AUDIO_TARGET_GROUPS,
  AUDIO_TARGET_PARAMS,
  HAZE_MIN_ATTACK_MS,
  HAZE_MIN_RELEASE_MS,
  MAX_AUDIO_MAPPINGS,
} from '../engine/audioModulation';
import { laserProjectors } from '../data/laserProjectors';

export interface AudioModulationTelemetry {
  active: boolean;
  flashLimited: boolean;
  entries: Array<{
    id: string;
    name: string;
    enabled: boolean;
    group: AudioTargetGroup;
    param: AudioTargetParam;
    projectorKey?: string;
    raw: number;
    envelope: number;
    modulatedValue: number;
  }>;
}

export const EMPTY_AUDIO_MOD_TELEMETRY: AudioModulationTelemetry = {
  active: false,
  flashLimited: false,
  entries: [],
};

interface AudioMappingSectionProps {
  rig: RigConfig;
  audioReactive: boolean;
  audioMap?: AudioMapConfig;
  audioStore: LiveStore<AudioMetrics>;
  audioModStore: LiveStore<AudioModulationTelemetry>;
  onToggleAudioReactive: () => void;
  onChangeAudioMap: (next?: AudioMapConfig) => void;
  onUploadAudio: (file: File) => void;
  onToggleMic: () => void;
}

const SOURCE_LABELS: Record<AudioMappingSource, string> = {
  bass: 'Bass',
  mid: 'Mid',
  high: 'High',
  energy: 'Energy',
  beat: 'Beat',
  drop: 'Drop',
  band: 'FFT Band',
};

const GROUP_LABELS: Record<AudioTargetGroup, string> = {
  beam: 'Beams',
  wash: 'Washes',
  blinder: 'Blinders',
  strobe: 'Strobes',
  ledWall: 'LED Wall',
  laser: 'Lasers',
  haze: 'Haze',
};

const PARAM_LABELS: Record<AudioTargetParam, string> = {
  dimmer: 'Dimmer',
  zoom: 'Zoom',
  colorMix: 'Color mix',
  strobe: 'Strobe',
  speed: 'Speed',
  tilt: 'Tilt',
  brightness: 'Brightness',
  intensity: 'Intensity',
  rotation: 'Rotation',
  spread: 'Spread',
};

function uniqueMappingId(existing: readonly AudioMapping[], prefix = 'map'): string {
  const taken = new Set(existing.map((m) => m.id));
  if (!taken.has(prefix) && /^[A-Za-z0-9_-]{1,32}$/.test(prefix)) return prefix;
  for (let i = 1; i <= 999; i++) {
    const candidate = `${prefix.slice(0, 26)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `map-${Date.now().toString(36).slice(-8)}`;
}

/** Isolated header leaf that re-renders only when audio source or trackName changes (never on FFT frames). */
const AudioSourceControls: React.FC<{
  audioStore: LiveStore<AudioMetrics>;
  onToggleMic: () => void;
}> = React.memo(({ audioStore, onToggleMic }) => {
  const [meta, setMeta] = useState(() => {
    const cur = audioStore.get();
    return { source: cur.source, trackName: cur.trackName };
  });
  useEffect(() => audioStore.subscribe(() => {
    const cur = audioStore.get();
    setMeta((prev) =>
      prev.source === cur.source && prev.trackName === cur.trackName
        ? prev
        : { source: cur.source, trackName: cur.trackName },
    );
  }), [audioStore]);

  return (
    <>
      <button
        type="button"
        aria-pressed={meta.source === 'mic'}
        onClick={onToggleMic}
        className={`px-1.5 py-0.5 rounded border flex items-center gap-1 cursor-pointer ${
          meta.source === 'mic'
            ? 'bg-emerald-500/25 border-emerald-400/60 text-emerald-200'
            : 'bg-white/5 border-white/10 text-zinc-300 hover:text-white'
        }`}
        title="Toggle live microphone / line-in FFT analysis"
      >
        <Mic className="w-3 h-3" aria-hidden="true" />
        <span>Mic</span>
      </button>
      <span className="text-[9px] text-zinc-400 truncate max-w-[10rem]" title={meta.trackName}>
        {meta.source === 'none' ? 'No source' : meta.trackName}
      </span>
    </>
  );
});

/** Isolated flash-limiter notice: persistent live region so screen readers always announce state transitions. */
const FlashLimiterNotice: React.FC<{
  audioModStore: LiveStore<AudioModulationTelemetry>;
}> = React.memo(({ audioModStore }) => {
  const [limited, setLimited] = useState(() => audioModStore.get().flashLimited);
  useEffect(() => audioModStore.subscribe(() => {
    const next = audioModStore.get().flashLimited;
    setLimited((prev) => (prev === next ? prev : next));
  }), [audioModStore]);

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="flash-limiter-notice"
      className={
        limited
          ? 'ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-400/60 text-amber-200 text-[9px]'
          : 'sr-only'
      }
    >
      {limited ? (
        <>
          <ShieldAlert className="w-3 h-3" aria-hidden="true" />
          Flash limiter active (≤ 3/s)
        </>
      ) : null}
    </span>
  );
});

/** Imperative ref-driven 32-band FFT meter: updates bar scaleY with zero React reconciliation at 20 Hz. */
const FftBandPicker: React.FC<{
  audioStore: LiveStore<AudioMetrics>;
  selectedRange: [number, number];
  onPickRange: (lo: number, hi: number) => void;
}> = React.memo(({ audioStore, selectedRange, onPickRange }) => {
  const meterRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<Array<HTMLSpanElement | null>>(new Array(32).fill(null));
  const dragAnchorRef = useRef<number | null>(null);

  useEffect(() => {
    const paint = () => {
      const spec = audioStore.get().spectrum;
      for (let b = 0; b < 32; b++) {
        const el = barRefs.current[b];
        if (!el) continue;
        const level = spec[b] ?? 0;
        const scale = Math.max(0.06, Math.min(1, level));
        el.style.transform = `scaleY(${scale.toFixed(3)})`;
      }
    };
    paint();
    return audioStore.subscribe(paint);
  }, [audioStore]);

  const bandFromPointer = (clientX: number): number => {
    const el = meterRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const norm = Math.max(0, Math.min(0.9999, (clientX - rect.left) / rect.width));
    return Math.floor(norm * 32);
  };

  return (
    <div
      ref={meterRef}
      role="group"
      aria-label="32-band FFT spectrum selector"
      data-testid="audio-fft-meter"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const band = bandFromPointer(e.clientX);
        dragAnchorRef.current = band;
        onPickRange(band, band);
      }}
      onPointerMove={(e) => {
        if (dragAnchorRef.current === null) return;
        const band = bandFromPointer(e.clientX);
        onPickRange(dragAnchorRef.current, band);
      }}
      onPointerUp={() => { dragAnchorRef.current = null; }}
      onPointerCancel={() => { dragAnchorRef.current = null; }}
      className="grid grid-cols-[repeat(32,minmax(0,1fr))] gap-0.5 h-10 items-end select-none touch-none cursor-crosshair px-0.5 py-0.5 rounded bg-black/60 border border-white/5"
    >
      {Array.from({ length: 32 }, (_, b) => {
        const inRange = b >= selectedRange[0] && b <= selectedRange[1];
        return (
          <div
            key={b}
            data-band={b}
            data-selected={inRange}
            className={`h-full flex items-end rounded-[1px] ${inRange ? 'bg-cyan-500/20' : ''}`}
            title={`Band ${b}`}
          >
            <span
              ref={(node) => { barRefs.current[b] = node; }}
              className={`w-full h-full origin-bottom rounded-t-[1px] ${
                inRange ? 'bg-cyan-300' : 'bg-zinc-500/75'
              }`}
              style={{ transform: 'scaleY(0.06)' }}
            />
          </div>
        );
      })}
    </div>
  );
});

/** Imperative ref-driven per-mapping live meter: zero React re-renders of the row at 20 Hz. */
const MappingLiveMeter: React.FC<{
  mappingId: string;
  name: string;
  audioModStore: LiveStore<AudioModulationTelemetry>;
}> = React.memo(({ mappingId, name, audioModStore }) => {
  const meterRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      const snap = audioModStore.get();
      const entry = snap.entries.find((e) => e.id === mappingId);
      const env = entry ? Math.max(0, Math.min(1, entry.envelope)) : 0;
      const pct = Math.round(env * 100);
      if (fillRef.current) fillRef.current.style.transform = `scaleX(${env.toFixed(3)})`;
      if (meterRef.current) meterRef.current.setAttribute('aria-valuenow', String(pct));
    };
    sync();
    return audioModStore.subscribe(sync);
  }, [audioModStore, mappingId]);

  return (
    <div
      ref={meterRef}
      role="meter"
      aria-label={`Live level for ${name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      className="ml-auto w-14 h-2 rounded bg-white/10 overflow-hidden"
    >
      <div
        ref={fillRef}
        className="w-full h-full origin-left bg-cyan-400"
        style={{ transform: 'scaleX(0)' }}
      />
    </div>
  );
});

export const AudioMappingSection: React.FC<AudioMappingSectionProps> = ({
  rig,
  audioReactive,
  audioMap,
  audioStore,
  audioModStore,
  onToggleAudioReactive,
  onChangeAudioMap,
  onUploadAudio,
  onToggleMic,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [selectedBandRange, setSelectedBandRange] = useState<[number, number]>([8, 14]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mappings = audioMap?.mappings ?? [];
  const projectors = useMemo(() => laserProjectors(rig), [rig]);
  const activeCount = mappings.filter((m) => m.enabled).length;

  const commitMappings = (next: AudioMapping[]) => {
    if (next.length === 0) onChangeAudioMap(undefined);
    else onChangeAudioMap({ mappings: next.slice(0, MAX_AUDIO_MAPPINGS) });
  };

  const applyBandRange = (lo: number, hi: number) => {
    const clampedLo = Math.max(0, Math.min(31, Math.round(Math.min(lo, hi))));
    const clampedHi = Math.max(clampedLo, Math.min(31, Math.round(Math.max(lo, hi))));
    setSelectedBandRange([clampedLo, clampedHi]);
  };

  const addPreset = (preset: AudioMapping) => {
    if (mappings.length >= MAX_AUDIO_MAPPINGS) return;
    const id = uniqueMappingId(mappings, preset.id);
    const copy: AudioMapping = {
      ...preset,
      id,
      ...(preset.bands ? { bands: [preset.bands[0], preset.bands[1]] } : {}),
      target: { ...preset.target },
    };
    commitMappings([...mappings, copy]);
  };

  const addBandMapping = () => {
    if (mappings.length >= MAX_AUDIO_MAPPINGS) return;
    const [lo, hi] = selectedBandRange;
    const id = uniqueMappingId(mappings, `band-${lo}-${hi}`);
    const next: AudioMapping = {
      id,
      name: `Band ${lo}–${hi} → laser rotation`,
      enabled: true,
      source: 'band',
      bands: [lo, hi],
      target: { group: 'laser', param: 'rotation' },
      amount: 0.85,
      attackMs: 25,
      releaseMs: 180,
      threshold: 0.1,
      curve: 'linear',
    };
    commitMappings([...mappings, next]);
  };

  const updateMapping = (id: string, updater: (m: AudioMapping) => AudioMapping) => {
    commitMappings(mappings.map((m) => (m.id === id ? updater(m) : m)));
  };

  const removeMapping = (id: string) => {
    commitMappings(mappings.filter((m) => m.id !== id));
  };

  const changeGroup = (m: AudioMapping, nextGroup: AudioTargetGroup): AudioMapping => {
    const validParams = AUDIO_TARGET_PARAMS[nextGroup];
    const nextParam = validParams.includes(m.target.param) ? m.target.param : validParams[0];
    const nextAmount = allowsNegativeAmount(nextGroup, nextParam) ? m.amount : Math.max(0, m.amount);
    const nextAttack = nextGroup === 'haze' ? Math.max(HAZE_MIN_ATTACK_MS, m.attackMs) : m.attackMs;
    const nextRelease = nextGroup === 'haze' ? Math.max(HAZE_MIN_RELEASE_MS, m.releaseMs) : m.releaseMs;
    return {
      ...m,
      amount: nextAmount,
      attackMs: nextAttack,
      releaseMs: nextRelease,
      target: { group: nextGroup, param: nextParam },
    };
  };

  const changeParam = (m: AudioMapping, nextParam: AudioTargetParam): AudioMapping => {
    const nextAmount = allowsNegativeAmount(m.target.group, nextParam) ? m.amount : Math.max(0, m.amount);
    return {
      ...m,
      amount: nextAmount,
      target: { ...m.target, param: nextParam },
    };
  };

  const changeSource = (m: AudioMapping, nextSource: AudioMappingSource): AudioMapping => {
    if (nextSource === 'band') {
      const bands: [number, number] = m.bands ? [m.bands[0], m.bands[1]] : [selectedBandRange[0], selectedBandRange[1]];
      return { ...m, source: 'band', bands };
    }
    const copy: AudioMapping = { ...m, source: nextSource };
    delete copy.bands;
    return copy;
  };

  return (
    <section aria-label="Audio reactive mappings" className="mt-2 pt-2 border-t border-white/10">
      <div className="flex flex-wrap items-center gap-1.5 font-mono-tech text-[10px]">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="audio-mappings-body"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/15 text-cyan-200 cursor-pointer"
        >
          <AudioLines className="w-3 h-3" aria-hidden="true" />
          <span>Audio</span>
          <span className="text-zinc-400">
            ({activeCount}/{mappings.length})
          </span>
        </button>

        <button
          type="button"
          data-testid="audio-beat-sync-toggle"
          aria-pressed={audioReactive}
          onClick={onToggleAudioReactive}
          className={`px-1.5 py-0.5 rounded border cursor-pointer ${
            audioReactive
              ? 'bg-cyan-500/25 border-cyan-400/60 text-cyan-100'
              : 'bg-white/5 border-white/10 text-zinc-400 hover:text-white'
          }`}
        >
          Beat sync: {audioReactive ? 'On' : 'Off'}
        </button>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-zinc-200 flex items-center gap-1 cursor-pointer"
          title="Load audio track for FFT analysis"
        >
          <Upload className="w-3 h-3" aria-hidden="true" />
          <span>Track</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          aria-label="Load track for audio mappings"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadAudio(f);
            e.target.value = '';
          }}
        />

        <AudioSourceControls audioStore={audioStore} onToggleMic={onToggleMic} />
        <FlashLimiterNotice audioModStore={audioModStore} />
      </div>

      {expanded && (
        <div id="audio-mappings-body" className="mt-2 space-y-2">
          {/* Live 32-band FFT meter with pointer drag + keyboard range controls */}
          <div className="rounded-lg border border-white/10 bg-black/50 p-2 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono-tech text-[9px] text-zinc-300">
              <span>
                32-band FFT · Drag to pick band range ({selectedBandRange[0]}–{selectedBandRange[1]})
              </span>
              <div className="flex items-center gap-1.5">
                <label className="flex items-center gap-1">
                  <span>Lo</span>
                  <input
                    type="number"
                    aria-label="FFT start band"
                    min={0}
                    max={31}
                    value={selectedBandRange[0]}
                    onChange={(e) => applyBandRange(Number(e.target.value), selectedBandRange[1])}
                    className="w-11 px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-100"
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span>Hi</span>
                  <input
                    type="number"
                    aria-label="FFT end band"
                    min={0}
                    max={31}
                    value={selectedBandRange[1]}
                    onChange={(e) => applyBandRange(selectedBandRange[0], Number(e.target.value))}
                    className="w-11 px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-100"
                  />
                </label>
                <button
                  type="button"
                  disabled={mappings.length >= MAX_AUDIO_MAPPINGS}
                  onClick={addBandMapping}
                  className="px-1.5 py-0.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-100 disabled:opacity-40 cursor-pointer flex items-center gap-0.5"
                >
                  <Plus className="w-3 h-3" aria-hidden="true" />
                  <span>Add band {selectedBandRange[0]}–{selectedBandRange[1]}</span>
                </button>
              </div>
            </div>

            <FftBandPicker
              audioStore={audioStore}
              selectedRange={selectedBandRange}
              onPickRange={applyBandRange}
            />
          </div>

          {/* Preset quick-add buttons */}
          <div className="flex flex-wrap items-center gap-1 font-mono-tech text-[9px]" role="group" aria-label="Audio mapping presets">
            <span className="text-zinc-400 mr-0.5">Presets:</span>
            {AUDIO_MAPPING_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={mappings.length >= MAX_AUDIO_MAPPINGS}
                onClick={() => addPreset(preset)}
                className="px-1.5 py-0.5 rounded bg-white/5 hover:bg-cyan-500/20 border border-white/15 text-zinc-200 disabled:opacity-40 cursor-pointer"
              >
                + {preset.name}
              </button>
            ))}
            <span className="ml-auto text-zinc-500">
              {mappings.length}/{MAX_AUDIO_MAPPINGS} · Stored in look/cues
            </span>
          </div>

          {/* Mapping rows (never re-rendered on 20 Hz audio frames) */}
          {mappings.length === 0 ? (
            <p className="font-mono-tech text-[10px] text-zinc-500">
              No audio mappings active. Choose a preset above or drag the FFT meter to add one.
            </p>
          ) : (
            <ul aria-label="Active audio mappings" className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {mappings.map((m) => {
                const validParams = AUDIO_TARGET_PARAMS[m.target.group];
                const canNeg = allowsNegativeAmount(m.target.group, m.target.param);
                const minAtk = m.target.group === 'haze' ? HAZE_MIN_ATTACK_MS : 0;
                const minRel = m.target.group === 'haze' ? HAZE_MIN_RELEASE_MS : 0;
                return (
                  <li
                    key={m.id}
                    data-mapping-id={m.id}
                    className="rounded-lg border border-white/10 bg-black/45 p-1.5 space-y-1 font-mono-tech text-[9px]"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Enable ${m.name}`}
                        checked={m.enabled}
                        onChange={(e) => updateMapping(m.id, (cur) => ({ ...cur, enabled: e.target.checked }))}
                        className="accent-cyan-400 cursor-pointer"
                      />
                      <span className="font-semibold text-zinc-100 truncate max-w-[11rem]" title={m.name}>
                        {m.name}
                      </span>

                      <select
                        aria-label={`Source for ${m.name}`}
                        value={m.source}
                        onChange={(e) => updateMapping(m.id, (cur) => changeSource(cur, e.target.value as AudioMappingSource))}
                        className="px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-200"
                      >
                        {AUDIO_SOURCES.map((s) => (
                          <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
                        ))}
                      </select>

                      {m.source === 'band' && (
                        <span className="inline-flex items-center gap-0.5 text-zinc-300">
                          <input
                            type="number"
                            aria-label={`Start band for ${m.name}`}
                            min={0}
                            max={31}
                            value={m.bands?.[0] ?? 0}
                            onChange={(e) => {
                              const lo = Math.max(0, Math.min(31, Math.round(Number(e.target.value) || 0)));
                              const hi = Math.max(lo, m.bands?.[1] ?? lo);
                              updateMapping(m.id, (cur) => ({ ...cur, bands: [lo, hi] }));
                            }}
                            className="w-10 px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-100"
                          />
                          <span>–</span>
                          <input
                            type="number"
                            aria-label={`End band for ${m.name}`}
                            min={0}
                            max={31}
                            value={m.bands?.[1] ?? 0}
                            onChange={(e) => {
                              const rawHi = Math.max(0, Math.min(31, Math.round(Number(e.target.value) || 0)));
                              const lo = Math.min(m.bands?.[0] ?? 0, rawHi);
                              updateMapping(m.id, (cur) => ({ ...cur, bands: [lo, rawHi] }));
                            }}
                            className="w-10 px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-100"
                          />
                        </span>
                      )}

                      <span aria-hidden="true" className="text-zinc-500">→</span>

                      <select
                        aria-label={`Target group for ${m.name}`}
                        value={m.target.group}
                        onChange={(e) => updateMapping(m.id, (cur) => changeGroup(cur, e.target.value as AudioTargetGroup))}
                        className="px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-200"
                      >
                        {AUDIO_TARGET_GROUPS.map((g) => (
                          <option key={g} value={g}>{GROUP_LABELS[g]}</option>
                        ))}
                      </select>

                      <select
                        aria-label={`Target parameter for ${m.name}`}
                        value={m.target.param}
                        onChange={(e) => updateMapping(m.id, (cur) => changeParam(cur, e.target.value as AudioTargetParam))}
                        className="px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-200"
                      >
                        {validParams.map((p) => (
                          <option key={p} value={p}>{PARAM_LABELS[p]}</option>
                        ))}
                      </select>

                      {m.target.group === 'laser' && projectors.length > 0 && (
                        <select
                          aria-label={`Laser projector for ${m.name}`}
                          value={m.target.projectorKey ?? ''}
                          onChange={(e) => {
                            const key = e.target.value;
                            updateMapping(m.id, (cur) => ({
                              ...cur,
                              target: key
                                ? { group: 'laser', param: cur.target.param, projectorKey: key }
                                : { group: 'laser', param: cur.target.param },
                            }));
                          }}
                          className="px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-200 max-w-[8rem]"
                        >
                          <option value="">All lasers</option>
                          {projectors.map((p) => (
                            <option key={p.key} value={p.key}>{p.label}</option>
                          ))}
                        </select>
                      )}

                      <MappingLiveMeter mappingId={m.id} name={m.name} audioModStore={audioModStore} />

                      <button
                        type="button"
                        aria-label={`Remove ${m.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeMapping(m.id);
                        }}
                        className="p-0.5 rounded text-zinc-400 hover:text-rose-300 hover:bg-rose-500/15 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 items-center text-zinc-300">
                      <label className="flex flex-col gap-0.5">
                        <span>Amt {Math.round(m.amount * 100)}%</span>
                        <input
                          type="range"
                          aria-label={`Amount for ${m.name}`}
                          min={canNeg ? -1 : 0}
                          max={1}
                          step={0.05}
                          value={m.amount}
                          onChange={(e) => updateMapping(m.id, (cur) => ({ ...cur, amount: parseFloat(e.target.value) }))}
                          className="console-slider w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span>Thr {Math.round(m.threshold * 100)}%</span>
                        <input
                          type="range"
                          aria-label={`Threshold for ${m.name}`}
                          min={0}
                          max={0.95}
                          step={0.02}
                          value={m.threshold}
                          onChange={(e) => updateMapping(m.id, (cur) => ({ ...cur, threshold: parseFloat(e.target.value) }))}
                          className="console-slider w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span>Atk {Math.round(m.attackMs)} ms</span>
                        <input
                          type="range"
                          aria-label={`Attack ms for ${m.name}`}
                          min={minAtk}
                          max={5000}
                          step={5}
                          value={Math.max(minAtk, m.attackMs)}
                          onChange={(e) => updateMapping(m.id, (cur) => ({ ...cur, attackMs: Math.max(minAtk, parseFloat(e.target.value)) }))}
                          className="console-slider w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span>Rel {Math.round(m.releaseMs)} ms</span>
                        <input
                          type="range"
                          aria-label={`Release ms for ${m.name}`}
                          min={minRel}
                          max={10000}
                          step={20}
                          value={Math.max(minRel, m.releaseMs)}
                          onChange={(e) => updateMapping(m.id, (cur) => ({ ...cur, releaseMs: Math.max(minRel, parseFloat(e.target.value)) }))}
                          className="console-slider w-full"
                        />
                      </label>
                      <label className="flex flex-col gap-0.5">
                        <span>Curve</span>
                        <select
                          aria-label={`Curve for ${m.name}`}
                          value={m.curve}
                          onChange={(e) => updateMapping(m.id, (cur) => ({ ...cur, curve: e.target.value as AudioMappingCurve }))}
                          className="px-1 py-0.5 rounded bg-black/70 border border-white/15 text-zinc-200"
                        >
                          {AUDIO_CURVES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
