import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import {
  PAPERWORK_SIMULATED_MAP_NOTICE,
  type PaperworkSheetId,
  type ShowPaperwork,
} from '../data/showPaperwork';
import {
  buildPlotPlan,
  DEFAULT_TITLE_BLOCK,
  type PlotTitleBlockState,
} from '../data/plotPlan';
import { LASER_SAFETY_DISCLAIMER } from '../data/laserSafety';
import {
  commissioningActionLabel,
  EMPTY_PREFLIGHT_ACKS,
  type PreflightAcknowledgementState,
  type PreflightReport,
} from '../data/preflight';
import { PlotPlanPage } from './PlotPlanPage';
import { RiggingPowerPrintContent } from './RiggingPowerPrintSheet';

export type PaperworkViewId = 'plot' | PaperworkSheetId | 'commissioning';
export type PaperworkPrintMode = PaperworkViewId | 'book';

interface PaperworkPrintSheetProps {
  rig: RigConfig;
  stage?: NativeStage;
  paperwork: ShowPaperwork;
  mode: PaperworkPrintMode;
  titleBlock?: PlotTitleBlockState;
  preflight?: PreflightReport;
  preflightAcks?: PreflightAcknowledgementState;
  testerName?: string;
}

function formatLocalDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function UnplacedPrintBanner({ paperwork }: { paperwork: ShowPaperwork }) {
  if (paperwork.unplaced.length === 0) return null;
  return (
    <div className="print-shortages">
      <h2>Unplaced Fixture Warning ({paperwork.unplaced.length} units)</h2>
      <p>
        {paperwork.unplaced.length} fixture unit(s) exist in the rig groups but had no available mount slot
        and are omitted from the MVR and DXF placements:{' '}
        {paperwork.unplaced
          .slice(0, 12)
          .map((u) => `${u.positionName} · ${u.modelName} #${u.index + 1}`)
          .join('; ')}
        {paperwork.unplaced.length > 12 ? ` (+${paperwork.unplaced.length - 12} more)` : ''}.
      </p>
    </div>
  );
}

/**
 * High-contrast black-on-white printable show paperwork portalled outside `#root`.
 * Mounts a single `.print-sheet` root matching either one selected sheet or the full 6-sheet Production Book
 * (true-scale Plot Plan first, followed by Patch, Instrument Schedule, Channel Hookup, Power & Load, and Cue Sheet).
 */
