// Types for branchRestructure.js (plain ESM, shared by the server and the page).
export interface BranchPlan {
  error?: string;
  slot?: string;
  level?: number;
  from?: string;
  to?: string;
  clientChanges: { id: string; name: string; slot: string; toId: string }[];
  teamChanges: { id: string; name: string; level: number; fromParent: string; toParent: string }[];
  skipped: { id: string; name: string; holder: string }[];
}
export declare function planBranchRestructure(input: {
  clients: { id: string; name?: string; hierarchy?: Record<string, string> }[];
  team: { id: string; name?: string; level: number; parentId?: string | null }[];
  fromId: string;
  toId: string;
}): BranchPlan;
