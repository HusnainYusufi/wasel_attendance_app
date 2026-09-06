import { ExportVariant } from '@wasel/contracts';
import type { ReportRecord } from '../admin.mapper.js';
import {
  EXPORT_COLUMNS,
  csvCells,
  exportHeaders,
  xlsxCells,
  type ExportColumn,
} from './export-columns.js';
import {
  MINIFIED_COLUMNS,
  minifiedCsvCells,
  minifiedHeaders,
  minifiedXlsxCells,
} from './minified-columns.js';

/**
 * One variant's columns and how to render a record into them.
 *
 * The seam is here, between the column definitions and the two writers, and it is
 * the only place the variant is consulted. `CsvSink` and `XlsxSink` ask a sheet
 * for its headers and its cells and never learn which sheet they are writing —
 * which is what keeps the properties that matter (injection neutralisation, the
 * BOM, per-row commits, waiting on the socket between batches, the keyset stream
 * feeding them) shared by construction rather than by two people remembering.
 *
 * A `switch` on the variant inside each writer would have been fewer lines and
 * the wrong shape: there would then be four renderers to audit instead of two,
 * and the third variant would add two more.
 */
export interface ExportSheet {
  readonly variant: ExportVariant;
  readonly columns: readonly ExportColumn[];
  /** Column titles, with the tenant's zone named on every column that renders an instant. */
  headers(timezone: string, zoneChanged: boolean): string[];
  /** A CSV line: text and numbers, quoted and neutralised downstream. */
  csvCells(record: ReportRecord, timezone: string): Array<string | number | null>;
  /** An XLSX row: real `Date` and `number` cells, never pre-formatted strings. */
  xlsxCells(record: ReportRecord, timezone: string): Array<Date | string | number | null>;
}

const DETAILED_SHEET: ExportSheet = {
  variant: ExportVariant.DETAILED,
  columns: EXPORT_COLUMNS,
  headers: exportHeaders,
  csvCells,
  xlsxCells,
};

const MINIFIED_SHEET: ExportSheet = {
  variant: ExportVariant.MINIFIED,
  columns: MINIFIED_COLUMNS,
  headers: minifiedHeaders,
  csvCells: minifiedCsvCells,
  xlsxCells: minifiedXlsxCells,
};

const SHEETS: Readonly<Record<ExportVariant, ExportSheet>> = {
  [ExportVariant.DETAILED]: DETAILED_SHEET,
  [ExportVariant.MINIFIED]: MINIFIED_SHEET,
};

/**
 * The sheet a request asked for.
 *
 * A total map rather than a default, so adding a variant to the contract fails
 * the typecheck here instead of silently exporting the detailed sheet for it.
 */
export function exportSheet(variant: ExportVariant): ExportSheet {
  return SHEETS[variant];
}
