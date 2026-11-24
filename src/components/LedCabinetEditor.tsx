import { useEffect, useState } from 'react';
import {
  catalogDisplayName,
  catalogLedPanels,
  formatCatalogSpecBadges,
  getCatalogEntry,
} from '../data/equipmentCatalog';
import { initialLedCabinets, ledPlacement, requestedWallSize } from '../data/stageEquipment';
import type { LedCabinets, RigConfig } from '../types/show';

function CabinetField({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (draft.trim() && Number.isInteger(next) && next >= min && next <= max) {
      if (next !== value) onChange(next);
      setDraft(String(next));
    } else setDraft(String(value));
  };
  return <label className="grid gap-0.5 text-[10px] text-zinc-300">
    {label}
    <input type="number" value={draft} min={min} max={max} step={1}
      className="w-full rounded border border-white/15 bg-zinc-900 px-1.5 py-1"
      onChange={e => setDraft(e.currentTarget.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  </label>;
}

export function LedCabinetEditor({ rig, layout, onChange }: {
  rig: RigConfig; layout: ReturnType<typeof ledPlacement>; onChange: (wall: RigConfig['ledWall']) => void;
}) {
  const panel = rig.ledWall.cabinets;
  const update = (cabinets: LedCabinets) => onChange({ ...rig.ledWall, cabinets, ...requestedWallSize(cabinets) });
  if (!panel) return <button type="button" className="rounded border border-white/15 py-1 px-2"
    onClick={() => update(initialLedCabinets(rig.ledWall))}>Build from LED cabinets</button>;

  const panels = catalogLedPanels();
  const activeEntry = getCatalogEntry(panel.cabinetId);
  const selectPanel = (id: string) => {
    if (!id) {
      const { cabinetId: _dropped, ...custom } = panel;
      update(custom);
      return;
    }
    const entry = getCatalogEntry(id);
    if (!entry?.panel) return;
    update({
      ...panel,
      cabinetId: entry.id,
      widthMm: entry.panel.widthMm,
      heightMm: entry.panel.heightMm,
      pixelsWide: entry.panel.pixelsWide,
      pixelsHigh: entry.panel.pixelsHigh,
    });
  };

  const field = (key: keyof Omit<LedCabinets, 'cabinetId'>, label: string, min: number, max: number) =>
    <CabinetField label={label} min={min} max={max} value={panel[key]}
      onChange={value => {
        if (key === 'columns' || key === 'rows') {
          update({ ...panel, [key]: value });
        } else {
          // Manual physical/pixel edits switch the cabinet back to Custom so cabinetId stays truthful.
          const { cabinetId: _dropped, ...custom } = panel;
          update({ ...custom, [key]: value });
        }
      }} />;
  const { wing } = layout;
  const badges = activeEntry ? formatCatalogSpecBadges(activeEntry) : [];
  return <fieldset className="rounded border border-white/15 p-2 space-y-1.5">
    <legend className="px-1 text-xs text-zinc-200">LED cabinets</legend>
    <label className="grid gap-0.5 text-[10px] text-zinc-300">
      Panel model
      <select
        aria-label="Panel model"
        value={activeEntry ? activeEntry.id : panel.cabinetId ? '__saved__' : ''}
        onChange={e => selectPanel(e.target.value)}
        className="w-full rounded border border-white/15 bg-zinc-900 px-1.5 py-1 text-zinc-100"
      >
        <option value="">Custom</option>
        {panels.map(entry => (
          <option key={entry.id} value={entry.id}>
            {catalogDisplayName(entry)} · {entry.panel!.pitchMm} mm ({entry.panel!.widthMm}×{entry.panel!.heightMm} mm)
          </option>
        ))}
        {panel.cabinetId && !activeEntry && (
          <option value="__saved__">Saved panel ({panel.cabinetId})</option>
        )}
      </select>
    </label>
    {activeEntry && (
      <p className="font-mono-tech text-[9px] text-zinc-400">
        {badges.map((b, i) => (
          <span key={i}>
            {i > 0 && ' · '}
            {b.text}
            {b.unverified && <span className="text-amber-300" aria-label="unverified" title="Unverified specification">?</span>}
          </span>
        ))}
      </p>
    )}
    <div className="grid grid-cols-2 gap-2">
      {field('columns', 'Requested columns', 1, 256)}
      {field('rows', 'Requested rows', 1, 256)}
      {field('widthMm', 'Cabinet width (mm)', 50, 2000)}
      {field('heightMm', 'Cabinet height (mm)', 50, 2000)}
      {field('pixelsWide', 'Cabinet width (px)', 1, 4096)}
      {field('pixelsHigh', 'Cabinet height (px)', 1, 4096)}
    </div>
    <output className="block text-xs text-zinc-200" aria-label="Installed LED wall">
      Main wall · {layout.columns} × {layout.rows} cabinets · {layout.pixelsWide} × {layout.pixelsHigh} px
    </output>
    {rig.ledWall.sideWings && <p className="text-xs text-zinc-300">
      Each wing · {wing.columns} × {wing.rows} cabinets · {wing.pixelsWide} × {wing.pixelsHigh} px
    </p>}
    <p className="text-[10px] text-zinc-400">
      {layout.columns * layout.rows + 2 * wing.columns * wing.rows} cabinets installed · Main wall {Number(layout.width.toFixed(3))} × {Number(layout.height.toFixed(3))} m
    </p>
    {layout.scale < 1 && <p className="text-xs text-amber-200">Venue clearance limits the installed grid.</p>}
  </fieldset>;
}
