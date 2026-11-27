import React from 'react';
import { AlertTriangle, Crosshair, Eye, Ruler, ShieldAlert, X } from 'lucide-react';
import type { FixtureMeasurement, LaserHazardZone, MeasureSnapshot } from '../data/measure';
import { AIM_CALIBRATION_NOTE, LASER_LSO_NOTICE } from '../data/measure';
import type { MeasureOverlayOptions } from '../engine/measureOverlay';
import { useLive, type LiveStore } from '../state/liveTelemetry';

interface MeasureOverlayHudProps {
  options: MeasureOverlayOptions;
  measureStore: LiveStore<MeasureSnapshot | null>;
  laserZones: readonly LaserHazardZone[];
  onChangeOptions: (patch: Partial<MeasureOverlayOptions>) => void;
  onClose: () => void;
}

function formatLux(lux: number | null): string {
  if (lux === null || !Number.isFinite(lux)) return 'n/a';
  if (lux >= 1000) return `~${Math.round(lux).toLocaleString()} lx (est.)`;
  if (lux >= 10) return `~${lux.toFixed(0)} lx (est.)`;
  return `~${lux.toFixed(1)} lx (est.)`;
}

function formatFootprint(u: FixtureMeasurement): string {
  if (!u.footprint) return '—';
  if (u.footprint.clipped) return 'Clipped by beam length';
  if (u.footprint.grazing || u.footprint.majorDiameterM === null || u.footprint.minorDiameterM === null) {
    return `Grazing (normal ${u.footprint.normalDiameterM.toFixed(2)} m)`;
  }
  if (Math.abs(u.footprint.majorDiameterM - u.footprint.minorDiameterM) < 0.05) {
    return `Ø ${u.footprint.normalDiameterM.toFixed(2)} m`;
  }
  return `${u.footprint.minorDiameterM.toFixed(2)} × ${u.footprint.majorDiameterM.toFixed(2)} m (est.)`;
}

/**
 * Lightweight HUD mounted ONLY while Measure overlay or a safety zone toggle is active.
 * Driven by a <=10 Hz `LiveStore` so React never re-renders the parent `App` tree.
 */