export const PaperworkPrintSheet: React.FC<PaperworkPrintSheetProps> = ({
  rig,
  stage,
  paperwork,
  mode,
  titleBlock = DEFAULT_TITLE_BLOCK,
  preflight,
  preflightAcks = EMPTY_PREFLIGHT_ACKS,
  testerName = '',
}) => {
  const generatedDate = formatLocalDate();
  const isBook = mode === 'book';
  const totalBookSheets = preflight ? 7 : 6;
  const show = (id: PaperworkViewId) => isBook || mode === id;
  const needPlot = show('plot');
  const plotPlan = useMemo(
    () =>
      needPlot
        ? buildPlotPlan(paperwork, rig, stage, {
            paper: titleBlock.paper,
            titleBlock,
            generatedDate,
            sheetNumber: 1,
            totalSheets: isBook ? totalBookSheets : 1,
          })
        : null,
    [needPlot, paperwork, rig, stage, titleBlock, generatedDate, isBook, totalBookSheets],
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <section
      className="print-sheet"
      aria-label={isBook ? 'Printable show production book' : 'Printable show paperwork sheet'}
      data-print-mode={mode}
    >
      {plotPlan && (
        <div
          className="print-section plot-page"
          data-paperwork-section="plot"
          data-paper={plotPlan.paper}
        >
          <PlotPlanPage plan={plotPlan} />
        </div>
      )}

      {show('patch') && (
        <div className="print-section" data-paperwork-section="patch">
          <header className="print-header">
            <div>
              <h1>{paperwork.rigName} — Patch Sheet</h1>
              <p className="print-meta">
                Venue: {paperwork.venue.toUpperCase()} · {paperwork.totals.unitCount} fixtures · Date: {generatedDate}
                {isBook ? ` · Sheet 2 of ${totalBookSheets}` : ''}
              </p>
            </div>
            <p className="print-disclaimer">{PAPERWORK_SIMULATED_MAP_NOTICE}</p>
          </header>

          <UnplacedPrintBanner paperwork={paperwork} />

          <div className="print-summary">
            {paperwork.universes.map((u) => (
              <div key={u.universe}>
                <strong>Universe {u.universe}</strong>
                <span>
                  {u.usedChannels} / 512 ch ({u.unitCount} units
                  {u.conflictChannels > 0 ? ` · ${u.conflictChannels} conflict ch` : ''}
                  {u.overflowUnits > 0 ? ` · ${u.overflowUnits} overflow` : ''})
                </span>
              </div>
            ))}
            <div>
              <strong>Patched / Issues</strong>
              <span>
                {paperwork.totals.patchedUnits} OK · {paperwork.totals.conflictUnits} CONFLICT ·{' '}
                {paperwork.totals.overflowUnits} OVERFLOW
              </span>
            </div>
            <div>
              <strong>MVR / DXF Parity</strong>
              <span>Fixture # matches MVR FixtureID; U.Addr matches DXF PATCH_TAGS</span>
            </div>
          </div>

          <table>
            <caption>DMX Patch Sheet (Universe &amp; Address Order)</caption>
            <thead>
              <tr>
                <th scope="col">DMX Range</th>
                <th scope="col">Abs Addr</th>
                <th scope="col">Fix #</th>
                <th scope="col">Position</th>
                <th scope="col">Unit #</th>
                <th scope="col">Model</th>
                <th scope="col">DMX Mode</th>
                <th scope="col">Ch</th>
                <th scope="col">Group</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {paperwork.patchRows.length === 0 ? (
                <tr>
                  <td colSpan={10}>No fixtures in this rig.</td>
                </tr>
              ) : (
                paperwork.patchRows.map((u) => (
                  <tr key={u.fixtureNumber}>
                    <td>{u.dmxRangeLabel}</td>
                    <td>{u.absoluteAddress ?? '—'}</td>
                    <td>{u.fixtureNumber}</td>
                    <td className="print-wrap">{u.positionName}</td>
                    <td>{u.unitNumber}</td>
                    <td className="print-wrap">
                      {u.manufacturer !== 'Generic' ? `${u.manufacturer} ` : ''}
                      {u.modelName}
                    </td>
                    <td className="print-wrap">{u.dmxMode ?? 'Default'}</td>
                    <td>{u.footprint}</td>
                    <td className="print-wrap">{u.groupId}</td>
                    <td>{u.status.toUpperCase()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <footer className="print-footnote">{PAPERWORK_SIMULATED_MAP_NOTICE}</footer>
        </div>
      )}

      {show('instrument') && (
        <div className="print-section print-wide" data-paperwork-section="instrument">
          <header className="print-header">
            <div>
              <h1>{paperwork.rigName} — Instrument Schedule</h1>
              <p className="print-meta">
                Venue: {paperwork.venue.toUpperCase()} · {paperwork.positions.length} positions ·{' '}
                {paperwork.totals.unitCount} fixtures · Date: {generatedDate}
                {isBook ? ` · Sheet 3 of ${totalBookSheets}` : ''}
              </p>
            </div>
            <p className="print-disclaimer">
              Sorted by hanging position and mount order along each truss. Coordinates in metres (Y up, +Z downstage).
            </p>
          </header>

          <UnplacedPrintBanner paperwork={paperwork} />

          <table>
            <caption>Instrument Schedule (Position &amp; Mount Order)</caption>
            <thead>
              <tr>
                <th scope="col">Position</th>
                <th scope="col">Mt #</th>
                <th scope="col">Fix #</th>
                <th scope="col">Unit #</th>
                <th scope="col">Model</th>
                <th scope="col">DMX</th>
                <th scope="col">Mode / Ch</th>
                <th scope="col">Wt (kg)</th>
                <th scope="col">Power (W)</th>
                <th scope="col">Circuit / φ</th>
                <th scope="col">X / Y / Z (m)</th>
                <th scope="col">Optics</th>
                <th scope="col">DXF Block</th>
              </tr>
            </thead>
            <tbody>
              {paperwork.instrumentRows.length === 0 ? (
                <tr>
                  <td colSpan={13}>No fixtures in this rig.</td>
                </tr>
              ) : (
                paperwork.instrumentRows.map((u) => (
                  <tr key={u.fixtureNumber}>
                    <td className="print-wrap">{u.positionName}</td>
                    <td>{u.mountOrder}</td>
                    <td>{u.fixtureNumber}</td>
                    <td>{u.unitNumber}</td>
                    <td className="print-wrap">
                      {u.manufacturer !== 'Generic' ? `${u.manufacturer} ` : ''}
                      {u.modelName}
                    </td>
                    <td>
                      {u.dmxLabel}
                      {u.status !== 'ok' ? ` (${u.status.toUpperCase()})` : ''}
                    </td>
                    <td className="print-wrap">{u.dmxMode ? `${u.dmxMode} (${u.footprint})` : `${u.footprint} ch`}</td>
                    <td>
                      {u.weightKg.toFixed(1)}
                      {u.weightEstimated ? '*' : ''}
                    </td>
                    <td>
                      {u.powerW}
                      {u.powerEstimated ? '*' : ''}
                    </td>
                    <td>{u.circuitId ? `${u.circuitId} (${u.phase})` : '—'}</td>
                    <td>
                      {u.x.toFixed(2)}, {u.y.toFixed(2)}, {u.z.toFixed(2)}
                    </td>
                    <td>{u.opticsNote}</td>
                    <td>{u.dxfBlock}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <footer className="print-footnote">
            {PAPERWORK_SIMULATED_MAP_NOTICE} * Estimated generic hardware allowance. Total fixture weight:{' '}
            {paperwork.totals.totalFixtureWeightKg.toFixed(1)} kg · Total fixture power:{' '}
            {paperwork.totals.totalFixturePowerW.toLocaleString()} W.
          </footer>
        </div>
      )}

      {show('hookup') && (
        <div className="print-section print-wide" data-paperwork-section="hookup">
          <header className="print-header">
            <div>
              <h1>{paperwork.rigName} — Channel Hookup</h1>
              <p className="print-meta">
                Venue: {paperwork.venue.toUpperCase()} · {paperwork.totals.unitCount} channels · Date: {generatedDate}
                {isBook ? ` · Sheet 4 of ${totalBookSheets}` : ''}
              </p>
            </div>
            <p className="print-disclaimer">
              Ordered by Fixture # / Console Channel (matches MVR FixtureID and CustomId).
            </p>
          </header>

          <UnplacedPrintBanner paperwork={paperwork} />

          <table>
            <caption>Channel Hookup (Fixture # / Channel Order)</caption>
            <thead>
              <tr>
                <th scope="col">Fix #</th>
                <th scope="col">Position</th>
                <th scope="col">Unit #</th>
                <th scope="col">Model</th>
                <th scope="col">DMX Address</th>
                <th scope="col">Abs Addr</th>
                <th scope="col">Ch</th>
                <th scope="col">Circuit</th>
                <th scope="col">Phase</th>
                <th scope="col">Wt (kg)</th>
                <th scope="col">Power (W)</th>
                <th scope="col">Optics</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {paperwork.units.length === 0 ? (
                <tr>
                  <td colSpan={13}>No fixtures in this rig.</td>
                </tr>
              ) : (
                paperwork.units.map((u) => (
                  <tr key={u.fixtureNumber}>
                    <td>{u.fixtureNumber}</td>
                    <td className="print-wrap">{u.positionName}</td>
                    <td>{u.unitNumber}</td>
                    <td className="print-wrap">
                      {u.manufacturer !== 'Generic' ? `${u.manufacturer} ` : ''}
                      {u.modelName}
                    </td>
                    <td>{u.dmxRangeLabel}</td>
                    <td>{u.absoluteAddress ?? '—'}</td>
                    <td>{u.footprint}</td>
                    <td>{u.circuitId ?? '—'}</td>
                    <td>{u.phase ?? '—'}</td>
                    <td>
                      {u.weightKg.toFixed(1)}
                      {u.weightEstimated ? '*' : ''}
                    </td>
                    <td>
                      {u.powerW}
                      {u.powerEstimated ? '*' : ''}
                    </td>
                    <td>{u.opticsNote}</td>
                    <td>{u.status.toUpperCase()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          <footer className="print-footnote">
            {PAPERWORK_SIMULATED_MAP_NOTICE} * Estimated generic hardware allowance.
          </footer>
        </div>
      )}

      {show('power') && (
        <div className="print-section" data-paperwork-section="power">
          <RiggingPowerPrintContent
            rig={rig}
            loads={paperwork.loads}
            power={paperwork.power}
            generatedDate={generatedDate}
            sheetLabel={isBook ? `Sheet 5 of ${totalBookSheets}` : undefined}
          />
        </div>
      )}

      {show('cues') && (
        <div className="print-section" data-paperwork-section="cues">
          <header className="print-header">
            <div>
              <h1>{paperwork.rigName} — Cue Sheet</h1>
              <p className="print-meta">
                Venue: {paperwork.venue.toUpperCase()} · {paperwork.totals.cueCount} cues
                {paperwork.timelineFrameRate ? ` · Take TC @ ${paperwork.timelineFrameRate} fps` : ''} · Date:{' '}
                {generatedDate}
                {isBook ? ` · Sheet 6 of ${totalBookSheets}` : ''}
              </p>
            </div>
            <p className="print-disclaimer">
              Stack order matches Console Cue List, OSC `/stageforge/go` index, and MIDI Show Control Q_number.
            </p>
          </header>

          <table>
            <caption>Show Cue Sheet</caption>
            <thead>
              <tr>
                <th scope="col">Cue #</th>
                <th scope="col">Name</th>
                <th scope="col">Tag</th>
                <th scope="col">Follow</th>
                <th scope="col">Take TC</th>
                <th scope="col">Dimmer</th>
                <th scope="col">Lighting</th>
                <th scope="col">Lasers</th>
                <th scope="col">Motors</th>
                <th scope="col">Atmo</th>
                <th scope="col">LED / Media</th>
              </tr>
            </thead>
            <tbody>
              {paperwork.cues.length === 0 ? (
                <tr>
                  <td colSpan={11}>No cues in this show.</td>
                </tr>
              ) : (
                paperwork.cues.map((c) => (
                  <tr key={c.id}>
                    <td>{c.cueNumber}</td>
                    <td className="print-wrap">{c.name}</td>
                    <td className="print-wrap">{c.tag}</td>
                    <td>{c.followLabel}</td>
                    <td>{c.takeTimecode ?? '—'}</td>
                    <td>{c.dimmerLabel}</td>
                    <td>{c.lightingSummary}</td>
                    <td>
                      {c.laserSummary}
                      {c.audienceScanWarning ? ` — WARNING: ${c.audienceScanWarning}` : ''}
                    </td>
                    <td>{c.motorsSummary}</td>
                    <td>{c.atmoSummary}</td>
                    <td className="print-wrap">{c.mediaSummary}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {paperwork.cues.some((c) => c.audienceScanWarning) && (
            <footer className="print-footnote">
              LASER SAFETY: One or more cues enable crowd scanning. {LASER_SAFETY_DISCLAIMER}
            </footer>
          )}
        </div>
      )}

      {show('commissioning') && preflight && (
        <div className="print-section" data-paperwork-section="commissioning">
          <header className="print-header">
            <div>
              <h1>{paperwork.rigName} — Commissioning Record</h1>
              <p className="print-meta">
                Venue: {paperwork.venue.toUpperCase()} · Status: {preflight.badgeLabel} · Rev: {preflight.configRevision} · Date: {generatedDate}
                {isBook ? ` · Sheet 7 of ${totalBookSheets}` : ''}
              </p>
            </div>
            <p className="print-disclaimer">
              {preflight.calibrationNote} {preflight.lsoNotice}
            </p>
          </header>

          <div className="print-summary">
            <div>
              <strong>Pre-flight Status</strong>
              <span>{preflight.badgeLabel} ({preflight.counts.pass} pass · {preflight.counts.warn} warn · {preflight.counts.fail} fail)</span>
            </div>
            <div>
              <strong>Tester / Technician</strong>
              <span>{testerName.trim() || '____________________________'}</span>
            </div>
            <div>
              <strong>Date</strong>
              <span>{titleBlock.date || generatedDate}</span>
            </div>
            <div>
              <strong>Signature</strong>
              <span>____________________________</span>
            </div>
          </div>

          <table>
            <caption>Pre-flight Commissioning Check Results ({preflight.evaluatorVersion})</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Item</th>
                <th scope="col">Location</th>
                <th scope="col">Outcome</th>
                <th scope="col">Operator Action</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {preflight.rows.map((row) => {
                const action = commissioningActionLabel(row, preflight, preflightAcks);
                return (
                  <tr key={row.id}>
                    <td>{row.kind}</td>
                    <td className="print-wrap">{row.label}</td>
                    <td className="print-wrap">{row.location}</td>
                    <td>{row.outcome.toUpperCase()}</td>
                    <td className="print-wrap">{action}</td>
                    <td className="print-wrap">{row.summary}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <footer className="print-footnote">
            Informational commissioning record only — never persisted as enabled. {preflight.disclaimer}
          </footer>
        </div>
      )}
    </section>,
    document.body,
  );
};
