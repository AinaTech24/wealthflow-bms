import pdf from 'pdf-parse/lib/pdf-parse.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Position-aware text extraction. pdf-parse reads some column-layout PDFs (e.g. JM)
 * column-by-column, scrambling scheme names away from their rates. pdfjs exposes each
 * text item's (x,y); we cluster items by y into visual rows and sort each row by x,
 * reconstructing proper "Scheme Name  1.44  0.26  1.70" lines.
 */
async function extractTextByRows(buffer) {
    // Copy into a plain Uint8Array — pdfjs rejects Node Buffer (a Uint8Array subclass).
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    let out = "";
    for (let pn = 1; pn <= doc.numPages; pn++) {
        const page = await doc.getPage(pn);
        const content = await page.getTextContent();
        const byY = new Map();
        for (const it of content.items) {
            if (!it.str || !it.str.trim()) continue;
            const y = Math.round(it.transform[5]);
            let key = [...byY.keys()].find((k) => Math.abs(k - y) <= 2);
            if (key === undefined) key = y;
            if (!byY.has(key)) byY.set(key, []);
            byY.get(key).push({ x: it.transform[4], s: it.str });
        }
        for (const y of [...byY.keys()].sort((a, b) => b - a)) {
            let line = byY.get(y).sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim();
            // Column-layout PDFs put the category cell first on the row ("Liquid JM Liquid
            // Fund 0.05 ..."). If dropping that leading category word makes the row start with
            // a known brand, strip it so the scheme parser sees a clean "<Brand> ... Fund".
            const m = line.match(/^(Equity|Debt|Hybrid|Liquid|Overnight|Index|Arbitrage|Solution|Gold|Thematic|Sectoral|FoF|ETF|Other)\s+(.+)/i);
            if (m) {
                const restUp = m[2].toUpperCase();
                if (BRANDS.some((b) => restUp.startsWith(b))) line = m[2];
            }
            if (line) out += line + "\n";
        }
    }
    try { await doc.destroy(); } catch { /* ignore */ }
    return out;
}

const CATEGORY_KEYWORDS = [
    "equity", "hybrid", "debt", "liquid", "index", "etf", "gold", "fof",
    "solution", "elss", "balanced", "arbitrage", "gilt", "credit", "money market",
    "thematic", "sectoral", "financial", "services", "flexi", "multicap", "midcap", "smallcap", "focused", "value", "dividend", "healthcare", "manufacturing", "infrastructure", "banking", "large & midcap", "multi asset", "balanced advantage"
];

const BRANDS = [
    "ADITYA BIRLA SUN LIFE", "ADITYA BIRLA SUNLIFE", "ADITYA BIRLA", "ABSL", "360 ONE", "FRANKLIN", "TEMPLETON",
    "HDFC", "KOTAK", "SBI", "ICICI", "AXIS", "NIPPON", "MIRAE", "TATA",
    "DSP", "UTI", "LIC MF", "LICMF", "HELIOS", "BANDHAN", "IDFC",
    "INVESCO", "WHITEOAK", "WHITE OAK", "CANARA", "ROBECO", "BOI",
    "BANK OF INDIA", "EDELWEISS", "HSBC", "TRUST", "UNION", "PPFAS",
    "QUANT", "MAHINDRA", "MAHENDRA", "MAHINDRA MANULIFE", "PGIM", "JM MF", "JM", "PARAG PARIKH", "PPFAS",
    "BARODA", "BNP", "PFRDA", "TAURUS", "ITI MF", "SAMCO", "TRUST MF", "WHITE OAK CAPITAL", "WHITE OAK", "THE WEALTH COMPANY", "THEWEALTHCOMPANY", "NEXTFREEDOM LIFEX PRIVATE LIMITED", "NEXTFREEDOM", "UTI MUTUAL FUND", "UTI MF", "SHRIRAM", "MOTILAL", "NAVI", "SAMCO", "NJ", "WHITE OAK", "HELIO", "HELIOS", "SUNDARAM", "GROWW", "ZERODHA", "OLD BRIDGE", "OLDBRIDGE", "BAJAJ FINSERV", "BAJAJ", "UNIFI", "ANGEL ONE", "CAPITALMIND"
];

const normalizeSpaces = (s) => (s || "").replace(/\s+/g, " ").trim();

const guessCategory = (text) => {
    const low = text.toLowerCase();
    if (/\b(arbitrage)\b/i.test(low)) return "Arbitrage";
    if (/\b(gilt|liquid|money market|credit|debt|duration|overnight|bond|psu|g-sec|sdl|floater|floating rate|savings fund|treasury|corporate bond|banking and psu|banking & psu)\b/i.test(low)) {
        // Make sure PSU Equity Fund is Equity not Debt
        if (/\bpsu\s*(equity|fund)\b/i.test(low) && /\bequity\b/i.test(low)) return "Equity";
        return "Debt";
    }
    if (/\b(balanced advantage|dynamic asset allocation|equity savings|hybrid|multi asset|multiasset|balanced|conservative hybrid|aggressive hybrid|equity hybrid)\b/i.test(low)) return "Hybrid";
    if (/\b(retirement|children|pension)\b/i.test(low)) return "Solution";
    if (/\b(flexi|flexicap|multicap|multi cap|mid|midcap|small|smallcap|focused|value|dividend|manufacturing|healthcare|pharma|infrastructure|banking|financial|large|largecap|technology|innovation|defence|business cycle|opportunities|equity|digital|quant|ethical|esg|large & midcap|large & mid cap|elss|consumption|fmcg|transportation|logistics|automotive|energy|housing|mnc|contra|mncfund|special opportunities|india consumer|resources)\b/i.test(low)) return "Equity";
    if (/\b(index|nifty|sensex|etf)\b/i.test(low)) return text.toLowerCase().includes("etf") ? "ETF" : "Index";
    if (/\b(gold|silver)\b/i.test(low)) return "Gold";
    if (/\b(fof|fund of fund)\b/i.test(low)) return "FoF";

    for (const kw of CATEGORY_KEYWORDS) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(low)) {
            if (kw === "etf") return "ETF";
            if (kw === "fof") return "FoF";
            if (kw === "elss") return "ELSS";
            return kw.charAt(0).toUpperCase() + kw.slice(1);
        }
    }
    return null;
};

const extractPercentages = (text) => {
    const found = [];
    const pushCandidate = (val, index, explicitPercent = false) => {
        if (!(val >= 0.005 && val <= 5.0)) return;
        const start = Math.max(0, (index || 0) - 40);
        const end = Math.min(text.length, (index || 0) + 40);
        const snippet = text.substring(start, end).toLowerCase();
        const isExitLoad = /\b(exit|load|within|if redeemed|switch out|allotment|days?)\b/.test(snippet);
        if (!found.some(f => Math.abs(f.val - val) < 0.001 && Math.abs(f.index - (index || 0)) < 10)) {
            found.push({ val, isExitLoad, index: index || 0, explicitPercent });
        }
    };

    const matchesArray = Array.from(text.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*%/g));
    for (const match of matchesArray) {
        pushCandidate(parseFloat(match[1]), match.index, true);
    }

    // Only skip implicit decimals for lines that are purely numeric WITH 2+ dots (e.g. "26.01.2026" dates).
    // The existing splitting logic already handles most date patterns.
    // We must NOT skip standalone rate lines like "0.40" or "1.25" which are common in AMC PDFs.
    const rawMatchesArray = Array.from(text.matchAll(/(\d+\.\d+(?:\.\d+)*)/g));
    let skipUntil = -1;
    for (const match of rawMatchesArray) {
        if (match.index < skipUntil) continue;
        // Skip only if line is a single compact date-like token (no letters, no spaces, 2+ dots e.g. "26.01.2026")
        // Lines with spaces like "0.95 0.95 0.95 0.95" (multi-column rates) must NOT be skipped.
        // Also skip ONLY if it looks like a date: has day/month/year pattern (dd.mm.yyyy or similar)
        // Rate-only lines like "0.950.950.950.95" should NOT be skipped!
        const looksLikePureDate = !/[A-Za-z\s]/.test(text.trim()) &&
                                  (text.match(/\./g) || []).length >= 2 &&
                                  matchesArray.length === 0 &&
                                  /\b(20\d{2}|202[0-9]|19\d{2})\b/.test(text); // Must contain a year to be a date
        if (looksLikePureDate) continue;
        let matchStr = match[0];
        const splitMatches = [];
        if (match.index > 0 && text[match.index - 1] === '-') {
            if (matchStr.length >= 4 && (matchStr.startsWith("26") || matchStr.startsWith("2026"))) {
                matchStr = matchStr.replace(/^(26|2026)/, "");
            }
        }
        if (matchStr.includes('.') && ((matchStr.match(/\./g) || []).length > 1 || matchStr.length >= 6)) {
            const pieces = matchStr.split('.');
            if (pieces.length > 1) {
                let firstPiece = pieces[0];
                if (firstPiece.endsWith("26") || firstPiece.endsWith("2026")) firstPiece = firstPiece.replace(/(26|2026)$/, "");
                if (firstPiece && pieces[1]) {
                    if (firstPiece.length > 2 && !matchStr.includes('..')) {
                        const integer = firstPiece.substring(firstPiece.length - 1);
                        splitMatches.push(integer + "." + pieces[1].substring(0, 2));
                    } else splitMatches.push(firstPiece + "." + pieces[1].substring(0, 2));
                }
                for (let i = 1; i < pieces.length - 1; i++) {
                    const lead = pieces[i].substring(2);
                    const trail = pieces[i + 1].substring(0, 2);
                    if (lead && trail) splitMatches.push(lead + "." + trail);
                }
            }
        } else splitMatches.push(matchStr);

        for (const sMatch of splitMatches) {
            pushCandidate(parseFloat(sMatch), match.index, false);
        }
    }
    if (found.length === 0) return [];
    found.sort((a, b) => {
        if (!a.isExitLoad && b.isExitLoad) return -1;
        if (a.isExitLoad && !b.isExitLoad) return 1;
        if (a.explicitPercent && !b.explicitPercent) return -1;
        if (!a.explicitPercent && b.explicitPercent) return 1;
        const hasDecA = a.val % 1 !== 0;
        const hasDecB = b.val % 1 !== 0;
        if (hasDecA && !hasDecB) return -1;
        if (!hasDecA && hasDecB) return 1;
        return a.index - b.index;
    });
    return found;
};

