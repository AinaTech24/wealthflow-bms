export interface FieldDef { key: string; label: string; group: string }
export const FIELDS: FieldDef[];
export const FIELD_KEYS: string[];
export function labelOf(key: string): string;
export function parseDate(v: unknown): string | null;
export const NORMALIZE: Record<string, (v: unknown) => { value?: string; error?: string }>;
export function normalizeChanges(raw: Record<string, unknown>): { changes: Record<string, string>; errors: string[] };
export function findHeaderRow(grid: unknown[][]): number;
export function detectColumns(grid: unknown[][], forcedHeaderRow?: number): { headerRow: number; columns: Record<string, number>; headers: string[] };
export interface ImportRow { rowNo: number; name: string; pan: string; values: Record<string, string>; problems: Array<{ key: string; label: string; text: string; cell: string }> }
export function readRows(grid: unknown[][], headerRow: number, columns: Record<string, number>): ImportRow[];
export function nameKey(s: string): string;
export interface MatchResult { row: ImportRow; status: 'matched' | 'not_found' | 'ambiguous' | 'duplicate'; by: string; person: any | null; candidates: any[] }
export function matchRows(rows: ImportRow[], team: any[]): MatchResult[];
export function currentValue(person: any, key: string): string;
export function diffFor(person: any, values: Record<string, string>): Array<{ key: string; label: string; from: string; to: string }>;
export function applyChanges(data: any, email: string, changes: Record<string, string>): { data: any; email: string };
export function maskAccount(v: unknown): string;
