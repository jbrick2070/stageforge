import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import {
  CATALOG_CATEGORY_LABELS,
  catalogDisplayName,
  catalogForRenderType,
  formatCatalogSpecBadges,
  getCatalogEntry,
  getCatalogMode,
  getSelectableModes,
  LEGACY_DEFAULTS,
  type CatalogCategory,
  type CatalogEntry,
  type HardwareType,
} from '../data/equipmentCatalog';
import { FIXTURE_CATALOG, FLOOR_FX_CATALOG } from '../data/presets';
import { groupFootprint, type GroupModelUpdate } from '../data/dmxPatch';
import type { FloorFxUnit, MountedFixtureGroup } from '../types/show';
import { EquipmentThumbnail } from './EquipmentThumbnail';

type Group = MountedFixtureGroup | FloorFxUnit;

const GENERIC_EQUIPMENT = { ...FIXTURE_CATALOG, ...FLOOR_FX_CATALOG };

interface EquipmentPickerProps {
  group: Group;
  /** Return an error string to reject the selection and keep the picker open, or undefined on success. */
  onApply: (update: GroupModelUpdate) => string | undefined;
}

export const EquipmentPicker: React.FC<EquipmentPickerProps> = ({ group, onApply }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CatalogCategory | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string>(group.catalogId ?? LEGACY_DEFAULTS[group.type]);
  const [selectedMode, setSelectedMode] = useState<string>(group.dmxMode ?? '');
  const [error, setError] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const compatible = useMemo(() => catalogForRenderType(group.type as HardwareType), [group.type]);
  const categories = useMemo(() => {
    const seen = new Set<CatalogCategory>();
    for (const item of compatible) seen.add(item.category);
    return [...seen];
  }, [compatible]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return compatible.filter((entry) => {
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        entry.manufacturer.toLowerCase().includes(q) ||
        entry.model.toLowerCase().includes(q) ||
        (entry.aliases?.some((a) => a.toLowerCase().includes(q)) ?? false) ||
        CATALOG_CATEGORY_LABELS[entry.category].toLowerCase().includes(q)
      );
    });
  }, [compatible, categoryFilter, query]);

  const activeEntry: CatalogEntry | undefined = getCatalogEntry(selectedId) ?? compatible[0];
  const selectableModes = activeEntry ? getSelectableModes(activeEntry) : [];
  const activeMode = activeEntry
    ? selectableModes.find((m) => m.name === selectedMode) ?? selectableModes[0] ?? activeEntry.modes[0]
    : undefined;
  const usingLegacyMode = Boolean(
    activeEntry &&
      group.catalogId === activeEntry.id &&
      group.dmxMode &&
      getCatalogMode(activeEntry, group.dmxMode)?.legacy,
  );
  const legacySpec = GENERIC_EQUIPMENT[group.type];
  const defaultEntry = getCatalogEntry(LEGACY_DEFAULTS[group.type]);
  const width = groupFootprint(group);

  useEffect(() => {
    if (!open) return;
    const initialId = group.catalogId && getCatalogEntry(group.catalogId) ? group.catalogId : LEGACY_DEFAULTS[group.type];
    const initialEntry = getCatalogEntry(initialId) ?? compatible[0];
    const initialModes = initialEntry ? getSelectableModes(initialEntry) : [];
    const currentIsSelectable = Boolean(
      initialEntry &&
        group.catalogId === initialEntry.id &&
        group.dmxMode &&
        initialModes.some((m) => m.name === group.dmxMode),
    );
    setSelectedId(initialEntry?.id ?? '');
    setSelectedMode(currentIsSelectable && group.dmxMode ? group.dmxMode : initialModes[0]?.name ?? initialEntry?.modes[0]?.name ?? '');
    setCategoryFilter('all');
    setQuery('');
    setError('');
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, group.catalogId, group.dmxMode, group.type, compatible]);

  const close = () => {
    setOpen(false);
    setError('');
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const applyEntry = (entry: CatalogEntry, modeName: string) => {
    const mode = getCatalogMode(entry, modeName) ?? entry.modes[0];
    if (!mode) return;
    const err = onApply({
      modelName: catalogDisplayName(entry),
      catalogId: entry.id,
      dmxMode: mode.name,
      dmxChannels: mode.channels,
    });
    if (err) {
      setError(err);
    } else {
      close();
    }
  };

  const applyGeneric = () => {
    const err = onApply({
      modelName: legacySpec.modelName,
      catalogId: undefined,
      dmxMode: undefined,
      dmxChannels: undefined,
    });
    if (err) {
      setError(err);
    } else {
      close();
    }
  };

  const currentEntry = getCatalogEntry(group.catalogId);
  const triggerLabel = currentEntry
    ? `${catalogDisplayName(currentEntry)} · ${width} ch`
    : group.catalogId
      ? `${group.modelName} · ${width} ch`
      : `${group.modelName} · ${width} ch`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Choose equipment model for ${group.modelName}`}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 max-w-full text-left rounded bg-black/40 hover:bg-white/10 border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-200 cursor-pointer"
        title={
          currentEntry
            ? `${catalogDisplayName(currentEntry)} (${group.dmxMode ?? ''}, ${width} ch)`
            : defaultEntry
              ? `Generic ${group.type} (≈ ${catalogDisplayName(defaultEntry)}) — click to pick a real model`
              : 'Pick equipment model'
        }
      >
        <EquipmentThumbnail
          type={group.type as HardwareType}
          catalogId={group.catalogId}
          className="w-3.5 h-3.5 shrink-0"
        />
        <span className="truncate font-medium">{triggerLabel}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-zinc-400" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px] flex items-end sm:items-center justify-center p-2 sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Equipment catalogue for ${group.modelName}`}
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || !dialogRef.current) return;
              const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
              );
              if (!focusable.length) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (e.shiftKey ? document.activeElement === first || !dialogRef.current.contains(document.activeElement) : document.activeElement === last) {
                e.preventDefault();
                (e.shiftKey ? last : first).focus();
              }
            }}
            className="w-full max-w-[380px] max-h-[82vh] bg-zinc-950 border border-white/15 rounded-t-2xl sm:rounded-xl shadow-2xl flex flex-col overflow-hidden text-xs text-zinc-100"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-black/70 border-b border-white/10">
              <div className="min-w-0">
                <div className="font-display font-bold text-xs tracking-wide text-white truncate">
                  EQUIPMENT MODEL &amp; DMX MODE
                </div>
                <div className="font-mono-tech text-[9px] text-zinc-400 truncate">
                  {group.count}× {group.type.replace('_', ' ')} · U{group.dmxUniverse}.{String(group.dmxStartChannel).padStart(3, '0')}
                </div>
              </div>
              <button
                type="button"
                aria-label="Close equipment picker"
                onClick={close}
                className="p-1.5 rounded bg-white/5 hover:bg-rose-500/30 text-zinc-300 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Search & Category Chips */}
            <div className="px-3 py-2 space-y-1.5 border-b border-white/10 bg-black/40">
              <label className="relative flex items-center">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2 pointer-events-none" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="Search equipment catalogue"
                  placeholder="Search manufacturer or model..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full pl-7 pr-2 py-1 rounded bg-zinc-900 border border-white/15 text-[11px] text-zinc-100 placeholder:text-zinc-500"
                />
              </label>

              {categories.length > 1 && (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by equipment category">
                  <button
                    type="button"
                    aria-pressed={categoryFilter === 'all'}
                    onClick={() => setCategoryFilter('all')}
                    className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech border cursor-pointer ${
                      categoryFilter === 'all'
                        ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                        : 'bg-white/5 border-white/10 text-zinc-400'
                    }`}
                  >
                    All ({compatible.length})
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      aria-pressed={categoryFilter === cat}
                      onClick={() => setCategoryFilter(cat)}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-mono-tech border cursor-pointer ${
                        categoryFilter === cat
                          ? 'bg-cyan-500/25 border-cyan-400 text-cyan-100'
                          : 'bg-white/5 border-white/10 text-zinc-400'
                      }`}
                    >
                      {CATALOG_CATEGORY_LABELS[cat]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="px-3 py-1.5 text-[11px] bg-amber-950/70 border-b border-amber-400/40 text-amber-200">
                {error}
              </p>
            )}

            {/* Model list */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              <button
                type="button"
                onClick={applyGeneric}
                className={`w-full text-left rounded-lg border px-2.5 py-1.5 transition cursor-pointer ${
                  !group.catalogId
                    ? 'bg-white/10 border-white/30 text-white'
                    : 'bg-black/30 border-white/10 text-zinc-300 hover:border-white/25'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[11px]">Generic ({legacySpec.modelName})</span>
                  <span className="font-mono-tech text-[9px] text-zinc-400">{legacySpec.dmxFootprint} ch</span>
                </div>
                {defaultEntry && (
                  <div className="text-[9px] text-zinc-400 font-mono-tech">
                    Legacy simulation default · ≈ {catalogDisplayName(defaultEntry)}
                  </div>
                )}
              </button>

              {filtered.map((entry) => {
                const isSelected = activeEntry?.id === entry.id;
                const isCurrent = group.catalogId === entry.id;
                const isDefault = LEGACY_DEFAULTS[group.type] === entry.id;
                const badges = formatCatalogSpecBadges(entry, isSelected ? activeMode?.name : undefined);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => {
                      setSelectedId(entry.id);
                      const modes = getSelectableModes(entry);
                      const keepCurrent = group.catalogId === entry.id && group.dmxMode && modes.some((m) => m.name === group.dmxMode);
                      setSelectedMode(
                        keepCurrent && group.dmxMode
                          ? group.dmxMode
                          : modes[0]?.name ?? entry.modes[0]?.name ?? '',
                      );
                      setError('');
                    }}
                    className={`w-full text-left rounded-lg border px-2.5 py-1.5 transition cursor-pointer ${
                      isSelected
                        ? 'bg-cyan-500/20 border-cyan-400 text-white'
                        : 'bg-black/40 border-white/10 text-zinc-200 hover:border-white/25'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <EquipmentThumbnail
                        family={entry.body}
                        catalogId={entry.id}
                        className="w-7 h-7 shrink-0 mt-0.5 rounded bg-black/50 p-0.5 border border-white/10"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[11px] truncate">
                            {entry.manufacturer} {entry.model}
                          </span>
                          <span className="font-mono-tech text-[9px] text-cyan-300 shrink-0">
                            {CATALOG_CATEGORY_LABELS[entry.category]}
                            {isCurrent ? ' · active' : isDefault ? ' · default' : ''}
                          </span>
                        </div>
                        <div className="font-mono-tech text-[9px] text-zinc-400 mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5">
                          {badges.map((b, i) => (
                            <span key={i}>
                              {i > 0 && <span aria-hidden="true">· </span>}
                              {b.text}
                              {b.unverified && (
                                <span
                                  className="text-amber-300 ml-0.5"
                                  aria-label="unverified"
                                  title="Unverified specification"
                                >
                                  ?
                                </span>
                              )}
                            </span>
                          ))}
                          {entry.placeholder && (
                            <span className="text-amber-300">· placeholder</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}

              {filtered.length === 0 && (
                <p className="text-center text-zinc-400 py-4 text-[11px]">No matching equipment models.</p>
              )}
            </div>

            {/* Footer: DMX mode selector & Apply */}
            {activeEntry && activeMode && (
              <div className="px-3 py-2.5 bg-black/75 border-t border-white/10 space-y-2">
                {usingLegacyMode && (
                  <p className="text-[10px] font-mono-tech text-amber-300 bg-amber-950/50 border border-amber-400/40 rounded px-2 py-1">
                    Using legacy mode ({group.dmxMode}). Apply below to upgrade to a real DMX mode.
                  </p>
                )}
                <label className="block space-y-1">
                  <span className="font-mono-tech text-[9px] text-zinc-400 uppercase tracking-wider">
                    DMX Mode · {catalogDisplayName(activeEntry)}
                  </span>
                  <select
                    aria-label="DMX mode"
                    value={activeMode.name}
                    onChange={(e) => {
                      setSelectedMode(e.target.value);
                      setError('');
                    }}
                    className="w-full min-h-[44px] sm:min-h-0 rounded bg-zinc-900 border border-white/15 px-2 py-1 text-[11px] text-zinc-100"
                  >
                    {(selectableModes.length ? selectableModes : activeEntry.modes).map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name} ({m.channels} ch)
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono-tech text-[9px] text-zinc-400">
                    Total footprint: {activeMode.channels * group.count} ch ({group.count}× {activeMode.channels})
                  </span>
                  <button
                    type="button"
                    onClick={() => applyEntry(activeEntry, activeMode.name)}
                    className="px-3 py-1 rounded bg-cyan-500 hover:bg-cyan-400 text-black font-mono-tech font-bold text-[10px] cursor-pointer"
                  >
                    Apply model
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
