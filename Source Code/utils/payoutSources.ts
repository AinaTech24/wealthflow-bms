/**
 * Friendly names for the product codes the server reports in the payout overview.
 *
 * A code with no entry shows as itself, so the next broker needs no change on any
 * page: it appears in the product dropdown as e.g. 'ANGEL' the day its first
 * statement lands, and gets a nicer name here whenever someone bothers.
 */
export const SOURCE_LABEL: Record<string, string> = {
  MF: 'Mutual fund',
  MOFSL: 'Motilal Oswal',
};

export const labelFor = (key: string) => (key === 'all' ? 'All products' : SOURCE_LABEL[key] || key);
