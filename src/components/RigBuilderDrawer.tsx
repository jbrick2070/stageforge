import React, { useEffect, useRef, useState } from 'react';
import { ScenicBuilder } from './ScenicBuilder';
import { LedCabinetEditor } from './LedCabinetEditor';
import { FixtureOpticsEditor } from './FixtureOpticsEditor';
import { EquipmentPicker } from './EquipmentPicker';
import { SpeakerHangsEditor } from './SpeakerHangsEditor';
import { ScreenWallsEditor } from './ScreenWallsEditor';
import type { NativeStage } from '../data/showFile';
import { isCustomMainWall } from '../data/studioGeometry';
import { addPatchedUnits, allocateDmx, repatchGroup, type GroupModelUpdate } from '../data/dmxPatch';
import { checkCatalogChannelDrift } from '../data/equipmentCatalog';
import { downloadRig, MAX_RIG_JSON_BYTES, parseRigJson } from '../data/rigImport';
import { GRID_HEIGHT, ledPlacement } from '../data/stageEquipment';
import { normalizeDesign } from '../data/stageDesign';
import { SPEAKER_PROFILES, type SpeakerProfileId } from '../data/speakerProfiles';
import {
  X,
  Plus,
  Trash2,
  Download,
  Upload,
  Layers,
  Cpu,
  Speaker,
  Wind,
  Tv,
} from 'lucide-react';
import {
  FixtureType,
  FloorFxType,
  RigConfig,
  TrussPodConfig,
  TrussShape,
  VENUE_TYPES,
} from '../types/show';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG, RIG_TEMPLATES } from '../data/presets';

interface RigBuilderDrawerProps {
  open: boolean;
  rig: RigConfig;
  stage?: NativeStage;
  onClose: () => void;
  onChangeRig: (next: RigConfig, replacing?: boolean) => void;
  onChangeStage: (next?: NativeStage) => void;
  onDesignStage: () => void;
  onOpenSavedDesign?: () => void;
  onNotify?: (message: string) => void;
  onModelChanged?: (podId: string | undefined, groupId: string) => void;
}

function TrussDimension({ label, value, low, high, minimum, increment, onChange }: {
  label: string; value: number; low: number; high: number; minimum?: number; increment: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [activeRange, setActiveRange] = useState<[number, number] | null>(null);
  useEffect(() => setText(String(value)), [value]);
  // Keep the track stable while the user drags an imported value toward the normal range.
  const range: [number, number] = activeRange ?? [Math.min(low, value), Math.max(high, value)];
  const accept = (v: number) => {
    if (Number.isFinite(v) && (minimum === undefined || v >= Math.min(minimum, value)) && v !== value) onChange(v);
  };
  const finish = () => {
    const next = Number(text);
    if (text.trim() && Number.isFinite(next) && (minimum === undefined || next >= Math.min(minimum, value))) accept(next);
    else setText(String(value));
  };
  return <div className="min-w-0">
    <label className="flex items-center gap-0.5">{label}
      <input type="number" aria-label={label + ' in metres'} value={text} step="any"
        min={minimum === undefined ? undefined : Math.min(minimum, value)}
        onChange={e => setText(e.target.value)} onBlur={finish} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="min-w-0 w-full bg-black/35 text-zinc-200 rounded px-0.5"/>m
    </label>
    <input type="range" aria-label={label} min={range[0]} max={range[1]} step="any" value={value}
      onFocus={() => setActiveRange(range)} onBlur={() => setActiveRange(null)}
      onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'].includes(e.key)) return;
        e.preventDefault();
        const direction = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
        accept(Math.min(range[1], Math.max(range[0], Number((value + direction * increment).toFixed(8)))));
      }}
      onChange={e => accept(e.currentTarget.valueAsNumber)} className="console-slider w-full mt-0.5"/>
  </div>;
}

