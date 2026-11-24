import React from 'react';
import { createPortal } from 'react-dom';
import type { RigConfig } from '../types/show';
import type { PowerReport } from '../data/powerReport';
import { RIG_KG_TO_LBS } from '../data/rigCatalog';
import { RIGGING_DISCLAIMER, statusLabelText, type RigLoadsReport } from '../data/rigLoads';

interface RiggingPowerPrintSheetProps {
  rig: RigConfig;
  loads: RigLoadsReport;
  power: PowerReport;
}

/**
 * High-contrast black-on-white printable rigging & power report portalled outside `#root`.
 * Hidden on screen (`.print-sheet { display: none }`) and revealed exclusively under `@media print`.
 */
export const RiggingPowerPrintSheet: React.FC<RiggingPowerPrintSheetProps> = ({
  rig,
  loads,
  power,
}) => {
  if (typeof document === 'undefined') return null;

  const now = new Date();
  const generatedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const activeFeederA = power.totals.configuredFeederA ?? power.totals.recommendedFeederA;

  return createPortal(
    <section className="print-sheet" aria-label="Printable rigging and power report">
      <header className="print-header">
        <div>
          <h1>{rig.name} — Rigging &amp; Power Report</h1>
          <p className="print-meta">
            Venue: {rig.venue.toUpperCase()} · Power: {power.system.label} · Date: {generatedDate}
          </p>
        </div>
        <p className="print-disclaimer">{RIGGING_DISCLAIMER}</p>
      </header>

      <div className="print-summary">
        <div>
          <strong>Suspended / Roof Load</strong>
          <span>
            {Math.round(loads.totals.totalSuspendedKg).toLocaleString()} kg / Roof{' '}
            {Math.round(loads.totals.totalRoofLoadKg).toLocaleString()} kg (
            {Math.round(loads.totals.totalRoofLoadKg * RIG_KG_TO_LBS).toLocaleString()} lb)
          </span>
        </div>
        <div>
          <strong>Hoist Points</strong>
          <span>
            {loads.totals.hoistPointCount} pts ({loads.totals.podCount} pods) · Status:{' '}
            {statusLabelText(loads.worstStatus)}
          </span>
        </div>
        <div>
          <strong>Total / Continuous Power</strong>
          <span>
            {power.totals.totalW.toLocaleString()} W total · {power.totals.continuousKva.toFixed(2)} kVA cont.
          </span>
        </div>
        <div>
          <strong>Feeder &amp; Neutral</strong>
          <span>
            {activeFeederA} A ({power.totals.maxPhaseAmps.toFixed(1)} A max φ) · N{' '}
            {power.totals.neutralAmps.toFixed(1)} A · Gen {power.totals.recommendedGeneratorKva} kVA
          </span>
        </div>
      </div>

      <table>
        <caption>Overhead Truss &amp; Hoist Point Loads</caption>
        <thead>
          <tr>
            <th scope="col">Pod / Profile</th>
            <th scope="col">Point</th>
            <th scope="col">Hoist</th>
            <th scope="col">Hoist Load (kg / lb)</th>
            <th scope="col">Kinetic ×1.2</th>
            <th scope="col">Roof Load (kg)</th>
            <th scope="col">Eff. WLL (kg)</th>
            <th scope="col">Util</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {loads.pods.length === 0 ? (
            <tr>
              <td colSpan={9}>No overhead truss pods in this rig.</td>
            </tr>
          ) : (
            loads.pods.flatMap((pod) =>
              pod.points.map((pt) => (
                <tr key={`${pod.podId}-${pt.pointIndex}`}>
                  <td>
                    {pod.podName} ({pod.trussProfileName})
                  </td>
                  <td>
                    {pt.label} ({pt.localX.toFixed(1)}, {pt.localZ.toFixed(1)} m)
                  </td>
                  <td>
                    {pod.hoistName} ({pod.hoistClass})
                  </td>
                  <td>
                    {pt.hoistLoadKg.toFixed(1)} kg ({Math.round(pt.hoistLoadKg * RIG_KG_TO_LBS)} lb)
                  </td>
                  <td>{pt.kineticLoadKg !== null ? `${pt.kineticLoadKg.toFixed(1)} kg` : '—'}</td>
                  <td>{pt.roofLoadKg.toFixed(1)} kg</td>
                  <td>{pt.effectiveWllKg !== null ? `${Math.round(pt.effectiveWllKg)} kg` : '—'}</td>
                  <td>{pt.utilization !== null ? `${Math.round(pt.utilization * 100)}%` : '—'}</td>
                  <td>{statusLabelText(pt.status)}</td>
                </tr>
              )),
            )
          )}
        </tbody>
      </table>

      {loads.pods.some((p) => p.spans.length > 0) && (
        <table>
          <caption>Truss Span Bending Moment Guidance</caption>
          <thead>
            <tr>
              <th scope="col">Pod</th>
              <th scope="col">Truss Profile</th>
              <th scope="col">Span</th>
              <th scope="col">Length (m)</th>
              <th scope="col">Max Moment (kg·m)</th>
              <th scope="col">Allowable M (kg·m)</th>
              <th scope="col">Util</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {loads.pods.flatMap((pod) =>
              pod.spans.map((sp) => (
                <tr key={`${pod.podId}-span-${sp.spanIndex}`}>
                  <td>{pod.podName}</td>
                  <td>{pod.trussProfileName}</td>
                  <td>
                    {sp.fromLabel}–{sp.toLabel}
                  </td>
                  <td>{sp.spanM.toFixed(2)}</td>
                  <td>{sp.maxMomentKgM.toFixed(1)}</td>
                  <td>{sp.allowableMomentKgM !== null ? sp.allowableMomentKgM.toFixed(1) : '—'}</td>
                  <td>{sp.utilization !== null ? `${Math.round(sp.utilization * 100)}%` : '—'}</td>
                  <td>{statusLabelText(sp.status)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}

      {loads.otherFlown.length > 0 && (
        <table>
          <caption>Other Flown Loads (Audio &amp; LED Video — Separate from Truss Pods)</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Assembly</th>
              <th scope="col">Detail</th>
              <th scope="col">Total Weight (kg / lb)</th>
              <th scope="col">Points</th>
              <th scope="col">Avg / Point (kg)</th>
            </tr>
          </thead>
          <tbody>
            {loads.otherFlown.map((o) => (
              <tr key={o.id}>
                <td>{o.category}</td>
                <td>{o.label}</td>
                <td>{o.detail}</td>
                <td>
                  {Math.round(o.totalWeightKg).toLocaleString()} kg ({Math.round(o.totalWeightLb).toLocaleString()} lb)
                </td>
                <td>{o.recommendedPoints}</td>
                <td>{Math.round(o.perPointEstimateKg).toLocaleString()} kg</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <table>
        <caption>Phase Load Balance ({power.system.label})</caption>
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Circuits</th>
            <th scope="col">Active Power (kW)</th>
            <th scope="col">Apparent Power (kVA)</th>
            <th scope="col">Current (A)</th>
            <th scope="col">Feeder Util ({activeFeederA} A)</th>
          </tr>
        </thead>
        <tbody>
          {power.phases.map((p) => (
            <tr key={p.phase}>
              <td>{p.phase}</td>
              <td>{p.circuitCount}</td>
              <td>{p.kw.toFixed(2)}</td>
              <td>{p.kva.toFixed(2)}</td>
              <td>{p.amps.toFixed(1)}</td>
              <td>{Math.round((p.amps / activeFeederA) * 100)}%</td>
            </tr>
          ))}
          <tr>
            <td>Intermittent Hoists</td>
            <td>{power.intermittent.hoistCount} hoists</td>
            <td>{(power.intermittent.watts / 1000).toFixed(2)}</td>
            <td>{(power.intermittent.va / 1000).toFixed(2)}</td>
            <td>{power.intermittent.ampsPerPhase.toFixed(1)} A/φ</td>
            <td>Peak w/ hoists: {Math.round(power.totals.feederWithHoistsUtilization * 100)}%</td>
          </tr>
        </tbody>
      </table>

      <table>
        <caption>Dimmer &amp; Power Circuit Schedule</caption>
        <thead>
          <tr>
            <th scope="col">Circuit</th>
            <th scope="col">Department</th>
            <th scope="col">Load</th>
            <th scope="col">Units</th>
            <th scope="col">Watts / VA</th>
            <th scope="col">Amps / Breaker</th>
            <th scope="col">Phase</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {power.circuits.map((c) => (
            <tr key={c.id}>
              <td>{c.id}</td>
              <td>{c.department}</td>
              <td>{c.description}</td>
              <td>{c.units}</td>
              <td>
                {c.watts.toLocaleString()} W / {Math.round(c.va).toLocaleString()} VA
              </td>
              <td>
                {c.amps.toFixed(1)} A / {c.breakerA} A ({Math.round(c.utilization * 100)}%)
              </td>
              <td>
                {c.phase}
                {c.pinned ? ' (pin)' : ''}
              </td>
              <td>{c.status.toUpperCase()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <footer className="print-footnote">
        {RIGGING_DISCLAIMER} Allowances: +1 kg/fixture clamps (est.), +10% cable loom. {power.harmonicNote}
      </footer>
    </section>,
    document.body,
  );
};
