/**
 * OCR-based PDF extraction for scanned/image-based PDFs.
 * Falls back to Tesseract.js when pdf-parse returns little/no text.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// canvas and tesseract are loaded lazily inside functions — they require native
// system libraries (libcairo, libpango) that may not be available on all hosts.
let canvasModule = null;
let cachedWorker = null;

async function loadCanvas() {
    if (canvasModule) return canvasModule;
    try {
        canvasModule = require('canvas');
        global.HTMLCanvasElement = canvasModule.Canvas;
        global.HTMLImageElement = canvasModule.Image;
        return canvasModule;
    } catch (err) {
        throw new Error(`Canvas native module unavailable (requires libcairo/libpango): ${err.message}`);
    }
}

/**
 * Detect if a PDF buffer is image-based (scanned) by checking text length.
 */
export async function isImageBasedPdf(buffer) {
    try {
        const pdfParse = require('pdf-parse/lib/pdf-parse.js');
        const data = await pdfParse(buffer);
        const text = (data.text || '').replace(/\s+/g, ' ').trim();
        return text.length < 50;
    } catch {
        return true;
    }
}

/**
 * Extract text from a scanned PDF using pdfjs-dist + canvas + tesseract.js OCR.
 */
export async function extractTextFromImagePdf(buffer) {
    const canvas = await loadCanvas();

    // In v4, legacy build is in a slightly different place or just pdfjs
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // Load the PDF
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(buffer),
        standardFontDataUrl: './node_modules/pdfjs-dist/standard_fonts/',
    });
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    console.log(`[OCR] PDF has ${numPages} page(s). Starting OCR...`);

    // Get or create Tesseract worker
    const { createWorker } = require('tesseract.js');
    if (!cachedWorker) {
        cachedWorker = await createWorker('eng');
    }
    const worker = cachedWorker;

    let fullText = '';

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        console.log(`[OCR] Processing page ${pageNum}/${numPages}...`);
        try {
            const page = await pdfDoc.getPage(pageNum);

            // Render at 2.5x scale for better OCR quality
            const scale = 2.5;
            const viewport = page.getViewport({ scale });

            const canvasObj = canvas.createCanvas(viewport.width, viewport.height);
            const context = canvasObj.getContext('2d');

            console.log(`[OCR] Page ${pageNum}: Rendering to canvas...`);
            await page.render({
                canvasContext: context,
                viewport: viewport,
            }).promise;

            console.log(`[OCR] Page ${pageNum}: Canvas rendered successfully. Converting to buffer...`);
            const pngBuffer = canvasObj.toBuffer('image/png');

            console.log(`[OCR] Page ${pageNum}: Buffer created (${pngBuffer.length} bytes). Starting Tesseract...`);
            const { data: { text } } = await worker.recognize(pngBuffer, {
                tessedit_pageseg_mode: '3' // Fully automatic page segmentation
            });
            fullText += text + '\n';

            console.log(`[OCR] Page ${pageNum}: extracted ${text.length} chars`);
        } catch (err) {
            console.error(`[OCR] Error on page ${pageNum}:`, err.message);
            throw err;
        }
    }

    return fullText;
}

/**
 * Process a PDF with OCR fallback, then run through the standard brokerage extractor.
 */
export async function extractBrokerageWithOcr(buffer, amcName, filename) {
    const { extractBrokerageRowsFromPdfBuffer } = await import('./brokerageExtractor.js');

    const rows = await extractBrokerageRowsFromPdfBuffer(buffer, amcName, filename);
    if (rows.length > 0) {
        console.log(`✅ [OCR Wrapper] Standard text extraction found ${rows.length} rows. Skipping OCR.`);
        return { rows, method: 'text' };
    }

    // If we reach here, standard extraction found 0 rows.
    // We should try OCR regardless of background text length to be safe.
    console.log(`🔍 [OCR Wrapper] 0 rows found in text layer for ${filename}. Starting OCR fallback...`);

    try {
        const ocrText = await extractTextFromImagePdf(buffer);
        console.log(`[OCR] Total OCR text received: ${ocrText.length} chars`);
        console.log(`[OCR DEBUG] Snippet: ${ocrText.substring(0, 500)}`);
        
        if (ocrText.length < 20) {
            return { rows: [], method: 'ocr', warning: 'OCR could not extract meaningful text from this PDF.' };
        }

        // Route OCR text through the same high-quality main extractor pipeline
        // instead of the simpler parseOcrText, giving OCR the same accuracy as text PDFs
        const { extractBrokerageRowsFromText } = await import('./brokerageExtractor.js');
        const preprocessedText = preprocessOcrForExtraction(ocrText);
        const ocrRows = extractBrokerageRowsFromText(preprocessedText, amcName, filename);
        console.log(`[OCR] Main extractor found ${ocrRows.length} rows from OCR text.`);
        // Fall back to parseOcrText if main extractor found nothing (different PDF layout)
        if (ocrRows.length === 0) {
            console.log(`[OCR] Main extractor found 0 rows, falling back to OCR-specific parser.`);
            const { cleanSchemeName } = await import('./brokerageExtractor.js');
            const fallbackRows = parseOcrText(ocrText, amcName, filename, cleanSchemeName);
            return { rows: fallbackRows, method: 'ocr', ocrText };
        }
        return { rows: ocrRows, method: 'ocr', ocrText };
    } catch (err) {
        console.error(`[OCR] Error during OCR processing:`, err.message);
        return { rows: [], method: 'ocr', warning: `OCR failed: ${err.message}` };
    }
}