const NOISE_KEYWORDS = [
    "exit load", "redemption", "switch out", "allotment", "remaining", "units", "subject to", "applicable", "effective", "stamp duty", "brokerage inclusive", "transaction charge", "disclaimer", "note:", "for units", "days from", "weeks from", "months from", "if redeemed", "within", "beyond", "period of", "lock-in", "arn-", "distributor", "investment period", "rate_type", "transaction nature", "b30 incentive", "1st yr", "2nd yr", "3rd yr", "4th yr", "threshold", "trailer fee", "investment amount", "core funds", "scheme category", "scheme name", "jdpel", "appetite", "nc-no clawback", "prop-proportionate", "thld(d)", "equity -", "hybrid -", "debt -", "fixedno", "indexindex", "sebi scheme", "categorization", "rate type", "structure for all", "year trail", "apm (%)", "fourth year", "onwards", "first year", "second year", "third year", "fund type", "fund name", "plancategory", "plan category", "total t30 payout", "total b30 payout", "trail applicable", "additional trail", "remuneration structure", "distribution remuneration", "sectoral / thematic", "sectoral/thematic", "flexible cap", "multi asset allocation", "nil", "equity schemes", "hybrid schemes", "debt schemes", "solution oriented schemes", "other schemes", "index schemes", "equityschemes", "hybridschemes", "debtschemes", "solutionorientedschemes", "otherschemes", "pms ^", "load structure", "sid/sai", "www.heliosmf.in", "terms & conditions", "aforesaid period", "average aum", "perc- percentage", "prop- proportion", "nc- no clawback", "thld(d)", "apprdrt", "rate_type", "trailer fee", "scheme nameinvestment period", "normal", "investmentperiod", "nc-no clawback", "prop-proportionate", "arn code", "arn name", "categoryequity", "categoryhybrid", "categorydebt", "categoryliquid", "perpetual trail", "1 year onwards", "mobilization", "additional trail", "mobilization (inr)", "sr. no.", "slab/tran.type", "1st year trail", "2nd year trail", "3rd year trail", "4th year onwards trail", "trail brokerage structure", "applicable from", "equity funds", "hybrid funds", "debt funds", "cash funds", "index funds", "etf funds", "liquid funds", "trail 1st", "trail 4th", "year ( p.a%)", "competing schemes", "any other mode", "read all scheme", "allotment of units", "from date of allotment", "date of allotment of units", "nextfreedom", "lifex", "private limited", "arn-", "c-kyc", "politically exposed", "amfi website", "lock-in period", "claus", "disclaimer", "statutory", "payout", "terms and conditions", "partner name", "arn no", "kyc compliant", "kra", "cvl", "compliance", "kfintech", "politically exposed person", "net worth", "income status", "stock exchange", "mfu system", "mutual fund platforms", "refer link below", "benchmark index", "index tri", "schemes classification", "add 1st yr trail", "1st year trail", "2nd year onwards", "trail brochure", "Asset Management Company Limited", "Private & Confidential", "Validity Period:", "all rights reserved", "subject to change", "applicable brokerage", "trailer brokerage", "structure for", "period starting", "period ending",
    "reserves the right", "asset management limited", "brokerage rates mentioned", "trail brokerage:", "brokerage structure for", "perpetual trail brokerage", "schemetrail brokerage"
];

const isNoiseLine = (line) => {
    const low = line.toLowerCase();
    // Count occurrences of numbers (with or without decimals) possibly followed by %
    const pcCount = (line.match(/\d+(\.\d+)?\s*%?/g) || []).length;

    // Strong noise filters: Exit load, tenure-based rules mixed with numbers/rates
    if ((low.includes("exit load") || low.includes("if redeemed") || low.includes("switch out") || low.includes("premature withdrawal")) && pcCount >= 1) return true;
    if (/\b(beyond|within)\b/i.test(low) && pcCount >= 1) return true;
    if (low.includes("within 1 day") || low.includes("within 7 days") || low.includes("day - 0.00")) return true;

    // If it has at least 2 decimal rates and is a reasonably sized line, it's likely data
    const decimalPcCount = (line.match(/\d+\.\d+/g) || []).length;
    if (decimalPcCount >= 2 && low.length < 160) return false;

    if (/(\d+%\s*(NIFTY|BSE|CRISIL|S&P|MSCI|DOMESTIC))/i.test(line)) return true;
    if (low.startsWith("+") && low.includes("%")) return true;
    if (low.includes("scheme name") && low.includes("trail")) return true;
    if (low.includes("investment period") && low.includes("trail")) return true;

    if (/\d+\.\d+/.test(line) && BRANDS.some(b => low.includes(b.toLowerCase()))) return false;
    const upLine = line.toUpperCase();
    if (BRANDS.some(b => upLine.startsWith(b.toUpperCase())) && line.length > 5) return false;
    if (upLine.includes(" FUND ") && line.length > 10) return false;
    if (NOISE_KEYWORDS.some(kw => low.includes(kw))) return true;
    if (low.length < 3) return true;
    if (/^\d+$/.test(line.trim())) return true;
    if (low.includes("trail apm") || low.includes("trail (%)")) return true;
    return false;
};

/**
 * Text that rides along on a scheme name but is not part of it.
 *
 * Cards carry link labels, footnote markers, a benchmark and date range, a leaked
 * category column, a half-cut "(Formerly known…" — 104 names in the master had one
 * of these glued on, "Bank of India Liquid Fund Click Here" among them.
 *
 * There is deliberately NO generic "trailing number" rule: it would eat the 50 in
 * "Nifty 50", the 200 in "BSE 200" and the series number on an FMP.
 */
