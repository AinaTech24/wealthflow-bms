export interface ChainSnapshot { before: string; hierarchy: Record<string, string>; leadSourceLevel?: number }
export interface ChainClient { hierarchy?: Record<string, string>; hierarchyHistory?: ChainSnapshot[]; leadSourceLevel?: number }
export function effectiveMonthOr(raw: unknown, fallback: string): string;
export function monthBefore(period: string): string;
export function chainAsOf(client: ChainClient | null | undefined, period?: string): { hierarchy: Record<string, string> | undefined; leadSourceLevel: number | undefined };
export function hierarchyAsOf(client: ChainClient | null | undefined, period?: string): Record<string, string> | undefined;
export function planChainChange(args: {
  client: ChainClient;
  hierarchy: Record<string, string>;
  leadSourceLevel?: number | string | null;
  effectiveFrom?: string;
}): { changed: boolean; hierarchy: Record<string, string>; hierarchyHistory: ChainSnapshot[] | undefined; leadSourceLevel: number | undefined };