/**
 * Pre-process raw OCR text to fix common OCR misreads before extraction.
 * Handles numeric OCR artifacts, concatenated brand names, and garbled rate values.
 */
function preprocessOcrForExtraction(text) {
    return text
        // Fix OCR misreads of decimal rates (word → number)
        .replace(/\boss\b/gi, ' 0.55 ')      // "oss" → 0.55
        .replace(/\bow\b/gi, ' 0.10 ')       // "ow" → 0.10
        .replace(/\boa\b/gi, ' 0.60 ')       // "oa" → 0.60
        .replace(/\bom\b/gi, ' 0.60 ')       // "om" → 0.60 (OCR variant of 0.60)
        // Fix 3-digit numbers where decimal point was dropped: "020" → "0.20"
        .replace(/\b0(\d{2})\b/g, '0.$1')
        // Fix OCR letter-for-digit: "13s" → "1.35" (s misread as 5, combined with no-dot)
        .replace(/\b(\d)(\d)s\b/g, '$1.$25')
        // Fix "Fo F" → "FoF" (OCR splits FoF across two tokens)
        .replace(/\bFo\s+F\b/gi, 'FoF')
        // Fix scheme name OCR typos
        .replace(/Fooused/gi, 'Focused')
        .replace(/smali/gi, 'Small')
        .replace(/\bpln\b/gi, 'Plan')
        .replace(/\bRetiremen\b/gi, 'Retirement')
        .replace(/\bAggress\b/gi, 'Aggressive')
        .replace(/\bConserv\b/gi, 'Conservative')
        // Fix hyphen-as-decimal OCR artifact: "0-10" → "0.10", "0-28" → "0.28"
        .replace(/\b0-(\d{2})\b/g, '0.$1')
        // Fix leading OCR noise character before brand: "lAxis" → "Axis"
        .replace(/\bl(Axis)/gi, '$1')
        // Fix missing space between brand and scheme: "AxisSmall" → "Axis Small"
        .replace(/\b(Axis)([A-Z][a-z])/g, 'Axis $2')
        .replace(/\b(Axis)([a-z])/g, 'Axis $2');
}

