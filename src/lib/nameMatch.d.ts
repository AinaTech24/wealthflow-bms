// Types for nameMatch.js, which is plain ESM so that both the Node backend and
// the TypeScript frontend can share ONE copy of the rule.
export declare function nameTokens(s: string): Set<string>;
export declare function nameContradicts(a: string, b: string): boolean;
