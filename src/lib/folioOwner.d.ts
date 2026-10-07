export declare function pickOwnerRecord<T extends { id: string; folios?: string[]; hierarchy?: Record<string, string> }>(records: T[], rmId: string): T | null;