export const MeasureOverlayHud: React.FC<MeasureOverlayHudProps> = ({
  options,
  measureStore,
  laserZones,
  onChangeOptions,
  onClose,
}) => {
  const snapshot = useLive(measureStore);
  const units = snapshot?.units ?? [];
  const selected =
    (options.selectedUnitId ? units.find((u) => u.unitId === options.selectedUnitId) : null) ??
    snapshot?.worstOffenders[0] ??
    units[0] ??
    null;

  // Cap projected hit-point labels to keep DOM light and <= 1 ms frame-time delta.
  const hitLabels: FixtureMeasurement[] = [];
  if (options.enabled && options.showRays && units.length > 0) {
    const seen = new Set<string>();
    const pushLabel = (u: FixtureMeasurement | undefined) => {
      if (!u || seen.has(u.unitId)) return;
      if (!u.inView || u.screenX == null || u.screenY == null || u.throwM === null) return;
      seen.add(u.unitId);
      hitLabels.push(u);
    };
    if (selected) pushLabel(selected);
    for (const u of snapshot?.worstOffenders ?? []) {
      if (hitLabels.length >= 6) break;
      pushLabel(u);
    }
    for (const u of units) {
      if (hitLabels.length >= 8) break;
      if (u.emittedVisible) pushLabel(u);
    }
  }

  return (
    <div
      data-testid="measure-overlay-hud"
      aria-label="Live measurements and safety zones"
      className="stage-measure-overlay pointer-events-none relative z-25 overflow-hidden"
    >
      {/* Projected 3D hit-point labels (distance, incidence, footprint) — solid bg avoids WebGL backdrop-filter cost */}
      {hitLabels.map((u) => {
        const isSel = selected?.unitId === u.unitId;
        const leftPct = Math.max(4, Math.min(92, (u.screenX ?? 0) * 100));
        const topPct = Math.max(10, Math.min(82, (u.screenY ?? 0) * 100));
        return (
          <button
            key={u.unitId}
            type="button"
            data-testid={`measure-hit-label-${u.fixtureNumber}`}
            onClick={() => onChangeOptions({ selectedUnitId: u.unitId })}
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded border px-1.5 py-0.5 font-mono-tech text-[9px] leading-tight cursor-pointer ${
              u.entersAudienceBelowThreshold
                ? 'border-rose-400/90 bg-rose-950/95 text-rose-100'
                : isSel
                  ? 'border-amber-300 bg-amber-950/95 text-amber-100'
                  : 'border-cyan-400/60 bg-zinc-950/90 text-cyan-100 hover:border-cyan-300'
            }`}
          >
            <span className="font-bold">#{u.fixtureNumber}</span>{' '}
            {u.throwM !== null ? `${u.throwM.toFixed(1)}m` : '—'}
            {u.incidenceDeg !== null ? ` · ${Math.round(u.incidenceDeg)}°` : ''}
            {u.footprint?.clipped ? ' · Clipped' : u.footprint ? ` · ${u.footprint.normalDiameterM.toFixed(1)}m` : ''}
          </button>
        );
      })}

      {/* Floating Measure & Safety Zone Control + Readout Panel */}
      <aside
        data-testid="measure-panel"
        aria-label="Measurement readout and safety zones"
        className="pointer-events-auto absolute top-2 left-2.5 z-30 w-[320px] max-w-[calc(100vw-20px)] max-h-[calc(100%_-_16px)] overflow-y-auto bg-zinc-950/92 rounded-xl border border-cyan-400/35 shadow-2xl p-2.5 space-y-2 font-mono-tech text-[10px] text-zinc-100"
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1.5">
          <div className="flex items-center gap-1.5 font-display font-bold text-xs text-cyan-200 tracking-wide">
            <Ruler className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>MEASURE &amp; SAFETY ZONES</span>
          </div>
          <button
            type="button"
            aria-label="Close measure overlay"
            onClick={onClose}
            className="p-1 rounded bg-white/5 hover:bg-rose-500/25 text-zinc-300 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Independent overlay & safety zone toggles (all zones default off) */}
        <div className="grid grid-cols-2 gap-1" role="group" aria-label="Safety zone overlays">
          <label className="flex items-center gap-1.5 rounded border border-white/10 bg-black/40 px-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              data-testid="measure-toggle-rays"
              checked={options.showRays}
              onChange={(e) => onChangeOptions({ showRays: e.target.checked })}
            />
            <span>Beam rays</span>
          </label>
          <label className="flex items-center gap-1.5 rounded border border-white/10 bg-black/40 px-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              data-testid="measure-toggle-audience"
              checked={options.showAudienceZone}
              onChange={(e) => onChangeOptions({ showAudienceZone: e.target.checked })}
            />
            <span>Audience 3.0 m</span>
          </label>
          <label className="flex items-center gap-1.5 rounded border border-white/10 bg-black/40 px-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              data-testid="measure-toggle-nohd"
              checked={options.showLaserNohd}
              onChange={(e) => onChangeOptions({ showLaserNohd: e.target.checked })}
            />
            <span>Laser NOHD</span>
          </label>
          <label className="flex items-center gap-1.5 rounded border border-white/10 bg-black/40 px-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              data-testid="measure-toggle-reach"
              checked={options.showReachMap}
              onChange={(e) => onChangeOptions({ showReachMap: e.target.checked })}
            />
            <span>Reach map (approx.)</span>
          </label>
        </div>

        <p className="text-[9px] text-zinc-400 leading-snug">{AIM_CALIBRATION_NOTE}</p>

        {/* Laser NOHD summary when laser NOHD zone is enabled */}
        {options.showLaserNohd && (
          <div data-testid="measure-nohd-summary" className="rounded border border-amber-400/40 bg-amber-950/35 p-2 space-y-1">
            <div className="flex items-center gap-1 font-semibold text-amber-200">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Laser NOHD (static beam, 0.25 s MPE)</span>
            </div>
            <p className="text-[9px] text-amber-100/90 leading-snug">{LASER_LSO_NOTICE}</p>
            {laserZones.length === 0 ? (
              <p className="text-[9px] text-zinc-400">No laser projectors in this rig.</p>
            ) : (
              <ul className="space-y-1 max-h-24 overflow-y-auto">
                {laserZones.map((z) => (
                  <li key={z.projectorKey} className="text-[9px] leading-snug border-t border-white/10 pt-1">
                    <span className="font-semibold text-white">{z.label}:</span>{' '}
                    {z.nohd.status === 'unknown' ? (
                      <span className="text-rose-300">Cannot assess ({z.nohd.reason})</span>
                    ) : z.nohd.nohdM !== null ? (
                      <span className={z.audienceInsideNohd ? 'text-rose-300' : 'text-amber-200'}>
                        ~{Math.round(z.nohd.nohdM)} m
                        {z.nohd.assumedAperture ? ` (assumed ${z.nohd.apertureMm} mm aperture)` : ''}
                        {z.audienceInsideNohd ? ' · Audience inside NOHD' : ''}
                      </span>
                    ) : (
                      <span className="text-amber-200">{z.nohd.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Selected fixture readout card */}
        {units.length > 0 && (
          <div data-testid="measure-readout-card" className="rounded border border-white/15 bg-black/55 p-2 space-y-1.5">
            <div className="flex items-center justify-between gap-1.5">
              <span className="flex items-center gap-1 font-semibold text-cyan-200">
                <Crosshair className="w-3 h-3" aria-hidden="true" />
                Selected fixture
              </span>
              <select
                aria-label="Select fixture to measure"
                data-testid="measure-fixture-select"
                value={selected?.unitId ?? ''}
                onChange={(e) => onChangeOptions({ selectedUnitId: e.target.value || null })}
                className="max-w-[175px] rounded border border-white/15 bg-black/80 px-1.5 py-0.5 text-[9px] text-white"
              >
                {units.map((u) => (
                  <option key={u.unitId} value={u.unitId}>
                    #{u.fixtureNumber} {u.modelName} ({u.positionName})
                  </option>
                ))}
              </select>
            </div>

            {selected && (
              <>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[9px]">
                  <div>
                    <dt className="text-zinc-400">Pan / DMX</dt>
                    <dd data-testid="measure-pan" className="text-white font-semibold">
                      {selected.panDeg.toFixed(1)}° (DMX {selected.panDmx})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Tilt / DMX</dt>
                    <dd data-testid="measure-tilt" className="text-white font-semibold">
                      {selected.tiltDeg.toFixed(1)}° (DMX {selected.tiltDmx})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Trim (deck / floor)</dt>
                    <dd data-testid="measure-trim" className="text-white">
                      {selected.trimAboveDeckM.toFixed(2)} m / {selected.trimAboveFloorM.toFixed(2)} m
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Throw / hit</dt>
                    <dd data-testid="measure-throw" className="text-white">
                      {selected.throwM !== null
                        ? `${selected.throwM.toFixed(2)} m (${selected.hitSurfaceLabel ?? selected.hitKind})`
                        : 'No hit'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Incidence</dt>
                    <dd data-testid="measure-incidence" className="text-white">
                      {selected.incidenceDeg !== null ? `${selected.incidenceDeg.toFixed(1)}°` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Beam angle</dt>
                    <dd data-testid="measure-beam-angle" className="text-white">
                      {selected.beamAngleDeg.toFixed(1)}°
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Footprint</dt>
                    <dd data-testid="measure-footprint" className="text-white">
                      {formatFootprint(selected)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400">Illuminance</dt>
                    <dd data-testid="measure-lux" className="text-white">
                      {formatLux(selected.luxLiveEst ?? selected.luxFullEst)}
                    </dd>
                  </div>
                  {selected.calibratedOptics && (
                    <div>
                      <dt className="text-zinc-400">Nominal preview flux</dt>
                      <dd className="text-white">
                        {selected.calibratedOptics.nominalPreviewLumens.toLocaleString()} lm ({selected.calibratedOptics.fluxSource})
                      </dd>
                    </div>
                  )}
                </dl>

                {selected.warnings.length > 0 && (
                  <ul className="space-y-0.5 border-t border-white/10 pt-1">
                    {selected.warnings.map((w) => (
                      <li
                        key={w.code}
                        className={`flex items-start gap-1 text-[9px] ${
                          w.severity === 'danger' ? 'text-rose-300' : 'text-amber-300'
                        }`}
                      >
                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
                        <span>{w.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {/* Compact worst offenders list across the entire rig */}
        <div data-testid="measure-worst-offenders" className="rounded border border-white/10 bg-black/45 p-2 space-y-1">
          <div className="flex items-center justify-between text-[9px]">
            <span className="font-semibold text-zinc-200 flex items-center gap-1">
              <Eye className="w-3 h-3 text-cyan-400" aria-hidden="true" />
              Rig warnings ({snapshot?.worstOffenders.length ?? 0})
            </span>
            {snapshot && (
              <span className="text-zinc-400">
                {snapshot.audienceBreachCount} aud · {snapshot.limitWarningCount} lim · {snapshot.noHitCount} miss
              </span>
            )}
          </div>
          {!snapshot || snapshot.worstOffenders.length === 0 ? (
            <p className="text-[9px] text-emerald-300/90">No moving-head aim or audience warnings right now.</p>
          ) : (
            <ul className="space-y-0.5 max-h-24 overflow-y-auto">
              {snapshot.worstOffenders.slice(0, 6).map((u) => (
                <li key={u.unitId}>
                  <button
                    type="button"
                    onClick={() => onChangeOptions({ selectedUnitId: u.unitId })}
                    className={`w-full text-left px-1.5 py-0.5 rounded text-[9px] cursor-pointer hover:bg-white/10 ${
                      u.severityRank === 2 ? 'text-rose-200 bg-rose-950/40' : 'text-amber-200 bg-amber-950/30'
                    }`}
                  >
                    <span className="font-semibold">#{u.fixtureNumber} {u.modelName}</span> — {u.warnings[0]?.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
};
