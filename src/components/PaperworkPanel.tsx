import React, { useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Download, Printer, SlidersHorizontal } from 'lucide-react';
import type { RigConfig } from '../types/show';
import type { NativeStage } from '../data/showFile';
import { downloadStageFile } from '../data/rigImport';
import { riggingPowerCsv } from '../data/powerReport';
import {
  buildPlotPlan,
  normalizeRevision,
  type PlotPaperSize,
  type PlotTitleBlockState,
} from '../data/plotPlan';
import {
  channelHookupCsv,
  cueSheetCsv,
  instrumentScheduleCsv,
  PAPERWORK_SIMULATED_MAP_NOTICE,
  patchSheetCsv,
  type PaperworkSheetId,
  type PaperworkUnitStatus,
  type ShowPaperwork,
} from '../data/showPaperwork';
import { RIGGING_DISCLAIMER, statusLabelText } from '../data/rigLoads';
import {
  commissioningActionLabel,
  commissioningRecordCsv,
  EMPTY_PREFLIGHT_ACKS,
  type PreflightAcknowledgementState,
  type PreflightReport,
} from '../data/preflight';
import type { PaperworkPrintMode, PaperworkViewId } from './PaperworkPrintSheet';
import { PlotPlanPage } from './PlotPlanPage';

interface PaperworkPanelProps {
  rig: RigConfig;
  stage?: NativeStage;
  paperwork: ShowPaperwork;
  preflight?: PreflightReport;
  preflightAcks?: PreflightAcknowledgementState;
  testerName?: string;
  onChangeTesterName?: (name: string) => void;
  activeSheet: PaperworkViewId;
  onChangeSheet: (next: PaperworkViewId) => void;
  titleBlock: PlotTitleBlockState;
  onChangeTitleBlock: (next: PlotTitleBlockState) => void;
  onPrint: (mode: PaperworkPrintMode) => void;
  onJumpToRigging?: () => void;
  onNotify?: (message: string) => void;
}

const SHEET_OPTIONS: ReadonlyArray<{
  id: PaperworkViewId;
  label: string;
  shortLabel: string;
  csvSuffix?: string;
  csvNotice?: string;
}> = [
  {
    id: 'plot',
    label: 'Plot plan',
    shortLabel: 'Plot',
  },
  {
    id: 'patch',
    label: 'Patch sheet',
    shortLabel: 'Patch',
    csvSuffix: 'patch-sheet.csv',
    csvNotice: 'Exported patch sheet CSV.',
  },
  {
    id: 'instrument',
    label: 'Instrument schedule',
    shortLabel: 'Instrument',
    csvSuffix: 'instrument-schedule.csv',
    csvNotice: 'Exported instrument schedule CSV.',
  },
  {
    id: 'hookup',
    label: 'Channel hookup',
    shortLabel: 'Hookup',
    csvSuffix: 'channel-hookup.csv',
    csvNotice: 'Exported channel hookup CSV.',
  },
  {
    id: 'power',
    label: 'Power & load',
    shortLabel: 'Power & load',
    csvSuffix: 'rigging-power.csv',
    csvNotice: 'Exported rigging and power CSV.',
  },
  {
    id: 'cues',
    label: 'Cue sheet',
    shortLabel: 'Cues',
    csvSuffix: 'cue-sheet.csv',
    csvNotice: 'Exported cue sheet CSV.',
  },
  {
    id: 'commissioning',
    label: 'Commissioning record',
    shortLabel: 'Commission',
    csvSuffix: 'commissioning-record.csv',
    csvNotice: 'Exported commissioning record CSV.',
  },
];

function formatTodayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function StatusBadge({ status }: { status: PaperworkUnitStatus }) {
  const cls =
    status === 'ok'
      ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40'
      : status === 'conflict'
        ? 'bg-rose-500/25 text-rose-200 border-rose-400/50'
        : 'bg-amber-500/25 text-amber-200 border-amber-400/50';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border font-mono-tech text-[10px] font-semibold ${cls}`}>
      {status.toUpperCase()}
    </span>
  );
}

export const PaperworkPanel: React.FC<PaperworkPanelProps> = ({
  rig,
  stage,
  paperwork,
  preflight,
  preflightAcks = EMPTY_PREFLIGHT_ACKS,
  testerName = '',
  onChangeTesterName,
  activeSheet,
  onChangeSheet,
  titleBlock,
  onChangeTitleBlock,
  onPrint,
  onJumpToRigging,
  onNotify,
}) => {
  const [exportNotice, setExportNotice] = useState('');
  const today = useMemo(() => formatTodayLocal(), []);

  const currentMeta = SHEET_OPTIONS.find((s) => s.id === activeSheet) ?? SHEET_OPTIONS[1];
  const isPlot = activeSheet === 'plot';
  const totalBookSheets = preflight ? 7 : 6;

  const plotPreview = useMemo(() => {
    if (!isPlot) return null;
    return buildPlotPlan(paperwork, rig, stage, {
      paper: titleBlock.paper,
      titleBlock,
      generatedDate: today,
      sheetNumber: 1,
      totalSheets: totalBookSheets,
    });
  }, [isPlot, paperwork, rig, stage, titleBlock, today, totalBookSheets]);

  const handleExportCsv = () => {
    if (activeSheet === 'plot' || !currentMeta.csvSuffix || !currentMeta.csvNotice) return;
    let csv: string;
    if (activeSheet === 'patch') csv = patchSheetCsv(paperwork);
    else if (activeSheet === 'instrument') csv = instrumentScheduleCsv(paperwork);
    else if (activeSheet === 'hookup') csv = channelHookupCsv(paperwork);
    else if (activeSheet === 'cues') csv = cueSheetCsv(paperwork);
    else if (activeSheet === 'commissioning') {
      if (!preflight) return;
      csv = commissioningRecordCsv(preflight, preflightAcks, {
        rigName: paperwork.rigName,
        venue: paperwork.venue,
        testerName,
        date: titleBlock.date || today,
      });
    } else csv = riggingPowerCsv(rig, stage, paperwork.loads, paperwork.power);

    downloadStageFile(rig.name, currentMeta.csvSuffix, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    setExportNotice(currentMeta.csvNotice);
    onNotify?.(currentMeta.csvNotice);
  };

  const updateTitleBlock = (patch: Partial<PlotTitleBlockState>) => {
    onChangeTitleBlock({ ...titleBlock, ...patch });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Sticky sheet selector & action bar */}
      <div className="shrink-0 px-4 sm:px-5 py-3 bg-black/50 border-b border-white/10 space-y-2.5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <fieldset className="paperwork-radio-group flex flex-wrap gap-1.5 border-0 m-0 p-0">
            <legend className="sr-only">Show paperwork sheet</legend>
            {SHEET_OPTIONS.map((opt) => {
              const selected = activeSheet === opt.id;
              return (
                <label
                  key={opt.id}
                  className={`gear-touch-control inline-flex items-center justify-center px-2.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition select-none ${
                    selected
                      ? 'bg-cyan-500/20 border-cyan-400/70 text-cyan-100'
                      : 'bg-white/5 border-white/10 text-zinc-300 hover:bg-white/10'
                  }`}
                >
                  <input
                    type="radio"
                    name="paperwork-sheet"
                    value={opt.id}
                    checked={selected}
                    onChange={() => {
                      setExportNotice('');
                      onChangeSheet(opt.id);
                    }}
                    className="sr-only"
                  />
                  <span className="sm:hidden">{opt.shortLabel}</span>
                  <span className="hidden sm:inline">{opt.label}</span>
                </label>
              );
            })}
          </fieldset>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPrint(activeSheet)}
              className="gear-touch-control inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/15 text-xs font-semibold text-zinc-100 cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Print sheet</span>
            </button>
            <button
              type="button"
              onClick={() => onPrint('book')}
              className="gear-touch-control inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-xs font-semibold text-cyan-100 cursor-pointer"
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Print full book</span>
            </button>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={isPlot}
              title={isPlot ? 'Plot plan is vector print/PDF only; pick a tabular sheet for CSV' : undefined}
              className={`gear-touch-control inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold ${
                isPlot
                  ? 'bg-white/5 border-white/10 text-zinc-500 cursor-not-allowed'
                  : 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-400/50 text-emerald-100 cursor-pointer'
              }`}
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* Collapsible paper size & title block settings (persisted in localStorage, never written to show files) */}
        <details className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5" data-testid="plot-settings">
          <summary className="gear-touch-control flex items-center justify-between gap-2 cursor-pointer text-xs font-semibold text-zinc-200 select-none">
            <span>Plot page &amp; title block</span>
            <span className="font-mono-tech text-[11px] text-cyan-200">
              {titleBlock.paper === 'letter' ? 'Letter' : 'A4'} landscape · Rev {titleBlock.revision}
              {titleBlock.designer ? ` · ${titleBlock.designer}` : ''}
            </span>
          </summary>
          <div className="pt-2.5 pb-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-zinc-300">
              <span className="font-mono-tech text-[10px] uppercase text-zinc-400">Paper size</span>
              <select
                aria-label="Plot paper size"
                value={titleBlock.paper}
                onChange={(e) => updateTitleBlock({ paper: e.target.value as PlotPaperSize })}
                className="gear-touch-control rounded-md border border-white/15 bg-black/60 px-2 py-1 text-xs text-white"
              >
                <option value="a4">A4 landscape (297 × 210 mm)</option>
                <option value="letter">Letter landscape (11 × 8.5 in)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-300">
              <span className="font-mono-tech text-[10px] uppercase text-zinc-400">Venue</span>
              <input
                type="text"
                aria-label="Title block venue"
                maxLength={120}
                value={titleBlock.venue}
                placeholder={paperwork.venue.toUpperCase()}
                onChange={(e) => updateTitleBlock({ venue: e.target.value })}
                className="gear-touch-control rounded-md border border-white/15 bg-black/60 px-2 py-1 text-xs text-white placeholder:text-zinc-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-300">
              <span className="font-mono-tech text-[10px] uppercase text-zinc-400">Designer</span>
              <input
                type="text"
                aria-label="Title block designer"
                maxLength={120}
                value={titleBlock.designer}
                placeholder="Lighting designer"
                onChange={(e) => updateTitleBlock({ designer: e.target.value })}
                className="gear-touch-control rounded-md border border-white/15 bg-black/60 px-2 py-1 text-xs text-white placeholder:text-zinc-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-300">
              <span className="font-mono-tech text-[10px] uppercase text-zinc-400">Revision</span>
              <input
                type="text"
                aria-label="Title block revision"
                maxLength={2}
                value={titleBlock.revision}
                onChange={(e) =>
                  updateTitleBlock({
                    revision: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2),
                  })
                }
                onBlur={(e) => updateTitleBlock({ revision: normalizeRevision(e.target.value) })}
                className="gear-touch-control rounded-md border border-white/15 bg-black/60 px-2 py-1 text-xs font-mono-tech text-white"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-zinc-300">
              <span className="font-mono-tech text-[10px] uppercase text-zinc-400">Date</span>
              <input
                type="text"
                aria-label="Title block date"
                maxLength={32}
                value={titleBlock.date}
                placeholder={today}
                onChange={(e) => updateTitleBlock({ date: e.target.value })}
                className="gear-touch-control rounded-md border border-white/15 bg-black/60 px-2 py-1 text-xs font-mono-tech text-white placeholder:text-zinc-500"
              />
            </label>
          </div>
          <p className="text-[10px] text-zinc-400 pt-1">
            Stored locally in this browser only; never written into show files.
          </p>
        </details>

        <div
          role="status"
          aria-live="polite"
          data-testid="paperwork-status"
          className="font-mono-tech text-[11px] text-zinc-300 flex flex-wrap items-center justify-between gap-2"
        >
          <span>
            {exportNotice ||
              `${paperwork.totals.unitCount} fixtures · ${paperwork.positions.length} positions · ${paperwork.totals.cueCount} cues · Fixture # matches the MVR FixtureID; addresses match the DXF patch tags`}
          </span>
          {(paperwork.totals.conflictUnits > 0 || paperwork.totals.overflowUnits > 0) && (
            <span className="text-rose-300 font-semibold">
              {paperwork.totals.conflictUnits} conflict · {paperwork.totals.overflowUnits} overflow
            </span>
          )}
        </div>
      </div>

      {/* Scrollable sheet body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
        {paperwork.unplaced.length > 0 && (
          <div
            role="alert"
            className="rounded-xl border border-rose-400/50 bg-rose-500/15 px-3.5 py-2.5 text-xs text-rose-100 flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <strong>
                {paperwork.unplaced.length} unplaced fixture unit{paperwork.unplaced.length === 1 ? '' : 's'}
              </strong>{' '}
              could not be assigned a mount slot and are omitted from MVR/DXF placements (rig total:{' '}
              {paperwork.totalExpectedUnits}).
            </div>
          </div>
        )}

        {activeSheet === 'plot' && plotPreview && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-100 flex flex-wrap items-center justify-between gap-2">
              <span>
                True-scale vector plot ({plotPreview.titleBlock.scaleLabel}, {plotPreview.geometry.paperLabel} landscape).
                In the print dialog, choose {plotPreview.geometry.paperLabel} landscape, 10 mm margins, and 100% (&ldquo;Actual size&rdquo;) scale; &ldquo;Print full book&rdquo; puts this plan first as Sheet 1 of {preflight ? 7 : 6}.
              </span>
              {plotPreview.oversizeNote && (
                <span className="font-semibold text-amber-200">{plotPreview.oversizeNote}</span>
              )}
            </div>
            <div className="plot-preview rounded-xl border border-white/15 bg-white p-2 shadow-lg">
              <PlotPlanPage plan={plotPreview} />
            </div>
          </div>
        )}

        {activeSheet === 'patch' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-100">
              {PAPERWORK_SIMULATED_MAP_NOTICE}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {paperwork.universes.map((u) => (
                <div key={u.universe} className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                  <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Universe {u.universe}</div>
                  <div className="font-mono-tech text-sm font-bold text-white mt-0.5">
                    {u.usedChannels} / 512 ch
                  </div>
                  <div className="font-mono-tech text-[10px] text-zinc-400">
                    {u.unitCount} units · {u.freeChannels} free
                    {u.conflictChannels > 0 ? ` · ${u.conflictChannels} conflict` : ''}
                  </div>
                </div>
              ))}
              <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Patched OK</div>
                <div className="font-mono-tech text-sm font-bold text-emerald-300 mt-0.5">
                  {paperwork.totals.patchedUnits} / {paperwork.totals.unitCount}
                </div>
                <div className="font-mono-tech text-[10px] text-zinc-400">MVR &amp; DXF aligned</div>
              </div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Issues</div>
                <div
                  className={`font-mono-tech text-sm font-bold mt-0.5 ${
                    paperwork.totals.conflictUnits + paperwork.totals.overflowUnits > 0
                      ? 'text-rose-300'
                      : 'text-zinc-200'
                  }`}
                >
                  {paperwork.totals.conflictUnits + paperwork.totals.overflowUnits}
                </div>
                <div className="font-mono-tech text-[10px] text-zinc-400">
                  {paperwork.totals.conflictUnits} conflict · {paperwork.totals.overflowUnits} overflow
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="inventory-table w-full text-left border-collapse text-xs">
                <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                  DMX Patch Sheet — sorted by Universe &amp; Start Address
                </caption>
                <thead>
                  <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                    <th scope="col" className="py-2 pr-3">DMX Range</th>
                    <th scope="col" className="py-2 pr-3">Abs</th>
                    <th scope="col" className="py-2 pr-3">Fix #</th>
                    <th scope="col" className="py-2 pr-3">Position</th>
                    <th scope="col" className="py-2 pr-3">Unit #</th>
                    <th scope="col" className="py-2 pr-3">Model</th>
                    <th scope="col" className="py-2 pr-3">Mode</th>
                    <th scope="col" className="py-2 pr-3">Ch</th>
                    <th scope="col" className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {paperwork.patchRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-4 text-center text-zinc-400">
                        No fixtures in this rig.
                      </td>
                    </tr>
                  ) : (
                    paperwork.patchRows.map((u) => (
                      <tr key={u.fixtureNumber} className="hover:bg-white/5">
                        <td data-label="Fixture · DMX" className="py-2 pr-3 font-mono-tech text-cyan-200 whitespace-nowrap">
                          <span>
                            <span className="sm:hidden">#{u.fixtureNumber} · </span>
                            {u.dmxRangeLabel}
                          </span>
                        </td>
                        <td data-label="Abs Addr" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.absoluteAddress ?? '—'}</span>
                        </td>
                        <td data-label="Fixture #" className="py-2 pr-3 font-mono-tech text-white font-semibold">
                          <span>#{u.fixtureNumber}</span>
                        </td>
                        <td data-label="Position" className="py-2 pr-3 text-zinc-200">
                          <span>{u.positionName}</span>
                        </td>
                        <td data-label="Unit #" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.unitNumber}</span>
                        </td>
                        <td data-label="Model" className="py-2 pr-3 text-white">
                          <span>
                            {u.manufacturer !== 'Generic' ? `${u.manufacturer} ` : ''}
                            {u.modelName}
                          </span>
                        </td>
                        <td data-label="DMX Mode" className="py-2 pr-3 text-zinc-300">
                          <span>{u.dmxMode ?? 'Default'}</span>
                        </td>
                        <td data-label="Footprint" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.footprint} ch</span>
                        </td>
                        <td data-label="Status" className="py-2">
                          <span>
                            <StatusBadge status={u.status} />
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSheet === 'instrument' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-100">
              {PAPERWORK_SIMULATED_MAP_NOTICE} * Estimated generic hardware allowance, not a datasheet value.
            </div>
            <div className="overflow-x-auto">
              <table className="inventory-table w-full text-left border-collapse text-xs">
                <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                  Instrument Schedule — sorted by Hanging Position &amp; Mount Order (world coords in metres)
                </caption>
                <thead>
                  <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                    <th scope="col" className="py-2 pr-3">Position</th>
                    <th scope="col" className="py-2 pr-3">Mt #</th>
                    <th scope="col" className="py-2 pr-3">Fix #</th>
                    <th scope="col" className="py-2 pr-3">Unit #</th>
                    <th scope="col" className="py-2 pr-3">Model</th>
                    <th scope="col" className="py-2 pr-3">DMX</th>
                    <th scope="col" className="py-2 pr-3">Circuit / φ</th>
                    <th scope="col" className="py-2 pr-3">Wt / W</th>
                    <th scope="col" className="py-2 pr-3">X / Y / Z (m)</th>
                    <th scope="col" className="py-2">DXF Block</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {paperwork.instrumentRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-4 text-center text-zinc-400">
                        No fixtures in this rig.
                      </td>
                    </tr>
                  ) : (
                    paperwork.instrumentRows.map((u) => (
                      <tr key={u.fixtureNumber} className="hover:bg-white/5">
                        <td data-label="Fixture · Position" className="py-2 pr-3 text-white font-medium">
                          <span>
                            <span className="sm:hidden font-mono-tech text-cyan-200">
                              #{u.fixtureNumber} · {u.dmxLabel} ·{' '}
                            </span>
                            {u.positionName}
                          </span>
                        </td>
                        <td data-label="Mount #" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.mountOrder}</span>
                        </td>
                        <td data-label="Fixture #" className="py-2 pr-3 font-mono-tech text-white font-semibold">
                          <span>#{u.fixtureNumber}</span>
                        </td>
                        <td data-label="Unit #" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.unitNumber}</span>
                        </td>
                        <td data-label="Model" className="py-2 pr-3 text-zinc-100">
                          <span>
                            {u.manufacturer !== 'Generic' ? `${u.manufacturer} ` : ''}
                            {u.modelName}
                          </span>
                        </td>
                        <td data-label="DMX" className="py-2 pr-3 font-mono-tech text-cyan-200 whitespace-nowrap">
                          <span>
                            {u.dmxLabel}
                            {u.status !== 'ok' ? ` (${u.status.toUpperCase()})` : ''}
                          </span>
                        </td>
                        <td data-label="Circuit / Phase" className="py-2 pr-3 font-mono-tech text-zinc-200 whitespace-nowrap">
                          <span>{u.circuitId ? `${u.circuitId} (${u.phase})` : '—'}</span>
                        </td>
                        <td data-label="Weight / Power" className="py-2 pr-3 font-mono-tech text-zinc-300 whitespace-nowrap">
                          <span>
                            {u.weightKg.toFixed(1)}{u.weightEstimated ? '*' : ''} kg · {u.powerW}{u.powerEstimated ? '*' : ''} W
                          </span>
                        </td>
                        <td data-label="Coords (m)" className="py-2 pr-3 font-mono-tech text-zinc-400 whitespace-nowrap">
                          <span>
                            {u.x.toFixed(2)}, {u.y.toFixed(2)}, {u.z.toFixed(2)}
                          </span>
                        </td>
                        <td data-label="DXF Block" className="py-2 font-mono-tech text-zinc-300">
                          <span>{u.dxfBlock}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSheet === 'hookup' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-100">
              {PAPERWORK_SIMULATED_MAP_NOTICE}
            </div>
            <div className="overflow-x-auto">
              <table className="inventory-table w-full text-left border-collapse text-xs">
                <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                  Channel Hookup — sorted by Fixture # / Console Channel (matches MVR FixtureID)
                </caption>
                <thead>
                  <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                    <th scope="col" className="py-2 pr-3">Fix #</th>
                    <th scope="col" className="py-2 pr-3">Position</th>
                    <th scope="col" className="py-2 pr-3">Unit #</th>
                    <th scope="col" className="py-2 pr-3">Model</th>
                    <th scope="col" className="py-2 pr-3">DMX Range</th>
                    <th scope="col" className="py-2 pr-3">Circuit</th>
                    <th scope="col" className="py-2 pr-3">Phase</th>
                    <th scope="col" className="py-2 pr-3">Optics</th>
                    <th scope="col" className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {paperwork.units.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-4 text-center text-zinc-400">
                        No fixtures in this rig.
                      </td>
                    </tr>
                  ) : (
                    paperwork.units.map((u) => (
                      <tr key={u.fixtureNumber} className="hover:bg-white/5">
                        <td data-label="Fixture · DMX" className="py-2 pr-3 font-mono-tech text-white font-semibold whitespace-nowrap">
                          <span>
                            #{u.fixtureNumber}
                            <span className="sm:hidden text-cyan-200"> · {u.dmxLabel}</span>
                          </span>
                        </td>
                        <td data-label="Position" className="py-2 pr-3 text-zinc-200">
                          <span>{u.positionName}</span>
                        </td>
                        <td data-label="Unit #" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.unitNumber}</span>
                        </td>
                        <td data-label="Model" className="py-2 pr-3 text-zinc-100">
                          <span>
                            {u.manufacturer !== 'Generic' ? `${u.manufacturer} ` : ''}
                            {u.modelName}
                          </span>
                        </td>
                        <td data-label="DMX Range" className="py-2 pr-3 font-mono-tech text-cyan-200 whitespace-nowrap">
                          <span>{u.dmxRangeLabel}</span>
                        </td>
                        <td data-label="Circuit" className="py-2 pr-3 font-mono-tech text-zinc-200">
                          <span>{u.circuitId ?? '—'}</span>
                        </td>
                        <td data-label="Phase" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{u.phase ?? '—'}</span>
                        </td>
                        <td data-label="Optics" className="py-2 pr-3 text-zinc-300">
                          <span>{u.opticsNote}</span>
                        </td>
                        <td data-label="Status" className="py-2">
                          <span>
                            <StatusBadge status={u.status} />
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSheet === 'power' && (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-100">
              <span>{RIGGING_DISCLAIMER}</span>
              {onJumpToRigging && (
                <button
                  type="button"
                  onClick={onJumpToRigging}
                  className="gear-touch-control shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 border border-white/20 text-xs font-semibold text-white cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Edit rigging &amp; power</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Roof Load</div>
                <div className="font-mono-tech text-sm font-bold text-white mt-0.5">
                  {Math.round(paperwork.loads.totals.totalRoofLoadKg).toLocaleString()} kg
                </div>
                <div className="font-mono-tech text-[10px] text-zinc-400">
                  {paperwork.loads.totals.hoistPointCount} hoist pts · {statusLabelText(paperwork.loads.worstStatus)}
                </div>
              </div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Total Power</div>
                <div className="font-mono-tech text-sm font-bold text-white mt-0.5">
                  {paperwork.power.totals.totalW.toLocaleString()} W
                </div>
                <div className="font-mono-tech text-[10px] text-zinc-400">
                  {paperwork.power.totals.continuousKva.toFixed(2)} kVA cont.
                </div>
              </div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Feeder ({paperwork.power.system.shortLabel})</div>
                <div className="font-mono-tech text-sm font-bold text-white mt-0.5">
                  {paperwork.power.totals.configuredFeederA ?? paperwork.power.totals.recommendedFeederA} A ·{' '}
                  {paperwork.power.totals.feederStatus.toUpperCase()}
                </div>
                <div className="font-mono-tech text-[10px] text-zinc-400">
                  Max φ {paperwork.power.totals.maxPhaseAmps.toFixed(1)} A · N {paperwork.power.totals.neutralAmps.toFixed(1)} A
                </div>
              </div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-2.5">
                <div className="font-mono-tech text-[10px] text-zinc-400 uppercase">Circuits</div>
                <div className="font-mono-tech text-sm font-bold text-white mt-0.5">
                  {paperwork.power.circuits.length} total
                </div>
                <div className="font-mono-tech text-[10px] text-zinc-400">
                  {paperwork.power.totals.overloadedCircuits} overload · {paperwork.power.totals.cautionCircuits} caution
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="inventory-table w-full text-left border-collapse text-xs">
                <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                  Overhead Hoist Points — exact totals shared with Rigging &amp; power tab
                </caption>
                <thead>
                  <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                    <th scope="col" className="py-2 pr-3">Pod / Profile</th>
                    <th scope="col" className="py-2 pr-3">Point</th>
                    <th scope="col" className="py-2 pr-3">Hoist</th>
                    <th scope="col" className="py-2 pr-3">Hook (kg)</th>
                    <th scope="col" className="py-2 pr-3">Roof (kg)</th>
                    <th scope="col" className="py-2 pr-3">Eff. WLL</th>
                    <th scope="col" className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {paperwork.loads.pods.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-4 text-center text-zinc-400">
                        No overhead truss pods in this rig.
                      </td>
                    </tr>
                  ) : (
                    paperwork.loads.pods.flatMap((pod) =>
                      pod.points.map((pt) => (
                        <tr key={`${pod.podId}-${pt.pointIndex}`} className="hover:bg-white/5">
                          <td data-label="Pod" className="py-2 pr-3 text-white">
                            <span>
                              {pod.podName} ({pod.trussProfileName})
                            </span>
                          </td>
                          <td data-label="Point" className="py-2 pr-3 font-mono-tech text-cyan-200">
                            <span>{pt.label}</span>
                          </td>
                          <td data-label="Hoist" className="py-2 pr-3 text-zinc-300">
                            <span>{pod.hoistName}</span>
                          </td>
                          <td data-label="Hook Load" className="py-2 pr-3 font-mono-tech text-zinc-200">
                            <span>{pt.hoistLoadKg.toFixed(1)} kg</span>
                          </td>
                          <td data-label="Roof Load" className="py-2 pr-3 font-mono-tech text-zinc-200">
                            <span>{pt.roofLoadKg.toFixed(1)} kg</span>
                          </td>
                          <td data-label="Eff. WLL" className="py-2 pr-3 font-mono-tech text-zinc-300">
                            <span>{pt.effectiveWllKg !== null ? `${Math.round(pt.effectiveWllKg)} kg` : '—'}</span>
                          </td>
                          <td data-label="Status" className="py-2 font-mono-tech text-zinc-100">
                            <span>{statusLabelText(pt.status)}</span>
                          </td>
                        </tr>
                      )),
                    )
                  )}
                </tbody>
              </table>
            </div>

            <div className="overflow-x-auto">
              <table className="inventory-table w-full text-left border-collapse text-xs">
                <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                  Power Circuits ({paperwork.power.system.label})
                </caption>
                <thead>
                  <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                    <th scope="col" className="py-2 pr-3">Circuit</th>
                    <th scope="col" className="py-2 pr-3">Dept</th>
                    <th scope="col" className="py-2 pr-3">Load</th>
                    <th scope="col" className="py-2 pr-3">Watts</th>
                    <th scope="col" className="py-2 pr-3">Amps / Breaker</th>
                    <th scope="col" className="py-2 pr-3">Phase</th>
                    <th scope="col" className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {paperwork.power.circuits.map((c) => (
                    <tr key={c.id} className="hover:bg-white/5">
                      <td data-label="Circuit" className="py-2 pr-3 font-mono-tech text-cyan-200">
                        <span>{c.id}</span>
                      </td>
                      <td data-label="Department" className="py-2 pr-3 text-zinc-300">
                        <span>{c.department}</span>
                      </td>
                      <td data-label="Load" className="py-2 pr-3 text-zinc-100">
                        <span>
                          {c.description} ({c.units})
                        </span>
                      </td>
                      <td data-label="Watts" className="py-2 pr-3 font-mono-tech text-zinc-200">
                        <span>{c.watts.toLocaleString()} W</span>
                      </td>
                      <td data-label="Amps" className="py-2 pr-3 font-mono-tech text-zinc-300 whitespace-nowrap">
                        <span>
                          {c.amps.toFixed(1)} A / {c.breakerA} A
                        </span>
                      </td>
                      <td data-label="Phase" className="py-2 pr-3 font-mono-tech text-zinc-200">
                        <span>
                          {c.phase}
                          {c.pinned ? ' (pin)' : ''}
                        </span>
                      </td>
                      <td data-label="Status" className="py-2 font-mono-tech text-zinc-100">
                        <span>{c.status.toUpperCase()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSheet === 'cues' && (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="inventory-table w-full text-left border-collapse text-xs">
                <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                  Show Cue Sheet — stack order matches Console, OSC &amp; MIDI Show Control
                  {paperwork.timelineFrameRate ? ` · Take TC @ ${paperwork.timelineFrameRate} fps` : ''}
                </caption>
                <thead>
                  <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                    <th scope="col" className="py-2 pr-3">Cue #</th>
                    <th scope="col" className="py-2 pr-3">Name</th>
                    <th scope="col" className="py-2 pr-3">Tag</th>
                    <th scope="col" className="py-2 pr-3">Fade</th>
                    <th scope="col" className="py-2 pr-3">Follow</th>
                    <th scope="col" className="py-2 pr-3">Take TC</th>
                    <th scope="col" className="py-2 pr-3">Dimmer</th>
                    <th scope="col" className="py-2 pr-3">Lighting</th>
                    <th scope="col" className="py-2 pr-3">Lasers</th>
                    <th scope="col" className="py-2">LED / Media</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {paperwork.cues.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-4 text-center text-zinc-400">
                        No cues in this show.
                      </td>
                    </tr>
                  ) : (
                    paperwork.cues.map((c) => (
                      <tr key={c.id} className="hover:bg-white/5">
                        <td data-label="Cue" className="py-2 pr-3 font-mono-tech text-white font-semibold whitespace-nowrap">
                          <span>
                            Cue {c.cueNumber}
                            <span className="sm:hidden text-cyan-200"> · {c.name}</span>
                          </span>
                        </td>
                        <td data-label="Name" className="py-2 pr-3 text-white font-medium">
                          <span>{c.name}</span>
                        </td>
                        <td data-label="Tag" className="py-2 pr-3 font-mono-tech text-zinc-300">
                          <span>{c.tag}</span>
                        </td>
                        <td data-label="Fade" className="py-2 pr-3 font-mono-tech text-zinc-300 whitespace-nowrap">
                          <span>{c.fadeLabel}</span>
                        </td>
                        <td data-label="Follow" className="py-2 pr-3 font-mono-tech text-zinc-300 whitespace-nowrap">
                          <span>{c.followLabel}</span>
                        </td>
                        <td data-label="Take TC" className="py-2 pr-3 font-mono-tech text-cyan-200 whitespace-nowrap">
                          <span>{c.takeTimecode ?? '—'}</span>
                        </td>
                        <td data-label="Dimmer" className="py-2 pr-3 font-mono-tech text-zinc-200 whitespace-nowrap">
                          <span>{c.dimmerLabel}</span>
                        </td>
                        <td data-label="Lighting" className="py-2 pr-3 text-zinc-300">
                          <span>{c.lightingSummary}</span>
                        </td>
                        <td data-label="Lasers" className="py-2 pr-3 text-zinc-300">
                          <span>
                            {c.laserSummary}
                            {c.audienceScanWarning && (
                              <span className="block text-[10px] text-rose-300 mt-0.5">
                                {c.audienceScanWarning}
                              </span>
                            )}
                          </span>
                        </td>
                        <td data-label="LED / Media" className="py-2 text-zinc-300">
                          <span>{c.mediaSummary}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeSheet === 'commissioning' && (
          <div data-testid="commissioning-record-sheet" className="space-y-3">
            {!preflight ? (
              <p className="text-xs text-zinc-400">Commissioning record unavailable.</p>
            ) : (
              <>
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-300">
                    <span className="font-mono-tech text-[10px] uppercase text-zinc-400">Tester / Technician</span>
                    <input
                      type="text"
                      aria-label="Commissioning tester name"
                      data-testid="commissioning-tester-name"
                      maxLength={120}
                      value={testerName}
                      placeholder="Name for printable record"
                      onChange={(e) => onChangeTesterName?.(e.target.value)}
                      className="gear-touch-control rounded-md border border-white/15 bg-black/60 px-2 py-1 text-xs text-white placeholder:text-zinc-500"
                    />
                  </label>
                  <div className="flex flex-col justify-center gap-0.5 font-mono-tech text-[11px]">
                    <span className="text-[10px] uppercase text-zinc-400">Pre-flight Status</span>
                    <span className="text-white font-semibold">
                      {preflight.badgeLabel} · Rev {preflight.configRevision}
                    </span>
                  </div>
                  <div className="flex flex-col justify-center gap-0.5 font-mono-tech text-[11px]">
                    <span className="text-[10px] uppercase text-zinc-400">Date &amp; Signature</span>
                    <span className="text-zinc-300">{titleBlock.date || today} · Signature line on print</span>
                  </div>
                </div>

                <p className="rounded-lg border border-amber-400/35 bg-amber-950/25 px-3 py-2 text-[11px] text-amber-100/90">
                  {preflight.calibrationNote} {preflight.lsoNotice} Informational only — never persisted as enabled.
                </p>

                <div className="overflow-x-auto">
                  <table className="inventory-table w-full text-left border-collapse text-xs">
                    <caption className="text-left font-mono-tech text-[11px] text-zinc-400 pb-2">
                      Commissioning Record ({preflight.evaluatorVersion}) — identical rows exported to CSV &amp; print
                    </caption>
                    <thead>
                      <tr className="border-b border-white/15 font-mono-tech text-[10px] uppercase text-zinc-400">
                        <th scope="col" className="py-2 pr-3">Category</th>
                        <th scope="col" className="py-2 pr-3">Item</th>
                        <th scope="col" className="py-2 pr-3">Location</th>
                        <th scope="col" className="py-2 pr-3">Outcome</th>
                        <th scope="col" className="py-2 pr-3">Operator Action</th>
                        <th scope="col" className="py-2">Summary</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {preflight.rows.map((row) => {
                        const action = commissioningActionLabel(row, preflight, preflightAcks);
                        return (
                          <tr key={row.id} className="hover:bg-white/5">
                            <td data-label="Category" className="py-2 pr-3 font-mono-tech text-zinc-300 uppercase">
                              <span>{row.kind}</span>
                            </td>
                            <td data-label="Item" className="py-2 pr-3 text-white font-medium">
                              <span>{row.label}</span>
                            </td>
                            <td data-label="Location" className="py-2 pr-3 text-zinc-300">
                              <span>{row.location}</span>
                            </td>
                            <td data-label="Outcome" className="py-2 pr-3 font-mono-tech font-semibold">
                              <span
                                className={
                                  row.outcome === 'pass'
                                    ? 'text-emerald-300'
                                    : row.outcome === 'warn'
                                      ? 'text-amber-300'
                                      : 'text-rose-300'
                                }
                              >
                                {row.outcome.toUpperCase()}
                              </span>
                            </td>
                            <td data-label="Action" className="py-2 pr-3 font-mono-tech text-cyan-200">
                              <span>{action}</span>
                            </td>
                            <td data-label="Summary" className="py-2 text-zinc-300">
                              <span>{row.summary}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
