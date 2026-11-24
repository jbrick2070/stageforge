import React, { useRef, useState } from 'react';
import { FileUp, Play, X } from 'lucide-react';
import { DEMO_ILDA_PRESETS, type DemoIldaKind, type IldaClip } from '../data/ilda';
import type { IldaRenderMode } from '../engine/ildaRenderer';

const FPS_OPTIONS = [12, 24, 30, 45, 60] as const;

export interface IldaControlProps {
  clip: IldaClip | null;
  mode: IldaRenderMode;
  fps: number;
  /** True when every laser projector in the rig is beam-only (disables Graphic mode). */
  allBeamOnly: boolean;
  onLoadDemo: (kind: DemoIldaKind) => void;
  onUploadFile: (file: File) => void;
  onClear: () => void;
  onChangeMode: (mode: IldaRenderMode) => void;
  onChangeFps: (fps: number) => void;
}

export const IldaLoader: React.FC<IldaControlProps> = ({
  clip,
  mode,
  fps,
  allBeamOnly,
  onLoadDemo,
  onUploadFile,
  onClear,
  onChangeMode,
  onChangeFps,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedDemo, setSelectedDemo] = useState<DemoIldaKind>('tour_show');

  return (
    <div
      data-testid="ilda-loader"
      className="rounded-lg border border-white/10 bg-black/45 px-2.5 py-2 space-y-1.5 text-[10px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="font-mono-tech text-[10px] tracking-widest text-emerald-300">
          ILDA (.ILD) FRAMES
        </span>

        {/* Demo picker + upload button in one compact, phone-friendly row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Demo ILDA clip"
            value={selectedDemo}
            onChange={(e) => setSelectedDemo(e.target.value as DemoIldaKind)}
            className="min-h-[44px] sm:min-h-0 rounded bg-zinc-900 border border-white/20 px-1.5 py-1 text-[10px] text-zinc-100 max-w-[175px]"
          >
            {DEMO_ILDA_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => onLoadDemo(selectedDemo)}
            className="min-h-[44px] sm:min-h-0 px-2 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 font-mono-tech text-[10px] text-emerald-100 inline-flex items-center gap-1 cursor-pointer"
          >
            <Play className="w-3 h-3" aria-hidden="true" />
            Load demo
          </button>

          <input
            ref={inputRef}
            type="file"
            accept=".ild,.ILDA"
            aria-label="Upload ILDA file"
            data-testid="ilda-file-input"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUploadFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="min-h-[44px] sm:min-h-0 px-2 py-1 rounded bg-white/10 hover:bg-white/15 border border-white/20 font-mono-tech text-[10px] text-zinc-100 inline-flex items-center gap-1 cursor-pointer"
          >
            <FileUp className="w-3 h-3" aria-hidden="true" />
            Open .ild
          </button>
        </div>
      </div>

      {clip && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-white/10">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0 font-mono-tech text-[9px]">
            <span className="font-semibold text-zinc-100 truncate max-w-[160px]" title={clip.name}>
              {clip.name}
            </span>
            <span className="text-zinc-400">
              {clip.frames.length}f · {clip.totalPoints.toLocaleString()} pts
            </span>
            <span
              data-testid="ilda-session-note"
              className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-400/40 text-amber-200"
            >
              Not saved with show
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div role="group" aria-label="ILDA display mode" className="inline-flex rounded overflow-hidden border border-white/15">
              {(['both', 'beam', 'graphic'] as const).map((m) => {
                const disabled = m === 'graphic' && allBeamOnly;
                const active = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    title={disabled ? 'Beam-only laser hardware cannot project graphic-only frames' : undefined}
                    onClick={() => onChangeMode(m)}
                    className={`min-h-[44px] sm:min-h-0 px-2 py-0.5 font-mono-tech text-[9px] uppercase cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                      active ? 'bg-emerald-500/30 text-emerald-100' : 'bg-zinc-900 text-zinc-400 hover:text-white'
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>

            <select
              aria-label="ILDA frame rate"
              value={fps}
              onChange={(e) => onChangeFps(Number(e.target.value))}
              className="min-h-[44px] sm:min-h-0 rounded bg-zinc-900 border border-white/20 px-1.5 py-0.5 font-mono-tech text-[9px] text-zinc-100"
            >
              {FPS_OPTIONS.map((rate) => (
                <option key={rate} value={rate}>
                  {rate} fps
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={onClear}
              aria-label="Unload ILDA clip"
              className="min-h-[44px] sm:min-h-0 px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 border border-rose-400/40 font-mono-tech text-[9px] text-rose-200 inline-flex items-center gap-1 cursor-pointer"
            >
              <X className="w-3 h-3" aria-hidden="true" />
              Unload
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
