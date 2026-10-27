export interface SheetLayout {
  headerRow: number;
  schemeCol: number;
  rateCol: number;
  categoryCol: number;
  amcCol: number;
  unit: 'percent' | 'fraction';
}
export interface SavedLayoutNames {
  schemeHeader: string;
  rateHeader: string;
  categoryHeader: string;
  amcHeader: string;
  unit: 'percent' | 'fraction' | string;
}
export interface RateRow {
  amcName: string;
  schemeName: string;
  category: string;
  trailRate: number;
  sourceFile: string;
  rawLine: string;
}
export function parseRate(v: unknown): number | null;
export function findHeaderRow(grid: unknown[][]): number;
export function detectLayout(grid: unknown[][], forcedHeaderRow?: number): SheetLayout | null;
export function guessUnit(grid: unknown[][], layout: SheetLayout): 'percent' | 'fraction';
export function inferCategory(name: string): string;
export function rowsFromGrid(grid: unknown[][], layout: SheetLayout | null, opts?: { amcName?: string; sourceFile?: string }): { rows: RateRow[]; skipped: number };
export function layoutToNames(grid: unknown[][], layout: SheetLayout): SavedLayoutNames;
export function layoutFromNames(grid: unknown[][], saved: SavedLayoutNames | null | undefined): SheetLayout | null;
export function sheetSignature(grid: unknown[][], layout: SheetLayout): string;
