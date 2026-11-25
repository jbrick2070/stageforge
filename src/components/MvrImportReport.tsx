import { useState } from 'react';
import type { MvrFinding, MvrFindingSeverity, MvrImportReport as MvrImportReportData } from '../interchange/mvr/importMvr';
import { DeskDialog } from './ShowFiles';

export interface MvrReportRecord {
  fileName: string;
  rigName: string;
  report: MvrImportReportData;
  importedAt: string;
}

type MvrImportReportProps =
  | {
      mode: 'preflight';
      fileName: string;
      rigName: string;
      report: MvrImportReportData;
      onImport: () => void;
      onCancel: () => void;
    }
  | {
      mode: 'view';
      fileName: string;
      rigName: string;
      report: MvrImportReportData;
      importedAt?: string;
      onClose: () => void;
    };

const SEVERITY_GROUPS: Array<{ severity: MvrFindingSeverity; title: string; badge: string }> = [
  { severity: 'block', title: 'Blocking issues', badge: 'BLOCK' },
  { severity: 'warn', title: 'Warnings', badge: 'WARN' },
  { severity: 'info', title: 'Notes', badge: 'INFO' },
];

function FindingItem({ finding, badge }: { finding: MvrFinding; badge: string }) {
  const ids = finding.fixtureIds;
  const remaining = ids ? Math.max(0, finding.count - ids.length) : 0;
  return (
    <li className={`mvr-finding mvr-finding--${finding.severity}`}>
      <div className="mvr-finding-head">
        <span className={`mvr-badge mvr-badge--${finding.severity}`}>{badge}</span>
        <code className="mvr-finding-code">{finding.code}</code>
        <span className="mvr-finding-count">{finding.count}</span>
      </div>
      <p className="mvr-finding-msg">{finding.message}</p>
      {ids && ids.length > 0 && (
        <details className="mvr-finding-ids">
          <summary>
            Affected items ({finding.count})
          </summary>
          <ul>
            {ids.map((id, idx) => (
              <li key={idx}>{id}</li>
            ))}
            {remaining > 0 && <li className="mvr-finding-more">… and {remaining} more</li>}
          </ul>
        </details>
      )}
    </li>
  );
}

export function MvrImportReport(props: MvrImportReportProps) {
  const { mode, fileName, rigName, report } = props;
  const [acknowledgedBlock, setAcknowledgedBlock] = useState(false);

  const grouped = SEVERITY_GROUPS.map((group) => ({
    ...group,
    items: report.findings.filter((f) => f.severity === group.severity),
  })).filter((g) => g.items.length > 0);

  const hasBlock = report.findings.some((f) => f.severity === 'block');
  const warnCount = report.findings.filter((f) => f.severity === 'warn').length;
  const blockCount = report.findings.filter((f) => f.severity === 'block').length;
  const onClose = mode === 'preflight' ? props.onCancel : props.onClose;
  const title = mode === 'preflight' ? 'MVR import preflight' : 'Last MVR import report';

  return (
    <DeskDialog title={title} onClose={onClose} className="mvr-report-dialog">
      <p className="file-show-name">{rigName}</p>
      <p className="mvr-report-meta">
        <span>{fileName}</span>
        <span>·</span>
        <span>{report.source === 'stageforge' ? 'StageForge MVR' : `Foreign MVR (${report.provider})`}</span>
        {mode === 'view' && props.importedAt && (
          <>
            <span>·</span>
            <time dateTime={props.importedAt}>{new Date(props.importedAt).toLocaleTimeString()}</time>
          </>
        )}
      </p>

      <div className="mvr-report-counts" aria-label="Scene object counts">
        <div>
          <strong>{report.fixtures}</strong>
          <span>Fixtures</span>
        </div>
        <div>
          <strong>{report.trusses}</strong>
          <span>Trusses</span>
        </div>
        <div>
          <strong>{report.screens}</strong>
          <span>Screens</span>
        </div>
        <div>
          <strong>{report.sceneObjects}</strong>
          <span>Objects</span>
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="mvr-report-clean" role="status">
          No warnings or losses detected. All fixtures, trusses, addresses and UUIDs match cleanly.
        </p>
      ) : (
        <div className="mvr-findings-groups">
          {grouped.map((group) => (
            <section key={group.severity} aria-label={group.title}>
              <h3>
                {group.title} <small>({group.items.length})</small>
              </h3>
              <ul className="mvr-finding-list">
                {group.items.map((finding, i) => (
                  <FindingItem key={`${finding.code}-${i}`} finding={finding} badge={group.badge} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {mode === 'preflight' ? (
        <div className="mvr-report-footer">
          {hasBlock ? (
            <label className="mvr-block-ack">
              <input
                type="checkbox"
                checked={acknowledgedBlock}
                onChange={(e) => setAcknowledgedBlock(e.target.checked)}
              />
              <span>Import anyway — the layout will differ</span>
            </label>
          ) : (
            <p className="mvr-report-summary">
              {warnCount > 0
                ? `${warnCount} ${warnCount === 1 ? 'warning' : 'warnings'} — review above before replacing the current desk.`
                : 'Importing replaces the current desk rig and stage layout.'}
            </p>
          )}
          <div className="mvr-report-actions">
            <button type="button" onClick={props.onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="mvr-import-confirm"
              disabled={hasBlock && !acknowledgedBlock}
              onClick={props.onImport}
            >
              Import
            </button>
          </div>
        </div>
      ) : (
        <div className="mvr-report-footer">
          <p className="mvr-report-summary">
            {blockCount > 0
              ? `Imported with ${blockCount} blocking ${blockCount === 1 ? 'issue' : 'issues'} acknowledged.`
              : warnCount > 0
                ? `Imported with ${warnCount} ${warnCount === 1 ? 'warning' : 'warnings'}.`
                : 'Imported cleanly with no warnings.'}
          </p>
          <div className="mvr-report-actions">
            <button type="button" onClick={props.onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </DeskDialog>
  );
}
