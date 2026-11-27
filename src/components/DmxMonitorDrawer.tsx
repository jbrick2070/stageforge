import React, { useMemo, useState } from 'react';
import { X, Radio } from 'lucide-react';
import { buildDmxPatch, DMX_CHANNELS, type FixturePatchUnit } from '../data/dmxPatch';
import { isLogicalDmxUniverse, isPhysicalDmxUniverse, LOGICAL_DMX_UNIVERSES, type LogicalDmxUniverse } from '../data/dmxUniverses';
import { getCatalogEntry, getCatalogMode, hasCatalogFixtures, type LaserChannelRole } from '../data/equipmentCatalog';
import { classifyPhysicalGroup } from '../dmx/physicalDmx';
import type { LiveDmxControllerApi } from '../dmx/useLiveDmxOutput';
import type { PreflightReport } from '../data/preflight';
import { useLive, type LiveStore } from '../state/liveTelemetry';
import { RigConfig } from '../types/show';
import { DmxOutputSection } from './DmxOutputSection';

export interface DmxSnapshot {
  u1: Uint8Array;
  u2: Uint8Array;
  extended?: Partial<Record<LogicalDmxUniverse, Uint8Array>>;
  physU1?: Uint8Array;
  physU2?: Uint8Array;
}

interface DmxMonitorDrawerProps {
  open: boolean;
  rig: RigConfig;
  dmxStore: LiveStore<DmxSnapshot>;
  liveOutput: LiveDmxControllerApi;
  preflight?: PreflightReport;
  liveViolationMessage?: string | null;
  aiBridgeBlocking?: boolean;
  webXrBlocking?: boolean;
  onOpenPreflight?: () => void;
  onClose: () => void;
}

const EMPTY_UNIVERSE = new Uint8Array(512);

const LASER_ROLE_LABELS: Record<LaserChannelRole, string> = {
  unused: 'Reserved',
  fb4Access16: 'FB4 Mode / Access',
  fb4Mode39: 'FB4 Fixture Mode',
  intensity: 'Master Dimmer',
  pattern: 'Cue / Pattern',
  sizeX: 'Size X',
  sizeY: 'Size Y',
  zoom: 'Zoom',
  speed: 'Scan / Cue Speed',
  rotation: 'Angle Z Rotation',
  posX: 'Position X',
  posY: 'Position Y',
  beamCount: 'Visible Points',
  strobe: 'Strobe / Blanking',
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
  colorScroll: 'Color Scroll',
  scanRate: 'Scan Rate',
};

