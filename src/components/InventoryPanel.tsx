import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Package,
  Printer,
  Radio,
  Scale,
  SlidersHorizontal,
  Store,
  Zap,
} from 'lucide-react';
import type { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import {
  CATALOG_CATEGORY_LABELS,
  catalogDisplayName,
  EQUIPMENT_CATALOG,
} from '../data/equipmentCatalog';
import {
  equipmentInventoryCsv,
  type EquipmentInventory,
  type SpecSource,
} from '../data/equipmentInventory';
import { downloadStageFile } from '../data/rigImport';
import {
  createCustomStockFrom,
  MAX_STOCK_QTY,
  SHOP_PRESETS,
  shopProfileLabel,
  type ShopProfileId,
  type ShopStockState,
} from '../data/shopStock';
import { EquipmentThumbnail } from './EquipmentThumbnail';

interface InventoryPanelProps {
  rig: RigConfig;
  stage?: NativeStage;
  inventory: EquipmentInventory;
  shopStock: ShopStockState;
  onChangeShopStock: (next: ShopStockState) => void;
  onNotify?: (message: string) => void;
}

function SpecBadge({ source, label }: { source: SpecSource; label?: string }) {
  if (source === 'datasheet') {
    return (
      <span className="inline-block rounded px-1 py-0.5 font-mono-tech text-[9px] bg-emerald-950/70 border border-emerald-500/40 text-emerald-200">
        {label ?? 'datasheet'}
      </span>
    );
  }
  if (source === 'unverified') {
    return (
      <span
        className="inline-block rounded px-1 py-0.5 font-mono-tech text-[9px] bg-amber-950/70 border border-amber-400/50 text-amber-200"
        title="Unverified catalogue spec — using touring allowance"
      >
        {label ?? 'unverified'}
      </span>
    );
  }
  return (
    <span
      className="inline-block rounded px-1 py-0.5 font-mono-tech text-[9px] bg-zinc-800/80 border border-white/15 text-zinc-300"
      title="Touring allowance estimate"
    >
      {label ?? 'estimate'}
    </span>
  );
}

export const InventoryPanel: React.FC<InventoryPanelProps> = ({
  rig,
  stage,
  inventory,
  shopStock,
  onChangeShopStock,
  onNotify,
}) => {
  const [customEditorOpen, setCustomEditorOpen] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const stockByKey = new Map(inventory.stock.map((s) => [s.stockKey, s]));
  const isLimited = shopStock.profileId !== 'unlimited';
  const totalSubRent = inventory.shortages.reduce((sum, s) => sum + s.subRent, 0);

  useEffect(() => {
    if (!exportNotice) return;
    const id = window.setTimeout(() => setExportNotice(''), 3500);
    return () => window.clearTimeout(id);
  }, [exportNotice]);

  const handleProfileChange = (profileId: ShopProfileId) => {
    if (profileId === 'custom') {
      const seedPreset =
        shopStock.profileId === 'club' || shopStock.profileId === 'regional' || shopStock.profileId === 'touring'
          ? shopStock.profileId
          : 'regional';
      const hasCustom = Object.keys(shopStock.customStock).length > 0;
      onChangeShopStock({
        ...shopStock,
        profileId: 'custom',
        customStock: hasCustom ? shopStock.customStock : createCustomStockFrom(seedPreset),
      });
      setCustomEditorOpen(true);
      return;
    }
    onChangeShopStock({
      ...shopStock,
      profileId,
    });
  };

  const handleCustomizeFromPreset = () => {
    const seed =
      shopStock.profileId === 'club' || shopStock.profileId === 'regional' || shopStock.profileId === 'touring'
        ? shopStock.profileId
        : 'regional';
    onChangeShopStock({
      ...shopStock,
      profileId: 'custom',
      customStock: createCustomStockFrom(seed),
    });
    setCustomEditorOpen(true);
  };

  const handleCustomQty = (catalogId: string, parsed: number) => {
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_STOCK_QTY) return;
    onChangeShopStock({
      ...shopStock,
      profileId: 'custom',
      customStock: {
        ...shopStock.customStock,
        [catalogId]: parsed,
      },
    });
  };

  const handleExportCsv = () => {
    const csv = equipmentInventoryCsv(rig, stage, shopStock);
    downloadStageFile(rig.name, 'equipment.csv', new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    setExportNotice('Exported equipment list CSV.');
    onNotify?.('Exported equipment list CSV.');
  };

  const handlePrint = () => {
    window.print();
  };

  const statusText = !isLimited
    ? 'Unlimited shop stock — no quantity limits active.'
    : inventory.shortages.length > 0
      ? `Shortage: ${inventory.shortages.length} ${inventory.shortages.length === 1 ? 'model exceeds' : 'models exceed'} ${shopProfileLabel(shopStock)} stock (${totalSubRent} ${totalSubRent === 1 ? 'unit' : 'units'} to sub-rent).`
      : `All ${inventory.totals.units} fixture units are within ${shopProfileLabel(shopStock)} stock.`;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      {/* Top 4 KPI Summary Cards (2x2 on phone, 4-col on desktop) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 p-3 sm:p-4 bg-black/35 border-b border-white/10">
        <SummaryCard
          icon={<Package className="w-4 h-4 text-cyan-400" />}
          label="FIXTURES & FX"
          value={`${inventory.totals.units} units`}
          sub={`${inventory.totals.modelRows} model ${inventory.totals.modelRows === 1 ? 'line' : 'lines'}`}
          accent="text-cyan-200"
        />
        <SummaryCard
          icon={<Scale className="w-4 h-4 text-amber-400" />}
          label="TOTAL RIG WEIGHT"
          value={`${Math.round(inventory.totals.weightKg).toLocaleString()} kg`}
          sub={`${Math.round(inventory.totals.weightLb).toLocaleString()} lb · ${Math.round(inventory.totals.verifiedWeightShare * 100)}% datasheet`}
          accent="text-amber-200"
        />
        <SummaryCard
          icon={<Zap className="w-4 h-4 text-fuchsia-400" />}
          label="NAMEPLATE MAX POWER"
          value={`${(inventory.totals.powerW / 1000).toFixed(1)} kW`}
          sub={`${Math.round(inventory.totals.powerW).toLocaleString()} W max draw`}
          accent="text-fuchsia-200"
        />
        <SummaryCard
          icon={<Radio className="w-4 h-4 text-emerald-400" />}
          label="DMX CHANNELS USED"
          value={`${inventory.totals.channelsUsed} / ${inventory.totals.channelsCapacity}`}
          sub={
            inventory.totals.unpatchedUnits > 0
              ? `${inventory.totals.unpatchedUnits} unpatched unit${inventory.totals.unpatchedUnits === 1 ? '' : 's'}`
              : `${inventory.universes.length} universes patched`
          }
          accent={inventory.totals.unpatchedUnits > 0 ? 'text-amber-300' : 'text-emerald-200'}
        />
      </div>

      {/* Shop Stock Selector & Export Controls */}
      <div className="px-3 sm:px-4 py-3 bg-black/45 border-b border-white/10 space-y-2.5">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2.5">
          <div className="flex-1 min-w-0 space-y-1">
            <label
              htmlFor="shop-stock-select"
              className="flex items-center gap-1.5 font-mono-tech text-[10px] text-zinc-300 uppercase tracking-wider"
            >
              <Store className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
              <span>Rental shop inventory</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="shop-stock-select"
                aria-label="Shop stock profile"
                value={shopStock.profileId}
                onChange={(e) => handleProfileChange(e.target.value as ShopProfileId)}
                className="gear-touch-control flex-1 min-w-[200px] rounded-lg bg-zinc-900 border border-white/15 px-2.5 py-2 text-xs text-zinc-100"
              >
                {SHOP_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
                <option value="custom">Custom shop (editable quantities)</option>
              </select>
              {isLimited && shopStock.profileId !== 'custom' && (
                <button
                  type="button"
                  onClick={handleCustomizeFromPreset}
                  className="gear-touch-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-white/5 hover:bg-white/15 border border-white/15 px-3 py-2 text-xs text-zinc-200 cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Customize</span>
                </button>
              )}
              {shopStock.profileId === 'custom' && (
                <button
                  type="button"
                  aria-expanded={customEditorOpen}
                  onClick={() => setCustomEditorOpen((v) => !v)}
                  className="gear-touch-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 px-3 py-2 text-xs text-cyan-100 cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{customEditorOpen ? 'Hide stock editor' : 'Edit custom stock'}</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="gear-touch-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/15 px-3 py-2 text-xs font-medium text-zinc-100 cursor-pointer"
            >
              <Printer className="w-4 h-4 text-cyan-300" aria-hidden="true" />
              <span>Print sheet</span>
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              className="gear-touch-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/35 border border-cyan-400/50 px-3 py-2 text-xs font-medium text-cyan-100 cursor-pointer"
            >
              <Download className="w-4 h-4 text-cyan-300" aria-hidden="true" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Soft-override checkbox & Switch to Unlimited */}
        {isLimited && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <label className="gear-touch-control inline-flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
              <input
                type="checkbox"
                checked={shopStock.allowOverStock}
                onChange={(e) =>
                  onChangeShopStock({ ...shopStock, allowOverStock: e.target.checked })
                }
                className="w-4 h-4 accent-cyan-400 rounded cursor-pointer"
              />
              <span>Allow over-stock (plan a sub-rental)</span>
            </label>
            <button
              type="button"
              onClick={() => onChangeShopStock({ ...shopStock, profileId: 'unlimited' })}
              className="gear-touch-control rounded-lg bg-white/5 hover:bg-white/15 border border-white/15 px-3 py-1.5 text-xs text-zinc-200 cursor-pointer"
            >
              Switch to Unlimited
            </button>
          </div>
        )}

        {/* Custom Shop Stock Editor */}
        {shopStock.profileId === 'custom' && customEditorOpen && (
          <div className="rounded-xl bg-black/55 border border-white/10 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono-tech text-[10px] text-cyan-300 uppercase tracking-wider">
                Custom shop stock quantities (0–{MAX_STOCK_QTY})
              </span>
              <div className="flex flex-wrap gap-1.5">
                {(['club', 'regional', 'touring'] as const).map((presetId) => (
                  <button
                    key={presetId}
                    type="button"
                    onClick={() =>
                      onChangeShopStock({
                        ...shopStock,
                        profileId: 'custom',
                        customStock: createCustomStockFrom(presetId),
                      })
                    }
                    className="gear-touch-control rounded bg-white/5 hover:bg-white/15 border border-white/10 px-2.5 py-1 font-mono-tech text-[10px] text-zinc-300 cursor-pointer capitalize"
                  >
                    Copy {presetId}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
              {EQUIPMENT_CATALOG.map((entry) => {
                const qty = shopStock.customStock[entry.id] ?? 0;
                return (
                  <label
                    key={entry.id}
                    className="flex items-center justify-between gap-2 rounded bg-white/5 border border-white/10 px-2 py-1.5 text-[11px]"
                  >
                    <span className="min-w-0 truncate text-zinc-200" title={catalogDisplayName(entry)}>
                      {catalogDisplayName(entry)}
                      <span className="block font-mono-tech text-[9px] text-zinc-500">
                        {CATALOG_CATEGORY_LABELS[entry.category]}
                      </span>
                    </span>
                    <StockQtyInput
                      ariaLabel={`Stock quantity for ${catalogDisplayName(entry)}`}
                      value={qty}
                      onCommit={(next) => handleCustomQty(entry.id, next)}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Polite aria-live Stock Status Banner */}
        <div
          role="status"
          aria-live="polite"
          data-testid="inventory-stock-status"
          className={`rounded-lg border px-3 py-2 text-xs flex flex-col gap-1.5 ${
            !isLimited
              ? 'bg-zinc-900/60 border-white/10 text-zinc-300'
              : inventory.shortages.length > 0
                ? 'bg-amber-950/60 border-amber-400/50 text-amber-100'
                : 'bg-emerald-950/50 border-emerald-500/40 text-emerald-100'
          }`}
        >
          <div className="flex items-center justify-between gap-2 font-medium">
            <div className="flex items-center gap-2 min-w-0">
              {isLimited && inventory.shortages.length > 0 ? (
                <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" aria-hidden="true" />
              )}
              <span>{statusText}</span>
            </div>
            {exportNotice && (
              <span className="font-mono-tech text-[10px] text-cyan-200 shrink-0">{exportNotice}</span>
            )}
          </div>
          {isLimited && inventory.shortages.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {inventory.shortages.map((s) => (
                <span
                  key={s.stockKey}
                  className="inline-flex items-center gap-1 rounded bg-amber-500/20 border border-amber-400/40 px-2 py-0.5 font-mono-tech text-[10px] text-amber-100"
                >
                  {s.model}: Need {s.need} · In stock {s.inStock} · Sub-rent {s.subRent}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Scrollable Body: DMX Universes, Fixtures by Model, Other Production Gear */}
      <div className="p-3 sm:p-4 space-y-4 text-xs">
        {/* DMX Universe Usage */}
        <section aria-labelledby="inventory-dmx-heading" className="bg-black/45 border border-white/10 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="inventory-dmx-heading" className="font-mono-tech text-[10px] tracking-widest text-cyan-400 uppercase">
              DMX Universes &amp; Channel Usage
            </h3>
            <span className="font-mono-tech text-[10px] text-zinc-400">
              {inventory.totals.channelsUsed} / {inventory.totals.channelsCapacity} slots allocated
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {inventory.universes.map((u) => {
              const pct = Math.min(100, Math.round(u.utilization * 100));
              const hasIssue = u.conflictSlots > 0 || u.overflowChannels > 0;
              return (
                <div key={u.universe} className="rounded-lg bg-black/45 border border-white/10 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 font-mono-tech text-[11px]">
                    <span className="font-semibold text-white">Universe {u.universe}</span>
                    <span className={hasIssue ? 'text-amber-300' : 'text-zinc-300'}>
                      {u.usedSlots} / 512 used ({pct}%) · {u.freeSlots} free
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-zinc-800 overflow-hidden flex" aria-hidden="true">
                    <div
                      className={hasIssue ? 'bg-amber-400' : u.universe === 1 ? 'bg-cyan-400' : 'bg-emerald-400'}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {(u.conflictSlots > 0 || u.overflowChannels > 0) && (
                    <div className="flex flex-wrap gap-2 font-mono-tech text-[10px] text-amber-300">
                      {u.conflictSlots > 0 && <span>{u.conflictSlots} conflicting channels</span>}
                      {u.overflowChannels > 0 && <span>{u.overflowChannels} overflow channels (&gt;512)</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Fixtures & FX by Model */}
        <section aria-labelledby="inventory-models-heading" className="bg-black/45 border border-white/10 rounded-xl p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="inventory-models-heading" className="font-mono-tech text-[10px] tracking-widest text-cyan-400 uppercase">
              Fixtures, Lasers &amp; FX by Model ({inventory.totals.units} units)
            </h3>
            <span className="font-mono-tech text-[10px] text-zinc-400">
              Power = nameplate max · Weight = kg (lb)
            </span>
          </div>

          {inventory.models.length === 0 ? (
            <p className="text-zinc-400 py-3 text-center">No lighting, laser, or FX fixtures in this rig.</p>
          ) : (
            <table className="inventory-table w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 font-mono-tech text-[10px] text-zinc-400 uppercase">
                  <th scope="col" className="py-1.5 pr-2">Model</th>
                  <th scope="col" className="py-1.5 px-2">DMX Mode</th>
                  <th scope="col" className="py-1.5 px-2 text-right">Qty</th>
                  {isLimited && <th scope="col" className="py-1.5 px-2">Shop Stock</th>}
                  <th scope="col" className="py-1.5 px-2 text-right">Weight</th>
                  <th scope="col" className="py-1.5 px-2 text-right">Power</th>
                  <th scope="col" className="py-1.5 pl-2">Addresses</th>
                </tr>
              </thead>
              <tbody>
                {inventory.models.map((row) => {
                  const stock = stockByKey.get(row.stockKey);
                  const displayName = row.manufacturer ? `${row.manufacturer} ${row.model}` : row.model;
                  return (
                    <tr key={row.key} className="border-b border-white/5 last:border-0 align-top">
                      <td data-label="Model" className="py-2 pr-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <EquipmentThumbnail
                            family={row.body}
                            catalogId={row.catalogId}
                            className="w-6 h-6 shrink-0 rounded bg-black/50 p-0.5 border border-white/10 mt-0.5"
                          />
                          <div className="min-w-0">
                            <div className="text-zinc-100 font-medium break-words">{displayName}</div>
                            <div className="font-mono-tech text-[10px] text-zinc-400">
                              {row.category}
                              {row.stockPoolNote ? ` · ${row.stockPoolNote}` : ''}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td data-label="DMX Mode" className="py-2 px-2 font-mono-tech text-[11px] text-zinc-300">
                        <div>
                          <div>{row.dmxMode ?? 'Simulator default'}</div>
                          <div className="text-[10px] text-zinc-500">{row.footprint} ch/unit</div>
                        </div>
                      </td>
                      <td data-label="Qty" className="py-2 px-2 text-right font-mono-tech font-semibold text-white">
                        <span>{row.qty}</span>
                      </td>
                      {isLimited && (
                        <td data-label="Shop Stock" className="py-2 px-2 font-mono-tech text-[10px]">
                          <div>
                            {stock && stock.inStock !== null ? (
                              stock.subRent > 0 ? (
                                <span className="inline-block rounded bg-amber-950/70 border border-amber-400/50 px-1.5 py-0.5 text-amber-200">
                                  Need {stock.need} · In stock {stock.inStock} · Sub-rent {stock.subRent}
                                </span>
                              ) : (
                                <span className="inline-block rounded bg-emerald-950/60 border border-emerald-500/40 px-1.5 py-0.5 text-emerald-200">
                                  {stock.inStock} in stock ({stock.inStock - stock.need} free)
                                </span>
                              )
                            ) : (
                              <span className="text-zinc-500">Not tracked</span>
                            )}
                          </div>
                        </td>
                      )}
                      <td data-label="Weight" className="py-2 px-2 text-right font-mono-tech text-zinc-200">
                        <div>
                          <div>{row.totalWeightKg.toFixed(1)} kg</div>
                          <div className="text-[10px] text-zinc-400">
                            {row.totalWeightLb.toLocaleString()} lb · <SpecBadge source={row.weightSource} />
                          </div>
                        </div>
                      </td>
                      <td data-label="Power" className="py-2 px-2 text-right font-mono-tech text-zinc-200">
                        <div>
                          <div>{row.totalPowerW.toLocaleString()} W</div>
                          <div className="text-[10px] text-zinc-400">
                            {row.unitPowerW} W/u · <SpecBadge source={row.powerSource} />
                          </div>
                        </div>
                      </td>
                      <td data-label="Addresses" className="py-2 pl-2 font-mono-tech text-[10px] text-cyan-200 break-words">
                        <div>
                          <div>{row.addresses}</div>
                          {row.unpatchedUnits > 0 && (
                            <div className="text-amber-300 mt-0.5">
                              {row.unpatchedUnits} unpatched (conflict/overflow)
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* Other Production Gear (Trusses, Motors, LED Video, Audio, Stage & Scenery) */}
        {inventory.other.length > 0 && (
          <section aria-labelledby="inventory-other-heading" className="bg-black/45 border border-white/10 rounded-xl p-3 space-y-2">
            <h3 id="inventory-other-heading" className="font-mono-tech text-[10px] tracking-widest text-amber-400 uppercase">
              Truss, Motors, LED Video, Audio &amp; Stage Infrastructure
            </h3>
            <table className="inventory-table w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 font-mono-tech text-[10px] text-zinc-400 uppercase">
                  <th scope="col" className="py-1.5 pr-2">Item</th>
                  <th scope="col" className="py-1.5 px-2">Qty</th>
                  <th scope="col" className="py-1.5 px-2 text-right">Weight</th>
                  <th scope="col" className="py-1.5 pl-2 text-right">Power</th>
                </tr>
              </thead>
              <tbody>
                {inventory.other.map((item, idx) => {
                  const ledStock = item.catalogId ? stockByKey.get(item.catalogId) : undefined;
                  return (
                    <tr key={idx} className="border-b border-white/5 last:border-0 align-top">
                      <td data-label="Item" className="py-2 pr-2">
                        <div className="flex items-start gap-2 min-w-0">
                          {item.body && (
                            <EquipmentThumbnail
                              family={item.body}
                              catalogId={item.catalogId}
                              className="w-6 h-6 shrink-0 rounded bg-black/50 p-0.5 border border-white/10 mt-0.5"
                            />
                          )}
                          <div className="min-w-0">
                            <div className="text-zinc-100 font-medium break-words">{item.label}</div>
                            <div className="font-mono-tech text-[10px] text-zinc-400">
                              {item.category} · <SpecBadge source={item.specSource} />
                            </div>
                            {isLimited && ledStock && ledStock.subRent > 0 && (
                              <div className="mt-1 inline-block rounded bg-amber-950/70 border border-amber-400/50 px-1.5 py-0.5 font-mono-tech text-[10px] text-amber-200">
                                Need {ledStock.need} · In stock {ledStock.inStock} · Sub-rent {ledStock.subRent} (soft warning)
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td data-label="Qty" className="py-2 px-2 font-mono-tech text-zinc-200">
                        <span>{item.qtyLabel}</span>
                      </td>
                      <td data-label="Weight" className="py-2 px-2 text-right font-mono-tech text-zinc-200">
                        <div>
                          <div>{item.totalWeightKg.toFixed(1)} kg</div>
                          <div className="text-[10px] text-zinc-400">{Math.round(item.totalWeightLb).toLocaleString()} lb</div>
                        </div>
                      </td>
                      <td data-label="Power" className="py-2 pl-2 text-right font-mono-tech text-zinc-200">
                        <span>{Math.round(item.totalPowerW).toLocaleString()} W</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}

        <p className="font-mono-tech text-[10px] text-zinc-500">
          Datasheet values come from cited manufacturer specs (docs/equipment.md). Rows badged &quot;unverified&quot; or &quot;estimate&quot; use touring allowances; power values represent nameplate maximum draw.
        </p>
      </div>
    </div>
  );
};

const StockQtyInput: React.FC<{
  ariaLabel: string;
  value: number;
  onCommit: (next: number) => void;
}> = ({ ariaLabel, value, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setDraft(String(value));
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_STOCK_QTY) {
      if (parsed !== value) onCommit(parsed);
      setDraft(String(parsed));
    } else {
      setDraft(String(value));
    }
  };
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      min={0}
      max={MAX_STOCK_QTY}
      step={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="gear-touch-control w-20 rounded bg-zinc-900 border border-white/15 px-2 py-1 text-right font-mono-tech text-xs text-white"
    />
  );
};

const SummaryCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: string;
}> = ({ icon, label, value, sub, accent }) => (
  <div className="bg-black/50 border border-white/10 rounded-xl p-2.5 min-w-0">
    <div className="flex items-center gap-1.5 font-mono-tech text-[9px] text-zinc-400 tracking-wider">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <div className={`font-display font-bold text-base mt-1 ${accent} truncate`}>{value}</div>
    <div className="font-mono-tech text-[9px] text-zinc-400 mt-0.5 truncate">{sub}</div>
  </div>
);