function parseOcrText(text, amcName, filename, cleanerFn) {
    const rows = [];
    const amcPrefix = (amcName || 'Axis').split(' ')[0].toLowerCase();
    const amcLowerPrefix = amcPrefix.toLowerCase();

    const categoryMap = {
        'equity': 'Equity', 'debt': 'Debt', 'hybrid': 'Hybrid',
        'liquid': 'Debt', 'overnight': 'Debt', 'gilt': 'Debt',
        'balanced': 'Hybrid', 'arbitrage': 'Arbitrage',
        'index': 'Index', 'etf': 'ETF', 'gold': 'Gold',
        'elss': 'Equity', 'tax saver': 'Equity',
        'flexi': 'Equity', 'mid cap': 'Equity', 'small cap': 'Equity',
        'large cap': 'Equity', 'multi cap': 'Equity', 'focused': 'Equity',
        'value': 'Equity', 'dividend': 'Equity', 'infrastructure': 'Equity',
        'banking': 'Equity', 'consumption': 'Equity', 'healthcare': 'Equity',
        'pharma': 'Equity', 'technology': 'Equity', 'manufacturing': 'Equity',
        'retirement': 'Solution', 'children': 'Solution',
        'savings fund': 'Debt', 'corporate bond': 'Debt', 'credit risk': 'Debt',
        'short duration': 'Debt', 'long duration': 'Debt', 'money market': 'Debt',
        'dynamic bond': 'Debt', 'ultra short': 'Debt', 'low duration': 'Debt',
        'floating rate': 'Debt', 'floater': 'Debt',
        'multi asset': 'Hybrid', 'balanced advantage': 'Hybrid',
        'aggressive hybrid': 'Hybrid', 'conservative hybrid': 'Hybrid',
        'equity savings': 'Hybrid',
    };

    function guessCategory(name) {
        const low = name.toLowerCase();
        const sortedKeys = Object.keys(categoryMap).sort((a, b) => b.length - a.length);
        for (const key of sortedKeys) {
            if (low.includes(key)) return categoryMap[key];
        }
        return 'Other';
    }

    const rateRegex = /(\d+[.,]\d+)\s*%?|\b(0\s?\d{2})\b|\boss\b/g;

    let schemeBuffer = [];
    
    // Pre-processing to fix very common OCR artifacts
    const cleanedText = text
        .replace(/\boss\b/gi, ' 0.55 ')
        .replace(/\bow\b/gi, ' 0.10 ')
        .replace(/\boa\b/gi, ' 0.60 ')
        .replace(/(\d)\s(\d{2})\b/g, '$1.$2') 
        .replace(/\b(0)(\d{2})\b/g, '$1.$2')
        .replace(/smali/gi, 'Small')
        .replace(/maicap/gi, 'Small Cap')
        .replace(/targecap/gi, 'Large Cap')
        .replace(/fooused/gi, 'Focused')
        .replace(/foused/gi, 'Focused')
        .replace(/Fo\s?F/gi, 'FoF')
        .replace(/Fo\s?f/gi, 'FoF')
        .replace(/\bpln\b/gi, 'Plan')
        .replace(/\bRetiremen\b/gi, 'Retirement')
        .replace(/\bAggress\b/gi, 'Aggressive')
        .replace(/\bConserv\b/gi, 'Conservative')
        .replace(/\bCAPFund\b/gi, 'CAP Fund')
        .replace(/\bSMALLCAPFund\b/gi, 'SMALL CAP Fund');

    const processedLines = cleanedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    for (let i = 0; i < processedLines.length; i++) {
        const line = processedLines[i];
        const low = line.toLowerCase();

        // Noise filters
        if (/brokerage|structure|commission|validity|particulars|sr\.?\s*no|serial|scheme\s*name|trail|upfront|sip|lump/i.test(line) && !/fund/i.test(line)) continue;
        if (/effective from|mutual fund/i.test(line) && line.length < 50 && !low.includes(amcPrefix)) continue;
        if (/page \d+/i.test(line)) continue;

        // Check if this line looks like a fresh start of a scheme
        const isFreshStart = low.startsWith(amcPrefix) || 
                           (low.includes(amcPrefix) && line.length < 100) ||
                           ((low.includes('fund') || low.includes('index') || low.includes('etf')) && line.length < 60);
        
        if (isFreshStart && schemeBuffer.length > 0) {
            // Check if we already have a potential scheme name in buffer
            const currentCombined = schemeBuffer.join(' ').toLowerCase();
            // If the new line starts with the same AMC prefix, it's definitely a new scheme
            if (low.startsWith(amcPrefix) || (currentCombined.includes('fund') && low.length > 10)) {
                 schemeBuffer = [];
            }
        }

        // Add line to buffer
        schemeBuffer.push(line);

        // Search for rates in the current line OR the buffer so far
        const combinedText = schemeBuffer.join(' ');
        let rates = [];
        let m;
        // Reset regex because of 'g' flag
        rateRegex.lastIndex = 0; 
        while ((m = rateRegex.exec(combinedText)) !== null) {
            let matchedStr = m[0].trim().toLowerCase();
            let val;
            if (matchedStr === 'oss') {
                val = 0.55;
            } else if (m[1]) {
                val = parseFloat(m[1].replace(',', '.'));
            } else if (m[2]) {
                val = parseFloat(m[2].replace(' ', '').replace(/^0/, '0.'));
            }

            if (val > 0 && val <= 3.5) rates.push({ val, index: m.index });
        }

        if (rates.length > 0) {
            // We found a rate! Extract name as everything before the first rate.
            let firstRateIdx = rates[0].index;
            let finalName = combinedText.substring(0, firstRateIdx).trim();

            // Clean up the name
            if (cleanerFn) {
                finalName = cleanerFn(finalName, amcName);
            } else {
                finalName = finalName
                    .replace(/^[\d.)\s|]+/, '') 
                    .replace(/[|:;,.!\[\]]+$/, '') 
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            // If cleanerFn stripped too much or we have artifacts
            if (finalName.length < 5 && combinedText.length > 10) {
                finalName = combinedText.split(/\d/)[0].trim().replace(/^[\d.)\s|]+/, '');
            }

            // Check if there's trailing name parts on the NEXT line (common if rate is mid-line)
            // OCR sometimes puts "Fund" on next line even if rate was on previous line
            if (i + 1 < processedLines.length) {
                const nextLine = processedLines[i+1];
                const nextLow = nextLine.toLowerCase();
                // If next line is just "Fund" or "Index Fund" or similar without a rate
                if (/^(fund|index fund|etf|passive fof|active fof)$/i.test(nextLine) || 
                    (nextLow.includes('fund') && nextLine.length < 20 && !rateRegex.test(nextLine))) {
                    finalName += ' ' + nextLine;
                    i++; // Skip next line
                }
            }

            if (finalName.length >= 6) {
                // Ensure amcName prefix
                const amcLowerPrefix = amcPrefix.toLowerCase();
                if (!finalName.toLowerCase().includes(amcLowerPrefix)) {
                    finalName = `${amcName} ${finalName}`;
                }

                rows.push({
                    amcName: amcName || 'Unknown',
                    schemeName: finalName,
                    category: guessCategory(finalName),
                    trailRate: rates[0].val,
                    sourceFile: filename,
                    rawBlock: combinedText
                });
            }
            
            // Clear buffer after success
            schemeBuffer = [];
        } else if (schemeBuffer.length > 8) {
            // Buffer too long without rate, likely noise
            schemeBuffer.shift(); 
        }
    }

    return rows;
}

export default { isImageBasedPdf, extractTextFromImagePdf, extractBrokerageWithOcr };
