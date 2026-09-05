/**
 * Indian number formatting helpers.
 *
 * `formatINR(123456789)` → "12,34,56,789"
 * `formatCompactINR(1500000)` → "₹15.0 L"   (compact lakh/crore notation)
 * `formatCurrencyINR(50000)` → "₹50,000"
 */

const inrFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inrFormatter2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatINR = (n: number | null | undefined, fractionDigits = 0): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  const fmt = fractionDigits === 2 ? inrFormatter2 : inrFormatter;
  return fmt.format(n);
};

export const formatCurrencyINR = (n: number | null | undefined, fractionDigits = 0): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return '₹0';
  return `₹${formatINR(n, fractionDigits)}`;
};

/**
 * Compact form for dashboards & KPIs.
 *   < 1,000      → "₹999"
 *   < 1,00,000   → "₹12,345"
 *   < 1 crore    → "₹12.3 L"
 *   < 100 crore  → "₹12.3 Cr"
 *   ≥ 100 crore  → "₹1,234 Cr"
 */
export const formatCompactINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || Number.isNaN(n)) return '₹0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 100000) return `${sign}₹${formatINR(abs)}`;
  if (abs < 10000000) return `${sign}₹${(abs / 100000).toFixed(abs >= 1000000 ? 1 : 2)} L`;
  return `${sign}₹${(abs / 10000000).toFixed(abs >= 100 * 10000000 ? 0 : 2)} Cr`;
};

/** Number-to-words for Indian system (e.g. invoice PDFs). */
export const numberToINRWords = (num: number): string => {
  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  if (!num || num < 0) return 'Zero';
  if (num > 999999999) return 'Overflow';

  const n = Math.floor(num);
  const decimal = Math.round((num - n) * 100);

  const inWords = (k: number): string => {
    if (k < 20) return a[k];
    if (k < 100) return `${b[Math.floor(k / 10)]}${k % 10 ? ' ' + a[k % 10] : ' '}`;
    if (k < 1000) return `${a[Math.floor(k / 100)]}Hundred ${k % 100 ? inWords(k % 100) : ''}`;
    if (k < 100000) return `${inWords(Math.floor(k / 1000))}Thousand ${k % 1000 ? inWords(k % 1000) : ''}`;
    if (k < 10000000) return `${inWords(Math.floor(k / 100000))}Lakh ${k % 100000 ? inWords(k % 100000) : ''}`;
    return `${inWords(Math.floor(k / 10000000))}Crore ${k % 10000000 ? inWords(k % 10000000) : ''}`;
  };

  const rupees = inWords(n).trim();
  const paise = decimal ? ` and ${inWords(decimal).trim()} Paise` : '';
  return `${rupees} Rupees${paise} Only`;
};