export const RigBuilderDrawer: React.FC<RigBuilderDrawerProps> = ({
  open,
  rig,
  stage,
  onClose,
  onChangeRig,
  onChangeStage,
  onDesignStage,
  onOpenSavedDesign,
  onNotify,
  onModelChanged,
}) => {
  const importRef = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const [patchError, setPatchError] = useState('');
  const [importError, setImportError] = useState('');

  if (!open) return null;
  const profileId = rig.audioRig.speakerProfile ?? 'touring';
  const speakerProfile = SPEAKER_PROFILES[profileId];
  const gridHeight = GRID_HEIGHT[rig.venue];
  const wall = ledPlacement(rig);

  const updatePod = (podId: string, patch: Partial<TrussPodConfig>) => {
    onChangeRig({
      ...rig,
      trussPods: rig.trussPods.map((p) => (p.id === podId ? { ...p, ...patch } : p)),
    });
  };

  const addTrussPod = (shape: TrussShape) => {
    const patch = allocateDmx(rig, 'beam', 6, 1);
    if (!patch) { setPatchError('No free DMX block for six beam fixtures.'); return; }
    setPatchError('');
    const idx = rig.trussPods.length + 1;
    const newPod: TrussPodConfig = {
      id: crypto.randomUUID(),
      name: `${shape === 'circle' ? 'Halo Ring' : shape === 'chevron' ? 'Kinetic Wing' : 'Box Truss'} ${idx}`,
      shape,
      width: shape === 'circle' ? 6.5 : 14,
      x: 0,
      baseY: Math.min(10.2, gridHeight - 0.8),
      z: (Math.random() - 0.5) * 6,
      rotationY: 0,
      motorized: true,
      motorMinY: Math.min(5.2, gridHeight - 2.0),
      motorMaxY: Math.min(13.5, gridHeight - 0.3),
      fixtures: [
        {
          id: crypto.randomUUID(),
          type: 'beam',
          modelName: FIXTURE_CATALOG.beam.modelName,
          count: 6,
          dmxUniverse: patch.dmxUniverse,
          dmxStartChannel: patch.dmxStartChannel,
        },
      ],
    };
    onChangeRig({ ...rig, trussPods: [...rig.trussPods, newPod] });
  };

  const removePod = (podId: string) => {
    onChangeRig({ ...rig, trussPods: rig.trussPods.filter((p) => p.id !== podId) });
  };

  const addFixtureToPod = (podId: string, type: FixtureType, groupId?: string) => {
    const pod = rig.trussPods.find(p => p.id === podId);
    if (!pod) return;
    const existing = pod.fixtures.find(f => (groupId ? f.id === groupId : f.type === type && !f.catalogId));
    const count = groupId ? 1 : existing || type === 'laser' ? 2 : 4;
    const group = {
      id: crypto.randomUUID(),
      type,
      modelName: existing?.modelName ?? FIXTURE_CATALOG[type].modelName,
      ...(existing?.catalogId !== undefined ? { catalogId: existing.catalogId } : {}),
      ...(existing?.dmxMode !== undefined ? { dmxMode: existing.dmxMode } : {}),
      ...(existing?.dmxChannels !== undefined ? { dmxChannels: existing.dmxChannels } : {}),
      optics: existing?.optics,
      count,
      dmxUniverse: existing?.dmxUniverse ?? (type === 'laser' ? 2 as const : 1 as const),
      dmxStartChannel: 1,
    };
    const fixtures = addPatchedUnits(rig, pod.fixtures, group, existing);
    if (!fixtures) { setPatchError(`No free DMX block for ${count} × ${group.modelName}.`); return; }
    setPatchError('');
    updatePod(podId, { fixtures });
  };

  const changePodFixtureModel = (podId: string, groupId: string, update: GroupModelUpdate): string | undefined => {
    const pod = rig.trussPods.find(p => p.id === podId);
    const group = pod?.fixtures.find(f => f.id === groupId);
    if (!pod || !group) return 'Fixture group not found.';
    const res = repatchGroup(rig, group, update);
    if (!res.ok) return res.reason;
    setPatchError('');
    if (
      update.catalogId !== group.catalogId ||
      update.dmxMode !== group.dmxMode ||
      update.dmxChannels !== group.dmxChannels
    ) {
      onModelChanged?.(podId, groupId);
    }
    updatePod(podId, { fixtures: pod.fixtures.map(f => (f.id === groupId ? res.group : f)) });
    if (res.moved) {
      onNotify?.(`Moved to U${res.group.dmxUniverse}.${String(res.group.dmxStartChannel).padStart(3, '0')} (${res.width} ch × ${res.group.count})`);
    }
    return undefined;
  };

  const removeFixture = (pod: TrussPodConfig, groupId: string) => {
    setPatchError('');
    updatePod(pod.id, { fixtures: pod.fixtures.map(f => f.id === groupId ? { ...f, count: f.count - 1 } : f).filter(f => f.count > 0) });
  };

  const addFloorFx = (type: FloorFxType, groupId?: string) => {
    const existing = rig.floorFx.find(f => (groupId ? f.id === groupId : f.type === type && !f.catalogId));
    const count = groupId ? 1 : existing || type === 'hazer' ? 2 : 4;
    const group = {
      x: 0,
      z: type === 'co2' ? 4.8 : type === 'floor_beam' ? -3 : 2.2,
      spread: 14,
      modelName: FLOOR_FX_CATALOG[type].modelName,
      dmxUniverse: 2 as const,
      dmxStartChannel: 1,
      ...existing,
      id: crypto.randomUUID(),
      type,
      count,
    };
    const floorFx = addPatchedUnits(rig, rig.floorFx, group, existing);
    if (!floorFx) { setPatchError(`No free DMX block for ${count} × ${group.modelName}.`); return; }
    setPatchError('');
    onChangeRig({ ...rig, floorFx });
  };

  const changeFloorFxModel = (groupId: string, update: GroupModelUpdate): string | undefined => {
    const group = rig.floorFx.find(f => f.id === groupId);
    if (!group) return 'Floor FX group not found.';
    const res = repatchGroup(rig, group, update);
    if (!res.ok) return res.reason;
    setPatchError('');
    if (
      update.catalogId !== group.catalogId ||
      update.dmxMode !== group.dmxMode ||
      update.dmxChannels !== group.dmxChannels
    ) {
      onModelChanged?.(undefined, groupId);
    }
    onChangeRig({ ...rig, floorFx: rig.floorFx.map(item => (item.id === groupId ? res.group : item)) });
    if (res.moved) {
      onNotify?.(`Moved to U${res.group.dmxUniverse}.${String(res.group.dmxStartChannel).padStart(3, '0')} (${res.width} ch × ${res.group.count})`);
    }
    return undefined;
  };

  const importJson = async (file: File) => {
    const request = ++importRequest.current;
    try {
      if (file.size > MAX_RIG_JSON_BYTES) throw new Error('This rig JSON file exceeds the 32 MiB limit.');
      const source = await file.text();
      if (request !== importRequest.current) return;
      const next = parseRigJson(source);
      onChangeRig(normalizeDesign(next), true);
      setImportError('');
    } catch (error) {
      if (request !== importRequest.current) return;
      const detail = error instanceof Error ? error.message : 'Choose a StageForge rig JSON file.';
      setImportError(`Could not read this rig. ${detail}`);
    }
  };

  const authoredHangs = stage?.layout?.hangs;
  const customMainWall = isCustomMainWall(stage?.walls.find(w => w.id === 'main-led'));
  return (
    <aside aria-label="Rig Builder" className="rig-builder-panel fixed top-16 bottom-[270px] right-2.5 w-[min(356px,calc(100vw-20px))] z-35 glass-panel rounded-xl shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/60 border-b border-white/10">
        <div>
          <h2 className="font-display font-bold text-sm text-white tracking-wide flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-cyan-400" />
            STAGE & RIG BUILDER
          </h2>
          <p className="font-mono-tech text-[9px] text-zinc-400">
            {rig.name}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => downloadRig(rig)}
            className="p-1.5 rounded bg-white/5 hover:bg-white/15 text-zinc-300 cursor-pointer"
            title="Export Custom Rig JSON"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => importRef.current?.click()}
            className="p-1.5 rounded bg-white/5 hover:bg-white/15 text-zinc-300 cursor-pointer"
            title="Import Rig JSON"
          >
            <Upload className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            aria-label="Close Rig Builder"
            className="p-1.5 rounded bg-white/5 hover:bg-rose-500/30 text-zinc-300 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {patchError && <p role="alert" className="px-3 py-1.5 text-xs text-amber-300">{patchError}</p>}
      {/* Scrollable Builder Sections */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3.5 text-xs">
        {importError && <p role="alert" className="text-rose-300">{importError}</p>}
        <div className="flex gap-2">
          <button className="transport-btn" onClick={onDesignStage}>Edit stage plan</button>
          {onOpenSavedDesign && <button className="transport-btn" onClick={onOpenSavedDesign}>Open saved design</button>}
        </div>
        <ScenicBuilder rig={rig} onChange={onChangeRig} />
        {/* 1. Stage Presets */}
        <div>
          <div className="font-mono-tech text-[10px] text-cyan-400 tracking-widest mb-1.5">
            LOAD VENUE & RIG PRESET
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(RIG_TEMPLATES).map(([key, tmpl]) => (
              <button
                key={key}
                onClick={() => onChangeRig(structuredClone(tmpl), true)}
                className={`px-2 py-1.5 rounded-lg border text-left transition cursor-pointer ${
                  rig.name === tmpl.name
                    ? 'bg-cyan-500/20 border-cyan-400 text-white'
                    : 'bg-black/40 border-white/10 text-zinc-300 hover:border-white/25'
                }`}
              >
                <div className="text-[11px] font-semibold truncate">{tmpl.name}</div>
                <div className="font-mono-tech text-[9px] text-zinc-400 uppercase">
                  {tmpl.venue} • {tmpl.trussPods.length} trusses
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 2. Venue, LED Wall & Audio Production */}
        <div className="bg-black/40 border border-white/10 rounded-lg p-2.5 space-y-2">
          <div className="font-mono-tech text-[10px] text-zinc-400 tracking-widest flex items-center gap-1.5">
            <Tv className="w-3.5 h-3.5 text-fuchsia-400" /> VENUE, LED WALL & SOUND
          </div>
          <div className="grid grid-cols-3 gap-1">
            {VENUE_TYPES.map((v) => (
              <button
                key={v}
                onClick={() => onChangeRig({ ...rig, venue: v })}
                className={`py-1 rounded font-mono-tech text-[10px] uppercase border cursor-pointer ${
                  rig.venue === v
                    ? 'bg-cyan-500/25 border-cyan-400 text-cyan-200'
                    : 'bg-white/5 border-white/10 text-zinc-400'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-1.5 pt-1">
            <ToggleChip
              label="Main LED Wall"
              active={rig.ledWall.enabled}
              onClick={() => onChangeRig({ ...rig, ledWall: { ...rig.ledWall, enabled: !rig.ledWall.enabled } })}
            />
            <ToggleChip
              label="Curved LED"
              active={!customMainWall && rig.ledWall.curved}
              disabled={customMainWall}
              title={customMainWall ? 'Custom main-led placement replaces the curved wall and IMAG wings' : undefined}
              onClick={() => onChangeRig({ ...rig, ledWall: { ...rig.ledWall, curved: !rig.ledWall.curved } })}
            />
            <ToggleChip
              label="IMAG Side Wings"
              active={!customMainWall && rig.ledWall.sideWings}
              disabled={customMainWall}
              title={customMainWall ? 'Custom main-led placement replaces the curved wall and IMAG wings' : undefined}
              onClick={() => onChangeRig({ ...rig, ledWall: { ...rig.ledWall, sideWings: !rig.ledWall.sideWings } })}
            />
            <ToggleChip
              label="Line Arrays"
              active={authoredHangs !== undefined ? authoredHangs.length > 0 : rig.audioRig.lineArrays}
              disabled={authoredHangs !== undefined}
              title={authoredHangs !== undefined ? 'Managed by Authored Speaker Hangs below' : undefined}
              onClick={() => onChangeRig({ ...rig, audioRig: { ...rig.audioRig, lineArrays: !rig.audioRig.lineArrays } })}
            />
            <ToggleChip
              label="Subwoofer Wall"
              active={rig.audioRig.subWall}
              onClick={() => onChangeRig({ ...rig, audioRig: { ...rig.audioRig, subWall: !rig.audioRig.subWall } })}
            />
            <ToggleChip
              label="DJ Console"
              active={rig.audioRig.djBooth}
              onClick={() => onChangeRig({ ...rig, audioRig: { ...rig.audioRig, djBooth: !rig.audioRig.djBooth } })}
            />
          </div>

          {rig.ledWall.enabled && <LedCabinetEditor rig={rig} layout={wall}
            onChange={ledWall => onChangeRig({ ...rig, ledWall })}/>}
          {rig.ledWall.enabled && !rig.ledWall.cabinets && wall.scale < 1 && (
            <p className="text-xs text-amber-200">
              {wall.height > 0
                ? `LED wall fits at ${wall.width.toFixed(1)} × ${wall.height.toFixed(1)} m under the ${gridHeight} m grid.`
                : `No clearance for the LED wall under the ${gridHeight} m grid at this deck height.`}
            </p>
          )}
          <ScreenWallsEditor rig={rig} stage={stage} onChangeStage={onChangeStage} />
          <label className="flex items-center gap-2">
            <span className="font-mono-tech text-[10px] text-zinc-300">Speaker system</span>
            <select aria-label="Speaker system" value={profileId}
              className="flex-1 min-w-0 p-1.5 rounded bg-zinc-900 border border-white/15"
              onChange={e => onChangeRig({ ...rig, audioRig: { ...rig.audioRig, speakerProfile: e.target.value as SpeakerProfileId } })}>
              {Object.entries(SPEAKER_PROFILES).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}
            </select>
          </label>
          {profileId === 'k2' && <div className="space-y-1">
            <p className="text-[10px] text-zinc-400">Cabinet dimensions · W × H × D (mm)</p>
            {[speakerProfile.array, speakerProfile.sub, speakerProfile.monitor].map(box => (
              <div key={box.label} className="flex justify-between text-[10px]">
                <a className="text-cyan-300 underline" href={box.url!} target="_blank" rel="noreferrer">{box.label}</a>
                <span className="font-mono-tech">{[box.width, box.height, box.depth].map(n => Math.round(n * 1000)).join(' × ')}</span>
              </div>
            ))}
          </div>}
          <div className="grid grid-cols-2 gap-2 pt-1">
            {([
              ['boxesPerSide', 'Flown boxes per side', 4, 12, 9],
              ['monitorCount', 'Monitor wedges', 0, 8, 0],
            ] as const).map(([key, label, min, max, fallback]) => {
              const managedByHangs = key === 'boxesPerSide' && authoredHangs !== undefined;
              const authoredTotal = managedByHangs ? authoredHangs.reduce((sum, h) => sum + h.count, 0) : 0;
              return (
                <label key={key} className="font-mono-tech text-[10px] text-zinc-300">
                  <span className="flex justify-between">
                    <span>{managedByHangs ? 'Authored boxes' : label}</span>
                    <output className="text-cyan-300">
                      {managedByHangs ? authoredTotal : (key === 'boxesPerSide' && !rig.audioRig.lineArrays ? 0 : rig.audioRig[key] ?? fallback)}
                    </output>
                  </span>
                  <input aria-label={label} type="range" min={min} max={max} step="1"
                    disabled={managedByHangs}
                    title={managedByHangs ? 'Edit cabinet counts in Authored Speaker Hangs below' : undefined}
                    value={rig.audioRig[key] ?? fallback} className="console-slider w-full disabled:opacity-40"
                    onChange={e => onChangeRig({ ...rig, audioRig: { ...rig.audioRig, [key]: Number(e.target.value),
                      ...(key === 'boxesPerSide' ? { lineArrays: true } : {}) } })} />
                </label>
              );
            })}
            <div>
              <div className="flex justify-between font-mono-tech text-[9px] text-zinc-400 mb-0.5">
                <span>SUBWOOFERS</span>
                <span className="text-cyan-300">{rig.audioRig.subWall ? rig.audioRig.subCount : 0}</span>
              </div>
              <input
                aria-label="Subwoofers"
                type="range"
                min={2}
                max={16}
                step={2}
                value={rig.audioRig.subCount}
                onChange={(e) =>
                  onChangeRig({
                    ...rig,
                    audioRig: {
                      ...rig.audioRig,
                      subWall: true,
                      subCount: parseInt(e.target.value, 10),
                    },
                  })
                }
                className="console-slider w-full"
              />
            </div>
            <div>
              <div className="flex justify-between font-mono-tech text-[9px] text-zinc-400 mb-0.5">
                <span>CROWD</span>
                <span className="text-cyan-300">{Math.round(rig.audioRig.crowdDensity * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={rig.audioRig.crowdDensity}
                onChange={(e) =>
                  onChangeRig({
                    ...rig,
                    audioRig: { ...rig.audioRig, crowdDensity: parseFloat(e.target.value) },
                  })
                }
                className="console-slider w-full"
              />
            </div>
          </div>
          <SpeakerHangsEditor rig={rig} stage={stage} onChangeStage={onChangeStage} />
        </div>

        {/* 3. Overhead Truss Pods + Chain Motors + Fixtures */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-mono-tech text-[10px] text-amber-400 tracking-widest flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5" /> TRUSSES & CHAIN MOTORS ({rig.trussPods.length})
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => addTrussPod('box')}
                className="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/50 text-[9px] font-mono-tech text-amber-200 flex items-center gap-0.5 cursor-pointer"
              >
                <Plus className="w-2.5 h-2.5" /> BOX
              </button>
              <button
                onClick={() => addTrussPod('circle')}
                className="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/50 text-[9px] font-mono-tech text-amber-200 flex items-center gap-0.5 cursor-pointer"
              >
                <Plus className="w-2.5 h-2.5" /> RING
              </button>
              <button
                onClick={() => addTrussPod('chevron')}
                className="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/50 text-[9px] font-mono-tech text-amber-200 flex items-center gap-0.5 cursor-pointer"
              >
                <Plus className="w-2.5 h-2.5" /> WING
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {rig.trussPods.map((pod) => (
              <div key={pod.id} className="bg-black/45 border border-white/10 rounded-lg p-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-[11px] text-white truncate">{pod.name}</div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => updatePod(pod.id, { motorized: !pod.motorized })}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech border cursor-pointer ${
                        pod.motorized
                          ? 'bg-amber-500/25 border-amber-400 text-amber-200'
                          : 'bg-white/5 border-white/10 text-zinc-500'
                      }`}
                    >
                      {pod.motorized ? 'MOTOR ON' : 'STATIC'}
                    </button>
                    <button
                      onClick={() => removePod(pod.id)}
                      className="p-1 rounded hover:bg-rose-500/25 text-zinc-400 hover:text-rose-300 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                {/* Pod Position & Width Sliders */}
                <div className="grid grid-cols-3 gap-1.5 font-mono-tech text-[9px] text-zinc-400">
                  {pod.shape === 'path' ? <div>LENGTH {pod.width.toFixed(1)}m
                    <button type="button" className="block underline" onClick={onDesignStage}>Edit path</button></div> :
                    <TrussDimension label="WIDTH" value={pod.width} low={0.25} high={Math.max(28, rig.stageWidth)} minimum={0.25}
                      increment={0.5} onChange={width => updatePod(pod.id, { width })}/>}
                  <TrussDimension label="HEIGHT" value={pod.baseY} low={0} high={Math.max(14.5, pod.motorMaxY)} minimum={0}
                    increment={0.2} onChange={baseY => updatePod(pod.id, { baseY, motorMinY: Math.min(baseY, pod.motorMinY), motorMaxY: Math.max(baseY, pod.motorMaxY) })}/>
                  <TrussDimension label="DEPTH" value={pod.z} low={-Math.max(6, rig.stageDepth)} high={Math.max(7, rig.stageDepth)}
                    increment={0.2} onChange={z => updatePod(pod.id, { z })}/>
                </div>

                {/* Mounted Fixtures List */}
                <div className="space-y-1">
                  {pod.fixtures.map((fg) => {
                    const drift = checkCatalogChannelDrift(fg);
                    return (
                    <React.Fragment key={fg.id}>
                    <div
                      className="flex items-center justify-between gap-1.5 bg-white/5 rounded px-2 py-1 text-[10px]"
                    >
                      <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                        <EquipmentPicker
                          group={fg}
                          onApply={(update) => changePodFixtureModel(pod.id, fg.id, update)}
                        />
                        <span className="font-mono-tech text-[9px] text-zinc-500 shrink-0">
                          U{fg.dmxUniverse}.{String(fg.dmxStartChannel).padStart(3, '0')}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono-tech shrink-0">
                        <button
                          onClick={() => removeFixture(pod, fg.id)}
                          aria-label={`Remove one ${fg.modelName}`}
                          className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                        >
                          -
                        </button>
                        <span className="text-cyan-300 w-4 text-center">{fg.count}</span>
                        <button
                          onClick={() => addFixtureToPod(pod.id, fg.type, fg.id)}
                          aria-label={`Add one ${fg.modelName}`}
                          className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    {drift && (
                      <div className="flex items-center justify-between gap-2 rounded bg-amber-950/50 border border-amber-400/40 px-2 py-1 text-[10px] text-amber-200">
                        <span>Catalogue now says {drift.expectedChannels} ch (saved {drift.actualChannels} ch).</span>
                        <button
                          type="button"
                          onClick={() => {
                            const err = changePodFixtureModel(pod.id, fg.id, {
                              modelName: fg.modelName,
                              catalogId: fg.catalogId,
                              dmxMode: fg.dmxMode,
                              dmxChannels: drift.expectedChannels,
                            });
                            if (err) setPatchError(err);
                          }}
                          className="rounded bg-amber-500/25 hover:bg-amber-500/40 px-1.5 py-0.5 font-mono-tech text-[9px] text-amber-100 cursor-pointer shrink-0"
                        >
                          Re-patch?
                        </button>
                      </div>
                    )}
                    {(fg.type === 'beam' || fg.type === 'wash') && <FixtureOpticsEditor kind={fg.type} catalogId={fg.catalogId} settings={fg.optics}
                      onChange={optics => updatePod(pod.id, { fixtures: pod.fixtures.map(item => item.id === fg.id ? { ...item, optics } : item) })}/>}
                    </React.Fragment>
                    );
                  })}
                </div>

                {/* Add Fixture Buttons */}
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {(['beam', 'wash', 'laser', 'strobe', 'blinder'] as FixtureType[]).map((ft) => (
                    <button
                      key={ft}
                      onClick={() => addFixtureToPod(pod.id, ft)}
                      className="px-1.5 py-0.5 rounded bg-cyan-500/10 hover:bg-cyan-500/25 border border-cyan-500/30 text-[9px] font-mono-tech text-cyan-200 uppercase cursor-pointer"
                    >
                      +{ft}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 4. Stage Floor FX (Smoke, Hazers, CO2, Floor Lasers & Beams) */}
        <div className="bg-black/40 border border-white/10 rounded-lg p-2.5 space-y-2">
          <div className="font-mono-tech text-[10px] text-sky-400 tracking-widest flex items-center gap-1.5">
            <Wind className="w-3.5 h-3.5" /> STAGE DECK FX & LASERS
          </div>
          <div className="flex flex-wrap gap-1">
            {(['co2', 'smoke', 'hazer', 'floor_laser', 'floor_beam'] as FloorFxType[]).map((ft) => (
              <button
                key={ft}
                onClick={() => addFloorFx(ft)}
                className="px-2 py-0.5 rounded bg-sky-500/15 hover:bg-sky-500/30 border border-sky-400/40 text-[9px] font-mono-tech text-sky-200 uppercase cursor-pointer"
              >
                +{ft.replace('_', ' ')}
              </button>
            ))}
          </div>
          <div className="space-y-1">
            {rig.floorFx.map((fx) => {
              const drift = checkCatalogChannelDrift(fx);
              return (
              <React.Fragment key={fx.id}>
              <div
                className="flex items-center justify-between gap-1.5 bg-white/5 rounded px-2 py-1 text-[10px]"
              >
                <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                  <EquipmentPicker
                    group={fx}
                    onApply={(update) => changeFloorFxModel(fx.id, update)}
                  />
                  <span className="font-mono-tech text-[9px] text-zinc-500 shrink-0">
                    U{fx.dmxUniverse}.{String(fx.dmxStartChannel).padStart(3, '0')}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 font-mono-tech shrink-0">
                  <button
                    onClick={() =>
                      onChangeRig({
                        ...rig,
                        floorFx: rig.floorFx
                          .map((item) => (item.id === fx.id ? { ...item, count: item.count - 1 } : item))
                          .filter((item) => item.count > 0),
                      })
                    }
                    aria-label={`Remove one ${fx.modelName}`}
                    className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                  >
                    -
                  </button>
                  <span className="text-sky-300 w-4 text-center">{fx.count}</span>
                  <button
                    onClick={() => addFloorFx(fx.type, fx.id)}
                    aria-label={`Add one ${fx.modelName}`}
                    className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>
              {drift && (
                <div className="flex items-center justify-between gap-2 rounded bg-amber-950/50 border border-amber-400/40 px-2 py-1 text-[10px] text-amber-200">
                  <span>Catalogue now says {drift.expectedChannels} ch (saved {drift.actualChannels} ch).</span>
                  <button
                    type="button"
                    onClick={() => {
                      const err = changeFloorFxModel(fx.id, {
                        modelName: fx.modelName,
                        catalogId: fx.catalogId,
                        dmxMode: fx.dmxMode,
                        dmxChannels: drift.expectedChannels,
                      });
                      if (err) setPatchError(err);
                    }}
                    className="rounded bg-amber-500/25 hover:bg-amber-500/40 px-1.5 py-0.5 font-mono-tech text-[9px] text-amber-100 cursor-pointer shrink-0"
                  >
                    Re-patch?
                  </button>
                </div>
              )}
              {fx.type === 'floor_beam' && <FixtureOpticsEditor kind="beam" catalogId={fx.catalogId} settings={fx.optics}
                onChange={optics => onChangeRig({ ...rig, floorFx: rig.floorFx.map(item => item.id === fx.id ? { ...item, optics } : item) })}/>}
              </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
};

const ToggleChip: React.FC<{ label: string; active: boolean; disabled?: boolean; title?: string; onClick: () => void }> = ({
  label,
  active,
  disabled,
  title,
  onClick,
}) => (
  <button
    type="button"
    disabled={disabled}
    title={title}
    onClick={onClick}
    className={`px-2 py-1 rounded text-[10px] font-mono-tech border text-left flex items-center justify-between cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
      active
        ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-100'
        : 'bg-white/5 border-white/10 text-zinc-500'
    }`}
  >
    <span>{label}</span>
    <span className={active ? 'text-cyan-300' : 'text-zinc-600'}>{active ? 'ON' : 'OFF'}</span>
  </button>
);