const SCHEME_NOISE = [
    /\s*click\s*here\s*$/i,                                              // link label
    /\s*\*+\s*$/,                                                        // footnote marker
    /\s*[.,;:\-–]+\s*$/,                                                 // trailing punctuation
    /\s*\(?\s*formerly\s+known\b.*$/i,                                   // truncated parenthetical
    /\s+erstwhile\s+[A-Za-z]+\s*$/i,
    /\s+an\s+open-?ended\b.*$/i,                                         // prospectus prose
    /\s+S?\s*ARE\s+MARKET\s+RISKS\b.*$/i,                                // disclaimer
    /\s*(?:AGGRESSIVE|CONSERVATIVE)?\s*INDEX\s+[A-Za-z]{3}-\d{4,6}\s*$/i, // benchmark + date
    /\s*(?:NA)?\d{2}-[A-Za-z]{3}-\d{4,6}\s*$/i,
    /\s*[A-Za-z ]*TRI\d[\d-]*[A-Za-z-]*\d*\s*$/i,
    /\s+(Equity|Debt|Hybrid|Liquid|Other)\s?\d+\s*$/i,                   // category column leaked in
    /\s*\d+\.\d+\.\d+\s*$/,                                              // rate digits glued on
    /^\s*[&*\-–,.]+\s*/,                                                 // leading punctuation
];
const stripSchemeNoise = (name) => {
    let s = String(name || "").trim(), prev;
    do {
        prev = s;
        for (const re of SCHEME_NOISE) {
            const t = s.replace(re, "").trim();
            // Never strip a name down to nothing — a fund whose whole identity is the
            // matched text keeps it, and the caller's length checks reject it instead.
            if (t !== s && t.length >= 6) s = t;
        }
    } while (s !== prev);
    return s.replace(/\s{2,}/g, " ").trim();
};

/**
 * Words a fund house writes in its Terms & Conditions and never in a fund's name.
 *
 * Abakkus' card opens with 39 lines of T&C before the rate table, and lines from it
 * were landing in the master as schemes — "intermediaries and other guidelines issued
 * by SEBI / AMFI from time to time for Mutual Fund . AMC reserves Abakkus Small Cap
 * Fund" at 1.05%, an ICICI private-circulation notice at 0.9%, a Kotak line about
 * email domains at 1%. One match is enough: no real scheme carries any of these.
 */
const DISCLAIMER = new RegExp([
    "\\bsebi\\b", "\\bamfi\\b", "\\bherein\\b", "\\bcirculat(?:ion|ed)\\b",
    "\\bprospective\\s+investors?\\b", "\\bexpense\\s+ratio\\b", "\\bcode\\s+of\\s+conduct\\b",
    "\\bstatutory\\b", "\\blevies\\b", "\\bannualized\\b", "\\bcommission\\b",
    "\\bdistributors?\\b", "\\bregulat(?:ory|ions?)\\b", "\\bterms\\s+and\\s+conditions\\b",
    "\\bmarket\\s+risks\\b", "\\bshall\\b", "\\bhereby\\b", "\\bwhatsoever\\b",
    "\\bplease\\s+(?:read|refer)\\b", "\\breserves?\\s+the\\s+right\\b",
    "\\bfrom\\s+time\\s+to\\s+time\\b", "\\bagrees?\\s+that\\b", "\\bwith\\s+regards?\\s+to\\b",
    "\\bemail\\s+address\\b", "\\bopen\\s+aum\\b", "\\bpositioning\\b", "\\bintermediaries\\b",
    "\\bstrategies\\b", "\\bsourcing\\b", "\\.com\\b",
    "\\bassets\\s+under\\s+management\\b", "\\binvested\\s+in\\b", "\\bmore\\s+than\\b",
    "\\bonly\\s+for\\s+select\\b", "\\bmfd\\b",
].join("|"), "i");

/** A ")" with no "(" is half a name the table split across two lines. */
const halfBracket = (s) => /\)/.test(String(s || "")) && !/\(/.test(String(s || ""));

/**
 * Many cards print the SEBI category in the next column, and it arrives glued to the
 * name — "LIC MF MANUFACTURING FUND SECTORAL/THEMATIC FUND", "ICICI Prudential
 * Multi-Asset Fund Multi Asset Allocation 1", "Mahindra Manulife Arbitrage Fund
 * Arbitrage0.42". Two narrow rules, because a broad one would rename real funds:
 *
 *  A. text after the last Fund/FOF/ETF that ENDS in a digit or a rate fragment —
 *     a bare number never ends a fund's name, so this is the table column;
 *  B. a handful of category labels that are never part of a name.
 *
 * "Fund of Funds" is stripped ONLY when the prefix already says FOF, so a genuine
 * fund-of-fund like "HDFC Gold ETF Fund of Fund" keeps its name.
 */
const TRAILING_CATEGORY = [
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s+[A-Za-z][A-Za-z&/\- ]*?\d+(?:\.\d+)?\s*$/i,
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s*\*?[A-Za-z][A-Za-z&/\- ]*\d+(?:\.\d+)?\s*$/i,
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s+sectoral\s*\/\s*thematic\s+fund\s*$/i,
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s+(?:sol\s*uti?\s*on|solution)\s+oriented\s+scheme\s*$/i,
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s+(?:equity\s+)?focused\s+fund\s*$/i,
    /(\(?FOF\)?)\s+fund\s+of\s+funds?\s*\d*\s*$/i,
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s+[A-Za-z][A-Za-z&/\- ]*?[A-Za-z]{3}-\d{4,6}\s*$/i,  // "… Jul-202630"
    /\b((?:Fund|FOF|ETF|Scheme|Plan)s?)\s+[A-Z]\s*$/,                                        // stray "FUND S"
];

/**
 * Trailing words that merely REPEAT words already in the name are the category
 * column printed again — "LIC MF CHILDRENS FUND CHILDREN'S FUND", "Mahindra
 * Manulife Large Cap Fund Large", "ICICI Prudential Focused Equity Fund Focused
 * Fund". The run must start after a scheme-type word and every word in it must
 * already appear earlier, so "HDFC Gold ETF Fund of Fund" is untouched: its "of"
 * appears nowhere before.
 */
/**
 * Cut whatever trails the LAST Fund/FOF/ETF/Scheme/Plan when that trailing text is
 * table debris rather than part of the name — a benchmark and settlement window
 * ("SBI LOW DURATION FUND Jul-202630", "… NIFTY 500 TRI01-Jul-202630") or a column
 * index ("… Fund of Funds 1").
 *
 * A name whose last scheme word IS the last word has no tail, so "HDFC Gold ETF Fund
 * of Fund" and "Kotak Nifty 50 Index Fund" pass through untouched.
 */
const cutDebrisTail = (name) => {
    const s = String(name || "").trim();
    const re = /\b(funds?|fof|etf|schemes?|plans?)\b/gi;
    let last = -1, m;
    while ((m = re.exec(s)) !== null) last = m.index + m[0].length;
    if (last < 0 || last >= s.length) return s;
    const tail = s.slice(last).trim();
    const head = s.slice(0, last).trim();
    if (!tail || head.length < 8) return s;
    const isDebris = /[A-Za-z]{3}-\d{4,6}/.test(tail)        // Jul-202630
        || /\d{1,2}-[A-Za-z]{3}-\d{2,6}/.test(tail)          // 01-Jul-2026
        || /\d\s*$/.test(tail);                              // a column index
    return isDebris ? head : s;
};

const stripRepeatedCategory = (name) => {
    const tokens = String(name || "").trim().split(/\s+/);
    const norm = (t) => t.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const isSchemeWord = (t) => /^(FUNDS?|FOF|ETF|SCHEMES?|PLANS?)$/.test(norm(t));
    for (let cut = tokens.length - 1; cut >= 3; cut--) {
        if (!isSchemeWord(tokens[cut - 1])) continue;         // run must begin after "Fund"/"FOF"/…
        const run = tokens.slice(cut);
        if (!run.length) continue;
        const before = new Set(tokens.slice(0, cut).map(norm));
        if (run.every(t => norm(t) && before.has(norm(t)))) return tokens.slice(0, cut).join(" ");
    }
    return name;
};
const stripTrailingCategory = (name) => {
    let s = String(name || ""), prev;
    do {
        prev = s;
        for (const re of TRAILING_CATEGORY) {
            const t = s.replace(re, "$1").trim();
            if (t !== s && t.length >= 8) s = t;
        }
    } while (s !== prev);
    return s;
};

export const cleanSchemeName = (line) => {
    // A criteria row ("AUM >= 50 Lakh") or a sentence out of the T&C is not a scheme.
    if (DISCLAIMER.test(line) || /[<>]=?\s*\d/.test(line)) return "";
    // A stray ")" with no "(" is half a name the table split across lines.
    if (/\)/.test(line) && !/\(/.test(line)) return "";
    let s = stripSchemeNoise(stripRepeatedCategory(cutDebrisTail(stripTrailingCategory(line))));
    // Common OCR typo in ABSL files.
    s = s.replace(/\bADITY\s+BIRLA\b/gi, "ADITYA BIRLA");
    // Filter out disclaimer/legal text that mentions AMC management
    if (/asset management limited/i.test(s) || /reserves the right/i.test(s)) {
        return "";
    }
    // Fix "Helio s" → "Helios" (common PDF parsing artifact)
    s = s.replace(/\bHelio\s+s\b/gi, "Helios");
    // Fix SUNLIFE → SUN LIFE, but avoid creating "SUN LIFE LIFE" when followed by " LIFE"
    s = s.replace(/SUNLIFE\s+LIFE\b/gi, "SUN LIFE");
    s = s.replace(/SUNLIFE/gi, "SUN LIFE");
    // Fix missing space: "SUN LIFEINTERNATIONAL" → "SUN LIFE INTERNATIONAL"
    s = s.replace(/SUN LIFE([A-Z])/g, "SUN LIFE $1");
    s = s.replace(/[ΓÇÖ''""〝〞├ü]/g, "'");
    s = s.replace(/&/g, " & ");
    s = s.replace(/WHITEOAK/gi, "WHITE OAK");
    s = s.replace(/GLOGAL/gi, "GLOBAL");
    s = s.replace(/CAPTIAL/gi, "CAPITAL");
    s = s.replace(/LARGECAP/gi, "LARGE CAP");
    s = s.replace(/MIDCAP/gi, "MID CAP");
    s = s.replace(/SMALLCAP/gi, "SMALL CAP");
    s = s.replace(/MULTICAP/gi, "MULTI CAP");
    s = s.replace(/FLEXICAP/gi, "FLEXI CAP");
    s = s.replace(/THEWEALTHCOMPANY/gi, "THE WEALTH COMPANY");
    s = s.replace(/([a-z])([A-Z])/g, "$1 $2");
    // Fix "Fo F" → "FoF" — must come AFTER the ([a-z])([A-Z]) rule which would re-break it
    s = s.replace(/\bFo\s+F\b/gi, "FoF");
    // Split uppercase acronym run into a Title-case word: "CAPFund" → "CAP Fund", "HDFCFund" → "HDFC Fund"
    s = s.replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2');
    // Fix common OCR artifacts for scheme names
    s = s.replace(/\bpln\b/gi, 'Plan');
    s = s.replace(/\bRetiremen\b/gi, 'Retirement');
    s = s.replace(/\bAggress\b/gi, 'Aggressive');
    s = s.replace(/\bConserv\b/gi, 'Conservative');
    for (const brand of BRANDS) {
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(`([A-Za-z])(${escaped})`, "gi"), "$1 $2");
    }
    // Strip concatenated rate from scheme name: "Fund0.75%" → "Fund"
    s = s.replace(/([A-Za-z])(\d+\.\d+)\s*%/g, '$1');
    s = normalizeSpaces(s);
    s = s.replace(/^[-.|\s>]+/, "");
    // Strip trailing pipe-separated OCR garbage: "Fund | os" → "Fund", "Plan | 1.25" → "Plan"
    s = s.replace(/\s*\|.*$/, '').trim();

    let foundBrand = false;
    let brandIdx = -1;
    let detectedBrand = "";
    const upS = s.toUpperCase();
    for (const brand of BRANDS) {
        const b = brand.toUpperCase();
        const escapedBrand = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escapedBrand}\\b`, 'i');
        const match = s.match(re);
        if (match) {
            brandIdx = match.index;
            detectedBrand = s.substring(match.index, match.index + match[0].length);
            foundBrand = true;
            break;
        }
    }

    if (foundBrand) {
        const before = s.substring(0, brandIdx).trim();
        const after = s.substring(brandIdx).trim();
        const upBefore = before.toUpperCase();
        const schemeKeywords = ["EQUITY", "DEBT", "HYBRID", "CASH", "LIQUID", "INDEX", "ETF", "BALANCED", "ARBITRAGE", "ELSS", "SAVINGS", "TAX", "FUND", "PLAN"];
        const isMeaningful = before.length > 4 && (/[A-Z]/.test(upBefore)) && (schemeKeywords.some(k => upBefore.includes(k)) || upBefore.length > 10);
        const looksLikeHeader = /\b(BROKERAGE|STRUCTURE|COMMISSION|VALIDITY|JAN|FEB|MAR|Q[1-4]|FY)\b/i.test(upBefore);
        if (looksLikeHeader) s = after;
        else if (isMeaningful) s = after + " " + before;
        else s = after;
    } else {
        s = s.replace(/^[0-9.%\s]+/, "");
        s = s.replace(/^\d+\)\s*/, "");
        if (!s.match(/^360/)) s = s.replace(/^[^A-Za-z0-9]+/, "");
    }

    s = s.replace(/#.*$/, "");
    s = s.replace(/arn-?\d+/gi, "").replace(/distributor/gi, "");
    s = s.replace(/see\s*overleaf.*/gi, "").trim();
    const cleanRe = /(Trail 1st|Trail 4th|Year|onwards|Equity Funds|Hybrid Funds|Debt Funds|Lump sum|Systematic|1 to MAX|NORMAL|INVESTMENT|PERIOD|TRANSACTION|B30|INCENTIVE|TRAILER|FEE|T\+\d|MONTHLY?|QUARTERLY|FIXEDNO|MONTHS|DAYS|REDEMPTION|SWITCH|EXIT LOAD|SUBJECT TO|PARTNER|FOR REMAINING|UNITS|ALLOTTED|\bNIL\b|\bALL\b|\bYEARS\b|REFER LINK BELOW|INVESTOR'S EXIT|BENCHMARK|FROM DATE|TO DATE|RS\s?\.?\d+\s?LAKH|[<>]=\s?RS\s?\.?\d+\s?LAKH|BEFORE \d+ (MONTH|DAY)S?|LOCK IN PERIOD OF \d+ YEARS?|REFER NOTE \d+|\*\*|White Oak Capital Asset Management Limited.*)/gi;
    s = s.replace(cleanRe, "").trim();
    s = s.replace(/\d{1,2}-\d{1,2}-\d{2,4}/g, "").trim();
    s = s.replace(/\d{2}-\d{2}/g, "").trim();
    s = s.replace(/\s+All$/i, "");
    s = s.replace(/Exit load.*?(\d+\.\d+|\d+%|days|$)/gi, "");
    s = s.replace(/Nil.*?(\d+\.\d+|\d+%|units|$)/gi, "");
    s = s.replace(/\s+All\s*$/i, "").replace(/All$/i, "");

    s = s.replace(/(\([A-Z0-9]+\))[\d. ]+%/gi, "$1").trim();
    s = s.replace(/(\([A-Z0-9]+\))[\d.]{2,}/gi, "$1").trim();

    // Bandhan specific: FundAll1.30%1.30%
    s = s.replace(/All(\d+\.\d+%\s*)*$/i, "").trim();

    // Repeated rate patterns: 0.850.850.85 or 1.30%1.30%
    s = s.replace(/(\d+\.\d+%\s*){2,}/gi, "").trim();
    s = s.replace(/(\d+\.\d+\s*%){2,}/gi, "").trim();
    s = s.replace(/[\d. ]+%\s*$/, "").trim();
    s = s.replace(/[\d. ]+%\s*$/, "").trim(); // Twice to catch multiple at end

    s = s.replace(/(\b|MAX)[\d. %]{7,}(\s+|$)/gi, "").trim();
    s = s.replace(/(\b|MAX)(\d+\.\d{1,3}%?){2,}/gi, "").trim();

    // Strip trailing category word + rate that got concatenated: "Overnight 0.05", "Debt 0.90"
    // Note: "Index" excluded — it's part of legitimate "...Index 0.72" lines where "Index Fund" is split across lines
    s = s.replace(/\s+(Overnight|Debt|Equity|Hybrid|Liquid|Cash|Arbitrage)\s+\d+\.\d+\s*$/i, "").trim();
    // Strip trailing bare rate: "Fund 0.05" or "Fund0.05"
    s = s.replace(/\s+\d+\.\d{2,}\s*$/g, "").trim();

    s = s.replace(/All$/i, "").trim();

    let prev;
    do {
        prev = s;
        s = s.replace(/\b(of|for|if|within|at|the|and|is)\b$/i, "").trim();
        s = s.replace(/\s+Fund\s+the$/i, " Fund").trim();
        s = s.replace(/\s*\b(Beyond|Within|Premature|If redeemed|If switched out|In respect of|Exit load|allotted)\b.*/gi, "").trim();
        s = s.replace(/\b(Beyond|Within|Premature|If redeemed|If switched out|In respect of|Exit load)\b.*$/gi, "").trim();
        // Strips trailing boilerplate ("… on the balance units", "… investment period").
        // NOTE the negative lookahead on `balance`: several AMCs sell a
        // "Balance(d) Advantage Fund", and stripping from "balance" onward deleted
        // the whole scheme name so the row was silently dropped (real case:
        // "Bajaj FinServ Balance Advantage Fund" vanished while every sibling
        // scheme parsed fine). Never cut a scheme name at "Balance(d) Advantage".
        s = s.replace(/\s*\b(NAV|investment|remaining|amount|balanced?(?!\s+(?:advantage|hybrid|fund))|units|period|allotment)\b.*/gi, "").trim();
        // Only strip pure category section headers, NOT legitimate fund type suffixes like "Fund of Fund"
        s = s.replace(/\s+\b(Sectoral|Thematic|Sectoral\/ Thematic|Sectoral \/Thematic|Sectoral \/ Thematic)\b.*$/gi, "").trim();
        s = s.replace(/\s*[<>]\s*$/g, "").trim();
        if (s.includes("/")) {
            const parts = s.split("/");
            if (parts[1] && parts[1].length > 5 && (parts[1].toLowerCase().includes("fund") || parts[1].toLowerCase().includes("plan"))) {
            } else s = parts[0].trim();
        }
    } while (s !== prev);

    s = normalizeSpaces(s);

    const mergedCats = ["EQUITYARBITRAGE", "EQUITY CORE", "EQUITY CORE FUNDS", "EQUITYCORE", "EQUITYINDEX", "EQUITY INDEX", "DEBTNFO", "DEBT NFO", "EQUITYNFO", "EQUITY NFO", "EQUITYFOF", "EQUITY FOF", "EQUITYHYBRID", "EQUITY HYBRID", "EQUITYSOLUTION", "EQUITY SOLUTION", "EQUITYEQUITY", "EQUITY EQUITY", "DEBTDEBT", "DEBT DEBT"];
    for (const mc of mergedCats) {
        const re = new RegExp(`(FUND|PLAN|INDEX)\\s*${mc.replace(/\s+/g, '\\s*')}.*?$`, 'gi');
        s = s.replace(re, "$1").trim();
        if (s.toUpperCase() === mc.toUpperCase()) return "";
    }

    const categories = ["EQUITY", "DEBT", "HYBRID", "LIQUID", "CASH", "INDEX", "FOF", "ARBITRAGE", "ELSS", "NORMAL", "RETIREMENT", "CHILDREN", "DYNAMIC ASSET", "EQUITY SAVINGS", "AGGRESSIVE HYBRID", "CONSERVATIVE HYBRID", "MULTI ASSET ALLOCATION", "BALANCED ADVANTAGE", "BANKING & PSU", "BANKING &PSU", "CORPORATE BOND", "GILT", "SHORT DURATION", "MEDIUM DURATION", "LONG DURATION", "MONEY MARKET", "LOW DURATION", "FLOATER", "ULTRA SHORT", "TRANSPORTATION", "LOGISTICS", "INNOVATION", "QUANT", "FLEXICAP", "MIDCAP", "LARGECAP", "SMALLCAP"];
    for (const cat of categories) {
        const re = new RegExp(`(${cat}\\b.*?)\\s?\\b(Fund|Plan|Fund and)?\\s?\\b${cat}\\b.*`, 'i');
        s = s.replace(re, "$1").trim();
    }

    // Note: "INDEX" intentionally excluded — it's part of legitimate "...Index Fund" scheme names
    // where OCR splits "Fund" to the next line, leaving "...Index" as the temporary scheme name
    const catWords = ["CASH", "NFO", "CORE FUNDS", "SECTORAL/THEMATIC", "SECTORAL/ THEMATIC", "SOLUTION BASED", "NORMAL"];
    for (const cw of catWords) {
        const re = new RegExp(`\\b${cw}\\s*$`, 'i');
        if (s.toUpperCase().endsWith(cw)) s = s.replace(re, "").trim();
    }

    // Protect compound suffixes like "LARGE & MID CAP" from being broken up
    const compoundNames = {
        'LARGE & MID CAP': 'LARGE_AND_MID_CAP_PLACEHOLDER',
        'LARGE AND MID CAP': 'LARGE_AND_MID_CAP_PLACEHOLDER'
    };
    for (const [orig, placeholder] of Object.entries(compoundNames)) {
        s = s.replace(new RegExp(orig, 'gi'), placeholder);
    }
    // Preserve structural words like FUND/INDEX/ETF as they are part of actual scheme names.
    const removableTailSuffixes = ["DIRECT", "REGULAR", "GROWTH", "TRI"];
    for (const sfx of removableTailSuffixes) {
        const re = new RegExp(`\\s${sfx}\\s*$`, 'i');
        const candidate = s.replace(re, "").trim();
        // Don't strip if it would leave only a brand name behind
        const isJustBrand = BRANDS.some(b => candidate.toUpperCase() === b.toUpperCase() || candidate.toUpperCase().replace(/\s+/g, ' ').trim() === b.toUpperCase());
        if (!isJustBrand) s = candidate;
    }
    const dedupeTailSuffixes = ["EQUITY", "DEBT", "HYBRID", "LIQUID", "ARBITRAGE", "GROWTH", "DIRECT", "REGULAR", "PLAN", "INDEX", "FUND", "FOF", "SERVICES", "TRI"];
    // Restore compound names
    for (const [orig, placeholder] of Object.entries(compoundNames)) {
        s = s.replace(new RegExp(placeholder, 'gi'), orig);
    }

    // Final aggressive cleanup of trailing "All" or rate remnants
    s = s.replace(/All[\d. %%]*$/i, "").trim();
    s = s.replace(/[\d. ]+%\s*$/, "").trim();
    s = s.replace(/All$/i, "").trim();

    const indexCutoffs = ["CRISIL", "S&P", "SENSEX", "MSCI", "BENCHMARK", "NIFTY", "NIFTY50", "NIFTY100", "BSE", "INDIA HYBRID", "COMPOSITE DEBT", "DOMESTIC PRICES"];
    const up = s.toUpperCase();
    for (const idx of indexCutoffs) {
        const pos = up.indexOf(idx);
        if (pos !== -1) {
            const before = up.substring(0, pos);
            const after = up.substring(pos + idx.length);
            // Check if the keyword is part of the actual fund/scheme name
            // Look at the ORIGINAL line (before suffix stripping) for INDEX/FUND/ETF keywords
            const originalUp = line.toUpperCase();
            const origAfter = originalUp.indexOf(idx) !== -1 ? originalUp.substring(originalUp.indexOf(idx) + idx.length) : after;
            const isFundName = /\b(INDEX|FUND|ETF|PLAN|FOF)\b/.test(after) || /\b(INDEX|FUND|ETF|PLAN|FOF)\b/.test(origAfter);
            // Do NOT truncate CRISIL-IBX fund names — "CRISIL IBX" is part of the scheme name, not a benchmark reference
            const isCrisilIndexFund = /CRISIL[- ]IBX/i.test(s);
            // NEW: If we already have FUND/FOF/PLAN before the benchmark, this is likely a concatenated benchmark
            const hasFundTypeBeforeBenchmark = /\b(FUND|FOF|PLAN|ETF)\b/.test(before);
            // Truncate if: (1) has fund type before benchmark, OR (2) position is far enough (>15 chars) and not a fund name
            if (!isCrisilIndexFund && (hasFundTypeBeforeBenchmark || (!isFundName && (pos > 15 || up.includes("BENCHMARK") || up.includes("CRISIL"))))) {
                s = s.substring(0, pos).trim();
                break;
            }
        }
    }

    for (const suffix of dedupeTailSuffixes) {
        const reSuffixSee = new RegExp(`(${suffix})(SEE)`, 'i');
        if (reSuffixSee.test(s)) s = s.replace(reSuffixSee, "$1").trim();
        const doubled = suffix + " " + suffix;
        const doubledFund = suffix + " Fund " + suffix;
        if (s.toUpperCase().includes(doubled)) {
            const parts = s.toUpperCase().split(doubled);
            s = parts[0] + suffix;
        } else if (s.toUpperCase().includes(doubledFund)) {
            const parts = s.toUpperCase().split(doubledFund);
            s = parts[0] + suffix + " Fund";
        }
    }

    if (s.includes(",") && s.toUpperCase().includes("FUND") && s.length > 40) {
        const parts = s.split(",");
        if (parts.length > 1 && parts[0].toUpperCase().includes("FUND")) s = parts[0];
    }
    s = s.replace(/ (through|Mutual Fund Platforms).*$/gi, "").trim();

    const words = s.split(/\s+/);
    if (words.length > 3) {
        let seen = new Set();
        let cleanedWords = [];
        const brandWords = BRANDS.flatMap(b => b.split(/\s+/));
        const excluded = new Set(["THE", "AND", "OF", "FUND", "FUNDS", "UTI", "ETF", "'S", ...brandWords]);
        for (let i = 0; i < words.length; i++) {
            let up = words[i].toUpperCase();
            if (up.length > 2 && seen.has(up) && !excluded.has(up)) {
                if (i + 1 < words.length) {
                    let nextUp = words[i + 1].toUpperCase();
                    if (seen.has(nextUp) && !excluded.has(nextUp)) break;
                } else break;
            }
            cleanedWords.push(words[i]);
            seen.add(up);
        }
        s = cleanedWords.join(" ");
    }
    // Clean up double "LIFE LIFE" caused by SUNLIFE → SUN LIFE replacement
    s = s.replace(/\bSUN LIFE LIFE\b/gi, "SUN LIFE");
    // Clean up trailing category+number artifacts like "DEBTEQUITY - 2", "EQUITYEQUITY - 1", "CASHINDEX", etc.
    // Only if they clearly follow a Fund/Plan/Index keyword or are clearly distinct artifacts
    s = s.replace(/(FUND|PLAN|INDEX)\s*(EQUITY|DEBT|HYBRID|CASH|INDEX|FOF|LIQUID|SOLUTION)\s*(EQUITY|DEBT|HYBRID|CASH|INDEX|FOF|LIQUID|SECTORAL|THEMATIC|SOLUTION|OTHER|NFO|CORE|ARBITRAGE)(\s*-?\s*\d+)?$/i, "$1").trim();
    s = s.replace(/\s+(EQUITY|DEBT|HYBRID|CASH|INDEX|FOF|LIQUID|SOLUTION)(EQUITY|DEBT|HYBRID|CASH|INDEX|FOF|LIQUID|SECTORAL|THEMATIC|SOLUTION|OTHER|NFO|CORE|ARBITRAGE)(\s*-?\s*\d+)?$/i, "").trim();
    // Same glued-category junk but joined by a HYPHEN rather than a space, e.g.
    // "… INDEX FUND-DEBTDEBT - 1". Only strips an IMMEDIATELY DOUBLED category —
    // never a single one, since "FOF"/"INDEX FUND"/"ETF" are real name parts.
    s = s.replace(/[\s-]+\b(EQUITY|DEBT|HYBRID|LIQUID|CASH|ARBITRAGE|ELSS|SOLUTION|OTHER|CORE)\1(?:\s*-\s*\d+)?\s*$/i, "").trim();
    // A trailing phrase that merely repeats text already in the name — the
    // category column echoing the scheme ("Bandhan Banking and PSU Fund Banking
    // and PSU Fund", "KOTAK … INDEX FUND INDEX Fund"). Longest real repeat wins.
    for (let cut = Math.floor(s.length / 2); cut >= 6; cut--) {
        const tail = s.slice(-cut).trim();
        const head = s.slice(0, s.length - cut).trim();
        if (tail.length >= 6 && head.toLowerCase().includes(tail.toLowerCase())) { s = head; break; }
    }
    // Clean up trailing "LT DEBT00" etc.
    s = s.replace(/\s+LT\s+DEBT\d*$/i, "").trim();
    return normalizeSpaces(s).replace(/[-:|]+$/, "").trim();
};

const postCleanSchemeName = (schemeName, amcName = "") => {
    let s = normalizeSpaces(schemeName || "");
    if (!s) return "";

    s = s
        .replace(/[^\x20-\x7E]/g, " ")
        .replace(/\bHelio\s+s\b/gi, "Helios")
        .replace(/\bWHITE\s*OAK\b/gi, "WHITE OAK")
        .replace(/\bTHE\s*WEALTH\s*COMPANY\b/gi, "THE WEALTH COMPANY")
        .replace(/\b(WHITEOAK|WHITE OAK|WhiteOak)\b/gi, "WHITE OAK")
        .replace(/\b(THEWEALTHCOMPANY|TheWealthCompany)\b/gi, "THE WEALTH COMPANY")
        .replace(/\b(FUND|PLAN|ETF|INDEX|FOF)(\s?\d{1,2})\b/gi, "$1")
        .replace(/\b(Fund|Plan)([A-Z])/g, "$1 $2")
        .replace(/\b(FUND|PLAN|ETF|INDEX|FOF)([A-Z])/g, "$1 $2")
        .replace(/\b(\d+(?:\.\d+)?)\s*%\s*(p\.?a\.?)?/gi, " ")
        .replace(/\b(?:<=|>=|<|>)\s*\d+(?:\.\d+)?\s*\*?/gi, " ")
        .replace(/\b(Beyond|Within|Before|After|If redeemed|If switched out|Exit load)\b.*$/i, "")
        .replace(/\b(BROKERAGE|STRUCTURE|COMMISSION|VALIDITY|JAN|FEB|MAR|Q[1-4]|FY|PARTICULARS)\b.*$/i, "")
        .replace(/\b(\d+)\s*(day|days|month|months|year|years)\b.*$/i, "")
        .replace(/\block[- ]?(?:in|n)\s*\d*\b.*$/i, "")    // handles "Lock-in" and OCR "Lock-n"
        .replace(/\b(Tax Saver)\d+\b/gi, "$1")
        .replace(/SOL\s*UTI\s*ON\s*BASED/gi, "")
        .replace(/SOLUTION\s*BASED/gi, "")
        .replace(/\s+\.\d+\b/g, " ")
        .replace(/\bAll\s*$/i, "")
        .replace(/\s*&\s*$/g, "")
        .replace(/[.,;:\-|]+$/g, "");

    // Strip trailing pipe-separated OCR garbage: "Fund | os" → "Fund"
    s = s.replace(/\s*\|.*$/, '').trim();
    // Strip trailing 1-3 char lowercase OCR artifacts — e.g. "Conservative a" → "Conservative", "Bond Fund oe" → "Bond Fund"
    s = s.replace(/\s+[a-z]{1,3}$/g, '').trim();
    // Fix "Fo F" → "FoF" (OCR splits FoF with a space)
    s = s.replace(/\bFo\s+F\b/gi, 'FoF');

    // De-duplicate words like "FUND FUND" or "LIFE LIFE"
    s = s.replace(/\b([A-Za-z]+)\s+\1\b/gi, "$1");
    // De-duplicate consecutive word pairs: "Focused Fund Focused Fund" → "Focused Fund"
    s = s.replace(/\b([A-Za-z]+\s+[A-Za-z]+)\s+\1\b/gi, "$1");
    // De-duplicate 3-word sequences: "Short Term Fund Short Term Fund" → "Short Term Fund"
    s = s.replace(/\b([A-Za-z]+\s+[A-Za-z]+\s+[A-Za-z]+)\s+\1\b/gi, "$1");
    s = normalizeSpaces(s);

    for (const brand of BRANDS) {
        const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(`([A-Za-z])(${escaped})`, "gi"), "$1 $2");
        s = s.replace(new RegExp(`(${escaped})([A-Za-z])`, "gi"), "$1 $2");
    }
    s = normalizeSpaces(s);

    const upper = s.toUpperCase();
    let firstBrandPos = -1;
    for (const brand of BRANDS) {
        const idx = upper.indexOf(brand.toUpperCase());
        if (idx !== -1 && (firstBrandPos === -1 || idx < firstBrandPos)) firstBrandPos = idx;
    }
    if (firstBrandPos > 0) {
        const prefix = upper.substring(0, firstBrandPos).trim();
        const looksLikeHeader = /\b(BROKERAGE|STRUCTURE|COMMISSION|VALIDITY|JAN|FEB|MAR|Q[1-4]|FY)\b/.test(prefix);
        const looksLikeCategoryPrefix = /^(EQUITY|DEBT|HYBRID|THEMATIC|INDEX|CASH|LIQUID|OTHER|FUND|ARBITRAGE|ELSS)\b/.test(prefix);
        if (looksLikeHeader || looksLikeCategoryPrefix || prefix.length < 20) {
            s = s.substring(firstBrandPos).trim();
        }
    }

    s = s.replace(/^(EQUITY|DEBT|HYBRID|THEMATIC|INDEX|CASH|LIQUID|OTHER|ARBITRAGE|ELSS)\s+/i, "");
    s = s.replace(/\b(of|for|with|and|the|to|in|on)\b$/i, "");
    s = normalizeSpaces(s);

    const words = s.split(/\s+/);
    if (words.length > 1) {
        const compact = [];
        for (const word of words) {
            if (compact.length > 0 && compact[compact.length - 1].toUpperCase() === word.toUpperCase()) continue;
            compact.push(word);
        }
        s = compact.join(" ");
    }

    const upAmc = normalizeSpaces(amcName).toUpperCase();
    const compact = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (BRANDS.some(b => compact === b.toUpperCase().replace(/[^A-Z0-9]/g, ""))) return "";
    if (upAmc && compact === upAmc.replace(/[^A-Z0-9]/g, "")) return "";

    // Clean up trailing artifacts like DEBTOTHER - FOF or EQUITYEQUITY
    // Note: FOF and INDEX excluded from single-tail strip — they are part of actual fund names
    // ("Passive FoF", "Active FoF", "...Index Fund" where OCR split "Fund" to next line)
    const tailCats = "EQUITY|DEBT|HYBRID|OTHER|INDEX|FOF|CASH|LIQUID|ARBITRAGE|THEMATIC|SECTORAL|SOLUTION|ELSS";
    const strippableTailCats = "EQUITY|DEBT|HYBRID|OTHER|CASH|LIQUID|ARBITRAGE|THEMATIC|SECTORAL|SOLUTION|ELSS";
    s = s.replace(new RegExp(`\\s+(${tailCats})\\s*[-\\s]*\\s*(${tailCats})$`, 'i'), "");
    s = s.replace(/\b(DEBTOTHER|EQUITYOTHER|HYBRIDOTHER|INDEXOTHER|OTHEROTHER|FOFOTHER)\b.*$/i, "");
    s = s.replace(new RegExp(`\\s+(${strippableTailCats})$`, 'i'), "");

    // Strip trailing benchmark/index name repetitions from SBI etc.
    // e.g. "SBI NIFTY50 EQUAL WEIGHT INDEX FUND NIFTY50" → "SBI NIFTY50 EQUAL WEIGHT INDEX FUND"
    s = s.replace(/\s+(NIFTY\s*\d*|NIFTY\s+IT|NIFTY\s+BANK|BSE\s+PSU\s+BANK|BSE|CRISIL|PRICE|S\s*&\s*P\s+\d+|NIFTY\s*\d+|NIFTY\s+INDIA)\s*$/i, "").trim();
    // Strip trailing "As per table below" text
    s = s.replace(/\s+As per table below.*$/i, "").trim();
    // Strip trailing PMSPMS artifacts
    s = s.replace(/\s*PMSPMS\s*$/i, "").trim();
    // Strip trailing "BSE" or "NIFTY" bare  
    s = s.replace(/\s+BSE\s*$/i, "").trim();
    s = s.replace(/\s+NIFTY\s*$/i, "").trim();

    return normalizeSpaces(s);
};

const splitCategoryScheme = (raw) => {
    const low = raw.toLowerCase();
    for (const kw of CATEGORY_KEYWORDS) {
        if (low.startsWith(kw + " ")) {
            const cat = kw === "etf" ? "ETF" : kw.charAt(0).toUpperCase() + kw.slice(1);
            let rest = raw.substring(kw.length).trim();
            if (rest.length < 3) return { category: cat, schemeName: raw };
            return { category: cat, schemeName: normalizeSpaces(rest) };
        }
    }
    const cat = guessCategory(raw);
    return { category: cat, schemeName: raw };
};

/**
 * Pre-process lines where category words are concatenated with brand/scheme names.
 * e.g. "Equity360 ONE Flexicap Fund0.75%" → "360 ONE Flexicap Fund 0.75%"
 * Also handles "Hybrid360 ONE ...", "Debt360 ONE ...", "Liquid360 ONE ..."
 */
/**
 * Cut an exit-load clause out of a line that also carries the scheme and its rates.
 *
 * Several AMCs put all three on ONE line:
 *   "Edelweiss Multi cap Fund Exit load of 1% if redeemed within 90 Days 0.98% 0.98% 0.98%"
 *   "Canara Robeco Value Fund1.00% - if redeemed/switched out within 365 days
 *    from the date of allotment.1.25 1.25"
 *
 * isNoiseLine() drops any line that mentions an exit load next to a number, so the
 * WHOLE row went — the scheme name and its trail rates with it. Edelweiss lost every
 * one of its schemes that way, and Canara lost seven.
 *
 * The clause runs from the exit-load rate up to the trailing run of trail rates that
 * ends the line, so that run is what we anchor on. A line that is ONLY an exit-load
 * note has no such trailing run, nothing is removed, and isNoiseLine still drops it.
 */
const EXIT_LOAD_CLAUSE =
    /(?:exit\s*load\b[^%\d]{0,30})?\d+(?:\.\d+)?\s*%?\s*[-–]?\s*[^%\d]{0,30}?(?:if\s+redeemed|if\s+units|if\s+switched|redeemed\s*\/?\s*switched?(?:[-\s]*out)?)[\s\S]*?[.,]?(?=\s*(?:\d+(?:\.\d+)?\s*%?[\s,]*){1,8}$)/gi;

const stripExitLoadClause = (line) => {
    if (!/exit\s*load|if\s+redeemed|redeemed\s*\/?\s*switch|switched[-\s]*out|if\s+units/i.test(line)) return line;
    return line.replace(EXIT_LOAD_CLAUSE, ' ').replace(/\s{2,}/g, ' ').trim();
};

const preProcessConcatenatedLines = (lines) => {
    const CATEGORY_PREFIXES = ['Equity', 'Hybrid', 'Debt', 'Liquid', 'Index', 'Cash', 'Solution', 'Other'];
    return lines.map(line => {
        // Take the exit-load clause out FIRST, so a real scheme row that happens to
        // carry its exit load inline survives isNoiseLine().
        line = stripExitLoadClause(line);
        // Pattern: CategoryBrandName SchemeName FundRate%
        // e.g. "Equity360 ONE Flexicap Fund0.75%"
        for (const cat of CATEGORY_PREFIXES) {
            const re = new RegExp(`^${cat}(\\d+\\s+ONE\\b|[A-Z][a-z])`, 'i');
            if (re.test(line)) {
                line = line.substring(cat.length);
                break;
            }
        }
        // Split concatenated rate at end: "Fund0.75%" → "Fund 0.75%", "Fund1.00%" → "Fund 1.00%"
        line = line.replace(/([A-Za-z])(\d+\.\d+%)/g, '$1 $2');
        // Fix missing space between brand and scheme after OCR: "AxisSmall" → "Axis Small", "AxisNIFTY" → "Axis NIFTY"
        line = line.replace(/\b(Axis)([A-Z][a-z])/g, 'Axis $2');
        line = line.replace(/\b(Axis)([A-Z]{2})/g, 'Axis $2');
        return line;
    });
};

/**
 * Core extraction logic that works on raw text.
 * Called by both the PDF buffer path and the OCR path.
 */
/**
 * Some AMCs (Motilal Oswal) publish the structure in BASIS POINTS as bare
 * integers — "Motilal Oswal Flexi Cap Fund 70 13 83 70 13 83 210 39 249" —
 * with no % sign and no decimal point. extractPercentages() only recognises
 * "1.25" or "1.25%", so every row of such a table scored zero rates and the
 * whole upload came back empty with no error to explain why.
 *
 * Columns repeat as (Trail, GST, Total) triplets, one triplet per tenure band.
 * We take the FIRST triplet — the trail in force today — and convert bps to
 * percent. The trailing "Total 3 Year Payout" triplet is 3x the first and must
 * never be read as a rate.
 *
 * What makes this safe to run over every PDF is arithmetic, not a filename:
 * a real triplet always satisfies Trail + GST === Total. Numbers inside a
 * scheme name ("Nifty 500 Index Fund") are followed by words, so they never
 * land in the trailing run, and a coincidental run would still have to balance.
 */
export function extractBpsRows(rawText, amcName, sourceFile) {
    // Only for documents that SAY they are in bps — never guess a unit.
    if (!/\bbps\b/i.test(rawText || "")) return [];
    const rows = [];
    let sectionCategory = "";
    for (const raw of (rawText || "").split("\n")) {
        const line = normalizeSpaces(raw);
        if (!line) continue;
        const up = line.toUpperCase();
        if (/^ACTIVE FUNDS?$/.test(up)) { sectionCategory = "Equity"; continue; }
        if (/^PASSIVE FUNDS?$/.test(up)) { sectionCategory = "Index"; continue; }
        if (/^ARBITRAGE FUNDS?$/.test(up)) { sectionCategory = "Arbitrage"; continue; }

        const m = line.match(/^(.*[A-Za-z)])\s+((?:\d{1,4}\s+){2,}\d{1,4})$/);
        if (!m) continue;
        const nums = m[2].split(/\s+/).map(Number);
        if (nums.length % 3 !== 0) continue;
        let balanced = true;
        for (let i = 0; i < nums.length; i += 3) {
            if (nums[i] + nums[i + 1] !== nums[i + 2]) { balanced = false; break; }
        }
        if (!balanced) continue;
        const trailBps = nums[0];
        // 500 bps = 5% p.a., the same ceiling extractPercentages() applies.
        if (!(trailBps > 0 && trailBps <= 500)) continue;
        const schemeName = postCleanSchemeName(cleanSchemeName(m[1]).trim(), amcName);
        if (!schemeName || schemeName.length < 6) continue;
        rows.push({
            amcName,
            schemeName,
            category: guessCategory(schemeName) || sectionCategory || "Other",
            trailRate: trailBps / 100,
            sourceFile,
            rawLine: line,
        });
    }
    return rows;
}

/**
 * Pair scheme names with rates when the PDF emits them as SEPARATE COLUMNS.
 *
 * Helios' card comes out of pdf-parse as every scheme name first, then every rate:
 *
 *     Helios Flexi Cap Fund          <- 8 names, with category headers between
 *     ... 7 more ...
 *     TrailGSTTotal                  <- "Upto 3 Years" block
 *     0.76%  ... 8 trail values
 *     0.14%  ... 8 GST values
 *     0.90%  ... 8 total values
 *     TrailGSTTotal                  <- "4th Year onwards" block, same shape
 *
 * Nothing on a line ties a name to its rate, so the line-based reader paired the
 * rates with whatever text sat nearest — it produced 33 rows carrying 2 distinct
 * names, one of them a sentence from the Terms & Conditions.
 *
 * Here the two runs are paired BY POSITION: the first run of numeric-only lines
 * whose length equals the number of names is the trail column. The first such block
 * is the headline rate (Helios: "Upto 3 Years"); later blocks are later-year tiers
 * and are ignored, as is the GST/Total run that follows.
 *
 * Deliberately narrow: it needs at least 3 names AND an exact length match, so a
 * card that already reads correctly line-by-line never reaches this path.
 */
export function extractColumnarRows(rawText, amcName, sourceFile) {
    const lines = (rawText || "").split("\n").map(l => String(l).trim()).filter(Boolean);
    const isPct = (l) => /^\d{1,3}(?:\.\d+)?\s*%?$/.test(l);
    const isHeader = (l) => /scheme\s*name\s*$/i.test(l) || /^trail|gst|total$/i.test(l.replace(/\s+/g, ""));
    const looksLikeScheme = (l) =>
        l.length >= 8 && l.length <= 70
        && /fund|scheme|yojana|etf|plan/i.test(l)
        && !isHeader(l)
        && !isPct(l)
        && !/\d\s*%/.test(l)                       // a rate on the line = not this layout
        && !/^[IVXLC]+\s*[.)]/.test(l)             // roman-numeral T&C clause
        && !/[.;:]\s/.test(l)                      // prose, not a scheme name
        && !/\b(shall|will|please|refer|applicable|distributor|investor|commission)\b/i.test(l);

    // Longest run of name-like lines, allowing category headers to sit between them.
    let best = [], cur = [];
    for (const l of lines) {
        if (looksLikeScheme(l)) cur.push(l);
        else if (isHeader(l) && cur.length) continue;   // "Equity Scheme Name" etc.
        else { if (cur.length > best.length) best = cur; cur = []; }
    }
    if (cur.length > best.length) best = cur;
    if (best.length < 3) return [];

    // First run of numeric-only lines exactly as long as the name list.
    const firstIdx = lines.indexOf(best[best.length - 1]) + 1;
    let run = [];
    for (let i = firstIdx; i < lines.length; i++) {
        if (isPct(lines[i])) { run.push(lines[i]); if (run.length === best.length) break; }
        else if (run.length) { if (run.length === best.length) break; run = []; }
    }
    if (run.length !== best.length) return [];

    const rows = [];
    for (let i = 0; i < best.length; i++) {
        const rate = parseFloat(String(run[i]).replace("%", ""));
        if (!(rate >= 0) || rate > 10) continue;       // a trail above 10% is not a trail
        const scheme = cleanSchemeName(best[i]) || best[i];
        if (!scheme || scheme.length < 5) continue;
        rows.push({ amcName, schemeName: scheme, trailRate: rate, category: "Other", sourceFile, rawLine: `${best[i]} | ${run[i]}` });
    }
    return rows;
}

/**
 * Cards that price each scheme over a TENURE GRID — qsif (quant's SIF) is the
 * first of them.
 *
 * The scheme name is spread over two or three lines, then one row per holding
 * period, each carrying nine numbers: three AUM slabs (BASE PLUS, BASE, OPEN)
 * times three figures (without GST, GST, total). pdf-parse flattens all of it,
 * and the ordinals arrive in pieces — "1", "st", "Year 0.97 0.18 …" on three
 * separate lines:
 *
 *     qsif Equity
 *     Long Short Fund
 *     (Equity)
 *     1
 *     st
 *     Year 0.97 0.18 1.15 0.78 0.14 0.92 0.63 0.11 0.74
 *
 * The generic line reader needs a name and a rate on ONE line, so it found three
 * fragments in a five-scheme document and glued them to the wrong names — the
 * review screen offered "Long Short Fund qsif Equity Ex-Top Fund (" at 0.97.
 *
 * The rate taken is the FIRST number of the FIRST tenure row: the first slab's
 * figure before GST, which is what this master stores everywhere else. Every
 * slab is kept in rawLine so the choice can be checked against the card.
 */
export function extractTenureGridRows(rawText, amcName, sourceFile) {
    const lines = (rawText || "").split("\n").map(l => String(l).replace(/\s+/g, " ").trim());

    const ORDINAL = /^\d{1,2}$/;
    const SUFFIX = /^(st|nd|rd|th)$/i;
    const TENURE = /^years?\b/i;
    const numbersIn = (l) => (String(l).match(/\d+\.\d{1,3}/g) || []).map(Number);
    // Prose, footers and the column headers that sit above the grid.
    const NOISE = /^(category|investment|strategy|period|without|gst|amt|total|onwards|base|open|document|communication|notes?|applicable|in case of|\*|registered office)/i;

    const schemes = [];
    let name = [];

    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l) continue;

        // A tenure marker: "1" + "st" + "Year …" across three lines.
        if (ORDINAL.test(l) && SUFFIX.test(lines[i + 1] || "") && TENURE.test(lines[i + 2] || "")) {
            let nums = numbersIn(lines[i + 2]);
            let j = i + 2;
            // "3rd Years / onwards* / 0.89 0.16 …" puts the figures further down.
            while (nums.length < 3 && j + 1 < lines.length && j < i + 5) {
                j++;
                nums = numbersIn(lines[j]);
            }
            const label = `${l}${lines[i + 1]}`;
            if (nums.length >= 3 && name.length) {
                schemes.push({ name: name.join(" ").trim(), label, nums });
                name = [];                      // later tenures belong to this scheme
            }
            i = j;
            continue;
        }

        // Anything else is either part of a scheme name or noise.
        if (NOISE.test(l)) { name = []; continue; }
        if (numbersIn(l).length >= 3) continue;             // a stray figures row
        if (l.length < 3 || l.length > 80) continue;
        name.push(l);
        if (name.length > 4) name.shift();                  // names run to three lines
    }

    // Only claim this layout when it is unmistakable. Two schemes priced over a
    // grid is a grid; one is a coincidence another reader probably handles better.
    if (schemes.length < 2) return [];

    const rows = [];
    for (const s of schemes) {
        const rate = s.nums[0];
        if (!(rate >= 0) || rate > 10) continue;
        // The card puts the asset class on its own line under the name. Read the
        // category from it, then drop it: leaving it on some names and not others
        // would file one scheme under two keys in the master.
        const bare = s.name.replace(/\s*\((equity|hybrid|debt|liquid|arbitrage)\)\s*$/i, "").trim();
        const cleaned = cleanSchemeName(bare) || bare;
        if (!cleaned || cleaned.length < 5) continue;
        rows.push({
            amcName,
            schemeName: cleaned,
            trailRate: rate,
            category: guessCategory(s.name),
            sourceFile,
            rawLine: `${s.name} | ${s.label} | slabs: ${s.nums.join(" ")}`,
        });
    }
    return rows;
}

export function extractBrokerageRowsFromText(rawText, amcName, sourceFile) {
    try {
        let lines = (rawText || "").split("\n").map(normalizeSpaces).filter(l => l.length > 0);
        // Pre-process concatenated category+brand lines (360 ONE format)
        lines = preProcessConcatenatedLines(lines);
        const rows = [];
        let currentCategory = "";
        let pendingFragments = [];
        let pendingRates = [];

        const isLikelySchemeFragment = (s) => {
            if (isNoiseLine(s)) return false;
            const up = s.toUpperCase();
            if (BRANDS.some(b => up.startsWith(b.toUpperCase()))) return true;
            if (up === "ALL" || up.includes("SCHEME CATEGORY") || up.includes("TRAILER FEE") || up === "NORMAL") return false;

            const cat = guessCategory(s);
            if (cat && s.length < 30) {
                const cleanTmp = s.replace(/[^A-Z]/gi, "").toUpperCase();
                const cleanCat = cat.replace(/[^A-Z]/gi, "").toUpperCase();
                if (cleanTmp === cleanCat || cleanTmp === "EQUITY" + cleanCat || cleanTmp === "DEBT" + cleanCat || cleanTmp === "HYBRID" + cleanCat) return false;
            }
            const keywords = ["fund", "equity", "plan", "index", "etf", "arbitrage", "bond", "liquid", "savings", "tax", "pension", "hybrid", "opportunity", "midcap", "smallcap", "focused", "banking", "infrastructure", "dividend", "duration", "energy", "healthcare", "logistics", "technology", "financial", "services", "growth", "value", "flexi", "large"];
            const low = s.toLowerCase();
            return keywords.some(k => low.includes(k)) || BRANDS.some(b => low.includes(b.toLowerCase()));
        };

        for (const line of lines) {
            const low = line.toLowerCase();
            let processedLine = line;
            if (low.includes("aditya birla") && (low.includes("lump sum") || low.includes("systematic"))) {
                const match = line.match(/(Lump sum|Systematic).*?(ADITYA BIRLA.*)/i);
                if (match) processedLine = match[2];
            }

            const guessedCat = guessCategory(processedLine);
            if (guessedCat && processedLine.length < 40 && !processedLine.includes("%")) currentCategory = guessedCat;

            if (isNoiseLine(line)) {
                if (low.includes("arn") || low.includes("employee") || low.includes("kyc ") || low.includes("partner name") || low.includes("validity period")) {
                    pendingFragments = [];
                    pendingRates = [];
                }
                continue;
            }

            const cleanedLineForCheck = cleanSchemeName(line);
            const brandStart = BRANDS.some(b => {
                const up = cleanedLineForCheck.toUpperCase();
                return up.startsWith(b) || (up.includes(b) && up.includes("FUND"));
            });
            const fragment = isLikelySchemeFragment(cleanedLineForCheck);

            // Standalone suffix words (ETF, FoF, "Fund of Fund" etc.) on their own line after a fragment
            // must be appended to the previous pending fragment, not dropped.
            // OCR commonly splits "Axis Silver ETF" into "Axis Silver" + "ETF" on separate lines.
            // Also catch OCR noise variants like "Fund }", "Fund i", "FUND )" → cleaned to "Fund"
            // BUT only if the line has NO rates — "Fund 1.00 1.00" is a data row, not a suffix line
            const cleanedSuffix = cleanSchemeName(line.trim()).trim();
            const suffixLineHasRates = extractPercentages(line).filter(p => !p.isExitLoad).length > 0;
            const isSuffixOnly = !suffixLineHasRates &&
                                  /^(ETF|FoF|Fund of Fund|Fund of Funds|Passive FoF|Active FoF|Index Fund|FOF|Fund)$/i.test(cleanedSuffix) &&
                                  /^(ETF|FoF|Fund of Fund|Fund of Funds|Passive FoF|Active FoF|Index Fund|FOF|Fund)[^a-z0-9]*/i.test(line.trim());
            if (isSuffixOnly && pendingFragments.length > 0) {
                const lastFrag = pendingFragments[pendingFragments.length - 1];
                // Use endsWith to avoid "Fund" not appending to "...Fund of" (contains "Fund" but doesn't end with it)
                if (!lastFrag.toLowerCase().endsWith(cleanedSuffix.toLowerCase())) {
                    pendingFragments[pendingFragments.length - 1] = lastFrag + ' ' + cleanedSuffix;
                }
                continue;
            }

            if (brandStart) pendingFragments = [];

            const percentages = extractPercentages(processedLine);
            const pureRates = percentages.filter(p => !p.isExitLoad).map(p => p.val);
            const isDataRow = (low.includes("lump sum") || low.includes("systematic") || (pureRates.length > 0 && processedLine.length < 160)) &&
                (!(/Beyond|Within|Premature|Each purchase|After|Before|Redeemed|<1 Year|<30 Days|<91 Days|<16 Days/i.test(line)) || (amcName.toLowerCase().includes("edelweiss") && percentages.length >= 2) || (amcName.toLowerCase().includes("bandhan") && pureRates.length >= 1) || (pureRates.length >= 1 && !(/Exit load|Within/i.test(line))) || (percentages.length >= 3));

            if (isDataRow && low.includes("lump sum") && amcName.toLowerCase().includes("aditya birla") && !brandStart) pendingFragments = [];

            if (isDataRow && percentages.length > 0) {
                const rates = percentages.filter(p => !p.isExitLoad).map(p => p.val);
                if (rates.length === 0 && !low.includes("lump sum") && !low.includes("systematic")) continue;
                const finalRate = rates.length > 0 ? rates[0] : percentages[0].val;
                let cleanedLine = cleanSchemeName(processedLine);
                let fullName = "";
                if (brandStart) {
                    if (pendingFragments.length > 0) {
                        const fragText = pendingFragments.join(" ").trim();
                        if (!cleanedLine.toUpperCase().includes(fragText.toUpperCase()) && fragText.length > 3) fullName = [fragText, cleanedLine].join(" ").trim();
                        else fullName = cleanedLine;
                    } else fullName = cleanedLine;
                } else if (pendingFragments.length > 0) {
                    if (low.includes("exit load") || low.includes("if redeemed") || low.includes("thereafter nil")) fullName = pendingFragments.join(" ").trim();
                    else {
                        // Handle rate-only lines (e.g., "0.950.950.950.95" in Axis PDFs)
                        // If cleanedLine is empty or very short (just numbers/rates), use pending fragments as scheme name
                        const isRateOnlyLine = cleanedLine.length === 0 || (cleanedLine.length <= 3 && /^\d+$/.test(cleanedLine)) || /^[\d.\s]+$/.test(cleanedLine.trim());
                        fullName = isRateOnlyLine ? pendingFragments.join(" ").trim() : [...pendingFragments, cleanedLine].join(" ").trim();
                    }
                } else {
                    pendingRates.push(finalRate);
                    continue;
                }
                fullName = cleanSchemeName(normalizeSpaces(fullName));
                if (fullName && fullName.length >= 8 && !isNoiseLine(fullName)) {
                    const { category, schemeName } = splitCategoryScheme(fullName);
                    let finalSchemeName = schemeName.replace(/\b(Months|Month|Days|Day|NIL)\b/gi, "").trim();
                    finalSchemeName = postCleanSchemeName(finalSchemeName, amcName);
                    // Final pass: Fix known PDF artifacts
                    finalSchemeName = finalSchemeName.replace(/\bHelio\s+s\b/gi, "Helios");
                    // OCR often splits "Index Fund" across lines; if name ends with bare "Index", append "Fund"
                    if (/\bIndex$/i.test(finalSchemeName) && !/\bIndex\s+Fund$/i.test(finalSchemeName)) {
                        finalSchemeName = finalSchemeName + " Fund";
                    }
                    // Strip residual "- No" or "- ET" artifacts left after lock-in cleanup
                    finalSchemeName = finalSchemeName.replace(/\s*-\s*[A-Z][a-z]{0,2}\s*$/, "").trim();
                    // The name is REASSEMBLED from fragments after cleanSchemeName ran —
                    // postCleanSchemeName and the "Index" → "Index Fund" repair both append
                    // to it — so a benchmark and date could come back after being cut.
                    // Re-apply the cuts to what is actually about to be stored.
                    finalSchemeName = finalSchemeName && !DISCLAIMER.test(finalSchemeName) && !halfBracket(finalSchemeName)
                        ? stripSchemeNoise(stripRepeatedCategory(cutDebrisTail(stripTrailingCategory(finalSchemeName))))
                        : "";
                    if (!finalSchemeName || finalSchemeName.length < 6) continue;
                    rows.push({ amcName, schemeName: finalSchemeName, category: category || currentCategory || "Other", trailRate: finalRate, sourceFile, rawLine: line });
                    pendingFragments = [];
                }
            } else {
                const cleaned = cleanSchemeName(line);
                if (fragment && !isDataRow) {
                    if (line.trim().startsWith("•") && !BRANDS.some(b => line.toUpperCase().includes(b))) continue;
                    if (brandStart) {
                        if (pendingRates.length > 0) {
                            const flushName = pendingFragments.length > 0 ? pendingFragments.join(" ").trim() : (cleaned || "");
                            for (const r of pendingRates) {
                                const { category, schemeName } = splitCategoryScheme(cleanSchemeName(flushName));
                                let finalSchemeName = schemeName.replace(/\b(Months|Month|Days|Day|NIL)\b/gi, "").trim();
                                finalSchemeName = postCleanSchemeName(finalSchemeName || cleaned, amcName);
                                // Final pass: Fix known PDF artifacts
                                finalSchemeName = finalSchemeName.replace(/\bHelio\s+s\b/gi, "Helios");
                                if (/\bIndex$/i.test(finalSchemeName) && !/\bIndex\s+Fund$/i.test(finalSchemeName)) finalSchemeName = finalSchemeName + " Fund";
                                finalSchemeName = finalSchemeName.replace(/\s*-\s*[A-Z][a-z]{0,2}\s*$/, "").trim();
                                if (!finalSchemeName || finalSchemeName.length < 6) continue;
                                rows.push({ amcName, schemeName: finalSchemeName, category: category || currentCategory || "Other", trailRate: Number(r) || 0, sourceFile, rawLine: "Rate pre-buffered" });
                            }
                            pendingRates = [];
                        }
                        pendingFragments = [cleaned];
                    } else pendingFragments.push(cleaned);
                    if (pendingFragments.length > 5) pendingFragments.shift();
                }
            }
        }
        const dedup = new Map();
        for (const row of rows) {
            const key = `${row.amcName.toLowerCase()}|${row.schemeName.toLowerCase()}|${row.trailRate}`;
            if (!dedup.has(key)) dedup.set(key, row);
        }
        const generic = Array.from(dedup.values());
        // A bps table scores zero through the percent parser, so let whichever
        // reading finds more schemes win — the same rule the two text sources
        // already use in extractBrokerageRowsFromPdfBuffer().
        const bps = extractBpsRows(rawText, amcName, sourceFile);
        return bps.length > generic.length ? bps : generic;
    } catch (error) {
        console.error("Error in brokerage text extraction:", error);
        return [];
    }
}


/**
 * The last gate before a name is allowed into the master: is this really a scheme?
 *
 * A card's footer ("Mutual Funds are subject to market risks … maximum of Rs.2"), its
 * SEBI registration line ("… Mutual Fund -SEBI Regn.No:MF…") and similar prose were
 * landing as schemes, because the parsers key on the word "Fund" and on a rate nearby.
 * A scheme name has a scheme-type word and no sentence fragments, and the PDF text
 * layer glues words of a footer together ("subjecttomarketrisks") while a real name
 * never has a 16-letter lowercase run.
 */
const SCHEME_WORD = /\b(fund|funds|etf|fof|elss|plan|scheme|index|fmp|savings|bond|liquid|overnight|arbitrage|gilt)\b/i;
const FOOTER_PROSE = /\bregn\b|\bregistration\b|\bmutual\s+funds?\s*[-–:]|\bsubject\s*to\b|\bmaximum\b|\bapplication\b|\bmode\b|\bread\s+all\b|\bmarket\s*risks?\b|\bsebi\b|\bamfi\b/i;
export const looksLikeScheme = (name) => {
    const s = String(name || "").trim();
    if (s.length < 8) return false;
    if (!SCHEME_WORD.test(s)) return false;
    if (/[a-z]{16,}/.test(s)) return false;                 // glued prose
    if (FOOTER_PROSE.test(s) || DISCLAIMER.test(s)) return false;
    if (/\bRs\.?\s*\d/i.test(s) || /\d{4,}/.test(s.replace(/\b(19|20)\d{2}\b/g, ""))) return false;
    return true;
};
const onlyRealSchemes = (rows, label) => {
    const kept = rows.filter(r => looksLikeScheme(r.schemeName));
    if (kept.length !== rows.length) {
        const dropped = [...new Set(rows.filter(r => !looksLikeScheme(r.schemeName)).map(r => r.schemeName))];
        console.log(`🧹 [Extractor] ${label}: dropped ${dropped.length} non-scheme line(s): ${dropped.map(d => JSON.stringify(String(d).slice(0, 60))).join(", ")}`);
    }
    return kept;
};

/**
 * Reads a PDF buffer, extracts raw text, then delegates to extractBrokerageRowsFromText.
 */
export async function extractBrokerageRowsFromPdfBuffer(buffer, amcName, sourceFile) {
    console.log(`🚀 [Extractor] Starting PDF extraction for ${amcName} (${sourceFile})...`);

    // Source A: pdf-parse (fast; good for most PDFs).
    let rowsA = [];
    try {
        const data = await pdf(buffer);
        rowsA = extractBrokerageRowsFromText(data.text || "", amcName, sourceFile);
    } catch (error) {
        console.error("pdf-parse failed:", error?.message || error);
    }

    // Source B: pdfjs row-reconstruction (handles column-layout PDFs like JM that
    // pdf-parse scrambles). Whichever source yields more schemes wins.
    let rowsB = [];
    try {
        const rowText = await extractTextByRows(buffer);
        rowsB = extractBrokerageRowsFromText(rowText, amcName, sourceFile);
    } catch (error) {
        console.error("pdfjs row-extraction failed:", error?.message || error);
    }

    // Source C: positional pairing, for cards that emit names and rates as separate
    // columns (Helios). Only fires when that shape is unmistakable — see the function.
    let rowsC = [];
    try {
        const data = await pdf(buffer);
        rowsC = extractColumnarRows(data.text || "", amcName, sourceFile);
    } catch (_) { /* source A already logged the parse failure */ }

    // Source D: tenure-grid cards (qsif), where the name spans several lines and
    // the rates sit in a holding-period grid beneath it.
    let rowsD = [];
    try {
        const data = await pdf(buffer);
        rowsD = extractTenureGridRows(data.text || "", amcName, sourceFile);
    } catch (_) { /* source A already logged the parse failure */ }

    // Rank by DISTINCT schemes, not row count. Helios' card gave pdf-parse 33 rows
    // carrying only 2 names — the rates were right but every one had been glued to
    // the wrong text — and that beat the 8 correct rows the other reader produced.
    const distinct = (rows) => new Set(rows.map(r => String(r.schemeName || "").toUpperCase().replace(/[^A-Z0-9]/g, ""))).size;
    const cands = [["pdf-parse", rowsA], ["pdfjs-rows", rowsB], ["columnar", rowsC], ["tenure-grid", rowsD]];
    let [label, winner] = cands[0];
    for (const [l, r] of cands.slice(1)) if (distinct(r) > distinct(winner)) { label = l; winner = r; }
    console.log(`✅ [Extractor] ${amcName}: pdf-parse=${distinct(rowsA)}, pdfjs-rows=${distinct(rowsB)}, columnar=${distinct(rowsC)}, tenure-grid=${distinct(rowsD)} distinct → using ${label} (${distinct(winner)} schemes)`);
    return onlyRealSchemes(winner, `${amcName} (${sourceFile})`);
}
