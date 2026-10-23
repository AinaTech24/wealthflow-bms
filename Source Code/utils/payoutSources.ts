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
  VOLT: 'Volt Money',
};

// Partners whose file layout was taught on the Partner Brokerage page carry their own name; the server
// sends them with the payout overview and the page registers them here.
const CUSTOM_LABEL: Record<string, string> = {};
export const registerLabels = (m?: Record<string, string>) => { if (m) Object.assign(CUSTOM_LABEL, m); };

export const labelFor = (key: string) => (key === 'all' ? 'All products' : SOURCE_LABEL[key] || CUSTOM_LABEL[key] || key);