export const DmxMonitorDrawer: React.FC<DmxMonitorDrawerProps> = ({
  open,
  rig,
  dmxStore,
  liveOutput,
  preflight,
  liveViolationMessage,
  aiBridgeBlocking,
  webXrBlocking,
  onOpenPreflight,
  onClose,
}) => {
  const [universe, setUniverse] = useState<LogicalDmxUniverse>(1);
  const [view, setView] = useState<'grid' | 'patch'>('grid');
  const [bufferMode, setBufferMode] = useState<'simulated' | 'physical'>('simulated');
  const [bank, setBank] = useState(0);
  const dmx = useLive(dmxStore);

  const patch = useMemo(() => (open ? buildDmxPatch(rig) : null), [open, rig.trussPods, rig.floorFx]);
  const rows = useMemo(() => (patch ? patch.rows.filter(row => row.group.dmxUniverse === universe) : []), [patch, universe]);
  const unitsByGroup = useMemo(() => {
    const groups = new Map<string, FixturePatchUnit[]>();
    for (const unit of patch?.units ?? []) {
      if (unit.universe !== universe) continue;
      const group = groups.get(unit.groupKey);
      if (group) group.push(unit);
      else groups.set(unit.groupKey, [unit]);
    }
    return groups;
  }, [patch, universe]);
  const channelNames = useMemo(() => {
    if (!patch) return [];
    const names = Array.from({ length: 512 }, () => [] as string[]);
    for (const row of rows) {
      const entry = getCatalogEntry(row.group.catalogId);
      const resolvedMode = entry ? getCatalogMode(entry, row.group.dmxMode) : undefined;
      const modeLayout = resolvedMode?.layout;
      const isUnmappedLaser = Boolean(entry?.laser && resolvedMode && !resolvedMode.legacy && !modeLayout?.length);
      const phys = classifyPhysicalGroup(row.group);
      for (let address = Math.max(1, row.start); address <= Math.min(row.end, 512); address++) {
        const index = Math.floor((address - row.start) / row.width);
        const offset = (address - row.start) % row.width;
        let channel: string;
        if (bufferMode === 'physical') {
          if (phys.status === 'simulation-only') {
            channel = 'Not driven (simulation only · 0)';
          } else if (phys.status === 'implemented' && phys.personality) {
            channel = phys.personality.channelNames[offset] ?? 'Reserved';
          } else {
            channel = DMX_CHANNELS[row.group.type][offset] ?? 'Reserved';
          }
        } else {
          channel = modeLayout && offset < modeLayout.length
            ? LASER_ROLE_LABELS[modeLayout[offset]]
            : isUnmappedLaser
              ? 'Unmapped (safe 0)'
              : DMX_CHANNELS[row.group.type][offset] ?? 'Reserved';
        }
        const unit = patch.unitFor(row.group, index, row.scope);
        const disabled = unit?.effectiveStart ? '' : ' · output disabled';
        names[address - 1].push(`${row.group.modelName} #${index + 1} · ${channel}${disabled}`);
      }
    }
    return names.map(parts => parts.join(' / ') || 'Unpatched');
  }, [bufferMode, patch, rows]);
  if (!open) return null;
  const invalid = rows.some(row => row.conflicts.length > 0 || row.end > 512);
  const catalogPatched = hasCatalogFixtures(rig);

  const data = bufferMode === 'physical'
    ? (universe === 1 ? dmx.physU1 : universe === 2 ? dmx.physU2 : undefined) ?? EMPTY_UNIVERSE
    : (universe === 1 ? dmx.u1 : universe === 2 ? dmx.u2 : dmx.extended?.[universe]) ?? EMPTY_UNIVERSE;

  return (
    <aside aria-label="DMX monitor" className="dmx-monitor-panel fixed top-16 bottom-[270px] left-2.5 w-[370px] z-35 glass-panel rounded-xl shadow-2xl flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-black/60 border-b border-white/10">
        <div>
          <h2 className="font-display font-bold text-sm text-white tracking-wide flex items-center gap-1.5">
            <Radio className="w-4 h-4 text-fuchsia-400" />
            DMX512 LIVE MONITOR
          </h2>
          <p className="font-mono-tech text-[9px] text-zinc-400">
            {bufferMode === 'physical' ? 'PHYSICAL OUTPUT PREVIEW · 0–255' : 'SIMULATED CHANNEL LEVELS · 0–255'}
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

      <DmxOutputSection
        output={liveOutput}
        rig={rig}
        hasCatalogFixtures={catalogPatched}
        preflight={preflight}
        liveViolationMessage={liveViolationMessage}
        aiBridgeBlocking={aiBridgeBlocking}
        webXrBlocking={webXrBlocking}
        onOpenPreflight={onOpenPreflight}
      />

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
          <select aria-label="Extended DMX universe" value={isPhysicalDmxUniverse(universe) ? '' : universe}
            onChange={event => {
              const selected = Number(event.target.value);
              if (isLogicalDmxUniverse(selected)) setUniverse(selected);
            }} className="rounded border border-white/15 bg-zinc-900 px-1 text-[10px] text-zinc-200">
            <option value="" disabled>U3–U16</option>
            {LOGICAL_DMX_UNIVERSES.filter(u => !isPhysicalDmxUniverse(u)).map(u => <option key={u} value={u}>Universe {u}</option>)}
          </select>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            data-testid="dmx-monitor-mode-sim"
            aria-pressed={bufferMode === 'simulated'}
            onClick={() => setBufferMode('simulated')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech cursor-pointer ${
              bufferMode === 'simulated' ? 'bg-white/15 text-white' : 'text-zinc-400'
            }`}
          >
            SIM
          </button>
          <button
            type="button"
            data-testid="dmx-monitor-mode-phys"
            aria-pressed={bufferMode === 'physical'}
            onClick={() => setBufferMode('physical')}
            className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech cursor-pointer ${
              bufferMode === 'physical' ? 'bg-amber-500/25 text-amber-200' : 'text-zinc-400'
            }`}
          >
            WIRE
          </button>
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

      {invalid && <p role="status" className="px-3 py-1 text-[10px] text-amber-300">Patch conflict or overflow. Affected fixtures have no DMX output. See Patch for addresses.</p>}
      {bufferMode === 'physical' ? (
        <p role="note" className="px-3 py-1 text-[10px] text-amber-200/90 bg-amber-950/40 border-b border-white/10">
          Preview of outgoing physical DMX bytes (not hardware acknowledgement). Unimplemented catalogue fixtures output neutral 0.
        </p>
      ) : catalogPatched && (
        <p role="note" className="px-3 py-1 text-[10px] text-cyan-200/90 bg-cyan-950/40 border-b border-white/10">
          Simulated control layout, not the fixture&apos;s real channel map.
        </p>
      )}
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
        {!isPhysicalDmxUniverse(universe) && bufferMode === 'physical' && (
          <p className="pb-2 text-xs text-amber-300">U{universe} is unavailable on current physical transports.</p>
        )}
        {!rows.length && <p className="pb-2 text-xs text-zinc-400">U{universe} has no patch.</p>}
        {view === 'grid' ? (
          <div className="grid grid-cols-8 gap-1">
            {Array.from({ length: 128 }).map((_, offset) => {
              const i = bank * 128 + offset;
              const val = data[i] || 0;
              const pct = val / 255;
              const address = i + 1;
              const title = `U${universe}.${String(address).padStart(3, '0')} · ${channelNames[i]} · ${val}`;
              return (
                <div
                  key={i}
                  title={title}
                  aria-label={title}
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
            {rows.map(({ group, groupKey, location, width, start, end, conflicts }) => (
              <details key={groupKey} className="bg-black/45 border border-white/10 rounded px-2 py-1.5">
                <summary className="cursor-pointer">
                  <span className="font-semibold text-white">{group.modelName} ×{group.count}</span>
                  <span className="ml-2 text-cyan-300">U{universe}.{String(start).padStart(3, '0')}–{String(end).padStart(3, '0')}</span>
                  <span className="block text-zinc-400">
                    {location} · {width} channels per fixture{group.dmxMode ? ` (${group.dmxMode})` : ''}
                  </span>
                  {conflicts.length > 0 && <span className="block text-amber-300">Overlapping channels {formatRanges(conflicts)}</span>}
                  {end > 512 && <span className="block text-amber-300">Outside universe from channel {Math.max(513, start)}</span>}
                </summary>
                <ul className="pt-1 space-y-0.5" aria-label={`${group.modelName} patch units`}>
                  {unitsByGroup.get(groupKey)?.map((unit) => (
                    <li key={unit.unitId} data-testid="dmx-patch-unit"
                      className={unit.effectiveStart ? 'text-zinc-300' : 'text-amber-300'}>
                      #{unit.ordinal + 1} · U{unit.universe}.{String(unit.start).padStart(3, '0')}–{String(unit.end).padStart(3, '0')}
                      {unit.conflict && ' · Conflict'}{unit.overflow && ' · Overflow'}
                      {unit.effectiveStart ? ' · Patch valid' : ' · Output disabled'}
                    </li>
                  ))}
                </ul>
                <p className="pt-1 text-zinc-300">
                  {DMX_CHANNELS[group.type].slice(0, width).map((name, i) => `${i + 1} ${name}`).join(' · ')}
                  {width > DMX_CHANNELS[group.type].length &&
                    ` · ${DMX_CHANNELS[group.type].length + 1}${width > DMX_CHANNELS[group.type].length + 1 ? `–${width}` : ''} Reserved`}
                </p>
                {(() => {
                  const phys = classifyPhysicalGroup(group);
                  if (phys.status === 'implemented') {
                    return (
                      <p className="pt-1 text-[9px] text-emerald-300/90">
                        Physical DMX: implemented personality ({phys.reason}).
                      </p>
                    );
                  }
                  return (
                    <p className="pt-1 text-[9px] text-amber-300/90">
                      Physical DMX: not driven (simulation only) — outputs neutral zeros.
                    </p>
                  );
                })()}
              </details>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};

function formatRanges(channels: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < channels.length; i++) {
    const start = channels[i];
    while (i + 1 < channels.length && channels[i + 1] === channels[i] + 1) i++;
    ranges.push(start === channels[i] ? String(start) : `${start}–${channels[i]}`);
  }
  return ranges.join(', ');
}
