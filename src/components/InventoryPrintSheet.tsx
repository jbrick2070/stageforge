import React from 'react';
import { createPortal } from 'react-dom';
import type { RigConfig } from '../types/show';
import type { EquipmentInventory, SpecSource } from '../data/equipmentInventory';
import { shopProfileLabel, type ShopStockState } from '../data/shopStock';

interface InventoryPrintSheetProps {
  rig: RigConfig;
  inventory: EquipmentInventory;
  shopStock: ShopStockState;
}

function sourceWord(w: SpecSource, p: SpecSource): string {
  if (w === 'datasheet' && p === 'datasheet') return 'Datasheet';
  if (w === 'unverified' || p === 'unverified') return 'Unverified*';
  if (w === 'datasheet' || p === 'datasheet') return 'Partial*';
  return 'Estimate*';
}

/**
 * High-contrast black-on-white printable rental sheet portalled outside `#root`.
 * Hidden on screen (`.print-sheet { display: none }`) and revealed exclusively under `@media print`.
 */
export const InventoryPrintSheet: React.FC<InventoryPrintSheetProps> = ({
  rig,
  inventory,
  shopStock,
}) => {
  if (typeof document === 'undefined') return null;

  const now = new Date();
  const generatedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const stockByKey = new Map(inventory.stock.map((s) => [s.stockKey, s]));
  const hasStockLimits = shopStock.profileId !== 'unlimited';

  return createPortal(
    <section className="print-sheet" aria-label="Printable equipment rental sheet">
      <header className="print-header">
        <div>
          <h1>{rig.name} — Equipment &amp; Rental List</h1>
          <p className="print-meta">
            Venue: {rig.venue.toUpperCase()} · Shop: {shopProfileLabel(shopStock)} · Date: {generatedDate}
          </p>
        </div>
        <p className="print-disclaimer">
          Illustrative equipment list — verify weights, nameplate power, and rigging loads against manufacturer datasheets.
        </p>
      </header>

      <div className="print-summary">
        <div>
          <strong>Fixtures &amp; FX</strong>
          <span>{inventory.totals.units} units ({inventory.totals.modelRows} line items)</span>
        </div>
        <div>
          <strong>Total Weight</strong>
          <span>
            {Math.round(inventory.totals.weightKg).toLocaleString()} kg ({Math.round(inventory.totals.weightLb).toLocaleString()} lb)
          </span>
        </div>
        <div>
          <strong>Nameplate Max Power</strong>
          <span>
            {(inventory.totals.powerW / 1000).toFixed(2)} kW ({Math.round(inventory.totals.powerW).toLocaleString()} W)
          </span>
        </div>
        <div>
          <strong>DMX Channels</strong>
          <span>
            {inventory.totals.channelsUsed} / {inventory.totals.channelsCapacity} used
            {inventory.totals.unpatchedUnits > 0 ? ` · ${inventory.totals.unpatchedUnits} unpatched` : ''}
          </span>
        </div>
      </div>

      {hasStockLimits && inventory.shortages.length > 0 && (
        <div className="print-shortages">
          <h2>Sub-Rental / Shop Shortages</h2>
          <table>
            <caption>Equipment exceeding {shopProfileLabel(shopStock)} stock</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Need</th>
                <th scope="col">In Stock</th>
                <th scope="col">Sub-Rent</th>
              </tr>
            </thead>
            <tbody>
              {inventory.shortages.map((s) => (
                <tr key={s.stockKey}>
                  <td>{s.model}</td>
                  <td>{s.need}</td>
                  <td>{s.inStock ?? '—'}</td>
                  <td>{s.subRent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <table>
        <caption>Lighting, Lasers &amp; FX by Model</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Model</th>
            <th scope="col">DMX Mode</th>
            <th scope="col">Qty</th>
            {hasStockLimits && <th scope="col">Stock / Sub-Rent</th>}
            <th scope="col">Weight (kg / lb)</th>
            <th scope="col">Power (W max)</th>
            <th scope="col">Addresses</th>
            <th scope="col">Spec</th>
          </tr>
        </thead>
        <tbody>
          {inventory.models.length === 0 ? (
            <tr>
              <td colSpan={hasStockLimits ? 9 : 8}>No lighting, laser, or FX fixtures in this rig.</td>
            </tr>
          ) : (
            inventory.models.map((row) => {
              const stock = stockByKey.get(row.stockKey);
              const fullName = row.manufacturer ? `${row.manufacturer} ${row.model}` : row.model;
              return (
                <tr key={row.key}>
                  <td>{row.category}</td>
                  <td>
                    {fullName}
                    {row.stockPoolNote ? ` (${row.stockPoolNote})` : ''}
                  </td>
                  <td>{row.dmxMode ? `${row.dmxMode} (${row.footprint} ch)` : `${row.footprint} ch`}</td>
                  <td>{row.qty}</td>
                  {hasStockLimits && (
                    <td>
                      {stock && stock.inStock !== null
                        ? stock.subRent > 0
                          ? `Need ${stock.need} · Stock ${stock.inStock} · Sub-rent ${stock.subRent}`
                          : `${stock.inStock} in stock`
                        : '—'}
                    </td>
                  )}
                  <td>
                    {row.totalWeightKg.toFixed(1)} kg ({row.totalWeightLb.toLocaleString()} lb)
                  </td>
                  <td>{row.totalPowerW.toLocaleString()} W</td>
                  <td>
                    {row.addresses}
                    {row.unpatchedUnits > 0 ? ` (${row.unpatchedUnits} unpatched)` : ''}
                  </td>
                  <td>{sourceWord(row.weightSource, row.powerSource)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {inventory.other.length > 0 && (
        <table>
          <caption>Truss, Motors, LED Video, Audio &amp; Stage</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Item</th>
              <th scope="col">Qty</th>
              <th scope="col">Weight (kg / lb)</th>
              <th scope="col">Power (W)</th>
              <th scope="col">Spec</th>
            </tr>
          </thead>
          <tbody>
            {inventory.other.map((item, idx) => (
              <tr key={idx}>
                <td>{item.category}</td>
                <td>{item.label}</td>
                <td>{item.qtyLabel}</td>
                <td>
                  {item.totalWeightKg.toFixed(1)} kg ({Math.round(item.totalWeightLb).toLocaleString()} lb)
                </td>
                <td>{Math.round(item.totalPowerW).toLocaleString()} W</td>
                <td>{item.specSource === 'datasheet' ? 'Datasheet' : 'Estimate*'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <table>
        <caption>DMX Universe Utilization</caption>
        <thead>
          <tr>
            <th scope="col">Universe</th>
            <th scope="col">Used Channels</th>
            <th scope="col">Free Channels</th>
            <th scope="col">Conflicts</th>
            <th scope="col">Overflow (&gt;512)</th>
            <th scope="col">Utilization</th>
          </tr>
        </thead>
        <tbody>
          {inventory.universes.map((u) => (
            <tr key={u.universe}>
              <td>Universe {u.universe}</td>
              <td>{u.usedSlots} / 512</td>
              <td>{u.freeSlots}</td>
              <td>{u.conflictSlots}</td>
              <td>{u.overflowChannels}</td>
              <td>{Math.round(u.utilization * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="print-footnote">
        * Datasheet values are verified against published manufacturer specifications (see docs/equipment.md).
        Unverified and Estimate rows use StageForge touring allowances; power figures represent nameplate maximum draw.
      </footer>
    </section>,
    document.body,
  );
};
