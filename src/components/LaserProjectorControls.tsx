import { useMemo, useState } from 'react';
import { getCatalogEntry } from '../data/equipmentCatalog';
import { DEFAULT_LASER_COLORS, DEFAULT_LASER_RESOLUTION, LASER_RESOLUTIONS, laserProjectors } from '../data/laserProjectors';
import type { LaserAppearance, LaserColorMode, LaserResolution, RigConfig, ShowState } from '../types/show';

const colorModes: [LaserColorMode, string][] = [
  ['custom', 'Custom solid'], ['custom_dual', 'Custom pair'],
  ['primary', 'Show primary'], ['dual', 'Show pair'], ['rainbow', 'RGB rainbow'],
  ['cyan_magenta', 'Cyan / magenta'], ['emerald_gold', 'Emerald / gold'], ['crimson_ice', 'Crimson / ice'],
];
const selectStyle = 'w-full min-w-0 min-h-[44px] sm:min-h-0 rounded bg-zinc-900 border border-white/20 px-1.5 py-1 text-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed';

export function LaserProjectorControls({ rig, laser, onPatch }: {
  rig: RigConfig; laser: ShowState['laser']; onPatch: (patch: Partial<ShowState['laser']>) => void;
}) {
  const units = useMemo(() => laserProjectors(rig), [rig]);
  const [selection, setSelection] = useState('');
  const selectedUnit = units.find(unit => unit.key === selection);
  const key = selectedUnit ? selectedUnit.key : '';
  const local = laser.projectors?.[key];
  const mode = local?.colorMode ?? laser.colorMode;
  const count = local?.beamCount ?? laser.beamCount;
  const segments = local?.patternSegments ?? laser.patternSegments ?? DEFAULT_LASER_RESOLUTION;

  const selectedEntry = selectedUnit ? getCatalogEntry(selectedUnit.catalogId) : undefined;
  const selectedLaserSpec = selectedEntry?.laser;
  // Disable color controls when the selected projector (or every projector in the rig) is single-color.
  const allSingleColor = units.length > 0 && units.every((u) => getCatalogEntry(u.catalogId)?.laser?.colorType === 'single');
  const singleColorSpec = selectedLaserSpec?.colorType === 'single'
    ? selectedLaserSpec
    : (!key && allSingleColor ? getCatalogEntry(units[0]?.catalogId)?.laser : undefined);
  const isSingleColor = Boolean(singleColorSpec);
  const singleColorHint = singleColorSpec
    ? `Single-colour ${singleColorSpec.wavelengthNm ?? 520} nm projector`
    : undefined;

  const apply = (patch: Partial<LaserAppearance>) => {
    if (!key) onPatch(patch);
    else onPatch({ projectors: { ...laser.projectors, [key]: { ...local, ...patch } } });
  };
  const reset = () => {
    const projectors = { ...laser.projectors };
    delete projectors[key];
    onPatch({ projectors: Object.keys(projectors).length ? projectors : undefined });
  };

  return <fieldset className="min-w-0 grid grid-cols-2 gap-x-2 gap-y-1.5 text-[10px] text-zinc-300">
    <legend className="sr-only">Laser projector settings</legend>
    <label className="col-span-2">Projector
      <select aria-label="Laser projector" className={selectStyle} value={key} onChange={e => setSelection(e.target.value)}>
        <option value="">All projectors · defaults</option>
        {units.map(unit => <option key={unit.key} value={unit.key}>{unit.label}{laser.projectors?.[unit.key] ? ' · edited' : ''}</option>)}
      </select>
    </label>
    {selectedLaserSpec && (
      <div className="col-span-2 font-mono-tech text-[9px] text-emerald-300/90 flex flex-wrap gap-x-2 gap-y-0.5">
        <span>{selectedLaserSpec.opticalPowerW < 1 ? `${Math.round(selectedLaserSpec.opticalPowerW * 1000)} mW` : `${selectedLaserSpec.opticalPowerW} W`}</span>
        <span>{selectedLaserSpec.colorType === 'single' ? `${selectedLaserSpec.wavelengthNm ?? 520} nm` : 'RGB'}</span>
        <span>{selectedLaserSpec.scanSpeedKpps} kpps</span>
        <span>{selectedLaserSpec.maxScanAngleDeg}° max</span>
        <span>Class {selectedLaserSpec.laserClass}</span>
        <span>{selectedLaserSpec.capability === 'beam' ? 'Beam only' : 'Beam + Graphic'}</span>
      </div>
    )}
    <label>Beams per projector <output className="text-emerald-300">{count}</output>
      <input className="w-full accent-emerald-400" aria-label="Beams per projector" type="range" min={1} max={32} step={1}
        value={count} onChange={e => apply({ beamCount: e.target.valueAsNumber })}/>
    </label>
    <label>Pattern resolution
      <select className={selectStyle} aria-label="Laser pattern resolution" value={segments}
        onChange={e => apply({ patternSegments: Number(e.target.value) as LaserResolution })}>
        {LASER_RESOLUTIONS.map(n => <option key={n} value={n}>{n} segments</option>)}
      </select>
    </label>
    <label>Laser color
      <select
        className={selectStyle}
        aria-label="Laser color mode"
        aria-describedby={isSingleColor ? 'single-color-laser-hint' : undefined}
        disabled={isSingleColor}
        value={isSingleColor ? 'primary' : mode}
        onChange={e => apply({ colorMode: e.target.value as LaserColorMode })}
      >
        {colorModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    <div className="flex items-end gap-2">
      {!isSingleColor && (mode === 'custom' || mode === 'custom_dual') && <label>Color A
        <input aria-label="Laser color A" type="color" className="block h-8 sm:h-6 w-10 sm:w-9 cursor-pointer"
          value={local?.colorA ?? laser.colorA ?? DEFAULT_LASER_COLORS[0]} onChange={e => apply({ colorA: e.target.value })}/>
      </label>}
      {!isSingleColor && mode === 'custom_dual' && <label>Color B
        <input aria-label="Laser color B" type="color" className="block h-8 sm:h-6 w-10 sm:w-9 cursor-pointer"
          value={local?.colorB ?? laser.colorB ?? DEFAULT_LASER_COLORS[1]} onChange={e => apply({ colorB: e.target.value })}/>
      </label>}
      {isSingleColor && (
        <span
          id="single-color-laser-hint"
          data-testid="single-color-laser-hint"
          className="text-[9px] font-mono-tech text-emerald-300/90 leading-tight"
        >
          {singleColorHint}
        </span>
      )}
    </div>
    {key && <button type="button" onClick={reset} disabled={!local}
      className="col-span-2 justify-self-start min-h-[44px] sm:min-h-0 text-emerald-300 disabled:text-zinc-500">Use all-projector defaults</button>}
  </fieldset>;
}
