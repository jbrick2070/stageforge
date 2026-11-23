import React, { useState } from 'react';
import { X, Radio } from 'lucide-react';
import { RigConfig } from '../types/show';

interface DmxMonitorDrawerProps {
  open: boolean;
  rig: RigConfig;
  universe1: Uint8Array;
  universe2: Uint8Array;
  onClose: () => void;
}

export const DmxMonitorDrawer: React.FC<DmxMonitorDrawerProps> = ({
  open,
  rig,
  universe1,
  universe2,
  onClose,
}) => {
  const [universe, setUniverse] = useState<1 | 2>(1);
  const [view, setView] = useState<'grid' | 'patch'>('grid');

  const [bank, setBank] = useState(0);

  if (!open) return null;

  const data = universe === 1 ? universe1 : universe2;

  return (
    <aside aria-label="DMX monitor" className="dmx-monitor-panel fixed top-16 bottom-[270px] left-2.5 w-[370px] z-35 glass-panel rounded-xl shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-black/60 border-b border-white/10">
        <div>
          <h2 className="font-display font-bold text-sm text-white tracking-wide flex items-center gap-1.5">
            <Radio className="w-4 h-4 text-fuchsia-400" />
            DMX512 LIVE MONITOR
          </h2>
          <p className="font-mono-tech text-[9px] text-zinc-400">
            SIMULATED CHANNEL LEVELS · 0–255
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close DMX monitor"
          className="p-1.5 rounded bg-white/5 hover:bg-rose-500/30 text-zinc-300 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center justify-between px-3 py-1.5 bg-black/40 border-b border-white/10">
        <div className="flex gap-1">
          <button
            onClick={() => setUniverse(1)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono-tech border cursor-pointer ${
              universe === 1
                ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200'
                : 'bg-white/5 border-white/10 text-zinc-400'
            }`}
          >
            UNIVERSE 1
          </button>
          <button
            onClick={() => setUniverse(2)}
            className={`px-2 py-0.5 rounded text-[10px] font-mono-tech border cursor-pointer ${
              universe === 2
                ? 'bg-emerald-500/25 border-emerald-400 text-emerald-200'
                : 'bg-white/5 border-white/10 text-zinc-400'
            }`}
          >
            UNIVERSE 2
          </button>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setView('grid')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech cursor-pointer ${
              view === 'grid' ? 'bg-white/15 text-white' : 'text-zinc-400'
            }`}
          >
            CH GRID
          </button>
          <button
            onClick={() => setView('patch')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech cursor-pointer ${
              view === 'patch' ? 'bg-white/15 text-white' : 'text-zinc-400'
            }`}
          >
            PATCH
          </button>
        </div>
      </div>

      {view === 'grid' && (
        <div className="flex gap-1 px-3 py-1.5 border-b border-white/10" aria-label="DMX channel banks">
          {[0, 1, 2, 3].map(n => (
            <button key={n} aria-pressed={bank === n} onClick={() => setBank(n)}
              className={`flex-1 py-1 rounded font-mono-tech text-[10px] cursor-pointer ${bank === n ? 'bg-white/15 text-white' : 'text-zinc-400'}`}>
              {n * 128 + 1}–{(n + 1) * 128}
            </button>
          ))}
        </div>
      )}
      <div key={`${view}-${bank}-${universe}`} className="flex-1 overflow-y-auto p-2.5">
        {view === 'grid' ? (
          <div className="grid grid-cols-8 gap-1">
            {Array.from({ length: 128 }).map((_, offset) => {
              const i = bank * 128 + offset;
              const val = data[i] || 0;
              const pct = val / 255;
              return (
                <div
                  key={i}
                  className="rounded border border-white/10 px-1 py-0.5 text-center font-mono-tech relative overflow-hidden"
                  style={{
                    background: `rgba(${universe === 1 ? '0, 240, 255' : '16, 185, 129'}, ${
                      0.05 + pct * 0.42
                    })`,
                  }}
                >
                  <div className="text-[7px] text-zinc-400 leading-none">{String(i + 1).padStart(3, '0')}</div>
                  <div className={`text-[10px] font-bold leading-tight ${val > 0 ? 'text-white' : 'text-zinc-600'}`}>
                    {val}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1.5 font-mono-tech text-[10px]">
            {rig.trussPods.map((pod) =>
              pod.fixtures.filter((fg) => fg.dmxUniverse === universe).map((fg) => (
                <div
                  key={fg.id}
                  className="flex items-center justify-between bg-black/45 border border-white/10 rounded px-2 py-1.5"
                >
                  <div>
                    <div className="text-white font-semibold">{fg.modelName} ×{fg.count}</div>
                    <div className="text-[9px] text-zinc-400">{pod.name}</div>
                  </div>
                  <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                    U{fg.dmxUniverse}.{String(fg.dmxStartChannel).padStart(3, '0')}
                  </span>
                </div>
              ))
            )}
            {rig.floorFx.filter((fx) => fx.dmxUniverse === universe).map((fx) => (
              <div
                key={fx.id}
                className="flex items-center justify-between bg-black/45 border border-white/10 rounded px-2 py-1.5"
              >
                <div>
                  <div className="text-white font-semibold">{fx.modelName} ×{fx.count}</div>
                  <div className="text-[9px] text-zinc-400">Stage Floor Deck</div>
                </div>
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  U{fx.dmxUniverse}.{String(fx.dmxStartChannel).padStart(3, '0')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};
