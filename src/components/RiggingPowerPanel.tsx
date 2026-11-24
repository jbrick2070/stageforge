import React, { useEffect, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Anchor,
  CheckCircle2,
  Download,
  Gauge,
  HelpCircle,
  Printer,
  Scale,
  Zap,
} from 'lucide-react';
import type { PhaseId, PowerPinTarget, PowerSystemId, RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import {
  circuitStatusFor,
  DEFAULT_POWER_SYSTEM,
  PHASE_IDS,
  POWER_SYSTEM_IDS,
  POWER_SYSTEMS,
  riggingPowerCsv,
  type CircuitStatus,
  type PowerReport,
} from '../data/powerReport';
import { RIG_KG_TO_LBS } from '../data/rigCatalog';
import {
  RIGGING_DISCLAIMER,
  statusLabelText,
  type LoadStatus,
  type RigLoadsReport,
} from '../data/rigLoads';
import { downloadStageFile } from '../data/rigImport';

interface RiggingPowerPanelProps {
  rig: RigConfig;
  stage?: NativeStage;
  loads: RigLoadsReport;
  power: PowerReport;
  applyD8Derate: boolean;
  onChangeD8Derate: (next: boolean) => void;
  onChangeRig?: (next: RigConfig) => void;
  onNotify?: (message: string) => void;
}

function statusPillClasses(status: LoadStatus | CircuitStatus): string {
  switch (status) {
    case 'uplift':
    case 'overload':
      return 'bg-rose-950/80 border-rose-400/60 text-rose-200';
    case 'caution':
      return 'bg-amber-950/80 border-amber-400/60 text-amber-200';
    case 'unknown':
      return 'bg-zinc-800/90 border-zinc-500/50 text-zinc-200';
    case 'ok':
      return 'bg-emerald-950/75 border-emerald-500/45 text-emerald-200';
  }
}

function StatusPill({ status, label }: { status: LoadStatus | CircuitStatus; label?: string }) {
  const text = label ?? (status === 'ok' ? 'OK' : status === 'caution' ? 'Caution' : status === 'overload' ? 'Overload' : status === 'uplift' ? 'Uplift' : 'Unverified');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono-tech text-[10px] font-semibold uppercase ${statusPillClasses(status)}`}
    >
      {status === 'overload' || status === 'uplift' ? (
        <AlertOctagon className="w-3 h-3 shrink-0" aria-hidden="true" />
      ) : status === 'caution' ? (
        <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
      ) : status === 'unknown' ? (
        <HelpCircle className="w-3 h-3 shrink-0" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="w-3 h-3 shrink-0" aria-hidden="true" />
      )}
      <span>{text}</span>
    </span>
  );
}

export const RiggingPowerPanel: React.FC<RiggingPowerPanelProps> = ({
  rig,
  stage,
  loads,
  power,
  applyD8Derate,
  onChangeD8Derate,
  onChangeRig,
  onNotify,
}) => {
  const [exportNotice, setExportNotice] = useState('');

  useEffect(() => {
    if (!exportNotice) return;
    const id = window.setTimeout(() => setExportNotice(''), 3500);
    return () => window.clearTimeout(id);
  }, [exportNotice]);

  const updatePowerConfig = (nextPower: RigConfig['power']) => {
    if (!onChangeRig) return;
    const cleaned =
      nextPower &&
      nextPower.system === DEFAULT_POWER_SYSTEM &&
      nextPower.feederA === undefined &&
      (!nextPower.pins || nextPower.pins.length === 0)
        ? undefined
        : nextPower;
    const nextRig: RigConfig = { ...rig };
    if (cleaned) nextRig.power = cleaned;
    else delete nextRig.power;
    onChangeRig(nextRig);
  };

  const handleSystemChange = (system: PowerSystemId) => {
    const spec = POWER_SYSTEMS[system];
    const currentPins = spec.phases === 3 ? rig.power?.pins : undefined;
    const currentFeeder =
      rig.power?.feederA !== undefined && spec.standardFeedersA.includes(rig.power.feederA)
        ? rig.power.feederA
        : undefined;
    updatePowerConfig({
      system,
      ...(currentFeeder !== undefined ? { feederA: currentFeeder } : {}),
      ...(currentPins && currentPins.length > 0 ? { pins: currentPins } : {}),
    });
  };

  const handleFeederChange = (raw: string) => {
    const system = rig.power?.system ?? DEFAULT_POWER_SYSTEM;
    const feederA = raw === 'auto' ? undefined : Number(raw);
    updatePowerConfig({
      system,
      ...(feederA !== undefined && Number.isInteger(feederA) ? { feederA } : {}),
      ...(rig.power?.pins && rig.power.pins.length > 0 ? { pins: rig.power.pins } : {}),
    });
  };

  const handleDepartmentPin = (target: PowerPinTarget, value: string) => {
    const system = rig.power?.system ?? DEFAULT_POWER_SYSTEM;
    const existing = (rig.power?.pins ?? []).filter((p) => p.target !== target);
    const nextPins =
      value === 'auto'
        ? existing
        : [...existing, { target, phase: value as PhaseId }];
    updatePowerConfig({
      system,
      ...(rig.power?.feederA !== undefined ? { feederA: rig.power.feederA } : {}),
      ...(nextPins.length > 0 ? { pins: nextPins } : {}),
    });
  };

  const handleExportCsv = () => {
    const csv = riggingPowerCsv(rig, stage, loads, power);
    downloadStageFile(
      rig.name,
      'rigging-power.csv',
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
    );
    setExportNotice('Exported rigging and power CSV.');
    onNotify?.('Exported rigging and power CSV.');
  };

  const handlePrint = () => {
    window.print();
  };

  const pinLookup = new Map((rig.power?.pins ?? []).map((p) => [p.target, p.phase]));
  const activeFeederA = power.totals.configuredFeederA ?? power.totals.recommendedFeederA;
  const maxPod = loads.pods.reduce<(typeof loads.pods)[number] | undefined>(
    (best, pod) => (!best || pod.maxPointLoadKg > best.maxPointLoadKg ? pod : best),
    undefined,
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
      {/* Guidance Disclaimer */}
      <div
        role="note"
        className="px-3 sm:px-4 py-2 bg-amber-950/35 border-b border-amber-400/30 flex items-start gap-2 text-[11px] text-amber-100"
      >
        <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{RIGGING_DISCLAIMER}</span>
      </div>

      {/* Top 4 KPI Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 p-3 sm:p-4 bg-black/35 border-b border-white/10">
        <SummaryCard
          icon={<Scale className="w-4 h-4 text-amber-400" />}
          label="SUSPENDED / ROOF LOAD"
          value={`${Math.round(loads.totals.totalSuspendedKg).toLocaleString()} kg`}
          sub={`Roof: ${Math.round(loads.totals.totalRoofLoadKg).toLocaleString()} kg · ${Math.round(loads.totals.totalRoofLoadKg * RIG_KG_TO_LBS).toLocaleString()} lb`}
          accent="text-amber-200"
        />
        <SummaryCard
          icon={<Anchor className="w-4 h-4 text-cyan-400" />}
          label="PEAK HOIST POINT"
          value={maxPod ? `${Math.round(maxPod.maxPointLoadKg)} kg` : '0 kg'}
          sub={
            maxPod
              ? `${statusLabelText(loads.worstStatus)} · ${loads.totals.hoistPointCount} pts (${loads.totals.podCount} pods)`
              : 'No overhead trusses'
          }
          accent={
            loads.worstStatus === 'overload' || loads.worstStatus === 'uplift'
              ? 'text-rose-300'
              : loads.worstStatus === 'caution'
                ? 'text-amber-200'
                : 'text-cyan-200'
          }
        />
        <SummaryCard
          icon={<Zap className="w-4 h-4 text-fuchsia-400" />}
          label="CONTINUOUS / TOTAL POWER"
          value={`${power.totals.continuousKva.toFixed(1)} kVA`}
          sub={`${power.totals.totalW.toLocaleString()} W total · ${power.totals.maxPhaseAmps.toFixed(1)} A max φ`}
          accent="text-fuchsia-200"
        />
        <SummaryCard
          icon={<Gauge className="w-4 h-4 text-emerald-400" />}
          label="FEEDER & BALANCE"
          value={`${activeFeederA} A ${power.system.phases === 3 ? '3φ' : '1φ'} · ${power.totals.feederStatus.toUpperCase()}`}
          sub={
            power.system.phases === 3
              ? `Imbal. ${power.totals.imbalancePct.toFixed(1)}% · N ${power.totals.neutralAmps.toFixed(1)} A · Gen ${power.totals.recommendedGeneratorKva} kVA`
              : `Util ${Math.round(power.totals.feederUtilization * 100)}% · Gen ${power.totals.recommendedGeneratorKva} kVA`
          }
          accent={
            power.totals.feederStatus === 'overload'
              ? 'text-rose-300'
              : power.totals.feederStatus === 'caution'
                ? 'text-amber-200'
                : 'text-emerald-200'
          }
        />
      </div>

      {/* Controls Bar */}
      <div className="px-3 sm:px-4 py-3 bg-black/45 border-b border-white/10 space-y-2.5">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2.5">
          <div className="flex flex-wrap items-end gap-2.5 flex-1 min-w-0">
            <label className="flex flex-col gap-1 min-w-[190px] flex-1">
              <span className="font-mono-tech text-[10px] text-zinc-300 uppercase tracking-wider">
                Electrical system
              </span>
              <select
                aria-label="Electrical system"
                value={power.system.id}
                disabled={!onChangeRig}
                onChange={(e) => handleSystemChange(e.target.value as PowerSystemId)}
                className="gear-touch-control rounded-lg bg-zinc-900 border border-white/15 px-2.5 py-2 text-xs text-zinc-100 disabled:opacity-60"
              >
                {POWER_SYSTEM_IDS.map((id) => (
                  <option key={id} value={id}>
                    {POWER_SYSTEMS[id].label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 min-w-[140px]">
              <span className="font-mono-tech text-[10px] text-zinc-300 uppercase tracking-wider">
                Feeder rating
              </span>
              <select
                aria-label="Feeder rating"
                value={power.totals.configuredFeederA === null ? 'auto' : String(power.totals.configuredFeederA)}
                disabled={!onChangeRig}
                onChange={(e) => handleFeederChange(e.target.value)}
                className="gear-touch-control rounded-lg bg-zinc-900 border border-white/15 px-2.5 py-2 text-xs text-zinc-100 disabled:opacity-60"
              >
                <option value="auto">Auto ({power.totals.recommendedFeederA} A rec.)</option>
                {power.totals.configuredFeederA !== null &&
                  !power.system.standardFeedersA.includes(power.totals.configuredFeederA) && (
                    <option value={power.totals.configuredFeederA}>
                      {power.totals.configuredFeederA} A (custom)
                    </option>
                  )}
                {power.system.standardFeedersA.map((a) => (
                  <option key={a} value={a}>
                    {a} A ({power.system.feederUnitLabel})
                  </option>
                ))}
              </select>
            </label>

            <label className="gear-touch-control inline-flex items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-2.5 py-2 text-xs text-zinc-200 cursor-pointer">
              <input
                type="checkbox"
                checked={applyD8Derate}
                onChange={(e) => onChangeD8Derate(e.target.checked)}
                className="accent-cyan-400"
              />
              <span>D8 50% over-people guidance</span>
            </label>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleExportCsv}
              className="gear-touch-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 px-3 py-2 text-xs font-medium text-cyan-100 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={handlePrint}
              className="gear-touch-control inline-flex items-center justify-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/20 px-3 py-2 text-xs font-medium text-white cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Print report</span>
            </button>
          </div>
        </div>

        <p role="status" aria-live="polite" className="text-[11px] font-mono-tech text-zinc-300">
          {exportNotice ||
            `Rigging: ${statusLabelText(loads.worstStatus)} (${loads.totals.overloadPods + loads.totals.upliftPods} critical, ${loads.totals.cautionPods} caution) · Power: ${power.circuits.length} circuits (${power.totals.overloadedCircuits} overloaded) · ${power.system.continuousNote}`}
        </p>
      </div>

      {/* Main Scrollable Content */}
      <div className="p-3 sm:p-4 space-y-5">
        {/* Section 1: Overhead Truss Pods & Hoist Point Loads */}
        <section aria-labelledby="rigging-pods-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3
              id="rigging-pods-heading"
              className="font-mono-tech text-xs font-semibold text-amber-300 uppercase tracking-wider"
            >
              Overhead Truss &amp; Hoist Point Loads ({loads.pods.length} pods)
            </h3>
            <span className="font-mono-tech text-[10px] text-zinc-400">
              Includes +1 kg/fixture clamp allowance (est.) &amp; +10% cable loom allowance
            </span>
          </div>

          {loads.pods.length === 0 ? (
            <p className="rounded-lg bg-black/30 border border-white/10 px-3 py-3 text-xs text-zinc-400">
              No overhead truss pods in this rig.
            </p>
          ) : (
            <div className="space-y-3">
              {loads.pods.map((pod) => (
                <div
                  key={pod.podId}
                  className="rounded-xl bg-black/35 border border-white/10 p-3 space-y-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="font-semibold text-sm text-white">{pod.podName}</h4>
                        <StatusPill status={pod.status} />
                        <span className="font-mono-tech text-[10px] text-zinc-400">
                          {pod.shape.toUpperCase()} · {pod.lengthM.toFixed(1)} m · {pod.motorized ? 'Kinetic' : 'Static'}
                        </span>
                      </div>
                      <p className="font-mono-tech text-[10px] text-zinc-300 mt-0.5">
                        Truss: {pod.trussProfileName} · Hoist: {pod.hoistName} ({pod.hoistClass})
                      </p>
                      <p className="text-[10px] text-zinc-400 mt-0.5">{pod.solverNote}</p>
                    </div>
                    <div className="font-mono-tech text-[10px] text-zinc-300 text-right shrink-0">
                      <div>
                        Suspended: <strong className="text-white">{pod.totalSuspendedKg.toFixed(1)} kg</strong>{' '}
                        ({Math.round(pod.totalSuspendedKg * RIG_KG_TO_LBS)} lb)
                      </div>
                      <div className="text-zinc-400">
                        Truss {pod.trussSelfWeightKg.toFixed(1)} + Fix {pod.fixtureWeightKg.toFixed(1)} + Clamps{' '}
                        {pod.clampAllowanceKg.toFixed(1)} + Cables (+10%) {pod.cableAllowanceKg.toFixed(1)} kg
                      </div>
                    </div>
                  </div>

                  {pod.warnings.length > 0 && (
                    <ul className="space-y-1 rounded-lg bg-amber-950/35 border border-amber-400/30 px-2.5 py-2 text-[11px] text-amber-100">
                      {pod.warnings.map((w, idx) => (
                        <li key={idx}>• {w}</li>
                      ))}
                    </ul>
                  )}

                  {/* Per-Point Table */}
                  <table className="inventory-table w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-white/10 font-mono-tech text-[10px] text-zinc-400 uppercase text-left">
                        <th className="py-1.5 pr-2">Point</th>
                        <th className="py-1.5 px-2 text-right">Hoist load</th>
                        {pod.motorized && <th className="py-1.5 px-2 text-right">Kinetic ×1.2</th>}
                        <th className="py-1.5 px-2 text-right">Roof load</th>
                        <th className="py-1.5 px-2 text-right">Eff. WLL</th>
                        <th className="py-1.5 px-2 text-right">Util</th>
                        <th className="py-1.5 pl-2 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pod.points.map((pt) => (
                        <tr key={pt.pointIndex} className="border-b border-white/5 last:border-0">
                          <td className="py-1.5 pr-2 font-mono-tech text-zinc-200">
                            <span>
                              {pt.label}{' '}
                              <span className="text-zinc-500">
                                ({pt.localX.toFixed(2)}, {pt.localZ.toFixed(2)} m)
                              </span>
                            </span>
                          </td>
                          <td data-label="Hoist load" className="py-1.5 px-2 text-right font-mono-tech">
                            <span>
                              {pt.hoistLoadKg.toFixed(1)} kg{' '}
                              <span className="text-zinc-500">
                                ({Math.round(pt.hoistLoadKg * RIG_KG_TO_LBS)} lb)
                              </span>
                            </span>
                          </td>
                          {pod.motorized && (
                            <td data-label="Kinetic ×1.2" className="py-1.5 px-2 text-right font-mono-tech text-amber-200">
                              <span>{pt.kineticLoadKg !== null ? `${pt.kineticLoadKg.toFixed(1)} kg` : '—'}</span>
                            </td>
                          )}
                          <td data-label="Roof load" className="py-1.5 px-2 text-right font-mono-tech text-zinc-300">
                            <span>{pt.roofLoadKg.toFixed(1)} kg</span>
                          </td>
                          <td data-label="Eff. WLL" className="py-1.5 px-2 text-right font-mono-tech text-zinc-300">
                            <span>{pt.effectiveWllKg !== null ? `${Math.round(pt.effectiveWllKg)} kg` : '—'}</span>
                          </td>
                          <td data-label="Util" className="py-1.5 px-2 text-right font-mono-tech">
                            <span>
                              {pt.utilization !== null ? `${Math.round(pt.utilization * 100)}%` : '—'}
                              {pt.kineticUtilization !== null
                                ? ` (${Math.round(pt.kineticUtilization * 100)}% dyn)`
                                : ''}
                            </span>
                          </td>
                          <td data-label="Status" className="py-1.5 pl-2 text-right">
                            <StatusPill status={pt.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Span Bending Moment Checks */}
                  {pod.spans.length > 0 && (
                    <div className="pt-1 border-t border-white/10">
                      <div className="font-mono-tech text-[10px] text-zinc-400 uppercase mb-1">
                        Span Bending Moment Check
                      </div>
                      <table className="inventory-table w-full text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-white/10 font-mono-tech text-[10px] text-zinc-400 uppercase text-left">
                            <th className="py-1 pr-2">Span</th>
                            <th className="py-1 px-2 text-right">Length</th>
                            <th className="py-1 px-2 text-right">Max M</th>
                            <th className="py-1 px-2 text-right">Allow M</th>
                            <th className="py-1 px-2 text-right">Util</th>
                            <th className="py-1 pl-2 text-right">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pod.spans.map((sp) => (
                            <tr key={sp.spanIndex} className="border-b border-white/5 last:border-0">
                              <td className="py-1 pr-2 font-mono-tech text-zinc-200">
                                <span>
                                  {sp.fromLabel}–{sp.toLabel}
                                  {sp.note && <span className="block text-[10px] text-zinc-400">{sp.note}</span>}
                                </span>
                              </td>
                              <td data-label="Length" className="py-1 px-2 text-right font-mono-tech">
                                <span>{sp.spanM.toFixed(2)} m</span>
                              </td>
                              <td data-label="Max M" className="py-1 px-2 text-right font-mono-tech">
                                <span>{sp.maxMomentKgM.toFixed(1)} kg·m</span>
                              </td>
                              <td data-label="Allow M" className="py-1 px-2 text-right font-mono-tech text-zinc-300">
                                <span>
                                  {sp.allowableMomentKgM !== null ? `${sp.allowableMomentKgM.toFixed(1)} kg·m` : '—'}
                                </span>
                              </td>
                              <td data-label="Util" className="py-1 px-2 text-right font-mono-tech">
                                <span>{sp.utilization !== null ? `${Math.round(sp.utilization * 100)}%` : '—'}</span>
                              </td>
                              <td data-label="Status" className="py-1 pl-2 text-right">
                                <StatusPill status={sp.status} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Section 2: Other Flown Loads (Speakers & LED Walls) */}
        {loads.otherFlown.length > 0 && (
          <section aria-labelledby="other-flown-heading" className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3
                id="other-flown-heading"
                className="font-mono-tech text-xs font-semibold text-sky-300 uppercase tracking-wider"
              >
                Other Flown Loads — Audio &amp; LED Video (Separate from Truss Pods)
              </h3>
              <span className="font-mono-tech text-[10px] text-zinc-400">
                Total: {Math.round(loads.totals.otherFlownKg).toLocaleString()} kg (
                {Math.round(loads.totals.otherFlownKg * RIG_KG_TO_LBS).toLocaleString()} lb)
              </span>
            </div>
            <table className="inventory-table w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-white/10 font-mono-tech text-[10px] text-zinc-400 uppercase text-left">
                  <th className="py-1.5 pr-2">Assembly</th>
                  <th className="py-1.5 px-2">Detail</th>
                  <th className="py-1.5 px-2 text-right">Total weight</th>
                  <th className="py-1.5 px-2 text-right">Points</th>
                  <th className="py-1.5 pl-2 text-right">Avg / point</th>
                </tr>
              </thead>
              <tbody>
                {loads.otherFlown.map((item) => (
                  <tr key={item.id} className="border-b border-white/5 last:border-0">
                    <td className="py-1.5 pr-2 text-zinc-100 font-medium">
                      <span>
                        {item.label}{' '}
                        {item.estimated && (
                          <span className="font-mono-tech text-[9px] text-zinc-400">(est.)</span>
                        )}
                      </span>
                    </td>
                    <td data-label="Detail" className="py-1.5 px-2 text-zinc-300">
                      <span>{item.detail}</span>
                    </td>
                    <td data-label="Total weight" className="py-1.5 px-2 text-right font-mono-tech">
                      <span>
                        {Math.round(item.totalWeightKg).toLocaleString()} kg (
                        {Math.round(item.totalWeightLb).toLocaleString()} lb)
                      </span>
                    </td>
                    <td data-label="Points" className="py-1.5 px-2 text-right font-mono-tech">
                      <span>{item.recommendedPoints} pts</span>
                    </td>
                    <td data-label="Avg / point" className="py-1.5 pl-2 text-right font-mono-tech text-cyan-200">
                      <span>{Math.round(item.perPointEstimateKg).toLocaleString()} kg</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* Section 3: Three-Phase Load Balance & Feeder Headroom */}
        <section aria-labelledby="power-balance-heading" className="space-y-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3
              id="power-balance-heading"
              className="font-mono-tech text-xs font-semibold text-fuchsia-300 uppercase tracking-wider"
            >
              {power.system.phases === 3 ? 'Three-Phase Load Balance' : 'Single-Phase Load Summary'} ({power.system.shortLabel})
            </h3>
            <span className="font-mono-tech text-[10px] text-zinc-400">
              Continuous: {(power.totals.continuousW / 1000).toFixed(2)} kW / {power.totals.continuousKva.toFixed(2)} kVA
              {power.totals.audioTypicalEighthW > 0
                ? ` · Audio est. ⅛-power: ${(power.totals.audioTypicalEighthW / 1000).toFixed(1)} kW`
                : ''}
            </span>
          </div>

          <div className={`grid gap-2.5 ${power.system.phases === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1'}`}>
            {power.phases.map((p) => {
              const pct = activeFeederA > 0 ? Math.min(100, (p.amps / activeFeederA) * 100) : 0;
              const phaseStatus = circuitStatusFor(p.amps, activeFeederA, power.system.continuousFactor);
              return (
                <div
                  key={p.phase}
                  className="rounded-lg bg-black/40 border border-white/10 p-2.5 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono-tech text-xs font-bold text-white">{p.phase}</span>
                      <StatusPill status={phaseStatus} />
                    </div>
                    <span className="font-mono-tech text-[11px] text-cyan-200">
                      {p.amps.toFixed(1)} A / {activeFeederA} A
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        phaseStatus === 'overload'
                          ? 'bg-rose-500'
                          : phaseStatus === 'caution'
                            ? 'bg-amber-400'
                            : 'bg-cyan-400'
                      }`}
                      style={{ width: `${pct.toFixed(1)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between font-mono-tech text-[10px] text-zinc-400">
                    <span>
                      {p.kw.toFixed(2)} kW · {p.kva.toFixed(2)} kVA
                    </span>
                    <span>{p.circuitCount} circuits</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
            <div className="rounded-lg bg-black/35 border border-white/10 p-2.5 space-y-1">
              <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">
                Neutral &amp; Feeder Sizing
              </div>
              <div className="font-mono-tech text-xs text-zinc-100">
                Neutral current (linear est.): <strong>{power.totals.neutralAmps.toFixed(1)} A</strong>
                {power.system.phases === 3 && (
                  <> · Imbalance: <strong>{power.totals.imbalancePct.toFixed(1)}%</strong></>
                )}
              </div>
              <div className="font-mono-tech text-[11px] text-zinc-300">
                Recommended feeder: <strong>{power.totals.recommendedFeederA} A</strong> · Generator (+25%):{' '}
                <strong>{power.totals.recommendedGeneratorKva} kVA</strong>
              </div>
              <p className="text-[10px] text-zinc-400">{power.harmonicNote}</p>
            </div>

            <div className="rounded-lg bg-black/35 border border-white/10 p-2.5 space-y-1">
              <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">
                Intermittent Chain Hoists (Excluded from Continuous Balance)
              </div>
              <div className="font-mono-tech text-xs text-zinc-100">
                {power.intermittent.hoistCount} hoists ·{' '}
                <strong>{(power.intermittent.watts / 1000).toFixed(2)} kW</strong> (
                {power.intermittent.ampsPerPhase.toFixed(1)} A/φ running)
              </div>
              <div className="font-mono-tech text-[11px] text-zinc-300">
                Peak phase w/ all hoists moving:{' '}
                <strong>{power.totals.maxPhaseWithHoistsAmps.toFixed(1)} A</strong> (
                {Math.round(power.totals.feederWithHoistsUtilization * 100)}% of {activeFeederA} A feeder)
              </div>
              <p className="text-[10px] text-zinc-400">{power.intermittent.note}</p>
            </div>
          </div>

          {/* Department Phase Pins (3-phase systems only) */}
          {power.system.phases === 3 && onChangeRig && (
            <div className="rounded-lg bg-black/35 border border-white/10 p-2.5">
              <div className="font-mono-tech text-[10px] text-zinc-400 uppercase mb-2">
                Department Phase Pins (optional — Auto balances L1/L2/L3)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  ['ledWall', 'LED Video Wall'],
                  ['audio', 'Audio / PA'],
                  ['foh', 'FOH & Stage Utility'],
                ] as const).map(([target, label]) => (
                  <label key={target} className="flex items-center justify-between gap-2 text-xs text-zinc-200">
                    <span>{label}</span>
                    <select
                      aria-label={`${label} phase pin`}
                      value={pinLookup.get(target) ?? 'auto'}
                      onChange={(e) => handleDepartmentPin(target, e.target.value)}
                      className="gear-touch-control rounded bg-zinc-900 border border-white/15 px-2 py-1 text-xs text-zinc-100"
                    >
                      <option value="auto">Auto</option>
                      {PHASE_IDS.map((ph) => (
                        <option key={ph} value={ph}>
                          Pin {ph}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Section 4: Dimmer & Circuit Schedule */}
        <section aria-labelledby="circuit-schedule-heading" className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3
              id="circuit-schedule-heading"
              className="font-mono-tech text-xs font-semibold text-emerald-300 uppercase tracking-wider"
            >
              Dimmer &amp; Power Circuit Schedule ({power.circuits.length} circuits)
            </h3>
            <span className="font-mono-tech text-[10px] text-zinc-400">
              {power.system.branchBreakerA} A @ {power.system.voltageLN} V circuits
            </span>
          </div>

          <table className="inventory-table w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-white/10 font-mono-tech text-[10px] text-zinc-400 uppercase text-left">
                <th className="py-1.5 pr-2">Circuit</th>
                <th className="py-1.5 px-2">Department &amp; Load</th>
                <th className="py-1.5 px-2 text-right">Watts / VA</th>
                <th className="py-1.5 px-2 text-right">Current</th>
                <th className="py-1.5 px-2 text-right">Phase</th>
                <th className="py-1.5 pl-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {power.circuits.map((c) => (
                <tr key={c.id} className="border-b border-white/5 last:border-0">
                  <td className="py-1.5 pr-2 font-mono-tech font-semibold text-cyan-200">
                    <span>{c.id}</span>
                  </td>
                  <td data-label="Load" className="py-1.5 px-2 text-zinc-200">
                    <span>
                      <span className="text-zinc-400">[{c.department}]</span> {c.description}{' '}
                      {c.units > 1 ? `× ${c.units}` : ''}
                      {c.note && <span className="block text-[10px] text-amber-200">{c.note}</span>}
                    </span>
                  </td>
                  <td data-label="Watts / VA" className="py-1.5 px-2 text-right font-mono-tech">
                    <span>
                      {c.watts.toLocaleString()} W / {Math.round(c.va).toLocaleString()} VA
                    </span>
                  </td>
                  <td data-label="Current" className="py-1.5 px-2 text-right font-mono-tech">
                    <span>
                      {c.amps.toFixed(1)} A / {c.breakerA} A ({Math.round(c.utilization * 100)}%)
                    </span>
                  </td>
                  <td data-label="Phase" className="py-1.5 px-2 text-right font-mono-tech text-zinc-200">
                    <span>
                      {c.phase}
                      {c.pinned ? ' (pin)' : ''}
                    </span>
                  </td>
                  <td data-label="Status" className="py-1.5 pl-2 text-right">
                    <StatusPill status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
};

const SummaryCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent: string;
}> = ({ icon, label, value, sub, accent }) => (
  <div className="bg-black/50 border border-white/10 rounded-xl p-2.5 sm:p-3">
    <div className="flex items-center gap-1.5 font-mono-tech text-[9px] text-zinc-400 tracking-wider">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <div className={`font-display font-bold text-base sm:text-lg mt-1 truncate ${accent}`}>{value}</div>
    <div className="font-mono-tech text-[10px] text-zinc-400 truncate">{sub}</div>
  </div>
);
