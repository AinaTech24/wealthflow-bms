/**
 * Brokerage Routes
 * PDF extraction, master list management, export.
 */
import { Router } from 'express';
import multer from 'multer';
import pool from '../lib/db.js';
import { extractBrokerageRowsFromPdfBuffer } from '../lib/brokerageExtractor.js';
import { extractBrokerageWithOcr } from '../lib/ocrExtractor.js';

const router = Router();

// File size limit: 20MB, allowed MIME types
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'];
const FILE_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FILE_SIZE_LIMIT },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only PDF and image files are allowed.`));
    }
  }
});

const PARSE_FILE_TIMEOUT_MS = Number(process.env.PARSE_FILE_TIMEOUT_MS) || 15000;

function withTimeout(promise, timeoutMs, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

function detectAmcNameFromFilename(filename = '') {
  const brands = [
    "ADITYA BIRLA SUN LIFE", "ADITYA BIRLA", "ABSL", "360 ONE", "FRANKLIN", "TEMPLETON",
    "HDFC", "KOTAK", "SBI", "ICICI", "AXIS", "NIPPON", "MIRAE", "TATA",
    "DSP", "UTI", "LIC MF", "LICMF", "HELIOS", "BANDHAN", "IDFC",
    "INVESCO", "WHITEOAK", "WHITE OAK", "CANARA", "ROBECO", "BOI",
    "BANK OF INDIA", "EDELWEISS", "HSBC", "TRUST", "UNION", "PPFAS",
    "QUANT", "MAHINDRA", "MAHINDRA MANULIFE", "PGIM", "JM MF", "JM",
    "PARAG PARIKH", "BARODA", "BNP", "TAURUS", "ITI MF", "SAMCO",
    "TRUST MF", "GROWW", "NAVI", "QUANTUM", "MOTILAL OSWAL", "MOTILAL",
    "OLD BRIDGE", "NJ", "SHRIRAM"
  ];
  const up = filename.toUpperCase();
  for (const b of brands) {
    if (up.includes(b)) return b;
  }
  const base = filename
    .replace(/\.pdf$/i, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(brokerage|structure|commission|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|q\d|fy|for|from|to|limited|pvt\.?|ltd\.?|of|the)\b/gi, ' ')
    .replace(/\d{2,4}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || 'Unknown AMC';
}

function isLikelyEncryptedPdf(buffer) {
  if (!buffer || !buffer.length) return false;
  const probe = buffer.toString('latin1', 0, Math.min(buffer.length, 120000));
  return /\/Encrypt\b/.test(probe);
}

// POST /api/parse-brokerage  — preview extraction (does NOT save to DB)
router.post('/parse-brokerage', upload.any(), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ success: false, error: 'No files uploaded' });

  const results = [];
  const fileStats = [];
  const warnings = [];

  for (const file of files) {
    const encrypted = isLikelyEncryptedPdf(file.buffer);
    try {
      const amcName = detectAmcNameFromFilename(file.originalname);
      const rows = await withTimeout(
        extractBrokerageRowsFromPdfBuffer(file.buffer, amcName, file.originalname),
        PARSE_FILE_TIMEOUT_MS,
        `Parsing ${file.originalname}`
      );
      results.push(...rows);

      let warning = '';
      if (rows.length === 0) {
        const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
        let textLen = 0;
        try { const d = await pdf(file.buffer); textLen = (d.text || '').trim().length; } catch (_) { }
        if (textLen < 50) {
          try {
            const ocrResult = await withTimeout(
              extractBrokerageWithOcr(file.buffer, amcName, file.originalname),
              120000,
              `OCR for ${file.originalname}`
            );
            if (ocrResult.rows?.length > 0) {
              results.push(...ocrResult.rows);
              warning = `${file.originalname}: Extracted via OCR. ${ocrResult.rows.length} rows found.`;
            } else {
              warning = ocrResult.warning || `${file.originalname}: OCR could not extract data.`;
            }
          } catch (ocrErr) {
            warning = `${file.originalname}: OCR failed: ${ocrErr.message}`;
          }
        } else if (encrypted) {
          warning = `${file.originalname}: Password-protected PDF — no rows extracted.`;
        } else {
          warning = `${file.originalname}: No scheme/rate rows detected.`;
        }
        if (warning) warnings.push(warning);
      }

      fileStats.push({ fileName: file.originalname, extractedRows: rows.length, encrypted, warning });
    } catch (innerError) {
      const warning = `${file.originalname}: parse failed (${innerError.message})`;
      warnings.push(warning);
      fileStats.push({ fileName: file.originalname, extractedRows: 0, encrypted, warning });
    }
  }

  const dedup = new Map();
  for (const r of results) {
    const stableId = `${String(r.amcName).trim()}|${String(r.schemeName).trim()}|FINAL`.toLowerCase();
    if (!dedup.has(stableId)) dedup.set(stableId, { id: stableId, ...r });
  }
  const rowsWithIds = Array.from(dedup.values());

  if (rowsWithIds.length === 0) {
    return res.json({ success: false, error: 'No brokerage rows could be extracted.', warnings, fileStats });
  }

  res.json({ success: true, extracted: rowsWithIds, message: `Extracted ${rowsWithIds.length} rows`, warnings, fileStats });
});

// POST /api/brokerage/extract — extract and immediately save to DB
router.post('/extract', upload.array('files'), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

  const results = { success: true, filesProcessed: req.files.length, inserted: 0, rows: [] };
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    for (const file of req.files) {
      const amcName = detectAmcNameFromFilename(file.originalname);
      const extractedRows = await extractBrokerageRowsFromPdfBuffer(file.buffer, amcName, file.originalname);

      for (const row of extractedRows) {
        const cleanAmc = String(row.amcName || '').trim();
        const cleanScheme = String(row.schemeName || '').trim();
        const id = `${cleanAmc}|${cleanScheme}|FINAL`.toLowerCase();
        const data = JSON.stringify({ category: row.category, sourceFile: row.sourceFile, rawLine: row.rawLine, parserVersion: 'v2' });

        await connection.query(
          `INSERT INTO brokerage_masters (id, amcName, schemeName, category, trailRate, period, data) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE trailRate=VALUES(trailRate), category=VALUES(category), data=VALUES(data)`,
          [id, cleanAmc, cleanScheme, row.category || 'Other', row.trailRate, 'FINAL', data]
        );
        results.inserted++;
        results.rows.push({ id, ...row });
      }
    }

    await connection.commit();
    res.json(results);
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('[Brokerage Extract] Error:', error.message);
    res.status(500).json({ success: false, error: 'Extraction or database error occurred.' });
  } finally {
    if (connection) connection.release();
  }
});

// GET /api/brokerage/list
router.get('/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM brokerage_masters ORDER BY createdAt DESC');
    const normalized = rows.map(row => {
      const meta = JSON.parse(row.data || '{}');
      return {
        id: row.id,
        amcName: row.amcName,
        schemeName: row.schemeName,
        category: meta.category || row.category || '',
        finalRate: row.trailRate,
        trailRate: row.trailRate,
        period: row.period || 'FINAL',
        sourceFile: meta.sourceFile || '',
        createdAt: row.createdAt
      };
    });
    res.json(normalized);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch brokerage list' });
  }
});

// GET /api/brokerage/export.csv
router.get('/export.csv', async (req, res) => {
  try {
    const { amcName, month, year, period } = req.query;
    let query = 'SELECT * FROM brokerage_masters WHERE 1=1';
    const params = [];

    if (amcName && amcName !== 'ALL') { query += ' AND amcName = ?'; params.push(amcName); }
    if (period) {
      query += ' AND period = ?'; params.push(period);
    } else {
      if (month && month !== 'ALL') { query += ' AND period LIKE ?'; params.push(`%-${month}`); }
      if (year && year !== 'ALL') { query += ' AND period LIKE ?'; params.push(`${year}-%`); }
    }
    query += ' ORDER BY amcName ASC, schemeName ASC';

    const [rows] = await pool.query(query, params);
    let csv = 'AMC,Category,Scheme Name,Brokerage Rate (%),Source File,Created At\n';
    rows.forEach(row => {
      const meta = JSON.parse(row.data || '{}');
      csv += `"${row.amcName}","${meta.category || ''}","${row.schemeName}",${row.trailRate},"${meta.sourceFile || ''}","${row.createdAt}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=brokerage_export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// POST /api/brokerage/reset
router.post('/reset', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM brokerage_masters');
    res.json({ success: true, message: `Cleared ${result.affectedRows} brokerage records.` });
  } catch (error) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// Multer error handler
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File too large. Maximum size is ${FILE_SIZE_LIMIT / 1024 / 1024}MB.` });
  }
  if (err.message?.includes('Invalid file type')) {
    return res.status(415).json({ error: err.message });
  }
  next(err);
});

export default router;
