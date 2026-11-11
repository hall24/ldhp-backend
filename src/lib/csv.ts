/** Minimal RFC 4180 CSV reading and writing, so imports need no extra dependency. */

export class CsvError extends Error {}

/** Parse CSV text into rows of cells. Handles quotes, escaped quotes, CRLF/LF and a UTF-8 BOM. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let quoteLine = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') {
      inQuotes = true;
      quoteLine = line;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      line++;
    } else cell += ch;
  }
  if (inQuotes) throw new CsvError(`Unclosed quote starting on line ${quoteLine}.`);
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Drop blank lines (e.g. a trailing newline or spacer rows from spreadsheets).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Quote a cell for CSV. Cells that a spreadsheet would run as a formula (=, +, -, @,
 * tab, CR) get a leading apostrophe so an exported file can't execute anything.
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: (string | number | boolean | null | undefined)[]) => cells.map(csvCell).join(',');
