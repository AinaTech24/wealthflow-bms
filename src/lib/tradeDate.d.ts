export type DateOrder = 'dmy' | 'mdy';
export function detectDateOrder(values: unknown[]): DateOrder;
export function parseTradeDate(raw: unknown, order?: DateOrder): string | null;
export function monthOfDate(raw: unknown, order?: DateOrder): string | null;
export function findDateColumn(grid: unknown[][], headerRow?: number, minShare?: number): { index: number; order: DateOrder; share: number } | null;
