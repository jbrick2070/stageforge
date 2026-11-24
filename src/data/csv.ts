/**
 * RFC 4180 CSV serialization helpers with spreadsheet formula-injection neutralization.
 *
 * Leading characters `=`, `+`, `@`, `-`, `\t`, and `\r` on string cells are prefixed with a
 * single quote so Excel / LibreOffice / Google Sheets treat untrusted text as literal data.
 */

const FORMULA_START = /^[=+@\-\t\r]/;

export type CsvValue = string | number | null | undefined;

/** Quote every value (matching legacy patchCsv.ts byte-for-byte). */
export function csvQuotedCell(value: string | number): string {
  const text = typeof value === 'string' && FORMULA_START.test(value) ? `'${value}` : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Format a spreadsheet-friendly cell:
 * - null / undefined / empty string -> empty cell
 * - finite numbers -> unquoted numeric literal (preserves numeric sorting & negative numbers)
 * - strings -> formula-neutralized and RFC 4180 quoted when needed (or always quoted for text)
 */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe) || safe !== value) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

export function formatCsv(
  rows: readonly (readonly CsvValue[])[],
  options: { bom?: boolean; quoteAll?: boolean } = {},
): string {
  const encode = options.quoteAll
    ? (v: CsvValue) => csvQuotedCell(v === null || v === undefined ? '' : v)
    : csvCell;
  const body = rows.map((row) => row.map(encode).join(',')).join('\r\n') + '\r\n';
  return options.bom ? `\uFEFF${body}` : body;
}
