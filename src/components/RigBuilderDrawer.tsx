import React, { useRef, useState } from 'react';
import { ScenicBuilder } from './ScenicBuilder';
import { isStageProp } from '../data/stageProps';
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
  VenueType,
} from '../types/show';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG, RIG_TEMPLATES } from '../data/presets';

interface RigBuilderDrawerProps {
  open: boolean;
  rig: RigConfig;
  onClose: () => void;
  onChangeRig: (next: RigConfig) => void;
}

export const RigBuilderDrawer: React.FC<RigBuilderDrawerProps> = ({
  open,
  rig,
  onClose,
  onChangeRig,
}) => {
  const importRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');

  if (!open) return null;
  const profileId = rig.audioRig.speakerProfile ?? 'touring';
  const speakerProfile = SPEAKER_PROFILES[profileId];

  const updatePod = (podId: string, patch: Partial<TrussPodConfig>) => {
    onChangeRig({
      ...rig,
      trussPods: rig.trussPods.map((p) => (p.id === podId ? { ...p, ...patch } : p)),
    });
  };

  const addTrussPod = (shape: TrussShape) => {
    const idx = rig.trussPods.length + 1;
    const newPod: TrussPodConfig = {
      id: `pod-${Date.now()}`,
      name: `${shape === 'circle' ? 'Halo Ring' : shape === 'chevron' ? 'Kinetic Wing' : 'Box Truss'} ${idx}`,
      shape,
      width: shape === 'circle' ? 6.5 : 14,
      x: 0,
      baseY: 10.2,
      z: (Math.random() - 0.5) * 6,
      rotationY: 0,
      motorized: true,
      motorMinY: 5.2,
      motorMaxY: 13.5,
      fixtures: [
        {
          id: `fix-${Date.now()}`,
          type: 'beam',
          modelName: FIXTURE_CATALOG.beam.modelName,
          count: 6,
          dmxUniverse: 1,
          dmxStartChannel: 1,
        },
      ],
    };
    onChangeRig({ ...rig, trussPods: [...rig.trussPods, newPod] });
  };

  const removePod = (podId: string) => {
    onChangeRig({ ...rig, trussPods: rig.trussPods.filter((p) => p.id !== podId) });
  };

  const addFixtureToPod = (podId: string, type: FixtureType) => {
    const meta = FIXTURE_CATALOG[type];
    onChangeRig({
      ...rig,
      trussPods: rig.trussPods.map((p) => {
        if (p.id !== podId) return p;
        const existing = p.fixtures.find((f) => f.type === type);
        if (existing) {
          return {
            ...p,
            fixtures: p.fixtures.map((f) =>
              f.type === type ? { ...f, count: Math.min(16, f.count + 2) } : f
            ),
          };
        }
        return {
          ...p,
          fixtures: [
            ...p.fixtures,
            {
              id: `fg-${Date.now()}`,
              type,
              modelName: meta.modelName,
              count: type === 'laser' ? 2 : 4,
              dmxUniverse: type === 'laser' ? 2 : 1,
              dmxStartChannel: 1,
            },
          ],
        };
      }),
    });
  };

  const updateFixtureCount = (podId: string, fgId: string, delta: number) => {
    onChangeRig({
      ...rig,
      trussPods: rig.trussPods.map((p) => {
        if (p.id !== podId) return p;
        return {
          ...p,
          fixtures: p.fixtures
            .map((f) => (f.id === fgId ? { ...f, count: f.count + delta } : f))
            .filter((f) => f.count > 0),
        };
      }),
    });
  };

  const addFloorFx = (type: FloorFxType) => {
    const meta = FLOOR_FX_CATALOG[type];
    const existing = rig.floorFx.find((f) => f.type === type);
    if (existing) {
      onChangeRig({
        ...rig,
        floorFx: rig.floorFx.map((f) =>
          f.type === type ? { ...f, count: Math.min(12, f.count + 2) } : f
        ),
      });
      return;
    }
    onChangeRig({
      ...rig,
      floorFx: [
        ...rig.floorFx,
        {
          id: `fx-${Date.now()}`,
          type,
          modelName: meta.modelName,
          count: type === 'hazer' ? 2 : 4,
          x: 0,
          z: type === 'co2' ? 4.8 : type === 'floor_beam' ? -3.0 : 2.2,
          spread: 14,
          dmxUniverse: 2,
          dmxStartChannel: 300,
        },
      ],
    });
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(rig, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${rig.name.toLowerCase().replace(/\s+/g, '-')}.stageforge.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as RigConfig;
        if (!parsed || typeof parsed.name !== 'string' || !parsed.ledWall || !parsed.audioRig ||
          (parsed.audioRig.speakerProfile !== undefined && !Object.hasOwn(SPEAKER_PROFILES, parsed.audioRig.speakerProfile)) ||
          ![parsed.stageWidth, parsed.stageDepth, parsed.stageHeight].every(n => Number.isFinite(n) && n > 0) ||
          !Array.isArray(parsed.trussPods) || !parsed.trussPods.every(p => p && Array.isArray(p.fixtures)) ||
          !Array.isArray(parsed.floorFx) || (parsed.props !== undefined &&
            (!Array.isArray(parsed.props) || !parsed.props.every(isStageProp) ||
              new Set(parsed.props.map(p => p.id)).size !== parsed.props.length))) throw new Error();
        onChangeRig(parsed);
        setImportError('');
      } catch {
        setImportError('Could not read this rig. Choose a StageForge rig JSON file with valid equipment and prop settings.');
      }
    };
    reader.readAsText(file);
  };

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
            SCENERY, RIGGING &amp; PRODUCTION
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={exportJson}
            className="p-1.5 rounded bg-white/5 hover:bg-white/15 text-zinc-300 cursor-pointer"
            title="Export Custom Rig JSON"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
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

      {/* Scrollable Builder Sections */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3.5 text-xs">
        {importError && <p role="alert" className="text-rose-300">{importError}</p>}
        <ScenicBuilder rig={rig} onChange={onChangeRig} />
        {/* 1. Stage Presets */}
        <div>
          <div className="font-mono-tech text-[10px] text-cyan-400 tracking-widest mb-1.5">
            LOAD CONCERT RIG TEMPLATE
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(RIG_TEMPLATES).map(([key, tmpl]) => (
              <button
                key={key}
                onClick={() => onChangeRig(structuredClone(tmpl))}
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
            {(['arena', 'warehouse', 'festival'] as VenueType[]).map((v) => (
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
              active={rig.ledWall.curved}
              onClick={() => onChangeRig({ ...rig, ledWall: { ...rig.ledWall, curved: !rig.ledWall.curved } })}
            />
            <ToggleChip
              label="IMAG Side Wings"
              active={rig.ledWall.sideWings}
              onClick={() => onChangeRig({ ...rig, ledWall: { ...rig.ledWall, sideWings: !rig.ledWall.sideWings } })}
            />
            <ToggleChip
              label="Line Arrays"
              active={rig.audioRig.lineArrays}
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
            ] as const).map(([key, label, min, max, fallback]) => (
              <label key={key} className="font-mono-tech text-[10px] text-zinc-300">
                <span className="flex justify-between"><span>{label}</span>
                  <output className="text-cyan-300">{key === 'boxesPerSide' && !rig.audioRig.lineArrays ? 0 : rig.audioRig[key] ?? fallback}</output>
                </span>
                <input aria-label={label} type="range" min={min} max={max} step="1"
                  value={rig.audioRig[key] ?? fallback} className="console-slider w-full"
                  onChange={e => onChangeRig({ ...rig, audioRig: { ...rig.audioRig, [key]: Number(e.target.value),
                    ...(key === 'boxesPerSide' ? { lineArrays: true } : {}) } })} />
              </label>
            ))}
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
                  <label>
                    WIDTH {pod.width.toFixed(0)}m
                    <input
                      type="range"
                      min={4}
                      max={28}
                      step={0.5}
                      value={pod.width}
                      onChange={(e) => updatePod(pod.id, { width: parseFloat(e.target.value) })}
                      className="console-slider w-full mt-0.5"
                    />
                  </label>
                  <label>
                    HEIGHT {pod.baseY.toFixed(1)}m
                    <input
                      type="range"
                      min={5}
                      max={14.5}
                      step={0.2}
                      value={pod.baseY}
                      onChange={(e) => updatePod(pod.id, { baseY: parseFloat(e.target.value) })}
                      className="console-slider w-full mt-0.5"
                    />
                  </label>
                  <label>
                    DEPTH {pod.z.toFixed(1)}m
                    <input
                      type="range"
                      min={-6}
                      max={7}
                      step={0.2}
                      value={pod.z}
                      onChange={(e) => updatePod(pod.id, { z: parseFloat(e.target.value) })}
                      className="console-slider w-full mt-0.5"
                    />
                  </label>
                </div>

                {/* Mounted Fixtures List */}
                <div className="space-y-1">
                  {pod.fixtures.map((fg) => (
                    <div
                      key={fg.id}
                      className="flex items-center justify-between bg-white/5 rounded px-2 py-1 text-[10px]"
                    >
                      <div>
                        <span className="text-zinc-200 font-medium">{fg.modelName}</span>
                        <span className="font-mono-tech text-[9px] text-zinc-500 ml-1.5">
                          U{fg.dmxUniverse}.{String(fg.dmxStartChannel).padStart(3, '0')}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono-tech">
                        <button
                          onClick={() => updateFixtureCount(pod.id, fg.id, -1)}
                          className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                        >
                          -
                        </button>
                        <span className="text-cyan-300 w-4 text-center">{fg.count}</span>
                        <button
                          onClick={() => updateFixtureCount(pod.id, fg.id, 1)}
                          className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ))}
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
            {rig.floorFx.map((fx) => (
              <div
                key={fx.id}
                className="flex items-center justify-between bg-white/5 rounded px-2 py-1 text-[10px]"
              >
                <span className="text-zinc-200">{fx.modelName}</span>
                <div className="flex items-center gap-1.5 font-mono-tech">
                  <button
                    onClick={() =>
                      onChangeRig({
                        ...rig,
                        floorFx: rig.floorFx
                          .map((item) => (item.id === fx.id ? { ...item, count: item.count - 1 } : item))
                          .filter((item) => item.count > 0),
                      })
                    }
                    className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                  >
                    -
                  </button>
                  <span className="text-sky-300 w-4 text-center">{fx.count}</span>
                  <button
                    onClick={() =>
                      onChangeRig({
                        ...rig,
                        floorFx: rig.floorFx.map((item) =>
                          item.id === fx.id ? { ...item, count: Math.min(12, item.count + 1) } : item
                        ),
                      })
                    }
                    className="w-4 h-4 rounded bg-black/60 hover:bg-white/15 cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
};

const ToggleChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    className={`px-2 py-1 rounded text-[10px] font-mono-tech border text-left flex items-center justify-between cursor-pointer ${
      active
        ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-100'
        : 'bg-white/5 border-white/10 text-zinc-500'
    }`}
  >
    <span>{label}</span>
    <span className={active ? 'text-cyan-300' : 'text-zinc-600'}>{active ? 'ON' : 'OFF'}</span>
  </button>
);
