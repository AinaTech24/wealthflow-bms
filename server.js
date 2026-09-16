// MUST run BEFORE any other import — Passenger/Phusion injects stale env vars at
// spawn time. The bootstrap module forces .env values to override them.
// Done in a separate module so it executes during import-evaluation, BEFORE
// downstream imports like ./src/lib/db.js snapshot process.env into their pools.
import './bootstrap-env.js';

import express from 'express';
import compression from 'compression';
import cors from 'cors';
import pool from './src/lib/db.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { extractBrokerageWithOcr, isImageBasedPdf } from './src/lib/ocrExtractor.js';

process.on('uncaughtException', (err) => {
  console.error('🔥 [CRITICAL] Uncaught Exception:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
import multer from 'multer';
import * as XLSX from 'xlsx';   // server-side spreadsheet parsing (/api/parse-sheet)
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { extractBrokerageRowsFromPdfBuffer } from './src/lib/brokerageExtractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'wealthflow-bms-secret-key-2026' || JWT_SECRET.length < 32) {
  console.error('🛑 [FATAL] JWT_SECRET must be set in .env and at least 32 characters long.');
  console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
const BCRYPT_ROUNDS = 10;
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS || 8000);
const PARSE_FILE_TIMEOUT_MS = Number(process.env.PARSE_FILE_TIMEOUT_MS || 15000);

function withTimeout(promise, timeoutMs, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

// --- Environment Validation ---
const REQUIRED_ENV = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.warn(`⚠️  [ENV] Missing required environment variables: ${missingEnv.join(', ')}`);
  console.warn(`   → Ensure your .env file contains: ${missingEnv.map(k => `${k}=<value>`).join(', ')}`);
  console.warn(`   → The server may fail to connect to the database without these.`);
}
// Trust the LiteSpeed / Passenger reverse proxy (Hostinger). Without this,
// express-rate-limit refuses to use X-Forwarded-For and spams ValidationError
// on every authenticated request.
app.set('trust proxy', 1);

// In-process cache for the dashboard summary aggregation. Refreshed when stale
// OR when a write hits the transactions table (see invalidateSummaryCache).
const SUMMARY_TTL_MS = 30_000;
let summaryCache = null;
let periodTotalsCache = null;   // { at, body } — 60s, same idea as summaryCache
// team_payouts cache: keyed by `${year}:${month}`; payout rules change rarely.
const TEAM_PAYOUTS_TTL_MS = 60_000;
let teamPayoutsCache = {};
// client_aum scans every AUM-carrying row and parses JSON on each one, which costs
// ~15s firm-wide. It only ever changes when transactions are written, and that path
// calls invalidateSummaryCache() below — so hold it far longer than the 30s the
// dashboard counters use rather than paying for the scan again every half minute.
const CLIENT_AUM_TTL_MS = 10 * 60_000;
let clientAumCache = null;      // { at, key, body } — see action=client_aum
const invalidateSummaryCache = () => { summaryCache = null; teamPayoutsCache = {}; memberClientCache = {}; clientAumCache = null; };

// Client ids whose hierarchy names this member at any level — i.e. their own book.
// Cached because the dashboard and the transactions fetch both ask for it on load.
let memberClientCache = {};
const MEMBER_CLIENTS_TTL_MS = 60_000;
async function clientIdsForMember(memberId) {
  const hit = memberClientCache[memberId];
  if (hit && Date.now() - hit.at < MEMBER_CLIENTS_TTL_MS) return hit.ids;
  const [rows] = await pool.query('SELECT id, data FROM clients');
  const ids = [];
  for (const c of rows) {
    let h;
    try { h = JSON.parse(c.data || '{}').hierarchy; } catch { continue; }
    if (!h) continue;
    for (let l = 1; l <= 7; l++) if (h[`level${l}Id`] === memberId) { ids.push(c.id); break; }
  }
  memberClientCache[memberId] = { at: Date.now(), ids };
  return ids;
}

// gzip every JSON / static response. For the typical 1-25 MB /api/data?type=*
// payload this is a 5-10× wire-size reduction. Filter skips tiny bodies and
// already-compressed assets to avoid wasted CPU.
app.use(compression({
  threshold: 1024, // don't bother with <1KB responses
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// --- CORS: whitelist via ALLOWED_ORIGINS env var ---
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION && ALLOWED_ORIGINS.length === 0) {
  console.error('🛑 [FATAL] ALLOWED_ORIGINS must be set in production (comma-separated origin list).');
  process.exit(1);
}
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / curl / mobile (no Origin header)
    if (!origin) return cb(null, true);
    // In dev, allow any localhost
    if (!IS_PRODUCTION && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn(`🛑 [CORS] Blocked origin: ${origin}`);
    return cb(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
// ── Security headers (helmet-equivalent, no extra dependency) ──────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS — force HTTPS for a year incl. subdomains (site is HTTPS-only on Hostinger)
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // CSP compatible with current runtime deps (Tailwind Play CDN needs unsafe-inline/eval;
  // Google Fonts for styles+fonts). Still enforces object-src/frame-ancestors/base-uri.
  // NOTE: migrating Tailwind to a build-time PostCSS step would let us drop the CDN and
  // tighten script-src to 'self' — recommended follow-up.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://cdn.tailwindcss.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

// Upload endpoints need the big limit; everything else is capped tighter to limit DoS surface.
app.use((req, res, next) => {
  const big = req.path === '/api/brokerage/extract' || req.path === '/api/data';
  return express.json({ limit: big ? '50mb' : '1mb' })(req, res, next);
});

// --- Rate Limiter for Login ---
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Too many login attempts. Please try again after 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Mount it. loginLimiter was defined but NEVER attached to anything, so login was
// only bounded by the generic 60/min mutation limiter — 12x the intended budget for
// password guessing. Login is POST /api/data with action='auth', so gate that shape
// specifically (body is already parsed by the json middleware above).
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/data' && (req.body || {}).action === 'auth') {
    return loginLimiter(req, res, next);
  }
  next();
});

// --- JWT Auth Middleware ---
const authMiddleware = (req, res, next) => {
  // Skip auth for login, health check, OTP self-serve, and static files only.
  // /api/parse-brokerage is NO LONGER exempt — it accepts 50MB uploads and must be authenticated.
  const exemptPaths = ['/api/health', '/api/ping', '/test-extractor', '/api/auth/send-otp', '/api/auth/verify-otp'];
  if (exemptPaths.includes(req.path)) return next();

  if (!req.path.startsWith('/api/')) return next();

  // Allow login POST through
  if (req.method === 'POST' && req.path === '/api/data') {
    const { action } = req.body || {};
    if (action === 'auth') return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn(`🛑 [AUTH] 401 Unauthorized for ${req.method} ${req.path} (No token)`);
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

app.use(authMiddleware);

// --- Admin-role guard ---
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    console.warn(`🛑 [AUTH] 403 Forbidden for ${req.method} ${req.path} (user=${req.user?.id || 'none'}, role=${req.user?.role || 'none'})`);
    return res.status(403).json({ error: 'Admin privileges required' });
  }
  next();
};

// Allow ADMIN or FINANCE (data import / brokerage extraction is a finance op).
const requireAdminOrFinance = (req, res, next) => {
  if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'FINANCE')) {
    console.warn(`🛑 [AUTH] 403 for ${req.method} ${req.path} (user=${req.user?.id || 'none'}, role=${req.user?.role || 'none'})`);
    return res.status(403).json({ error: 'Admin or Finance privileges required' });
  }
  next();
};

// Predicate form of the above, for guarding individual actions inside the
// /api/data dispatcher (which is app.all and can't use route middleware).
// Only ADMIN/FINANCE may WRITE core data — without this, any authenticated user
// could POST to /api/data and rewrite payout config or their own customLevels /
// hierarchy and inflate their own payout.
const isWriter = (req) => !!req.user && (req.user.role === 'ADMIN' || req.user.role === 'FINANCE');

// --- Generic mutation rate limiter (per-IP) ---
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 mutations/min per IP
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Self-serve password reset via email OTP ---
// In-memory OTP store. Lost on restart (acceptable; users just request a new code).
const otpStore = new Map();
const OTP_TTL_MS = 5 * 60 * 1000;        // 5 min
const OTP_MAX_PER_EMAIL_HOUR = 3;        // rate limit per email

// Lazy-load email service so failures here don't crash the rest of the app.
let emailServiceModule = null;
async function getEmailService() {
  if (emailServiceModule) return emailServiceModule;
  try {
    emailServiceModule = await import('./src/lib/emailService.js');
  } catch (e) {
    console.warn('[OTP] Email service load failed:', e.message);
    emailServiceModule = { sendEmail: async () => {} };
  }
  return emailServiceModule;
}

const otpRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many OTP requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/send-otp', otpRateLimiter, async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier || typeof identifier !== 'string') {
    return res.status(400).json({ error: 'Email or login ID required.' });
  }
  try {
    const ident = identifier.trim();
    const [rows] = await pool.query(
      'SELECT id, email, name FROM team WHERE email = ? OR code = ? LIMIT 1',
      [ident.toLowerCase(), ident]
    );
    // Always return success to avoid account-enumeration leak.
    if (rows.length === 0 || !rows[0].email) return res.json({ success: true });

    const user = rows[0];
    const emailKey = user.email.toLowerCase();
    const now = Date.now();
    const existing = otpStore.get(emailKey);
    // Rate limit: max OTPs per email per hour
    const recent = (existing?.history || []).filter(t => now - t < 60 * 60 * 1000);
    if (recent.length >= OTP_MAX_PER_EMAIL_HOUR) {
      return res.status(429).json({ error: 'Too many OTP requests for this account. Try again in 1 hour.' });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    otpStore.set(emailKey, {
      code,
      expires: now + OTP_TTL_MS,
      userId: user.id,
      history: [...recent, now],
    });

    const { sendEmail } = await getEmailService();
    // Fire-and-forget — don't block the response on SMTP latency.
    sendEmail({
      to: user.email,
      subject: 'My Earnings — Password Reset OTP',
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="color:#1e293b;margin:0 0 16px">Password Reset</h2>
          <p style="color:#475569">Hi ${user.name || 'there'},</p>
          <p style="color:#475569">Your one-time password reset code is:</p>
          <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
            <span style="font-size:36px;font-weight:900;letter-spacing:12px;color:#3b82f6">${code}</span>
          </div>
          <p style="color:#94a3b8;font-size:12px">Expires in 5 minutes. If you did not request this, ignore this email.</p>
        </div>
      `,
    });
    console.log(`📧 [OTP] Issued for ${emailKey}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP] send-otp error:', err.message);
    return res.status(500).json({ error: 'Failed to send OTP.' });
  }
});

app.post('/api/auth/verify-otp', otpRateLimiter, async (req, res) => {
  const { identifier, otp, newPassword } = req.body || {};
  if (!identifier || !otp || !newPassword) {
    return res.status(400).json({ error: 'identifier, otp, and newPassword are required.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  try {
    const ident = identifier.trim();
    const [rows] = await pool.query(
      'SELECT id, email FROM team WHERE email = ? OR code = ? LIMIT 1',
      [ident.toLowerCase(), ident]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Invalid OTP or account.' });

    const user = rows[0];
    const emailKey = (user.email || '').toLowerCase();
    const stored = otpStore.get(emailKey);
    if (!stored || stored.code !== String(otp).trim()) {
      return res.status(400).json({ error: 'Invalid OTP.' });
    }
    if (Date.now() > stored.expires) {
      otpStore.delete(emailKey);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    // Consume the OTP and update the password
    otpStore.delete(emailKey);
    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE team SET password = ? WHERE id = ?', [hashed, user.id]);
    await pool.query(
      'INSERT INTO activity_log (userId, userName, action, description) VALUES (?, ?, ?, ?)',
      [user.id, 'System', 'password_reset', 'Password reset via email OTP']
    );
    console.log(`🔐 [OTP] Password reset for user=${user.id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[OTP] verify-otp error:', err.message);
    return res.status(500).json({ error: 'Failed to verify OTP.' });
  }
});

app.get('/test-extractor', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Extractor Diagnostic</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="p-10 bg-slate-50">
      <h1 class="text-2xl font-bold mb-4">Brokerage Extractor Diagnostic</h1>
      <div class="bg-white p-6 rounded shadow">
        <input type="file" id="files" multiple class="mb-4 block">
        <button onclick="extract()" class="bg-blue-600 text-white px-4 py-2 rounded">Extract Now</button>
        <pre id="output" class="mt-4 p-4 bg-slate-100 rounded text-xs overflow-auto max-h-96"></pre>
      </div>
      <script>
        async function extract() {
          const files = document.getElementById('files').files;
          if (files.length === 0) return alert('Select files');
          const fd = new FormData();
          for(let f of files) fd.append('files', f);
          const out = document.getElementById('output');
          out.textContent = 'Processing...';
          try {
            const res = await fetch('/api/brokerage/extract', { method: 'POST', body: fd });
            const data = await res.json();
            out.textContent = JSON.stringify(data, null, 2);
          } catch(e) {
            out.textContent = 'Error: ' + e.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// REQ LOGGER
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// HEALTH CHECK
app.get('/api/health', async (req, res) => {
  try {
    const start = Date.now();
    const [rows] = await pool.query('SELECT 1 as ok');
    const latency = Date.now() - start;
    res.json({
      status: 'online',
      database: 'connected',
      latency: `${latency}ms`,
      // Booleans only — never echo actual host/user/db names to clients.
      configStatus: {
        host: !!process.env.DB_HOST,
        user: !!process.env.DB_USER,
        pass: !!process.env.DB_PASSWORD,
        name: !!process.env.DB_NAME
      }
    });
  } catch (err) {
    // Don't leak connection internals (host, codes) to unauthenticated callers.
    console.error('[health] DB check failed:', err.code, err.message);
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

const VALID_TABLES = ['clients', 'team', 'transactions', 'batches', 'amc_mappings', 'scheme_mappings', 'config', 'invoices', 'activity_log', 'payout_ledger', 'brokerage_masters'];

/**
 * DATABASE INITIALIZATION (Self-Healing)
 */
async function initDB() {
  console.log('🔄 [System] Checking Database Schema...');

  const queries = [
    "CREATE TABLE IF NOT EXISTS team (id VARCHAR(100) PRIMARY KEY, parentId VARCHAR(100), name VARCHAR(255), code VARCHAR(100), role VARCHAR(50) DEFAULT 'OPS', level INT DEFAULT 6, email VARCHAR(255), password VARCHAR(255), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS clients (id VARCHAR(100) PRIMARY KEY, primaryOwnerId VARCHAR(100), pan VARCHAR(50), name VARCHAR(255), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS transactions (id VARCHAR(100) PRIMARY KEY, batchId VARCHAR(100), pan VARCHAR(50), investorName VARCHAR(255), transactionDate DATE, amcName VARCHAR(255), schemeName VARCHAR(255), grossAmount DECIMAL(15,2), brokeragePeriod VARCHAR(20), mappedClientId VARCHAR(120), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_batch (batchId), INDEX idx_pan (pan), INDEX idx_brokerage_period (brokeragePeriod), INDEX idx_mapped_client (mappedClientId), INDEX idx_period_client (brokeragePeriod, mappedClientId))",
    "CREATE TABLE IF NOT EXISTS batches (id VARCHAR(100) PRIMARY KEY, fileName VARCHAR(255), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS amc_mappings (original VARCHAR(255) PRIMARY KEY, standard VARCHAR(255))",
    "CREATE TABLE IF NOT EXISTS scheme_mappings (original VARCHAR(255) PRIMARY KEY, standard VARCHAR(255))",
    "CREATE TABLE IF NOT EXISTS config (id VARCHAR(100) PRIMARY KEY, data LONGTEXT)",
    "CREATE TABLE IF NOT EXISTS invoices (id VARCHAR(100) PRIMARY KEY, userId VARCHAR(100), month VARCHAR(20), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_user (userId))",
    "CREATE TABLE IF NOT EXISTS activity_log (id INT AUTO_INCREMENT PRIMARY KEY, userId VARCHAR(100), userName VARCHAR(255), action VARCHAR(255), description TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_user (userId))",
    "CREATE TABLE IF NOT EXISTS payout_ledger (transactionId VARCHAR(100), userId VARCHAR(100), amount DECIMAL(15,4), level INT, UNIQUE KEY unq_tx_user (transactionId, userId), INDEX idx_user (userId))",
    "CREATE TABLE IF NOT EXISTS brokerage_masters (id VARCHAR(100) PRIMARY KEY, amcName VARCHAR(255), schemeName VARCHAR(255), category VARCHAR(100), trailRate DECIMAL(10,4), period VARCHAR(50), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_amc (amcName))",
    // Records which schema migrations have been applied (versioning, not ad-hoc).
    "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(150) PRIMARY KEY, appliedAt DATETIME DEFAULT CURRENT_TIMESTAMP)"
  ];

  for (const query of queries) {
    try {
      await pool.query(query);
    } catch (e) {
      console.error(`❌ [SQL Error] Schema creation failed: ${e.message}`);
    }
  }

  // Migrations (Ensuring columns exist)
  const columns = [
    { table: 'team', column: 'parentId', type: 'VARCHAR(100)' },
    { table: 'clients', column: 'primaryOwnerId', type: 'VARCHAR(100)' },
    { table: 'transactions', column: 'investorName', type: 'VARCHAR(255)' },
    { table: 'transactions', column: 'transactionDate', type: 'DATE' },
    { table: 'transactions', column: 'amcName', type: 'VARCHAR(255)' },
    { table: 'transactions', column: 'schemeName', type: 'VARCHAR(255)' },
    { table: 'transactions', column: 'grossAmount', type: 'DECIMAL(15,2)' },
    { table: 'brokerage_masters', column: 'amcName', type: 'VARCHAR(255)' },
    { table: 'brokerage_masters', column: 'schemeName', type: 'VARCHAR(255)' },
    { table: 'brokerage_masters', column: 'category', type: 'VARCHAR(100)' },
    { table: 'brokerage_masters', column: 'trailRate', type: 'DECIMAL(10,4)' },
    { table: 'brokerage_masters', column: 'period', type: 'VARCHAR(50)' },
    // Lead-source / indexed-column migration (self-heals on any environment).
    { table: 'transactions', column: 'brokeragePeriod', type: 'VARCHAR(20)' },
    { table: 'transactions', column: 'mappedClientId', type: 'VARCHAR(120)' }
  ];

  for (const col of columns) {
    try {
      await pool.query(`ALTER TABLE ${col.table} ADD COLUMN ${col.column} ${col.type}`);
      console.log(`✅ [Migration] Added ${col.column} to ${col.table}`);
    } catch (e) {
      // Column likely exists, skip
    }
  }

  // ADD DATABASE INDEXES (idempotent)
  const indexes = [
    { table: 'transactions', name: 'idx_batch', col: 'batchId' },
    { table: 'transactions', name: 'idx_pan', col: 'pan' },
    { table: 'transactions', name: 'idx_tx_date', col: 'transactionDate' },
    { table: 'transactions', name: 'idx_amc', col: 'amcName' },
    { table: 'clients', name: 'idx_pan', col: 'pan' },
    { table: 'clients', name: 'idx_owner', col: 'primaryOwnerId' },
    { table: 'team', name: 'idx_email', col: 'email' },
    { table: 'team', name: 'idx_parent', col: 'parentId' },
    { table: 'invoices', name: 'idx_month', col: 'month' },
    { table: 'activity_log', name: 'idx_created', col: 'createdAt' },
    { table: 'payout_ledger', name: 'idx_tx', col: 'transactionId' },
    { table: 'transactions', name: 'idx_brokerage_period', col: 'brokeragePeriod' },
    { table: 'transactions', name: 'idx_mapped_client', col: 'mappedClientId' },
  ];
  for (const idx of indexes) {
    try {
      await pool.query(`ALTER TABLE ${idx.table} ADD INDEX ${idx.name} (${idx.col})`);
      console.log(`✅ [Index] Added ${idx.name} on ${idx.table}.${idx.col}`);
    } catch (e) { /* Index likely exists */ }
  }

  // Record applied schema migrations (versioning trail). Idempotent.
  const MIGRATIONS = [
    '001_indexed_period_mapped_client',
    '002_lead_source_cumulative_model',
    '003_audit_logging',
  ];
  for (const m of MIGRATIONS) {
    try { await pool.query('INSERT IGNORE INTO schema_migrations (name) VALUES (?)', [m]); } catch (_) {}
  }

  // RETENTION: prune activity_log entries older than 365 days (run once at startup).
  // Cheap to run idempotently — limited via index.
  try {
    const [r] = await pool.query("DELETE FROM activity_log WHERE createdAt < DATE_SUB(NOW(), INTERVAL 365 DAY)");
    if (r.affectedRows > 0) console.log(`🧹 [Retention] Pruned ${r.affectedRows} activity_log entries older than 365 days`);
  } catch (e) {
    console.warn('[Retention] activity_log prune skipped:', e.message);
  }

  // RETENTION: hard-purge soft-deleted batches older than 30 days.
  //
  // ⚠ The age check MUST be done in JS, not SQL. The previous version compared
  // JSON_EXTRACT(data,'$.deletedAt') — a QUOTED JSON string — directly against
  // DATE_SUB(NOW(), INTERVAL 30 DAY), a DATETIME. MySQL coerces that type
  // mismatch instead of erroring, and the predicate matched EVERY soft-deleted
  // batch regardless of age. Since this job runs at startup, any batch sent to
  // Trash was permanently destroyed on the next restart — the 30-day recovery
  // window never worked, and this silently ate real imports (16,758 rows on
  // 2026-07-16, plus batches on 2026-05-20 and 2026-05-29).
  try {
    const [softDeleted] = await pool.query(
      "SELECT id, data FROM batches WHERE JSON_EXTRACT(data, '$.deletedAt') IS NOT NULL"
    );
    const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const oldBatches = [];
    for (const b of softDeleted) {
      let d;
      try { d = b.data ? JSON.parse(b.data) : {}; } catch { continue; }
      const deletedMs = Date.parse(d.deletedAt);
      // Only purge when we can positively prove it's been trashed >30 days.
      if (Number.isFinite(deletedMs) && deletedMs < cutoffMs) oldBatches.push({ id: b.id });
    }
    for (const b of oldBatches) {
      await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (SELECT id FROM transactions WHERE batchId = ?)', [b.id]);
      await pool.query('DELETE FROM transactions WHERE batchId = ?', [b.id]);
      await pool.query('DELETE FROM batches WHERE id = ?', [b.id]);
    }
    if (oldBatches.length > 0) console.log(`🧹 [Retention] Auto-purged ${oldBatches.length} soft-deleted batches >30 days old`);
  } catch (e) {
    console.warn('[Retention] batch auto-purge skipped:', e.message);
  }

  // SEED DEFAULT ADMIN
  try {
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM team');
    if (rows[0].count === 0) {
      console.log('🌱 [Seed] Database empty. Creating Root Admin...');
      const hashedPw = await bcrypt.hash('admin', BCRYPT_ROUNDS);
      const adminData = JSON.stringify({ bankDetails: { accountName: 'Admin', accountNumber: '', bankName: '', ifscCode: '' } });
      await pool.query(
        'INSERT INTO team (id, name, code, role, level, email, password, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['admin_root', 'System Administrator', 'ADMIN-001', 'ADMIN', 1, 'admin@wealthflow.com', hashedPw, adminData]
      );
    }
  } catch (e) { }

  // AUTO-MIGRATE: Hash any plain-text passwords
  try {
    const [users] = await pool.query('SELECT id, password FROM team');
    for (const u of users) {
      if (u.password && !u.password.startsWith('$2b$') && !u.password.startsWith('$2a$')) {
        const hashed = await bcrypt.hash(u.password, BCRYPT_ROUNDS);
        await pool.query('UPDATE team SET password = ? WHERE id = ?', [hashed, u.id]);
        console.log(`🔒 [Migration] Hashed password for user ${u.id}`);
      }
    }
  } catch (e) {
    console.error('⚠️ [Migration] Password hashing failed:', e.message);
  }
}

// ── Server-side recompute of ALL stored breakdowns + payout_ledger ──────────
// Reflects the CURRENT client mappings + config across every view (Dashboard,
// Monthly, Client-wise, invoices) — not just the live team_payouts. Runs in the
// background so the HTTP request returns immediately. Guarded against overlap.
let recalcState = { running: false, processed: 0, total: 0, startedAt: null, finishedAt: null, error: null };
async function recomputeAllBreakdowns() {
  if (recalcState.running) return recalcState;
  // The in-process flag above only guards THIS worker. Passenger can run several,
  // and recalcRun.js is a separate process entirely — two concurrent rebuilds both
  // DROP/CREATE payout_ledger_stage and race the RENAME, which can leave the ledger
  // truncated or the swap half-applied. Take a DB-wide advisory lock so only one
  // rebuild runs firm-wide, whatever started it.
  const [[lockRow]] = await pool.query("SELECT GET_LOCK('wf_recalc', 0) AS got");
  if (!Number(lockRow?.got)) {
    console.warn('[recalc] another rebuild is already running (DB lock held) — skipping');
    return { ...recalcState, running: true, error: 'Another recalculation is already running.' };
  }
  recalcState = { running: true, processed: 0, total: 0, startedAt: Date.now(), finishedAt: null, error: null };
  try {
    const [cfgRows] = await pool.query("SELECT data FROM config LIMIT 1");
    const cfg = JSON.parse(cfgRows[0]?.data || '{}');
    // RESIDUAL is the only supported model. The stored value is read for the log
    // only, never branched on — Slices/Cumulative let levels sum past 100%.
    const model = cfg.leadSharingModel || 'RESIDUAL';
    const leadPct = Number(cfg.leadSourcePct) || 0;
    const globalLevels = cfg.levels || {};
    const companyExpensePct = Number(cfg.companyExpensePct) || 0;
    const residualLevel = Number(cfg.residualLevel) || 4;
    // Settled months are FROZEN. A rate/level/mapping change must never rewrite a
    // period that has already been reconciled and invoiced — for a locked period we
    // keep the stored breakdown and re-emit its EXISTING ledger rows unchanged, so
    // a paid invoice can never stop matching the ledger behind it.
    const lockedPeriods = new Set(cfg.lockedPeriods || []);
    if (lockedPeriods.size) console.log('locked (frozen) periods:', [...lockedPeriods].join(', '));

    const [clients] = await pool.query("SELECT id,data FROM clients");
    const hier = new Map(), lead = new Map();
    for (const c of clients) { let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; } if (d.hierarchy) hier.set(c.id, d.hierarchy); if (d.leadSourceLevel) lead.set(c.id, Number(d.leadSourceLevel)); }
    const [teamRows] = await pool.query("SELECT id,level,data FROM team");
    const teamMap = new Map();
    for (const t of teamRows) { let cl, rh; try { const d = JSON.parse(t.data || '{}'); cl = d.customLevels; rh = d.rateHistory; } catch {} teamMap.set(t.id, { level: Number(t.level), customLevels: cl, rateHistory: rh }); }

    // RESIDUAL model — company keeps companyExpensePct off the top; levels below the
    // residual level keep their per-RM slice; the residual-level user takes the rest.
    let overDistributed = 0;   // clients whose L1-L3 rates alone exceed (100 - company%)
    const calcResidual = (gross, h, lsl, period) => {
      const lp = {1:0,2:0,3:0,4:0,5:0,6:0,7:0}, up = {};
      let oCL; for (let l=1;l<=7;l++){ const u=h[`level${l}Id`]; if(u){ oCL=memberAsOf(teamMap.get(u), period)?.customLevels; break; } }
      const rl = residualLevel; const paid = new Set(); let lowerSum = 0, dist = 0;
      for (let l=1;l<rl;l++){ const u=h[`level${l}Id`]; if(!u||paid.has(u)) continue; paid.add(u);
        const info=memberAsOf(teamMap.get(u), period); const cl=info?.customLevels, uL=info?.level;
        const pct=Math.max(0, cl&&cl[uL]!==undefined?cl[uL]:(cl&&cl[l]!==undefined?cl[l]:(oCL?.[l]!==undefined?oCL[l]:(globalLevels[l]||0))));
        const p=Math.round(gross*pct/100*10000)/10000; lp[l]=p; if(p!==0)up[u]=(up[u]||0)+p; lowerSum+=pct; dist+=p; }   // p!==0: clawbacks must deduct
      // The lead-source add-on belongs to the LOWER levels, so it must also reduce
      // the residual. If it were paid without adding to lowerSum, the L4 residual
      // would be overstated by exactly leadPct and the firm would distribute >100%.
      if (leadPct > 0 && lsl && lsl < rl) {
        const su = h[`level${lsl}Id`];
        if (su) { const p=Math.round(gross*leadPct/100*10000)/10000; lp[lsl]=(lp[lsl]||0)+p; if(p!==0)up[su]=(up[su]||0)+p; lowerSum+=leadPct; dist+=p; }
      }
      let ru=null, ruL=rl; for(let l=rl;l<=7;l++){ if(h[`level${l}Id`]){ ru=h[`level${l}Id`]; ruL=l; break; } }
      if (lowerSum > 100 - companyExpensePct + 0.0001) overDistributed++;   // config error: levels alone exceed what is available
      if (ru && !paid.has(ru)) { const surplus=Math.max(0, 100-companyExpensePct-lowerSum);
        const p=Math.round(gross*surplus/100*10000)/10000; lp[ruL]=(lp[ruL]||0)+p; if(p!==0)up[ru]=(up[ru]||0)+p; dist+=p; }   // p!==0: clawbacks must deduct
      const exp = Math.round((gross-dist)*100)/100;
      return { gross, expenseAmount: exp, netPool: Math.round((gross-exp)*100)/100, levelPayouts: lp, userPayouts: up };
    };

    const [[{ n: total }]] = await pool.query("SELECT COUNT(*) n FROM transactions");
    recalcState.total = total;

    // Build the rebuilt ledger in a STAGING table, then swap it in with an atomic
    // RENAME. This guarantees: (a) a crash mid-rebuild can NEVER leave payout_ledger
    // empty or partial — the live table is only replaced at the final atomic step,
    // so readers always see a complete ledger (the previous TRUNCATE+reinsert left a
    // window where all payouts read as ₹0); (b) ledger rows stream to the DB per
    // page instead of buffering every row in Node memory.
    await pool.query("DROP TABLE IF EXISTS payout_ledger_stage");
    await pool.query("CREATE TABLE payout_ledger_stage LIKE payout_ledger");

    const PAGE = 20000; let lastId = ''; let ledgerCount = 0;
    while (true) {
      const [rows] = await pool.query("SELECT id, grossAmount, brokeragePeriod, data FROM transactions WHERE id>? ORDER BY id LIMIT ?", [lastId, PAGE]);
      if (!rows.length) break;
      const upserts = [];
      const ledgerRows = [];
      for (const r of rows) {
        let d; try { d = JSON.parse(r.data); } catch { recalcState.processed++; continue; }
        // Locked period → preserve exactly: no recalculation, and the existing
        // payout rows are copied forward into the staging ledger untouched.
        if (lockedPeriods.has(r.brokeragePeriod)) {
          const keep = d.breakdown;
          if (keep && keep.userPayouts) {
            for (const [uid, amt] of Object.entries(keep.userPayouts)) {
              if (Math.abs(Number(amt) || 0) > 0.0001) ledgerRows.push([r.id, uid, Number(amt), 0]);
            }
          }
          recalcState.processed++; continue;
        }
        const gross = Number(r.grossAmount) || 0; const h = hier.get(d.mappedClientId);
        const bd = !h ? { gross, expenseAmount: gross, netPool: 0, levelPayouts:{1:0,2:0,3:0,4:0,5:0,6:0,7:0}, userPayouts:{} }
                      // RESIDUAL is the ONLY model now. Slices/Cumulative were removed:
                      // both allow the levels to sum past 100%, which paid out MORE than
                      // the firm received (PRADEEP book ran at 103.46% of gross).
                      : calcResidual(gross, h, lead.get(d.mappedClientId), r.brokeragePeriod);
        d.breakdown = bd; upserts.push([r.id, JSON.stringify(d)]);
        for (const [uid, amt] of Object.entries(bd.userPayouts)) if (Math.abs(amt) > 0.0001) ledgerRows.push([r.id, uid, amt, 0]);
        recalcState.processed++;
      }
      for (let i=0;i<upserts.length;i+=500){ const ch=upserts.slice(i,i+500); await pool.query("INSERT INTO transactions (id,data) VALUES ? ON DUPLICATE KEY UPDATE data=VALUES(data)", [ch]); }
      for (let i=0;i<ledgerRows.length;i+=1000){ const ch=ledgerRows.slice(i,i+1000); await pool.query("INSERT INTO payout_ledger_stage (transactionId,userId,amount,level) VALUES ?", [ch]); ledgerCount += ch.length; }
      lastId = rows[rows.length-1].id;
    }

    // Atomic swap. If anything above threw, we never reach here and the live
    // payout_ledger is left intact (stale, not empty). RENAME is atomic in MySQL.
    await pool.query("DROP TABLE IF EXISTS payout_ledger_prev");
    await pool.query("RENAME TABLE payout_ledger TO payout_ledger_prev, payout_ledger_stage TO payout_ledger");
    // KEEP the previous ledger. It used to be dropped one statement later, so a
    // recompute that ran with bad config/mappings was irreversible — the only way
    // back was to fix the inputs and rebuild, with no way to compare or restore.
    // payout_ledger_prev is the last-known-good copy; the NEXT rebuild replaces it.
    //   rollback:  RENAME TABLE payout_ledger TO payout_ledger_bad,
    //                           payout_ledger_prev TO payout_ledger;

    invalidateSummaryCache();
    recalcState.finishedAt = Date.now();
    // Log the MONEY, not just the row count — a catastrophic run (everything zero,
    // or double-counted) is invisible in a row count but obvious in the total.
    try {
      const [[tot]] = await pool.query("SELECT ROUND(SUM(amount),2) s FROM payout_ledger");
      const [[prev]] = await pool.query("SELECT ROUND(SUM(amount),2) s FROM payout_ledger_prev");
      const now = Number(tot?.s) || 0, before = Number(prev?.s) || 0;
      const delta = now - before;
      if (overDistributed) console.warn(`⚠️  [recalc] ${overDistributed} transactions had L1-L3 rates exceeding (100 - company%).`);
      console.log(`✅ [recalc] ${recalcState.processed} tx, ${ledgerCount} ledger rows, total Rs ${now} (was Rs ${before}, change Rs ${delta.toFixed(2)})`);
      if (before > 0 && Math.abs(delta) / before > 0.10) {
        console.warn(`⚠️  [recalc] payout total moved ${((delta / before) * 100).toFixed(1)}% — verify before paying. Previous ledger kept as payout_ledger_prev.`);
      }
    } catch (_) {
      console.log(`✅ [recalc] recomputed ${recalcState.processed} tx, ${ledgerCount} ledger rows`);
    }
  } catch (e) {
    recalcState.error = e.message;
    console.error('[recalc] failed:', e.message);
  } finally {
    recalcState.running = false;
    try { await pool.query("SELECT RELEASE_LOCK('wf_recalc')"); } catch (_) {}
  }
  return recalcState;
}

// ── Shared payout engine ─────────────────────────────────────────────────────
// ONE implementation of "who earns what per transaction", used by BOTH the admin
// Team Payouts view and the per-user my_payouts view. An RM logging in must never
// see a figure that disagrees with what the admin sees for them — because it is
// literally the same computation. Do NOT reintroduce a second copy: this app has
// repeatedly drifted (admin vs user, admin vs ledger) whenever payout math was
// duplicated. The stored payout_ledger is a separate per-tx record used for
// recompute/drill-down; it can differ by rounding and is NOT the user-facing source.
async function buildPayoutContext(pool) {
  const [clientRows] = await pool.query("SELECT id, data FROM clients");
  const [teamRows]   = await pool.query("SELECT id, level, data FROM team");
  const [cfgRows]    = await pool.query("SELECT data FROM config LIMIT 1");

  const hierarchyMap = new Map();
  const leadSourceMap = new Map();
  for (const c of clientRows) {
    try {
      const d = c.data ? JSON.parse(c.data) : {};
      if (d.hierarchy) hierarchyMap.set(c.id, d.hierarchy);
      if (d.leadSourceLevel) leadSourceMap.set(c.id, Number(d.leadSourceLevel));
    } catch (_) {}
  }
  const teamMap = new Map();
  for (const t of teamRows) {
    try {
      const d = t.data ? JSON.parse(t.data) : {};
      teamMap.set(t.id, { level: t.level, customLevels: d.customLevels, rateHistory: d.rateHistory });
    } catch (_) { teamMap.set(t.id, { level: t.level, customLevels: undefined }); }
  }
  let globalLevels = {}, leadSharingModel = 'RESIDUAL', leadSourcePct = 0;
  let companyExpensePct = 0, residualLevel = 4, lockedPeriods = [];
  try {
    const cfg = cfgRows[0]?.data ? JSON.parse(cfgRows[0].data) : {};
    globalLevels = cfg.levels || {};
    leadSharingModel = cfg.leadSharingModel || 'RESIDUAL';
    leadSourcePct = Number(cfg.leadSourcePct) || 0;
    companyExpensePct = Number(cfg.companyExpensePct) || 0;
    residualLevel = Number(cfg.residualLevel) || 4;
    lockedPeriods = Array.isArray(cfg.lockedPeriods) ? cfg.lockedPeriods : [];
  } catch (_) {}
  if (leadSharingModel && leadSharingModel !== 'RESIDUAL') {
    console.warn(`[payouts] config says model=${leadSharingModel}; RESIDUAL is the only supported model and is being used.`);
  }
  // RESIDUAL model: company takes companyExpensePct off the top, levels below the
  // residual level keep their per-RM slice, and the residual-level user absorbs
  // whatever is left (100 − company − Σ lower shares).
  return { hierarchyMap, leadSourceMap, teamMap, globalLevels, leadSourcePct, companyExpensePct, residualLevel, lockedPeriods };
}

// Given transaction rows ({ grossAmount, mcid }) and a context from
// buildPayoutContext, return totals keyed by userId: { userId, grossTotal,
// earnings, txCount }. Each user is paid ONCE per transaction (a user occupying
// multiple hierarchy slots must not earn per slot — the old 175% over-pay bug).
// ── Effective-dated rates ──────────────────────────────────────────────────
// A member's level and sharing rate are a TIMELINE, not a single value. Without
// this, re-grading someone rewrote EVERY historical month at the new rate: on
// 2026-08-04 moving one RM L2→L3 @35% silently restated Nov-2025..Jun-2026 from
// 50% to 60%, including months already invoiced. A promotion must apply from its
// effective month FORWARD and leave settled history untouched.
//
// `rateHistory` on the team member holds the timeline, newest or oldest order
// irrelevant: [{ effectiveFrom:'YYYY-MM', level, customLevels }, ...]. We pick
// the entry in force during the transaction's brokerage period. A member with no
// history resolves to their current values, so behaviour is unchanged until the
// first re-grade — that keeps this safe to deploy against existing data.
function memberAsOf(info, period) {
  if (!info) return info;
  const hist = info.rateHistory;
  if (!Array.isArray(hist) || hist.length === 0 || !period) return info;
  const p = String(period);
  let inForce = null, earliest = null;
  for (const h of hist) {
    if (!h || !h.effectiveFrom) continue;
    const ef = String(h.effectiveFrom);
    if (!earliest || ef < String(earliest.effectiveFrom)) earliest = h;
    if (ef <= p && (!inForce || ef > String(inForce.effectiveFrom))) inForce = h;
  }
  // A period older than every entry uses the EARLIEST known rate — never the
  // current one, which is the whole bug this function exists to prevent.
  const pick = inForce || earliest;
  if (!pick) return info;
  return {
    level: (pick.level !== undefined && pick.level !== null) ? Number(pick.level) : info.level,
    customLevels: pick.customLevels || info.customLevels,
    rateHistory: hist,
  };
}

function accumulatePayoutTotals(txRows, ctx) {
  const { hierarchyMap, leadSourceMap, teamMap, globalLevels, leadSourcePct, companyExpensePct, residualLevel } = ctx;
  const totals = Object.create(null);
  for (const tx of txRows) {
    const h = hierarchyMap.get(tx.mcid);
    if (!h) continue;
    const gross = Number(tx.grossAmount) || 0;
    // Rates are resolved AS OF the brokerage period, so a later promotion never
    // restates this month. See memberAsOf().
    const period = tx.period || tx.brokeragePeriod || null;

    let ownerCustomLevels, ownerLevel;
    for (let l = 1; l <= 7; l++) {
      const uid = h[`level${l}Id`];
      if (uid) { ownerCustomLevels = memberAsOf(teamMap.get(uid), period)?.customLevels; ownerLevel = l; break; }
    }
    const lsl = leadSourceMap.get(tx.mcid);

    const grossCredited = new Set();
    for (let l = 1; l <= 7; l++) {
      const uid = h[`level${l}Id`];
      if (!uid) continue;
      if (!totals[uid]) totals[uid] = { userId: uid, grossTotal: 0, earnings: 0, txCount: 0, ownerGross: 0 };
      if (!grossCredited.has(uid)) { totals[uid].grossTotal += gross; totals[uid].txCount += 1; grossCredited.add(uid); }
    }
    // ownerGross — gross credited ONLY to the client's PRIMARY owner (the lowest
    // assigned level, i.e. the servicing RM) rather than to everyone in the chain.
    // "RM" must mean "owns the client", NOT "sits in the level-3 slot": RMs can be
    // placed at L1/L2/L3 depending on their grade, so a slot-based definition
    // silently drops whole books from RM-wise reports and makes RM totals
    // disagree with BM totals. Summing ownerGross over all users == total gross,
    // exactly once, which is what makes RM-vs-BM reconcile every month.
    if (ownerLevel) {
      const ownerUid = h[`level${ownerLevel}Id`];
      if (ownerUid) { if (!totals[ownerUid]) totals[ownerUid] = { userId: ownerUid, grossTotal: 0, earnings: 0, txCount: 0, ownerGross: 0 }; totals[ownerUid].ownerGross += gross; }
    }

    {   // RESIDUAL is the ONLY payout model (Slices/Cumulative removed 2026-08-18)
      // Company keeps companyExpensePct off the top. Each level BELOW the residual
      // level with a user gets their own slice (own-level-first). The residual-level
      // user absorbs the remainder: 100 − company − Σ(lower shares actually paid).
      const paidSet = new Set();
      let lowerSum = 0;
      const rl = residualLevel || 4;
      for (let l = 1; l < rl; l++) {
        const uid = h[`level${l}Id`];
        if (!uid || paidSet.has(uid)) continue;
        paidSet.add(uid);
        const info = memberAsOf(teamMap.get(uid), period);
        const cl = info?.customLevels; const uLvl = info?.level;
        const slicePct = (cl && cl[uLvl] !== undefined ? cl[uLvl]
                        : cl && cl[l] !== undefined ? cl[l]
                        : ownerCustomLevels?.[l] !== undefined ? ownerCustomLevels[l]
                        : (globalLevels[l] || 0));
        if (slicePct > 0) { totals[uid].earnings += Math.round(gross * slicePct / 100 * 10000) / 10000; lowerSum += slicePct; }
      }
      // The lead-source add-on is paid to the LOWER-level owner, so it must also
      // reduce the residual — otherwise L4 is overstated by exactly leadSourcePct.
      // Kept byte-identical in meaning to recomputeAllBreakdowns.calcResidual.
      if (leadSourcePct > 0 && lsl && lsl < rl) {
        const su = h[`level${lsl}Id`];
        if (su) { totals[su].earnings += Math.round(gross * leadSourcePct / 100 * 10000) / 10000; lowerSum += leadSourcePct; }
      }
      // Surplus flows UP to the RM's nearest superior: the FIRST assigned level at
      // or above the residual level (L4 → L5 → L6 → L7). If none exists, the surplus
      // stays with the company.
      let residualUid = null;
      for (let l = rl; l <= 7; l++) { if (h[`level${l}Id`]) { residualUid = h[`level${l}Id`]; break; } }
      if (residualUid && !paidSet.has(residualUid)) {
        const surplus = Math.max(0, 100 - (companyExpensePct || 0) - lowerSum);
        if (surplus > 0) { if (!totals[residualUid]) totals[residualUid] = { userId: residualUid, grossTotal: 0, earnings: 0, txCount: 0 }; totals[residualUid].earnings += Math.round(gross * surplus / 100 * 10000) / 10000; }
      }
    }
  }
  return totals;
}

// Allow an OPS/RM user to persist THEIR OWN payout invoice (status SUBMITTED)
// without ADMIN/FINANCE write privilege — the "Raise Invoice" button is shown to
// RMs, so they must be able to save the invoice for their own monthly payout.
// Guards against: raising for someone else, self-approving/paying, and inflating
// the amount above what the shared payout engine says they actually earned that
// month. Returns true only if EVERY item in the payload passes all checks.
async function isOwnInvoiceSubmission(req, payload) {
  if (!req.user) return false;
  const uid = req.user.id;
  const list = Array.isArray(payload) ? payload : [payload];
  if (!list.length) return false;
  for (const inv of list) {
    if (!inv || inv.userId !== uid) return false;                       // only their own
    if (String(inv.status || 'SUBMITTED').toUpperCase() !== 'SUBMITTED') return false; // can't self-approve/pay
    if (!/^\d{4}-\d{2}$/.test(String(inv.month || ''))) return false;
    // An RM may EDIT their own invoice only while it is still SUBMITTED. Once
    // Finance has approved / paid / rejected it, it is locked — otherwise an RM
    // could alter the amount after approval, or silently revert a rejection.
    const [[stored]] = await pool.query('SELECT userId, data FROM invoices WHERE id = ?', [inv.id]);
    if (stored) {
      if (stored.userId !== uid) return false;                          // never touch someone else's
      let prevStatus = 'SUBMITTED';
      try { prevStatus = String(JSON.parse(stored.data || '{}').status || 'SUBMITTED').toUpperCase(); } catch {}
      if (prevStatus !== 'SUBMITTED') {
        console.warn(`🛑 [invoice] ${uid} tried to modify invoice ${inv.id} already ${prevStatus}`);
        return false;
      }
    }
  }
  // Anti-forgery: the claimed base amount may not exceed the user's earnings for
  // that month. Validate against payout_ledger — the SAME source the RM's Monthly
  // Payouts view / my_payouts shows and derives the invoice amount from — so a
  // legitimate invoice matches exactly and only an inflated claim is rejected.
  // (Do NOT use the inline team_payouts engine here: it rounds differently from
  // the ledger and would reject a correct invoice by ~₹10.)
  const earnedByMonth = new Map();
  for (const inv of list) {
    const month = String(inv.month);
    if (!earnedByMonth.has(month)) {
      const [[l]] = await pool.query(
        `SELECT COALESCE(SUM(l.amount), 0) AS amt
           FROM payout_ledger l JOIN transactions t ON t.id = l.transactionId
          WHERE l.userId = ? AND t.brokeragePeriod = ?`,
        [uid, month]);
      earnedByMonth.set(month, Number(l.amt) || 0);
    }
    if ((Number(inv.amount) || 0) > earnedByMonth.get(month) + 1) return false; // ₹1 rounding tolerance
  }
  return true;
}

// Allow a non-admin user to update THEIR OWN team record (profile: bank details,
// address, GSTIN, PAN, signature, ARN/EUIN) without ADMIN/FINANCE privilege — so
// RMs can maintain the details their invoices need. Rejects any change to the
// security/payout-sensitive fields (role, level, parentId, password, customLevels),
// so a self-update can never escalate privilege or alter someone's payout rate.
async function isOwnProfileUpdate(req, payload) {
  if (!req.user) return false;
  const list = Array.isArray(payload) ? payload : [payload];
  if (list.length !== 1) return false;                 // self-update is a single record
  const rec = list[0];
  if (!rec || rec.id !== req.user.id) return false;    // only your own record
  const [[cur]] = await pool.query('SELECT role, level, parentId, password, data FROM team WHERE id = ?', [req.user.id]);
  if (!cur) return false;
  if (String(rec.role ?? '') !== String(cur.role ?? '')) return false;
  if (Number(rec.level) !== Number(cur.level)) return false;
  if (String(rec.parentId ?? '') !== String(cur.parentId ?? '')) return false;
  if (rec.password && rec.password !== cur.password) return false;   // password change is a separate flow
  // rateHistory OVERRIDES level and customLevels in memberAsOf, so it is every bit
  // as payout-sensitive as the fields above — and it was added AFTER this guard was
  // written, leaving a hole: a self-update with unchanged level/customLevels passed
  // every check while smuggling in a forged timeline (e.g. effectiveFrom '0000-01',
  // level 1 @95%) that restated the user's ENTIRE payout history upward.
  const curRH = JSON.stringify((JSON.parse(cur.data || '{}').rateHistory) || []);
  const recRH = JSON.stringify(rec.rateHistory || []);
  if (curRH !== recRH) return false;                   // only ADMIN/FINANCE may set rates
  const curCL = JSON.stringify((JSON.parse(cur.data || '{}').customLevels) || {});
  if (JSON.stringify(rec.customLevels || {}) !== curCL) return false; // cannot change own rate
  return true;
}

// Redact sensitive bits — never log raw host/user/password.
const maskValue = (v) => v ? `${String(v).slice(0, 2)}***` : '(unset)';
console.log('--- ENV ---');
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('DB_HOST :', maskValue(process.env.DB_HOST));
console.log('DB_USER :', maskValue(process.env.DB_USER));
console.log('DB_NAME :', maskValue(process.env.DB_NAME));
console.log('------------');

// initDB(); // Moved to app.listen


app.all('/api/data', mutationLimiter, async (req, res) => {
  const { method, body, query } = req;

  try {
    if (method === 'GET') {
      const { type, action, id } = query;

      if (action === 'reset_db_confirm') {
        // Admin only + require explicit confirmation token in query string.
        if (!req.user || req.user.role !== 'ADMIN') {
          console.warn(`🛑 [reset_db_confirm] BLOCKED non-admin attempt by user=${req.user?.id || 'anonymous'}`);
          return res.status(403).json({ error: 'Admin privileges required' });
        }
        if (query.confirm !== 'YES_WIPE_ALL_DATA') {
          return res.status(400).json({
            error: 'Missing confirmation token. Pass ?action=reset_db_confirm&confirm=YES_WIPE_ALL_DATA to proceed.'
          });
        }
        // Extra guard: require a server-side env switch so a leaked admin token alone
        // can never wipe production. Set ALLOW_DB_RESET=true only when intentionally resetting.
        if (process.env.ALLOW_DB_RESET !== 'true') {
          console.warn(`🛑 [reset_db_confirm] BLOCKED: ALLOW_DB_RESET not enabled. Attempt by admin=${req.user.id}`);
          return res.status(403).json({ error: 'DB reset is disabled on this server (ALLOW_DB_RESET not set).' });
        }
        console.warn(`💣 [reset_db_confirm] DB WIPE initiated by admin=${req.user.id} (${req.user.name || req.user.email})`);
        // Snapshot row counts to activity_log before wiping (audit breadcrumb).
        try {
          const [[c]] = await pool.query('SELECT COUNT(*) n FROM transactions');
          await pool.query(
            'INSERT INTO activity_log (userId, userName, action, description, createdAt) VALUES (?,?,?,?,NOW())',
            [req.user.id, req.user.name || req.user.email || 'admin', 'DB_RESET', `Wiped DB (had ${c.n} transactions)`]
          );
        } catch (_) {}
        for (const t of ['clients', 'team', 'transactions', 'batches', 'amc_mappings', 'scheme_mappings', 'config', 'invoices', 'payout_ledger']) {
          await pool.query(`TRUNCATE TABLE ${t}`);
        }
        await initDB();
        return res.json({ success: true, message: 'Database reset complete' });
      }

      // ── Dashboard summary: aggregates server-side so the client never has
      //    to download all transactions just to render KPI cards.
      //    Cached in-process for SUMMARY_TTL_MS so a wave of dashboard loads
      //    only pays the SQL aggregation cost once.
      // ── Period totals, straight from the database ────────────────────────
      // The Summary tab used to add up the transactions the BROWSER happened to
      // hold — a capped slice of ~265k of 514k rows — so its figures disagreed
      // with Team Payouts, and any row imported in the same session was counted
      // twice (once from the server fetch, once from the import). Both numbers
      // now come from here.
      //
      // Grouped by brokeragePeriod, NOT transactionDate: a CAMS statement paid in
      // July carries June's trade dates, so grouping by date puts a month's money
      // under the wrong heading. `distributed` is what payout_ledger actually
      // holds, which is what Team Payouts reports — so the two can never drift.
      if (action === 'period_totals') {
        try {
          const now = Date.now();
          if (periodTotalsCache && now - periodTotalsCache.at < 60_000) {
            res.set('X-Cache', 'HIT');
            return res.json(periodTotalsCache.body);
          }
          const [rows] = await pool.query(`
            SELECT brokeragePeriod AS period,
                   COUNT(*)                      AS rowCount,
                   ROUND(SUM(grossAmount), 2)    AS gross
            FROM transactions
            WHERE brokeragePeriod IS NOT NULL AND brokeragePeriod <> ''
            GROUP BY brokeragePeriod
            ORDER BY brokeragePeriod DESC
          `);
          const [led] = await pool.query(`
            SELECT t.brokeragePeriod AS period, ROUND(SUM(l.amount), 2) AS distributed
            FROM payout_ledger l
            JOIN transactions t ON t.id = l.transactionId
            GROUP BY t.brokeragePeriod
          `);
          const dist = new Map(led.map(r => [r.period, Number(r.distributed) || 0]));
          const periods = rows.map(r => ({
            period: r.period,
            rows: Number(r.rowCount) || 0,
            gross: Number(r.gross) || 0,
            // What the ledger really pays out for that month. Falls back to the
            // company-expense split only when the ledger has no rows yet (a month
            // imported but not yet recalculated) — flagged so the UI can say so.
            distributed: dist.has(r.period) ? dist.get(r.period) : null,
          }));
          const body = {
            generatedAt: new Date().toISOString(),
            totalRows: periods.reduce((s, p) => s + p.rows, 0),
            totalGross: Math.round(periods.reduce((s, p) => s + p.gross, 0) * 100) / 100,
            periods,
          };
          periodTotalsCache = { at: now, body };
          res.set('X-Cache', 'MISS');
          return res.json(body);
        } catch (e) {
          console.error('[period_totals]', e);
          return res.status(500).json({ error: 'Failed to build period totals' });
        }
      }

      // ── Per-client AUM, computed in SQL over EVERY row ──────────────────────
      //    The clients table used to derive this in the browser from the
      //    `transactions` array, which is CAPPED at 200k of ~450k rows. Admin got
      //    a truncated slice and an RM got their whole (scoped) book, so the SAME
      //    client read ₹10,986 under Enterprise Management and ₹12,266 under
      //    Linked Portfolios. Same bug as my_payouts; same cure — compute it here.
      //
      //    The rule, and why each part of it is there:
      //      • latest period PER FOLIO, not per folio+scheme. One holding gets
      //        written under whatever name the month's file used — folio
      //        38383558/63 carries "HDFC Diversified Equity All Cap Active FOF -
      //        Regular Plan - Growth Plan", "…FOF Regular Growth" AND the bare
      //        scheme code "HARGR". Keyed per scheme, those are three keys whose
      //        latest values STACK, and one ₹10,245 holding reads ₹12,285.
      //        Anchoring on the folio's own latest month drops the dead spellings.
      //      • MAX within that month, not first-seen. CAMS writes ~12 sub-period
      //        slices per folio+scheme; picking whichever arrived first makes the
      //        answer depend on row order, which is exactly why two screens
      //        disagreed. MAX is order-independent.
      //      • folio alone as the key, NOT amc+folio. amcName is spelled
      //        inconsistently across imports, so pairing it with the folio splits
      //        one folio in two and double-counts it (₹41.37 Cr → ₹75.97 Cr).
      if (action === 'client_aum') {
        try {
          const now = Date.now();
          const scoped = !isWriter(req) && req.user?.id;
          const cacheKey = scoped ? `u:${req.user.id}` : 'all';
          if (clientAumCache && clientAumCache.key === cacheKey && now - clientAumCache.at < CLIENT_AUM_TTL_MS) {
            res.set('X-Cache', 'HIT');
            return res.json(clientAumCache.body);
          }
          let scopeSql = '', args = [];
          if (scoped) {
            const mine = await clientIdsForMember(req.user.id);
            if (!mine.length) return res.json({ generatedAt: new Date().toISOString(), aum: {} });
            scopeSql = ` AND mappedClientId IN (${mine.map(() => '?').join(',')})`;
            args = mine;
          }
          const [rows] = await pool.query(`
            WITH r AS (
              SELECT mappedClientId cid,
                     JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) folio,
                     schemeName scheme,
                     brokeragePeriod p,
                     CAST(JSON_EXTRACT(data,'$.currentValue') AS DECIMAL(20,2)) cv
              FROM transactions
              WHERE mappedClientId IS NOT NULL
                AND brokeragePeriod IS NOT NULL AND brokeragePeriod <> ''
                AND CAST(JSON_EXTRACT(data,'$.currentValue') AS DECIMAL(20,2)) > 0
                ${scopeSql}
            ),
            l AS (SELECT cid, folio, MAX(p) mp FROM r GROUP BY cid, folio),
            s AS (SELECT r.cid, r.folio, r.scheme, MAX(r.cv) v
                  FROM r JOIN l ON l.cid = r.cid AND l.folio = r.folio AND r.p = l.mp
                  GROUP BY r.cid, r.folio, r.scheme)
            SELECT s.cid, ROUND(SUM(s.v), 2) total, MAX(l.mp) asOf
            FROM s JOIN l ON l.cid = s.cid AND l.folio = s.folio
            GROUP BY s.cid
          `, args);
          const aum = {};
          for (const r of rows) aum[r.cid] = { total: Number(r.total) || 0, asOf: r.asOf || '' };
          const body = { generatedAt: new Date().toISOString(), aum };
          clientAumCache = { at: now, key: cacheKey, body };
          res.set('X-Cache', 'MISS');
          return res.json(body);
        } catch (e) {
          console.error('[client_aum]', e);
          return res.status(500).json({ error: 'Failed to build client AUM' });
        }
      }

      if (action === 'summary') {
        try {
          const now = Date.now();
          // Scope to the caller's own book unless they are ADMIN/FINANCE. This used to
          // be one firm-wide figure handed to everyone, so an RM's dashboard reported
          // the firm's 1,330 investors and 562,417 transactions as their own, and drew
          // the firm's revenue curve under the heading "Earnings dashboard for <them>".
          const scoped = !isWriter(req) && req.user?.id;
          const cacheKey = scoped ? `u:${req.user.id}` : 'all';
          if (summaryCache && summaryCache.key === cacheKey && now - summaryCache.at < SUMMARY_TTL_MS) {
            res.set('X-Cache', 'HIT');
            return res.json(summaryCache.body);
          }
          let where = '', args = [];
          if (scoped) {
            const mine = await clientIdsForMember(req.user.id);
            if (!mine.length) {
              return res.json({ totalTx: 0, totalGross: 0, myTotal: 0, clientCount: 0, monthly: [] });
            }
            where = ` WHERE mappedClientId IN (${mine.map(() => '?').join(',')})`;
            args = mine;
          }
          const [[agg]] = await pool.query(`
            SELECT
              COUNT(*)               AS totalTx,
              COALESCE(SUM(grossAmount), 0) AS totalGross,
              COUNT(DISTINCT pan)    AS clientCount
            FROM transactions${where}
          `, args);
          const [monthlyRows] = await pool.query(`
            SELECT
              brokeragePeriod                       AS month,
              SUM(grossAmount)                      AS gross,
              COUNT(*)                              AS cnt
            FROM transactions
            WHERE brokeragePeriod >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 18 MONTH), '%Y-%m')
              ${scoped ? `AND mappedClientId IN (${args.map(() => '?').join(',')})` : ''}
            GROUP BY month
            ORDER BY month ASC
          `, scoped ? args : []);
          const body = {
            totalTx:     Number(agg.totalTx) || 0,
            totalGross:  Number(agg.totalGross) || 0,
            myTotal:     0, // requires per-user breakdown; client computes locally if needed
            clientCount: Number(agg.clientCount) || 0,
            monthly:     monthlyRows.map(r => ({ month: r.month, gross: Number(r.gross) || 0, cnt: Number(r.cnt) || 0 })),
          };
          summaryCache = { at: now, key: cacheKey, body };
          res.set('X-Cache', 'MISS');
          return res.json(body);
        } catch (e) {
          console.error('[Summary] aggregation failed:', e.message);
          return res.status(500).json({ error: e.message });
        }
      }

      // ── Per-user monthly payouts, straight from payout_ledger ──────────────
      //    The RM-facing "Monthly Payouts" view used to aggregate the browser's
      //    `transactions` array, which is CAPPED (200k of ~450k rows). Any user
      //    whose book fell partly outside the loaded slice saw an understated
      //    share — and, worse, RAISED INVOICES on that understated figure
      //    (Virendra: 2,810 of 3,361 tx, Rs 4,569.75 instead of Rs 5,408.22).
      //    payout_ledger is the same source recomputeAllBreakdowns/recalcRun
      //    write, so this matches the admin view by construction.
      //
      //    GET /api/data?action=my_payouts            -> the caller's own payouts
      //    GET /api/data?action=my_payouts&userId=X   -> ADMIN/FINANCE only
      if (action === 'my_payouts') {
        try {
          if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
          const asked = query.userId ? String(query.userId) : null;
          // A user may only ever read their OWN payouts; only ADMIN/FINANCE may
          // name someone else. Without this an RM could enumerate the whole team.
          if (asked && asked !== req.user.id && !isWriter(req)) {
            console.warn(`🛑 [my_payouts] 403 user=${req.user.id} tried to read userId=${asked}`);
            return res.status(403).json({ error: 'Forbidden' });
          }
          const uid = asked || req.user.id;
          // Compute with the SAME engine as the admin Team Payouts view — NOT from
          // payout_ledger. The ledger is a per-tx record that can differ by a few
          // rupees of rounding from the canonical inline calc; reading it here is
          // exactly what made a user's login disagree with admin. Restrict to the
          // clients where this user appears in the hierarchy (own + override), so
          // we process ~their book, not all 450k rows.
          const ctx = await buildPayoutContext(pool);
          const myClientIds = [];
          for (const [cid, h] of ctx.hierarchyMap) {
            for (let l = 1; l <= 7; l++) { if (h[`level${l}Id`] === uid) { myClientIds.push(cid); break; } }
          }
          if (myClientIds.length === 0) return res.json({ userId: uid, monthly: [] });
          const [txRows] = await pool.query(
            `SELECT grossAmount, mappedClientId AS mcid, brokeragePeriod AS period
             FROM transactions
             WHERE brokeragePeriod IS NOT NULL AND brokeragePeriod <> '' AND mappedClientId IN (?)`,
            [myClientIds]
          );
          const byMonth = new Map();
          for (const tx of txRows) { if (!byMonth.has(tx.period)) byMonth.set(tx.period, []); byMonth.get(tx.period).push(tx); }
          const monthly = [];
          for (const [month, rows] of byMonth) {
            const t = accumulatePayoutTotals(rows, ctx)[uid];
            if (!t) continue;
            monthly.push({
              month,
              count:   t.txCount,
              myShare: Math.round(t.earnings * 100) / 100,
              gross:   Math.round(t.grossTotal * 100) / 100,
            });
          }
          monthly.sort((a, b) => b.month.localeCompare(a.month));
          return res.json({ userId: uid, monthly });
        } catch (e) {
          console.error('[my_payouts] failed:', e.message);
          return res.status(500).json({ error: e.message });
        }
      }

      // ── Team Payouts aggregation — walks the FULL transactions table for the
      //    requested period and accumulates per-user gross / tx counts by
      //    traversing each client's hierarchy. Bypasses the row-cap entirely
      //    so the dashboard never undercounts when imports span many months.
      //
      //    GET /api/data?action=team_payouts&year=2026&month=04
      //         year or month can be "All" or omitted for the full corpus.
      if (action === 'team_payouts') {
        try {
          const year = String(query.year || 'All');
          const month = String(query.month || 'All');
          // Serve from cache when fresh (payout config changes are rare and
          // invalidate the cache on any write).
          const tpKey = `${year}:${month}`;
          const tpNow = Date.now();
          if (teamPayoutsCache[tpKey] && tpNow - teamPayoutsCache[tpKey].at < TEAM_PAYOUTS_TTL_MS) {
            res.set('X-Cache', 'HIT');
            return res.json(teamPayoutsCache[tpKey].body);
          }
          // Validate year/month format to keep them safe inside LIKE patterns.
          if (year !== 'All' && !/^\d{4}$/.test(year)) return res.status(400).json({ error: 'Invalid year' });
          if (month !== 'All' && !/^\d{1,2}$/.test(month)) return res.status(400).json({ error: 'Invalid month' });
          // Use the indexed brokeragePeriod / mappedClientId columns (migrated from
          // JSON) so period filters hit a B-tree index instead of full-scanning 400k rows.
          const where = [];
          const params = [];
          if (year !== 'All' && month !== 'All') {
            where.push(`brokeragePeriod = ?`);
            params.push(`${year}-${month}`);
          } else if (year !== 'All') {
            where.push(`brokeragePeriod LIKE ?`);
            params.push(`${year}-%`);
          } else if (month !== 'All') {
            where.push(`brokeragePeriod LIKE ?`);
            params.push(`%-${month}`);
          }
          const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

          const t0 = Date.now();
          const [txRows] = await pool.query(
            // brokeragePeriod is REQUIRED here: the engine resolves each member's
            // rate as of that period, so omitting it would fall back to today's
            // rate and restate history.
            `SELECT grossAmount, mappedClientId AS mcid, brokeragePeriod AS period
             FROM transactions ${whereSql}`,
            params
          );
          // Shared payout engine (same computation the per-user my_payouts view
          // uses, so an RM's own login can never disagree with this admin view).
          const ctx = await buildPayoutContext(pool);

          // ── Locked periods are served from the LEDGER, never recomputed ──────
          // A settled month is frozen in payout_ledger, but this engine recomputes
          // from CURRENT config — so after any rate/level/mapping change a locked
          // month silently restated on screen while the invoice behind it did not.
          // Finance then sees the report disagree with a paid invoice, and the
          // invoice anti-forgery check (which validates against the ledger) rejects
          // a legitimate re-raise. Split the rows: recompute the open months, read
          // the frozen ones back exactly as they were paid.
          const lockedSet = new Set(ctx.lockedPeriods || []);
          const openRows = lockedSet.size ? txRows.filter(r => !lockedSet.has(r.period)) : txRows;
          const totals = accumulatePayoutTotals(openRows, ctx);
          if (lockedSet.size && openRows.length !== txRows.length) {
            const lockedInRange = [...new Set(txRows.filter(r => lockedSet.has(r.period)).map(r => r.period))];
            if (lockedInRange.length) {
              const [frozen] = await pool.query(
                `SELECT l.userId, ROUND(SUM(l.amount),4) earnings, COUNT(*) txCount,
                        ROUND(SUM(t.grossAmount),4) grossTotal
                   FROM payout_ledger l JOIN transactions t ON t.id = l.transactionId
                  WHERE t.brokeragePeriod IN (?) GROUP BY l.userId`, [lockedInRange]);
              for (const f of frozen) {
                const t = totals[f.userId] || (totals[f.userId] = { userId: f.userId, grossTotal: 0, earnings: 0, txCount: 0, ownerGross: 0 });
                t.earnings   += Number(f.earnings)   || 0;
                t.grossTotal += Number(f.grossTotal) || 0;
                t.txCount    += Number(f.txCount)    || 0;
              }
            }
          }

          const payouts = Object.values(totals).map((p) => ({
            userId: p.userId,
            grossTotal: Math.round(p.grossTotal * 100) / 100,
            // ownerGross: gross of the clients this user PRIMARILY owns (servicing
            // RM), independent of which hierarchy slot they occupy. Summing this
            // across users equals the period's total gross exactly once — which is
            // what makes the RM-wise total reconcile with the BM-wise total.
            ownerGross: Math.round((p.ownerGross || 0) * 100) / 100,
            earnings: Math.round(p.earnings * 100) / 100,
            // Percentage computed from FULL-PRECISION figures, not the 2dp values
            // above. Deriving it in the browser from a rounded rupee amount made a
            // clean 50% read as "49.96%" and a clean 75% as "74.98%" on small
            // books — repeatedly reported as a payout bug when only the display
            // was wrong. The underlying rate was always exact.
            pctOfGross: p.grossTotal > 0 ? Math.round((p.earnings / p.grossTotal) * 1000000) / 10000 : 0,
            txCount: p.txCount,
          }));

          const tpBody = {
            period: { year, month },
            txCount: txRows.length,
            payouts,
            ms: Date.now() - t0,
          };
          teamPayoutsCache[tpKey] = { at: tpNow, body: tpBody };
          res.set('X-Cache', 'MISS');
          return res.json(tpBody);
        } catch (e) {
          console.error('[team_payouts] failed:', e.message);
          return res.status(500).json({ error: e.message });
        }
      }

      // ── Reconciliation: list transactions whose mappedClientId is empty OR
      //    doesn't resolve to an existing client. Grouped by PAN/folio so the
      //    user can see exactly which investor accounts are unassigned (and the
      //    brokerage currently flowing 100% to company retention).
      //    GET /api/data?action=unmapped&period=2026-04   (period optional)
      // ── Recompute all stored breakdowns + ledger from CURRENT mappings/config ──
      //    GET /api/data?action=recalc_all   (admin) — runs in background, returns immediately.
      //    GET /api/data?action=recalc_status — poll progress.
      if (action === 'recalc_all') {
        if (!req.user || req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin privileges required' });
        if (recalcState.running) return res.json({ started: false, message: 'A recalculation is already running.', state: recalcState });
        recomputeAllBreakdowns(); // fire-and-forget; progress via recalc_status
        try {
          await pool.query('INSERT INTO activity_log (userId, userName, action, description, createdAt) VALUES (?,?,?,?,NOW())',
            [req.user.id, req.user.name || req.user.email || 'admin', 'RECALC_ALL', 'Triggered full payout recompute from current mappings']);
        } catch (_) {}
        return res.json({ started: true, message: 'Recalculation started. It will reflect across all reports within a minute or two.' });
      }
      if (action === 'recalc_status') {
        return res.json(recalcState);
      }

      // Batch integrity: actual persisted transaction count per batchId. The UI
      // compares this to each batch's recorded totalLines so a half-failed import
      // (batch metadata saved but transactions rolled back) shows as INCOMPLETE
      // instead of a misleading "Live". Uses the idx_batch index — cheap.
      if (action === 'batch_counts') {
        try {
          const [rows] = await pool.query("SELECT batchId, COUNT(*) AS c, ROUND(SUM(grossAmount),2) AS g FROM transactions GROUP BY batchId");
          // Return the MONEY as well as the row count. Batch History showed the
          // totals declared when the import ran, so a batch whose rows had since
          // moved to a newer batch still displayed its original figures — two rows
          // looking identical, one an empty shell. Deleting the wrong one would
          // have destroyed a live month.
          const counts = {}, gross = {};
          for (const r of rows) { counts[r.batchId] = Number(r.c) || 0; gross[r.batchId] = Number(r.g) || 0; }
          return res.json({ counts, gross });
        } catch (e) {
          console.error('[batch_counts] failed:', e.message);
          return res.status(500).json({ error: 'batch_counts failed' });
        }
      }

      // Re-map orphan transactions to clients by folio. After a Folio Master import
      // creates new client records, brokerage rows that were imported earlier as
      // "unmapped" (no client for their folio) can now be linked. This scans only
      // the unmapped rows (mappedClientId NULL/empty) and attaches any whose folio
      // now matches a client. Returns how many were linked; the UI then recalcs.
      // ── Exceptions report ────────────────────────────────────────────────
      // Everything an import left in a state a human has to resolve, in one
      // read-only payload: brokerage that reaches nobody, clients with no RM,
      // folios two records both claim, folios Excel destroyed, and rows whose
      // investor is not the client they were mapped to. Read-only by design —
      // it never writes, so it is safe to run straight after any import.
      if (action === 'exceptions_report') {
        if (!req.user || !['ADMIN', 'FINANCE'].includes(req.user.role)) {
          return res.status(403).json({ error: 'Admin or Finance privileges required' });
        }
        try {
          const period = String(req.query.period || '').trim();   // '' = all periods
          const CAP = Math.min(Number(req.query.cap) || 2000, 10000);
          const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const toks = (s) => new Set(String(s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(x => x.length > 2));
          const TRUNC = /^\d{6}0{5,}$/;

          const [teamRows] = await pool.query("SELECT id, name, level FROM team");
          const teamName = new Map(teamRows.map(t => [t.id, `${t.name} (L${t.level})`]));

          const [clientRows] = await pool.query("SELECT id, name, pan, data FROM clients");
          const clientName = new Map(), clientPan = new Map(), clientRm = new Map(), folioOwners = new Map();
          const byExactName = new Map();   // normalised name -> [clientId] (for one-click suggestions)
          const unassigned = [];
          for (const c of clientRows) {
            let d; try { d = JSON.parse(c.data || '{}'); } catch { d = {}; }
            clientName.set(c.id, c.name);
            clientPan.set(c.id, String(c.pan || '').toUpperCase().trim());
            const nk = norm(c.name);
            if (nk) { if (!byExactName.has(nk)) byExactName.set(nk, []); byExactName.get(nk).push(c.id); }
            const h = d.hierarchy || {};
            // level6/level7 are the house rows every client carries; an RM means
            // somebody in level1..level5 actually owns this investor.
            const owner = [1, 2, 3, 4, 5].map(l => h[`level${l}Id`]).find(Boolean) || '';
            clientRm.set(c.id, owner ? (teamName.get(owner) || owner) : '');
            if (!owner) unassigned.push({ clientId: c.id, name: c.name, pan: c.pan || '', folios: (d.folios || []).join(', ') });
            for (const f of new Set((d.folios || []).map(x => String(x).trim()).filter(Boolean))) {
              if (!folioOwners.has(f)) folioOwners.set(f, []);
              folioOwners.get(f).push(c.id);
            }
          }

          const where = period ? "WHERE brokeragePeriod = ?" : "";
          const args = period ? [period] : [];

          // 1. Brokerage that reaches nobody — no client, so no RM, so no payout.
          const [unmappedTx] = await pool.query(
            `SELECT brokeragePeriod period, JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) folio,
                    investorName, pan, amcName, COUNT(*) rowCount, ROUND(SUM(grossAmount),2) gross
             FROM transactions
             ${where ? where + " AND" : "WHERE"} (mappedClientId IS NULL OR mappedClientId = '')
             GROUP BY 1,2,3,4,5 ORDER BY gross DESC LIMIT ?`, [...args, CAP]);

          // 2. Mapped to a client id that no longer exists (a delete or a bad merge).
          const [mappedAgg] = await pool.query(
            `SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.mappedClientId')) clientId, brokeragePeriod period,
                    JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) folio, investorName, MAX(pan) pan,
                    COUNT(*) rowCount, ROUND(SUM(grossAmount),2) gross
             FROM transactions ${where} GROUP BY 1,2,3,4`, args);
          const orphanTx = [], nameDrift = [], truncated = [], noRmTx = [];
          for (const r of mappedAgg) {
            const f = String(r.folio || '').trim();
            if (f && TRUNC.test(f)) {
              truncated.push({ period: r.period, folio: f, investorName: r.investorName, rows: r.rowCount, gross: r.gross,
                               note: 'Excel flattened this folio to scientific notation — re-download the file as .xlsx' });
            }
            if (!r.clientId) continue;
            if (!clientName.has(r.clientId)) {
              orphanTx.push({ period: r.period, folio: f, investorName: r.investorName, rows: r.rowCount, gross: r.gross,
                              missingClientId: r.clientId });
              continue;
            }
            if (!clientRm.get(r.clientId)) {
              noRmTx.push({ period: r.period, folio: f, investorName: r.investorName, rows: r.rowCount, gross: r.gross,
                            clientId: r.clientId, client: clientName.get(r.clientId) });
            }
            // 3. Mapped to a client who is not this investor.
            // Two different people often share a name. When the file carries a PAN
            // and it is NOT the client's PAN, the row is on the wrong record even
            // though the names line up -- which is exactly how one investor's folio
            // ended up earning for somebody else's RM.
            const txPan = String(r.pan || '').toUpperCase().trim();
            const cPan = clientPan.get(r.clientId) || '';
            const panMismatch = !!txPan && !!cPan && txPan !== cPan;
            const cn = norm(clientName.get(r.clientId)), tn = norm(r.investorName);
            if (panMismatch) {
              // A minor invests under the GUARDIAN's PAN, so a PAN that belongs to
              // someone else is normal and must never be auto-suggested as the new
              // home. Only offer a target when that PAN's owner also answers to the
              // investor's name -- that is a genuine same-name mix-up, not a family.
              const byPanHit = clientRows.filter(x => String(x.pan || '').toUpperCase().trim() === txPan);
              const named = byPanHit.filter(x => {
                const xn = norm(x.name);
                return xn && (xn === tn || xn.includes(tn) || tn.includes(xn));
              });
              const sug = named.length === 1 ? named[0].id : '';
              // No client answers to BOTH this PAN and this investor's name, so there
              // is nowhere better to send the row -- which is exactly what a minor
              // investing under a guardian's PAN looks like. Flagging it only trains
              // people to click Move on a row that is already correct, so leave it out.
              if (!sug) continue;
              nameDrift.push({ suggestClientId: sug, suggestClient: sug ? clientName.get(sug) : '',
                               suggestRm: sug ? (clientRm.get(sug) || '(no RM)') : '',
                               period: r.period, folio: f, investorName: r.investorName + ' [PAN ' + txPan + ']',
                               mappedTo: clientName.get(r.clientId) + ' [PAN ' + cPan + ']', clientId: r.clientId,
                               rm: clientRm.get(r.clientId) || '(no RM)', rows: r.rowCount, gross: r.gross });
            } else if (cn && tn && cn !== tn && !cn.includes(tn) && !tn.includes(cn)) {
              const a = toks(clientName.get(r.clientId)), b = toks(r.investorName);
              const shared = [...b].filter(x => a.has(x)).length;
              if (!(b.size && shared >= Math.min(2, b.size))) {
                const hit = byExactName.get(tn) || [];
                const suggestId = hit.length === 1 && hit[0] !== r.clientId ? hit[0] : '';
                nameDrift.push({ suggestClientId: suggestId, suggestClient: suggestId ? clientName.get(suggestId) : '',
                                 suggestRm: suggestId ? (clientRm.get(suggestId) || '(no RM)') : '',
                                 period: r.period, folio: f, investorName: r.investorName,
                                 mappedTo: clientName.get(r.clientId), clientId: r.clientId,
                                 rm: clientRm.get(r.clientId) || '(no RM)', rows: r.rowCount, gross: r.gross });
              }
            }
          }

          // 4. A folio two or more client records both claim. This is what makes
          //    mapping drift between months: folio lookup keeps only one winner.
          // How many rows each claimant actually has on the folio — the one
          // with the history is almost always the rightful owner, so the UI can
          // offer it as the default without the operator hunting for it.
          const txPerClientFolio = new Map();
          for (const r of mappedAgg) {
            if (!r.clientId || !r.folio) continue;
            const k = r.clientId + '|' + String(r.folio).trim();
            txPerClientFolio.set(k, (txPerClientFolio.get(k) || 0) + Number(r.rowCount || 0));
          }
          const ambiguousFolios = [];
          for (const [f, ids] of folioOwners) {
            if (ids.length < 2) continue;
            const cand = ids
              .map(id => ({ id, name: clientName.get(id), rm: clientRm.get(id) || '(no RM)', tx: txPerClientFolio.get(id + '|' + f) || 0 }))
              .sort((x, y) => y.tx - x.tx);
            ambiguousFolios.push({
              candidates: cand.slice(0, 20), suggestClientId: cand[0] && cand[0].tx > 0 ? cand[0].id : '',
              folio: f, claimedBy: ids.length,
              clients: ids.slice(0, 12).map(id => `${clientName.get(id)} [${id}]`).join(' | '),
              rms: [...new Set(ids.map(id => clientRm.get(id) || '(no RM)'))].join(' | '),
            });
          }
          ambiguousFolios.sort((x, y) => y.claimedBy - x.claimedBy);

          const sum = (a) => Math.round(a.reduce((s, r) => s + (Number(r.gross) || 0), 0) * 100) / 100;
          return res.json({
            period: period || 'ALL',
            generatedAt: new Date().toISOString(),
            summary: {
              unmappedTx: { count: unmappedTx.length, gross: sum(unmappedTx) },
              noRmTx: { count: noRmTx.length, gross: sum(noRmTx) },
              orphanTx: { count: orphanTx.length, gross: sum(orphanTx) },
              nameDrift: { count: nameDrift.length, gross: sum(nameDrift) },
              truncatedFolios: { count: truncated.length, gross: sum(truncated) },
              ambiguousFolios: { count: ambiguousFolios.length, gross: 0 },
              unassignedClients: { count: unassigned.length, gross: 0 },
            },
            unmappedTx,
            noRmTx: noRmTx.sort((a, b) => b.gross - a.gross).slice(0, CAP),
            orphanTx: orphanTx.sort((a, b) => b.gross - a.gross).slice(0, CAP),
            nameDrift: nameDrift.sort((a, b) => b.gross - a.gross).slice(0, CAP),
            truncatedFolios: truncated.slice(0, CAP),
            ambiguousFolios: ambiguousFolios.slice(0, CAP),
            unassignedClients: unassigned.slice(0, CAP),
          });
        } catch (e) {
          console.error('[exceptions_report]', e);
          return res.status(500).json({ error: 'Failed to build exceptions report' });
        }
      }

      if (action === 'remap_unmapped') {
        if (!req.user || req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin privileges required' });
        try {
          const [clientRows] = await pool.query("SELECT id, data FROM clients");
          const folioToClient = new Map();
          for (const c of clientRows) {
            try {
              for (const f of (JSON.parse(c.data || '{}').folios || [])) {
                const k = String(f).trim();
                if (k && !folioToClient.has(k)) folioToClient.set(k, c.id);
              }
            } catch (_) {}
          }
          let scanned = 0, remapped = 0, lastId = '';
          const PAGE = 5000;
          while (true) {
            const [rows] = await pool.query(
              "SELECT id, data FROM transactions WHERE (mappedClientId IS NULL OR mappedClientId='') AND id>? ORDER BY id LIMIT ?",
              [lastId, PAGE]
            );
            if (!rows.length) break;
            for (const r of rows) {
              scanned++;
              let d; try { d = JSON.parse(r.data); } catch { continue; }
              const folio = d.folio ? String(d.folio).trim() : '';
              const cid = folio ? folioToClient.get(folio) : undefined;
              if (cid) {
                d.mappedClientId = cid;
                await pool.query("UPDATE transactions SET mappedClientId=?, data=? WHERE id=?", [cid, JSON.stringify(d), r.id]);
                remapped++;
              }
            }
            lastId = rows[rows.length - 1].id;
          }
          if (remapped > 0) invalidateSummaryCache();
          console.log(`[remap_unmapped] scanned ${scanned} unmapped, linked ${remapped}`);
          return res.json({ scanned, remapped });
        } catch (e) {
          console.error('[remap_unmapped] failed:', e.message);
          return res.status(500).json({ error: 'remap failed' });
        }
      }

      if (action === 'unmapped') {
        try {
          const period = query.period ? String(query.period) : null;
          if (period && !/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Invalid period (use YYYY-MM)' });
          const [clientRows] = await pool.query("SELECT id FROM clients");
          const known = new Set(clientRows.map(c => c.id));
          const where = [];
          const params = [];
          if (period) { where.push(`brokeragePeriod = ?`); params.push(period); }
          const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
          const [rows] = await pool.query(
            `SELECT grossAmount,
                    mappedClientId AS mcid,
                    JSON_UNQUOTE(JSON_EXTRACT(data,'$.investorPan'))    AS pan,
                    JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio'))          AS folio,
                    JSON_UNQUOTE(JSON_EXTRACT(data,'$.investorName'))   AS name
             FROM transactions ${whereSql}`, params);
          const groups = new Map();
          let totalGross = 0, totalRows = 0;
          for (const r of rows) {
            if (r.mcid && known.has(r.mcid)) continue; // mapped & resolvable → skip
            const key = `${r.pan || ''}|${r.folio || ''}`;
            const g = groups.get(key) || { pan: r.pan, folio: r.folio, name: r.name, gross: 0, n: 0 };
            g.gross += Number(r.grossAmount) || 0; g.n += 1;
            groups.set(key, g);
            totalGross += Number(r.grossAmount) || 0; totalRows += 1;
          }
          const list = [...groups.values()].sort((a, b) => b.gross - a.gross);
          return res.json({ period: period || 'All', totalRows, totalGross: Math.round(totalGross * 100) / 100, groups: list.slice(0, 1000) });
        } catch (e) {
          console.error('[unmapped] failed:', e.message);
          return res.status(500).json({ error: e.message });
        }
      }

      if (!type || !VALID_TABLES.includes(type)) return res.status(400).json({ error: 'Invalid table type' });

      // ── Caps for table fetches. Transactions has 400k+ rows; sending all
      //    would OOM the browser. Order by createdAt DESC so the most-recently
      //    IMPORTED batches always make the cut — historically we ordered by
      //    transactionDate DESC, which dropped older-trade rows that still
      //    belong to a recent brokerage period (CAMS settles trades from
      //    months/years ago in the current month's brokerage statement).
      let sql = `SELECT * FROM ${type}`;
      const params = [];
      if (type === 'transactions') {
        const since = (query.since || '').toString().match(/^\d{4}-\d{2}(-\d{2})?$/)
          ? query.since
          : new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        // Cut on the BROKERAGE PERIOD, not transactionDate. CAMS writes the original
        // investment date into transactionDate, so a July 2026 brokerage row routinely
        // carries a date from 2019 — and a two-year cut on that date silently dropped
        // 138,207 rows, 23% of every recent month. An RM's dashboard was adding up
        // roughly three quarters of their own book. brokeragePeriod is set on all
        // 562,417 rows, so there is nothing to fall back to.
        sql += ' WHERE brokeragePeriod >= ?';
        params.push(String(since).slice(0, 7));

        // A member who is not ADMIN/FINANCE only ever needs their OWN book. Sending
        // all 200,000 rows to an RM was a 155 MB download that never finished — their
        // dashboard sat at "the most recent 0 of 562,417 transactions" — and it handed
        // them every other RM's business besides. Shakeel's seven clients are 164 rows.
        if (!isWriter(req) && req.user?.id) {
          const mine = await clientIdsForMember(req.user.id);
          if (!mine.length) { res.set('Cache-Control', 'no-store'); return res.json([]); }
          sql += ` AND mappedClientId IN (${mine.map(() => '?').join(',')})`;
          params.push(...mine);
        }
        sql += ' ORDER BY createdAt DESC, id DESC';
        const limit = Math.min(200000, Math.max(1, parseInt(query.limit, 10) || 200000));
        sql += ` LIMIT ${limit}`;
      } else if (type === 'payout_ledger') {
        // Payout ledger can also explode (1M+ rows). Cap defensively.
        const limit = Math.min(50000, Math.max(1, parseInt(query.limit, 10) || 50000));
        sql += ` LIMIT ${limit}`;
      } else if (type === 'clients') {
        const limit = Math.min(20000, Math.max(1, parseInt(query.limit, 10) || 20000));
        sql += ` LIMIT ${limit}`;
      }
      // Browser caching for tables that change rarely (team / config / mappings).
      // private = don't store on a shared proxy; must-revalidate = check with us
      // after expiry. Saves ~400 ms/page for sub-navigations.
      // `team` is deliberately NOT cached: it changes on every profile edit,
      // level change and rate change, and a 5-minute stale copy made the
      // optimistic-concurrency retry re-send an out-of-date base version, so a
      // legitimate save failed over and over with "changed elsewhere".
      const CACHEABLE_TABLES = ['config', 'amc_mappings', 'scheme_mappings'];
      if (CACHEABLE_TABLES.includes(type)) {
        res.set('Cache-Control', 'private, max-age=300, must-revalidate');
      } else {
        res.set('Cache-Control', 'no-store');
      }
      const [rows] = await pool.query(sql, params);
      const parsedData = rows.map(row => {
        const item = { ...row };

        // NEVER ship the credential. `SELECT * FROM team` includes the bcrypt hash,
        // and this endpoint has no role gate — so every logged-in RM's browser was
        // being handed every colleague's (and the admin's) password hash, cached for
        // 5 minutes. No client screen has ever needed this field.
        delete item.password;

        // Normalize common column name casing issues
        if (row.primaryownerid !== undefined) { item.primaryOwnerId = row.primaryownerid; delete item.primaryownerid; }
        if (row.parentid !== undefined) { item.parentId = row.parentid; delete item.parentid; }
        if (row.batchid !== undefined) { item.batchId = row.batchid; delete item.batchid; }
        if (row.investorname !== undefined) { item.investorName = row.investorname; delete item.investorname; }
        if (row.transactiondate !== undefined) { item.transactionDate = row.transactiondate; delete item.transactiondate; }
        if (row.amcname !== undefined) { item.amcName = row.amcname; delete item.amcname; }
        if (row.schemename !== undefined) { item.schemeName = row.schemename; delete item.schemename; }
        if (row.grossamount !== undefined) { item.grossAmount = row.grossamount; delete item.grossamount; }
        if (row.userid !== undefined) { item.userId = row.userid; delete item.userid; }
        if (row.filename !== undefined) { item.fileName = row.filename; delete item.filename; }

        if (row.data) {
          try {
            const extra = JSON.parse(row.data);
            Object.assign(item, extra);
          } catch (e) { }
          delete item.data;
        }
        return item;
      });
      return res.json(parsedData);
    }

    if (method === 'POST') {
      const { action, userId, userName, activityAction, description, identifier, password, collection, payload } = body;

      // ── Write authorization ──────────────────────────────────────────────
      // Every POST mutates data EXCEPT login (`auth`) and benign activity
      // logging (`log_activity`). Require ADMIN/FINANCE for the rest so a
      // low-privilege user can never rewrite config, team rates, clients,
      // transactions, or the payout ledger via this endpoint.
      // Exempt: login (`auth`), benign activity logging (`log_activity`), and an
      // RM raising THEIR OWN payout invoice (a pure `invoices` persist — no action —
      // validated + amount-checked against the payout engine by isOwnInvoiceSubmission).
      const writeExempt = action === 'auth' || action === 'log_activity';
      const ownInvoice = !writeExempt && !action && !isWriter(req)
        && collection === 'invoices'
        && await isOwnInvoiceSubmission(req, payload);
      const ownProfile = !writeExempt && !action && !isWriter(req)
        && collection === 'team'
        && await isOwnProfileUpdate(req, payload);
      if (!writeExempt && !ownInvoice && !ownProfile && !isWriter(req)) {
        console.warn(`🛑 [WRITE] 403 POST action=${action || '(persist)'} coll=${collection || '-'} blocked user=${req.user?.id || 'none'} role=${req.user?.role || 'none'}`);
        return res.status(403).json({ error: 'Admin or Finance privileges required to modify data' });
      }

      // ── Map RM from registrar file ───────────────────────────────────────
      // body: { action:'map_rm_folios', rmId, folios:[...], hierarchy?, leadSourceLevel? }
      // Sets every client that owns one of these folios to the RM's hierarchy,
      // then triggers a background recompute. This is the safe, one-click monthly
      // reconciliation: upload an RM's "RM-wise" file → all their folios map to them.
      // ── Merge duplicate client records ──────────────────────────────────
      // The old UI-only merge combined folios in local state and dropped the
      // duplicates from the array. updateClients() only PERSISTS changed rows, so
      // the duplicates survived in the DB, and their transactions were never
      // re-pointed at the master — which is how 61 transactions (Rs 6,433) ended
      // up orphaned against client ids that no longer resolve. A merge has to move
      // the transactions, then delete the losing rows, then recompute.
      // ── Fix one exception, from the exceptions report ────────────────────
      // Three surgical operations, each the smallest write that resolves one row
      // of that report. Every one is audited, refuses to touch a settled period,
      // and writes mappedClientId to BOTH the column and the JSON copy — the
      // payout engines read the JSON, so updating only the column pays nobody.
      if (action === 'exception_fix') {
        if (!req.user || !['ADMIN', 'FINANCE'].includes(req.user.role)) {
          return res.status(403).json({ error: 'Admin or Finance privileges required' });
        }
        const op = String(body.op || '');
        try {
          const [[cfgRow]] = await pool.query("SELECT data FROM config LIMIT 1");
          const lockedPeriods = new Set(JSON.parse(cfgRow?.data || '{}').lockedPeriods || []);
          const audit = (what) => pool.query(
            "INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)",
            [req.user.id, req.user.name || req.user.email || req.user.id, 'EXCEPTION_FIX', what]
          ).catch(() => {});

          // 1. Give a client an RM by copying the hierarchy that RM already uses.
          //    We never invent a chain — an invented L4 would silently reroute the
          //    surplus. If the RM has no client yet, say so instead of guessing.
          if (op === 'assign_rm') {
            const clientId = String(body.clientId || '');
            const rmId = String(body.rmId || '');
            if (!clientId || !rmId) return res.status(400).json({ error: 'clientId and rmId required' });
            const [[target]] = await pool.query("SELECT id, name, data FROM clients WHERE id=?", [clientId]);
            if (!target) return res.status(404).json({ error: 'Client not found' });
            const [clientRows] = await pool.query("SELECT data FROM clients");
            const counts = new Map();
            for (const c of clientRows) {
              let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; }
              const h = d.hierarchy; if (!h) continue;
              let owns = false;
              for (let l = 1; l <= 7; l++) if (h[`level${l}Id`] === rmId) { owns = true; break; }
              if (!owns) continue;
              const k = JSON.stringify(h);
              counts.set(k, (counts.get(k) || 0) + 1);
            }
            if (!counts.size) {
              return res.status(400).json({ error: 'That RM has no client yet, so there is no hierarchy to copy. Map one client to them first (Map RM from Registrar File), then use this.' });
            }
            const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            const d = JSON.parse(target.data || '{}');
            d.hierarchy = JSON.parse(best);
            await pool.query("UPDATE clients SET data=? WHERE id=?", [JSON.stringify(d), clientId]);
            await audit(`Assigned RM ${rmId} to client ${target.name} [${clientId}] from the exceptions report`);
            return res.json({ ok: true, message: `RM assigned to ${target.name}. Recalculate to move the money.`, needsRecalc: true });
          }

          // 2. Send a folio's transactions to the client that folio really belongs
          //    to. Settled periods are frozen and are reported back, not written.
          if (op === 'repoint') {
            const folio = String(body.folio || '').trim();
            const toClientId = String(body.toClientId || '');
            if (!folio || !toClientId) return res.status(400).json({ error: 'folio and toClientId required' });
            const [[target]] = await pool.query("SELECT id, name FROM clients WHERE id=?", [toClientId]);
            if (!target) return res.status(404).json({ error: 'Target client not found' });
            const [rows] = await pool.query(
              `SELECT id, brokeragePeriod p, grossAmount g FROM transactions
               WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) = ?`, [folio]);
            const movable = rows.filter(r => !lockedPeriods.has(r.p));
            const frozen = rows.length - movable.length;
            if (!movable.length) {
              return res.json({ ok: false, message: `Nothing to move — all ${rows.length} rows sit in settled months.` });
            }
            let gross = 0;
            for (let i = 0; i < movable.length; i += 500) {
              const chunk = movable.slice(i, i + 500);
              gross += chunk.reduce((s, r) => s + (Number(r.g) || 0), 0);
              await pool.query(
                "UPDATE transactions SET mappedClientId=?, data=JSON_SET(data,'$.mappedClientId',?) WHERE id IN (?)",
                [toClientId, toClientId, chunk.map(r => r.id)]);
            }
            await audit(`Re-pointed folio ${folio} (${movable.length} rows, Rs ${gross.toFixed(2)}) to ${target.name} [${toClientId}]`);
            return res.json({
              ok: true, needsRecalc: true,
              message: `${movable.length} rows (₹${gross.toFixed(2)}) moved to ${target.name}.` +
                       (frozen ? ` ${frozen} row(s) left untouched — settled months are frozen.` : ''),
            });
          }

          // 3. One folio, one owner. While two records both list it, folio lookup
          //    keeps whichever it saw last and the mapping flips between months.
          if (op === 'resolve_folio') {
            const folio = String(body.folio || '').trim();
            const keepClientId = String(body.keepClientId || '');
            if (!folio || !keepClientId) return res.status(400).json({ error: 'folio and keepClientId required' });
            const [clientRows] = await pool.query("SELECT id, name, data FROM clients");
            let stripped = 0, kept = false;
            for (const c of clientRows) {
              let d; try { d = JSON.parse(c.data || '{}'); } catch { continue; }
              const list = (d.folios || []).map(x => String(x).trim()).filter(Boolean);
              if (!list.includes(folio)) continue;
              if (c.id === keepClientId) { kept = true; continue; }
              d.folios = list.filter(f => f !== folio);
              await pool.query("UPDATE clients SET data=? WHERE id=?", [JSON.stringify(d), c.id]);
              stripped++;
            }
            if (!kept) {
              const [[k]] = await pool.query("SELECT data FROM clients WHERE id=?", [keepClientId]);
              if (k) {
                const d = JSON.parse(k.data || '{}');
                d.folios = [...new Set([...(d.folios || []).map(x => String(x).trim()).filter(Boolean), folio])];
                await pool.query("UPDATE clients SET data=? WHERE id=?", [JSON.stringify(d), keepClientId]);
              }
            }
            await audit(`Folio ${folio} kept on ${keepClientId}; removed from ${stripped} other client record(s)`);
            return res.json({ ok: true, needsRecalc: false, message: `Folio ${folio} now belongs to one client only (removed from ${stripped} other record${stripped === 1 ? '' : 's'}).` });
          }

          return res.status(400).json({ error: `Unknown op "${op}"` });
        } catch (e) {
          console.error('[exception_fix]', e);
          return res.status(500).json({ error: 'Fix failed — nothing was changed for this row.' });
        }
      }

      if (action === 'merge_clients') {
        if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'FINANCE'))
          return res.status(403).json({ error: 'Admin or Finance privileges required' });
        const masterId = String(body.masterId || '').trim();
        const dupIds = (Array.isArray(body.duplicateIds) ? body.duplicateIds : [])
          .map(x => String(x || '').trim()).filter(Boolean).filter(x => x !== masterId);
        const dryRun = body.dryRun !== false;
        if (!masterId || !dupIds.length) return res.status(400).json({ error: 'masterId and duplicateIds[] required' });

        const [rows] = await pool.query("SELECT id, name, pan, data FROM clients WHERE id IN (?)", [[masterId, ...dupIds]]);
        const byId = new Map(rows.map(r => [r.id, r]));
        const master = byId.get(masterId);
        if (!master) return res.status(400).json({ error: 'Master client not found' });
        const missing = dupIds.filter(id => !byId.get(id));
        if (missing.length) return res.status(400).json({ error: 'Unknown client id(s): ' + missing.join(', ') });

        const [teamRows] = await pool.query("SELECT id, name, level, parentId FROM team");
        const teamById = new Map(teamRows.map(t => [t.id, t]));
        const ownerOf = (rec) => {
          let d; try { d = JSON.parse(rec.data || '{}'); } catch { d = {}; }
          const h = d.hierarchy || {};
          for (let l = 1; l <= 7; l++) if (h[`level${l}Id`]) return teamById.get(h[`level${l}Id`]) || { name: h[`level${l}Id`] };
          return null;
        };

        let mData; try { mData = JSON.parse(master.data || '{}'); } catch { mData = {}; }
        const folios = new Set((mData.folios || []).map(f => String(f).trim()).filter(Boolean));
        const detail = [];
        let movingTx = 0, movingGross = 0;
        for (const id of dupIds) {
          const rec = byId.get(id);
          let d; try { d = JSON.parse(rec.data || '{}'); } catch { d = {}; }
          for (const f of (d.folios || [])) { const t = String(f).trim(); if (t) folios.add(t); }
          const [[agg]] = await pool.query(
            "SELECT COUNT(*) n, ROUND(COALESCE(SUM(grossAmount),0),2) g FROM transactions WHERE mappedClientId = ?", [id]);
          movingTx += Number(agg.n) || 0;
          movingGross += Number(agg.g) || 0;
          const own = ownerOf(rec);
          detail.push({ id, name: rec.name, folios: (d.folios || []).length, txCount: Number(agg.n) || 0,
                        gross: Number(agg.g) || 0, rm: own ? own.name : null });
        }

        const masterOwner = ownerOf(master);
        // Merging re-points every transaction at the master, so if the records sit
        // under DIFFERENT RMs this MOVES MONEY between them. Say so explicitly.
        const rmChanges = detail.filter(d => d.rm && masterOwner && d.rm !== masterOwner.name && d.gross !== 0);

        const [[mAgg]] = await pool.query(
          "SELECT COUNT(*) n, ROUND(COALESCE(SUM(grossAmount),0),2) g FROM transactions WHERE mappedClientId = ?", [masterId]);

        const summary = {
          master: { id: masterId, name: master.name, rm: masterOwner ? masterOwner.name : null,
                    txCount: Number(mAgg.n) || 0, gross: Number(mAgg.g) || 0,
                    foliosBefore: (mData.folios || []).length },
          merging: detail,
          foliosAfter: folios.size,
          txMoving: movingTx,
          grossMoving: Math.round(movingGross * 100) / 100,
          rmChanges: rmChanges.map(d => ({ from: d.rm, to: masterOwner ? masterOwner.name : null, gross: d.gross })),
        };

        if (dryRun) return res.json({ success: true, dryRun: true, summary });

        // Validate any requested reassignment BEFORE touching a single row. This
        // used to run after the transactions had already been moved, so a bad id
        // returned 400 with the merge half-applied — transactions re-pointed, the
        // duplicates still present, and no recompute.
        const newRmId = String(body.rmId || '').trim();
        const newBmId = String(body.bmId || '').trim();
        const rmT = newRmId ? teamById.get(newRmId) : null;
        if (newRmId && !rmT) return res.status(400).json({ error: 'Unknown rmId' });
        const bmT = newBmId ? teamById.get(newBmId) : null;
        if (newBmId && !bmT) return res.status(400).json({ error: 'Unknown bmId' });

        // 1. every transaction of the losing records now belongs to the master
        for (const id of dupIds) {
          // BOTH the column AND the JSON. The recompute engines read
          // d.mappedClientId out of transactions.data, NOT the column, so updating
          // only the column left those rows pointing at a client id that had just
          // been deleted — hier.get() missed, the breakdown came back empty, and the
          // transactions produced NO payout for anyone.
          await pool.query(
            "UPDATE transactions SET mappedClientId = ?, data = JSON_SET(data, '$.mappedClientId', ?) WHERE mappedClientId = ?",
            [masterId, masterId, id]);
        }
        // 2. master keeps the union of folios
        mData.folios = [...folios];
        mData.updatedAt = new Date().toISOString();
        await pool.query("UPDATE clients SET data = ? WHERE id = ?", [JSON.stringify(mData), masterId]);
        // 2b. Apply the reassignment (already validated above).
        if (rmT) {
          const hier = { level1Id:'', level2Id:'', level3Id:'', level4Id:'', level5Id:'', level6Id:'', level7Id:'' };
          const rl = Math.min(7, Math.max(1, Number(rmT.level) || 3));
          hier['level' + rl + 'Id'] = rmT.id;
          if (bmT && Number(bmT.level) !== rl) hier['level' + Math.min(7, Math.max(1, Number(bmT.level))) + 'Id'] = bmT.id;
          let cur = (bmT || rmT).parentId, guard = 0;
          while (cur && teamById.get(cur) && guard++ < 10) {
            const p = teamById.get(cur);
            const pl = Math.min(7, Math.max(1, Number(p.level) || 0));
            if (pl && !hier['level' + pl + 'Id']) hier['level' + pl + 'Id'] = p.id;
            cur = p.parentId;
          }
          mData.hierarchy = hier;
          mData.leadSourceLevel = rl;
          await pool.query("UPDATE clients SET data = ?, primaryOwnerId = ? WHERE id = ?", [JSON.stringify(mData), rmT.id, masterId]);
        }
        // 3. only now are the duplicates safe to delete — nothing points at them
        await pool.query("DELETE FROM clients WHERE id IN (?)", [dupIds]);
        try {
          await pool.query("INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)",
            [req.user.id, req.user.name || req.user.id, 'CLIENT_MERGE',
             `Merged ${dupIds.length} record(s) into "${master.name}" (${masterId}): ${movingTx} transactions and ` +
             `Rs ${Math.round(movingGross * 100) / 100} re-pointed, folios ${(mData.folios || []).length}` +
             (rmChanges.length ? `; RM changed for Rs ${rmChanges.reduce((s, x) => s + x.gross, 0).toFixed(2)}` : '')]);
        } catch (_) {}
        invalidateSummaryCache();
        recomputeAllBreakdowns();   // fire-and-forget; progress via recalc_status

        return res.json({ success: true, dryRun: false, summary });
      }

      // ── Bulk client mapping from a spreadsheet ──────────────────────────
      // The registrar-file tool below needs a "Folio" column and maps ONE RM at a
      // time. This accepts a plain sheet of  Name | PAN | RM | BM  and maps many
      // clients to many RMs in one pass — which is how the team actually keeps
      // mappings up to date. Always callable with dryRun to preview first: nothing
      // is written until the operator confirms what they are about to change.
      if (action === 'bulk_map_clients') {
        if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'FINANCE'))
          return res.status(403).json({ error: 'Admin or Finance privileges required' });
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const dryRun = body.dryRun !== false;              // default to preview
        if (!rows.length) return res.status(400).json({ error: 'rows[] required' });
        if (rows.length > 20000) return res.status(400).json({ error: 'Too many rows (max 20000)' });

        // PAN is NOT a unique investor key (minors hold under a guardian's PAN),
        // so identity is PAN+name first, then PAN alone only when that PAN has a
        // single client on file. See the PAN-duplicate work in Clients & Map.
        const nameKey = (s) => String(s || '').toUpperCase()
          .replace(/\b(MR|MRS|MS|MISS|DR|SHRI|SMT|LATE)\b\.?/g, ' ')
          .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
          .split(' ').filter(Boolean).sort().join(' ');
        const panKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').trim();

        const [teamRows] = await pool.query("SELECT id, name, code, level, parentId FROM team");
        const teamById = new Map(teamRows.map(t => [t.id, t]));
        const byTeamName = new Map(), byTeamCode = new Map();
        for (const t of teamRows) {
          const k = nameKey(t.name);
          if (k) byTeamName.set(k, byTeamName.has(k) ? null : t);   // null = ambiguous
          const c = String(t.code || '').toUpperCase().trim();
          if (c) byTeamCode.set(c, byTeamCode.has(c) ? null : t);
        }
        // ── Typo-tolerant matching ──────────────────────────────────────────
        // Operators type these names by hand, so exact-match-only rejected whole
        // files over one wrong letter. Order: exact code → exact name → CLOSE
        // name (edit distance). A close match is ACCEPTED but always reported as
        // "read as <name>" so nothing is silently guessed, and when two names are
        // equally close it is refused with both spelled out.
        const lev = (a, b) => {
          if (a === b) return 0;
          if (!a.length) return b.length;
          if (!b.length) return a.length;
          let prev = new Array(b.length + 1);
          for (let j = 0; j <= b.length; j++) prev[j] = j;
          for (let i = 1; i <= a.length; i++) {
            const cur = [i];
            for (let j = 1; j <= b.length; j++) {
              cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = cur;
          }
          return prev[b.length];
        };
        const sim = (a, b) => { const m = Math.max(a.length, b.length); return m ? 1 - lev(a, b) / m : 0; };

        const teamKeys = teamRows.map(t => ({ t, k: nameKey(t.name) })).filter(x => x.k);
        const findMember = (raw, explicitId, roleWanted) => {
          // An explicit team ID always wins. It is the only truly unambiguous
          // key: names repeat (16 duplicates) and the firm ARN is on 119 of 184.
          const eid = String(explicitId || '').trim();
          if (eid) {
            const byIdHit = teamById.get(eid);
            return byIdHit ? { kind: 'hit', member: byIdHit }
                           : { kind: 'miss', note: 'ID ' + eid + ' is not a team member — do not edit the ID columns' };
          }
          const s = String(raw || '').trim();
          if (!s) return { kind: 'empty' };
          // 1. ARN / code — short and unambiguous, the safest thing to type
          // A code identifies someone only when it is unique. The firm ARN is on
          // 119 of 184 members, so a shared code must never resolve to a person.
          const byCode = byTeamCode.get(s.toUpperCase());
          if (byCode) return { kind: 'hit', member: byCode };
          if (byCode === null) return { kind: 'ambiguous', note: 'that code belongs to many members — use the name, or paste the ID' };
          // 2. exact name (token-sorted, honorifics stripped)
          const k = nameKey(s);
          const exact = byTeamName.get(k);
          if (exact) return { kind: 'hit', member: exact };
          if (exact === null) {
            // Somebody who runs their own book AND manages others deliberately has
            // TWO records — one at RM level, one at manager level — so they get two
            // logins showing two different books. AdvisorKhoj is set up the same way,
            // and 17 people here are like this. The column the name was typed into
            // says which of the two is meant, so it is not really ambiguous.
            if (roleWanted) {
              const cands = teamKeys.filter(x => x.k === k).map(x => x.t);
              const want = roleWanted === 'BM'
                ? cands.filter(c => Number(c.level) >= 4)
                : cands.filter(c => Number(c.level) <= 3);
              if (want.length === 1) {
                return { kind: 'fuzzy', member: want[0], score: 1 };
              }
            }
            const withIds = teamKeys.filter(x => x.k === k).map(x => x.t.name + ' [ID ' + x.t.id + '] L' + x.t.level);
            return { kind: 'ambiguous', note: withIds.length + ' members share this name — paste the right ID into the RM ID / BM ID column: ' + withIds.join('  |  ') };
          }
          // 3. one stored name whose words are all present in what was typed
          //    (e.g. "Next Freedom Lifex" -> "Freedom Lifex"). Only when unique.
          const inTok = new Set(k.split(' ').filter(Boolean));
          const subset = teamKeys.filter(x => {
            const ts = x.k.split(' ').filter(Boolean);
            return ts.length >= 2 && ts.every(w => inTok.has(w));
          });
          if (subset.length === 1) return { kind: 'fuzzy', member: subset[0].t, score: 1 };

          // 4. closest spelling
          const scored = teamKeys.map(x => ({ t: x.t, s: sim(k, x.k) })).sort((a, b) => b.s - a.s);
          const best = scored[0], second = scored[1];
          if (best && best.s >= 0.82 && (!second || best.s - second.s >= 0.06)) {
            return { kind: 'fuzzy', member: best.t, score: best.s };
          }
          const near = scored.filter(x => x.s >= 0.6).slice(0, 3).map(x => `${x.t.name}${x.t.code ? ' (' + x.t.code + ')' : ''}`);
          return { kind: 'miss', note: near.length ? `did you mean: ${near.join(' | ')}?` : 'no similar name found' };
        };

        const [clientRows] = await pool.query("SELECT id, name, pan, data FROM clients");
        const byPanName = new Map(), byPan = new Map(), byName = new Map(), byId = new Map();
        const dataById = new Map();
        for (const c of clientRows) {
          let d; try { d = JSON.parse(c.data || '{}'); } catch { d = {}; }
          dataById.set(c.id, d); byId.set(c.id, c);
          const p = panKey(c.pan), n = nameKey(c.name);
          if (p) {
            const k = p + '|' + n;
            if (!byPanName.has(k)) byPanName.set(k, c);
            byPan.set(p, byPan.has(p) ? null : c);
          }
          if (n) byName.set(n, byName.has(n) ? null : c);
        }

        // for the typo fallback on client names
        const clientKeys = clientRows.map(c => ({ c, k: nameKey(c.name) })).filter(x => x.k);

        const out = [], writes = [];
        let ok = 0, skip = 0, err = 0;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i] || {};
          const line = Number(r.__row) || (i + 2);
          const nm = String(r.name || '').trim();
          const nk = nameKey(nm);
          const pan = panKey(r.pan);
          const push = (status, message, extra) => out.push({ row: line, name: nm, pan: r.pan || '', status, message, ...(extra || {}) });

          // 1. which client?  Client ID wins outright — the "Download Current
          //    Mapping" sheet carries it, so the operator never types a client
          //    name and a spelling mistake becomes impossible. PAN/name are the
          //    fallback for sheets typed from scratch.
          let client, howFound = '';
          const cid = String(r.clientId || '').trim();
          if (cid) {
            client = byId.get(cid);
            if (!client) { err++; push('error', 'Client ID ' + cid + ' is not in the system — do not edit that column'); continue; }
          }
          if (!client && pan && nk && byPanName.has(pan + '|' + nk)) client = byPanName.get(pan + '|' + nk);
          if (!client && pan && byPan.get(pan)) client = byPan.get(pan);
          else if (!client && pan && byPan.get(pan) === null) { err++; push('error', 'PAN ' + (r.pan || '') + ' belongs to more than one client — add the exact name, or use the Download Current Mapping sheet'); continue; }
          if (!client && nk && byName.get(nk)) { client = byName.get(nk); }
          else if (!client && nk && byName.get(nk) === null) { err++; push('error', 'Name "' + nm + '" matches more than one client — add the PAN'); continue; }
          // last resort: closest client name, so a typed sheet still lands
          if (!client && nk) {
            const scored = clientKeys.map(x => ({ c: x.c, s: sim(nk, x.k) })).sort((a, b) => b.s - a.s);
            const b0 = scored[0], b1 = scored[1];
            if (b0 && b0.s >= 0.86 && (!b1 || b0.s - b1.s >= 0.06) && (!pan || panKey(b0.c.pan) === pan || !panKey(b0.c.pan))) {
              client = b0.c; howFound = 'read as "' + b0.c.name + '"; ';
            } else {
              const near = scored.filter(x => x.s >= 0.6).slice(0, 3).map(x => x.c.name);
              err++; push('error', 'No client matched' + (near.length ? ' — did you mean: ' + near.join(' | ') + '?' : ' this PAN / name'));
              continue;
            }
          }
          if (!client) { err++; push('error', 'No client found for this PAN / name'); continue; }

          // 2. which RM / BM?  Typos are tolerated but always reported back.
          // Same name typed for RM and BM, and that name has exactly two records at
          // different levels? Then the lower level is the RM and the higher is the
          // manager — which is precisely why those duplicate records exist.
          let rmRes = findMember(r.rm, r.rmId, 'RM');
          let bmPre;
          if (rmRes.kind === 'ambiguous' && !String(r.rmId || '').trim() && nameKey(r.rm) === nameKey(r.bm)) {
            const pair = teamKeys.filter(x => x.k === nameKey(r.rm)).map(x => x.t)
                                 .sort((a, b) => Number(a.level) - Number(b.level));
            if (pair.length === 2 && Number(pair[0].level) !== Number(pair[1].level)) {
              const bmId = String(r.bmId || '').trim();
              if (bmId && pair.some(p => p.id === bmId)) {
                // The manager was named explicitly by ID, so the RM is simply the
                // OTHER record of that person — no need to ask for a second ID.
                rmRes = { kind: 'fuzzy', member: pair.find(p => p.id !== bmId), score: 1 };
                bmPre = pair.find(p => p.id === bmId);
              } else if (!bmId) {
                // Neither ID given: lower level is the RM, higher is the manager.
                // That split is exactly why these duplicate records exist.
                rmRes = { kind: 'fuzzy', member: pair[0], score: 1 };
                bmPre = pair[1];
              }
            }
          }
          if (rmRes.kind === 'empty')     { err++; push('error', 'RM is required'); continue; }
          if (rmRes.kind === 'ambiguous') { err++; push('error', 'RM "' + r.rm + '" — ' + rmRes.note); continue; }
          if (rmRes.kind === 'miss')      { err++; push('error', 'RM "' + r.rm + '" not found — ' + rmRes.note); continue; }
          const rm = rmRes.member;
          if (rmRes.kind === 'fuzzy') howFound += 'RM read as "' + rm.name + '" (L' + rm.level + '); ';

          let bm;
          if (bmPre) { bm = bmPre; howFound += 'BM read as "' + bm.name + '" (L' + bm.level + '); '; }
          else if (String(r.bm || '').trim()) {
            const bmRes = findMember(r.bm, r.bmId, 'BM');
            if (bmRes.kind === 'ambiguous') { err++; push('error', 'BM "' + r.bm + '" — ' + bmRes.note); continue; }
            if (bmRes.kind === 'miss')      { err++; push('error', 'BM "' + r.bm + '" not found — ' + bmRes.note); continue; }
            bm = bmRes.member;
            if (bmRes.kind === 'fuzzy') howFound += 'BM read as "' + bm.name + '" (L' + bm.level + '); ';
            // Same PERSON in both columns = they are both the RM and the manager.
            // Keep them once, in their own level slot, instead of failing.
            if (bm.id === rm.id) { bm = undefined; }
            else if (Number(bm.level) === Number(rm.level)) { err++; push('error', 'RM "' + rm.name + '" and BM "' + bm.name + '" are both level ' + rm.level + ', so they would need the same slot. Put the manager at a higher level, or leave BM blank.'); continue; }
          }

          // 3. Build the hierarchy: RM in their own level slot, BM in theirs, then
          //    walk the reporting chain upward to fill anything still empty.
          const hierarchy = { level1Id:'', level2Id:'', level3Id:'', level4Id:'', level5Id:'', level6Id:'', level7Id:'' };
          const rl = Math.min(7, Math.max(1, Number(rm.level) || 3));
          hierarchy['level' + rl + 'Id'] = rm.id;
          if (bm) hierarchy['level' + Math.min(7, Math.max(1, Number(bm.level) || 4)) + 'Id'] = bm.id;
          let cur = bm ? bm.parentId : rm.parentId, guard = 0;
          while (cur && teamById.get(cur) && guard++ < 10) {
            const p = teamById.get(cur);
            const pl = Math.min(7, Math.max(1, Number(p.level) || 0));
            if (pl && !hierarchy['level' + pl + 'Id']) hierarchy['level' + pl + 'Id'] = p.id;
            cur = p.parentId;
          }

          const d = dataById.get(client.id) || {};
          const before = JSON.stringify(d.hierarchy || {}) + '|' + (d.leadSourceLevel || '');
          const after  = JSON.stringify(hierarchy) + '|' + rl;
          if (before === after) { skip++; push('unchanged', howFound + 'Already mapped to ' + rm.name + (bm ? ' / ' + bm.name : '')); continue; }

          let prevOwner = null;
          const oh = d.hierarchy || {};
          for (let l = 1; l <= 7; l++) if (oh['level' + l + 'Id']) { prevOwner = (teamById.get(oh['level' + l + 'Id']) || {}).name || oh['level' + l + 'Id']; break; }

          ok++;
          // howFound explains any spelling the matcher had to interpret, so a
          // fuzzy hit is never silent — the operator sees it before approving.
          push('ok', howFound + (prevOwner ? prevOwner + ' → ' : '') + rm.name + (bm ? ' / ' + bm.name : ''), { clientId: client.id, clientName: client.name });
          writes.push({ id: client.id, data: { ...d, hierarchy, leadSourceLevel: rl, updatedAt: new Date().toISOString() } });
        }

        if (!dryRun && writes.length) {
          for (const w of writes) {
            let owner = null;
            for (let l = 1; l <= 7; l++) if (w.data.hierarchy['level' + l + 'Id']) { owner = w.data.hierarchy['level' + l + 'Id']; break; }
            await pool.query("UPDATE clients SET data=?, primaryOwnerId=? WHERE id=?", [JSON.stringify(w.data), owner, w.id]);
          }
          try {
            await pool.query("INSERT INTO activity_log (userId, userName, action, description) VALUES (?,?,?,?)",
              [req.user.id, req.user.name || req.user.id, 'BULK_CLIENT_MAPPING',
               'Bulk mapping from spreadsheet: ' + writes.length + ' client(s) re-mapped, ' + skip + ' unchanged, ' + err + ' error(s)']);
          } catch (_) {}
          invalidateSummaryCache();
          recomputeAllBreakdowns();   // fire-and-forget; progress via recalc_status
        }

        return res.json({
          success: true,
          dryRun,
          summary: { total: rows.length, willUpdate: ok, unchanged: skip, errors: err },
          rows: out.slice(0, 500),
          truncated: out.length > 500,
        });
      }

      if (action === 'map_rm_folios') {
        if (!req.user || (req.user.role !== 'ADMIN' && req.user.role !== 'FINANCE'))
          return res.status(403).json({ error: 'Admin or Finance privileges required' });
        const rmId = body.rmId;
        const folios = Array.isArray(body.folios) ? body.folios.map(f => String(f).trim()).filter(Boolean) : [];
        if (!rmId || folios.length === 0) return res.status(400).json({ error: 'rmId and folios[] required' });

        // Resolve the hierarchy to apply: explicit > RM's canonical (most common
        // among their existing clients) > sensible default built from team levels.
        const [teamRows] = await pool.query("SELECT id, level, parentId, data FROM team");
        const teamById = new Map(teamRows.map(t => [t.id, t]));
        const rm = teamById.get(rmId);
        if (!rm) return res.status(400).json({ error: 'Unknown rmId' });

        const [clientRows] = await pool.query("SELECT id, data FROM clients");
        const folioToClient = new Map(); const clientDataById = new Map(); const known = new Set();
        const hierCount = new Map();
        for (const c of clientRows) {
          known.add(c.id); let d; try { d = JSON.parse(c.data || '{}'); } catch { d = {}; }
          clientDataById.set(c.id, d);
          for (const f of (Array.isArray(d.folios) ? d.folios : [])) folioToClient.set(String(f).trim(), c.id);
          if (d.hierarchy) { let isRM = false; for (let l = 1; l <= 7; l++) if (d.hierarchy[`level${l}Id`] === rmId) { isRM = true; break; } if (isRM) { const k = JSON.stringify(d.hierarchy) + '|' + (d.leadSourceLevel || ''); hierCount.set(k, (hierCount.get(k) || 0) + 1); } }
        }

        let hierarchy = body.hierarchy, leadSourceLevel = body.leadSourceLevel;
        if (!hierarchy) {
          // canonical = most common existing hierarchy for this RM
          let best = 0, bestK = null; for (const [k, n] of hierCount) if (n > best) { best = n; bestK = k; }
          if (bestK) { hierarchy = JSON.parse(bestK.split('|')[0]); const ls = bestK.split('|')[1]; leadSourceLevel = ls ? Number(ls) : undefined; }
          else {
            // default: fill L1..rm.level with the RM, then walk parentId upward
            hierarchy = { level1Id:'',level2Id:'',level3Id:'',level4Id:'',level5Id:'',level6Id:'',level7Id:'' };
            const lvl = Number(rm.level) || 3;
            for (let l = 1; l <= lvl; l++) hierarchy[`level${l}Id`] = rmId;
            let cur = rm.parentId, cl = lvl + 1;
            while (cur && cl <= 7 && teamById.get(cur)) { hierarchy[`level${cl}Id`] = cur; cur = teamById.get(cur).parentId; cl++; }
            leadSourceLevel = 1;
          }
        }

        // Resolve folios → clients (client.folios first, then transaction mappedClientId)
        const need = folios.filter(f => !folioToClient.has(f));
        if (need.length) {
          // batched lookup of folio→mappedClientId from transactions
          for (let i = 0; i < need.length; i += 500) {
            const chunk = need.slice(i, i + 500);
            const [rows] = await pool.query(
              `SELECT mappedClientId mcid, JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) folio
               FROM transactions WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.folio')) IN (${chunk.map(()=>'?').join(',')})`, chunk);
            for (const r of rows) { const f = (r.folio||'').trim(); if (f && r.mcid && !folioToClient.has(f)) folioToClient.set(f, r.mcid); }
          }
        }

        const targets = new Set(); let unmatched = 0;
        for (const f of folios) { const cid = folioToClient.get(f); if (cid && known.has(cid)) targets.add(cid); else unmatched++; }
        for (const cid of targets) {
          const d = clientDataById.get(cid) || {};
          d.hierarchy = { ...hierarchy };
          if (leadSourceLevel) d.leadSourceLevel = leadSourceLevel; else delete d.leadSourceLevel;
          await pool.query("UPDATE clients SET data=? WHERE id=?", [JSON.stringify(d), cid]);
        }
        try {
          await pool.query('INSERT INTO activity_log (userId, userName, action, description, createdAt) VALUES (?,?,?,?,NOW())',
            [req.user.id, req.user.name || req.user.email || 'admin', 'MAP_RM_FOLIOS', `Mapped ${targets.size} clients (${folios.length} folios) to ${rm.name||rmId}`]);
        } catch (_) {}
        invalidateSummaryCache();
        recomputeAllBreakdowns(); // background recompute so all reports update
        return res.json({ success: true, foliosReceived: folios.length, clientsMapped: targets.size, foliosUnmatched: unmatched, hierarchy, leadSourceLevel });
      }

      // Bulk Deletion
      if (action === 'bulk_delete' && collection && payload) {
        if (!VALID_TABLES.includes(collection)) {
          console.warn(`❌ [Bulk Delete] Rejected invalid table: ${collection}`);
          return res.status(400).json({ error: `Invalid table: ${collection}` });
        }

        const type = collection;
        const ids = Array.isArray(payload) ? payload : [payload];
        if (ids.length === 0) return res.json({ success: true, count: 0 });
        if (ids.length > 1000) {
          return res.status(400).json({ error: 'Bulk delete capped at 1000 IDs per request.' });
        }

        console.log(`🗑️ [Bulk Delete Request] Table: ${type}, IDs: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '...' : ''} (Total: ${ids.length})`);

        try {
          const idCol = ['amc_mappings', 'scheme_mappings'].includes(type) ? 'original' : 'id';

          if (type === 'transactions') {
            await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (?)', [ids]);
          }

          // Use the internal row count to be sure
          const [result] = await pool.query(`DELETE FROM ${type} WHERE ${idCol} IN (?)`, [ids]);
          const affected = result.affectedRows || 0;

          if (type === 'transactions' || type === 'batches') invalidateSummaryCache();
          console.log(`✅ [Bulk Delete Success] Removed ${affected} records from ${type}`);
          return res.json({ success: true, count: affected });
        } catch (dbErr) {
          console.error(`❌ [Bulk Delete SQL Error]`, dbErr);
          return res.status(500).json({ error: `Database Error: ${dbErr.message}` });
        }
      }

      // Activity Logging
      if (action === 'log_activity') {
        await pool.query('INSERT INTO activity_log (userId, userName, action, description) VALUES (?, ?, ?, ?)', [userId, userName, activityAction, description]);
        return res.json({ success: true });
      }

      // Authentication
      if (action === 'auth') {
        const [rows] = await withTimeout(
          pool.query('SELECT * FROM team WHERE (email = ? OR code = ?)', [identifier, identifier]),
          AUTH_TIMEOUT_MS,
          'Authentication query'
        );
        if (rows.length > 0) {
          const dbUser = rows[0];
          let passwordMatch = false;

          // Bcrypt only. Plain-text login is NOT accepted (migration window closed).
          // Any legacy un-hashed password row simply fails auth until reset.
          if (dbUser.password && (dbUser.password.startsWith('$2b$') || dbUser.password.startsWith('$2a$'))) {
            passwordMatch = await bcrypt.compare(password, dbUser.password);
          }

          if (passwordMatch) {
            const user = { ...dbUser };
            if (user.data) Object.assign(user, JSON.parse(user.data));
            delete user.data;
            delete user.password;

            // Issue JWT
            const token = jwt.sign(
              { id: user.id, role: user.role, level: user.level },
              JWT_SECRET,
              { expiresIn: '7d' }
            );

            return res.json({ success: true, user, token });
          }
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Bulk Data Persistence
      if (!collection || !VALID_TABLES.includes(collection)) return res.status(400).json({ error: 'Invalid collection' });
      const items = Array.isArray(payload) ? payload : [payload];

      // ── Optimistic concurrency (clients & team) — stops stale-tab reverts ──────
      // A browser tab holds a snapshot; when it saves it can overwrite changes made
      // elsewhere since it loaded. Each accepted write stamps data.updatedAt = server
      // time; a write is REJECTED as a CONFLICT (not applied) when its incoming
      // updatedAt is OLDER than what is already stored — i.e. it is based on data
      // that has since changed. Fresh edits (the app stamps a new updatedAt on any
      // record it changes) and brand-new records always pass. This is the durable
      // fix for the repeated "we corrected it yesterday, it reverted" problem.
      let staleConflicts = [];
      const nowISO = new Date().toISOString();
      if ((collection === 'clients' || collection === 'team') && items.length) {
        const ids = items.map(it => it && it.id).filter(Boolean);
        const storedU = new Map();
        if (ids.length) {
          const [rows] = await pool.query(
            `SELECT id, JSON_UNQUOTE(JSON_EXTRACT(data,'$.updatedAt')) u FROM ${collection} WHERE id IN (?)`, [ids]);
          for (const r of rows) if (r.u) storedU.set(r.id, r.u);
        }
        // Compare PARSED instants, never raw strings. The table holds two formats —
        // legacy MySQL "2026-06-03 07:05:46" (1,344 client rows) and ISO
        // "2026-08-01T13:37:20.886Z" — and a lexical compare puts EVERY MySQL-style
        // value before EVERY ISO one (space 0x20 < "T" 0x54) no matter the real
        // time. That made a legitimate save look stale, so it was silently skipped
        // and the client appeared to revert to Unassigned. A 1s tolerance absorbs
        // format/rounding differences; only a genuinely older base is a conflict.
        const ts = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : 0; };
        const accepted = [];
        for (const it of items) {
          const prev = storedU.get(it && it.id);
          const inTs = ts(it && it.updatedAt), prevTs = ts(prev);
          if (prev && inTs > 0 && prevTs > 0 && inTs < prevTs - 1000) { staleConflicts.push(it.id); continue; }
          if (it) it.updatedAt = nowISO;   // stamp accepted write with authoritative server time (always ISO)
          accepted.push(it);
        }
        if (accepted.length !== items.length) { items.length = 0; items.push(...accepted); }
      }

      // ── Capture level changes BEFORE the write ───────────────────────────
      // A client's hierarchy stores the user id in a specific level slot
      // (level3Id, level4Id …). So moving a team member to another level used to
      // strand every one of their clients in the OLD slot, which then had to be
      // re-mapped by hand, client by client. Record the before/after level here so
      // the client placements can follow the member automatically after commit.
      const levelMoves = [];
      if (collection === 'team' && items.length) {
        const ids = items.map(it => it && it.id).filter(Boolean);
        if (ids.length) {
          const [prevRows] = await pool.query('SELECT id, level, data FROM team WHERE id IN (?)', [ids]);
          const prevLevel = new Map(prevRows.map(r => [r.id, Number(r.level)]));
          const prevData  = new Map(prevRows.map(r => { let d = {}; try { d = JSON.parse(r.data || '{}'); } catch {} return [r.id, d]; }));
          // Current month on the SERVER clock — never the browser's, which has
          // already caused one silent-write bug in this file.
          const thisMonth = new Date().toISOString().slice(0, 7);
          for (const it of items) {
            const before = prevLevel.get(it.id);
            const after = Number(it.level);
            if (before !== undefined && Number.isFinite(after) && before !== after && after >= 1 && after <= 7) {
              levelMoves.push({ userId: it.id, from: before, to: after });
            }

            // ── Effective-dated rate change ────────────────────────────────
            // Record the OLD level/rate as a closed period and open a new one
            // from the effective month, so recomputes leave prior months alone.
            // Previously the new rate was simply applied to all of history.
            const prev = prevData.get(it.id);
            if (!prev) continue;                                   // brand-new member: nothing to preserve
            const prevCL = prev.customLevels || {};
            const nextCL = it.customLevels || {};
            const levelChanged = before !== undefined && Number.isFinite(after) && before !== after;
            const rateChanged  = JSON.stringify(prevCL) !== JSON.stringify(nextCL);
            // An explicit effective month is itself a reason to rewrite the timeline,
            // even when the rate VALUE is unchanged — otherwise an admin who sets the
            // right rate first and only then realises it should also cover past months
            // has no way to say so: the save silently becomes a no-op.

            const asked = String(it.rateEffectiveFrom || '').trim();
            const askedValid = /^\d{4}-\d{2}$/.test(asked);
            if (!levelChanged && !rateChanged && !askedValid) continue;
            const effectiveFrom = /^\d{4}-\d{2}$/.test(asked) ? asked : thisMonth;

            // "All months" (0000-01) is an explicit CORRECTION, not a promotion:
            // the admin is saying this rate was always right. Replace the whole
            // timeline with a single entry rather than stacking on top of it —
            // otherwise a later entry would keep overriding recent months and the
            // correction would appear not to work.
            if (effectiveFrom === "0000-01") {
              it.rateHistory = [{ effectiveFrom: "0000-01", level: after, customLevels: nextCL }];
              delete it.rateEffectiveFrom;
              console.log(`[rate-history] ${it.id}: L${before}->L${after} applied to ALL months (timeline reset)`);
              continue;
            }
            const hist = Array.isArray(prev.rateHistory) ? prev.rateHistory.slice() : [];
            if (!hist.length) {
              // First re-grade: everything up to now was the OLD rate. '0000-01'
              // is an open-ended lower bound so no historical month is missed.
              hist.push({ effectiveFrom: '0000-01', level: before, customLevels: prevCL });
            }
            // Re-saving the same effective month replaces that entry rather than
            // stacking duplicates (admins correct a rate they just typed).
            const kept = hist.filter(h => String(h && h.effectiveFrom) !== effectiveFrom);
            kept.push({ effectiveFrom, level: after, customLevels: nextCL });
            kept.sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));
            it.rateHistory = kept;
            delete it.rateEffectiveFrom;                           // control field, not stored data
            console.log(`[rate-history] ${it.id}: L${before}→L${after} effective ${effectiveFrom} (${kept.length} periods)`);
          }
        }
      }

      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        if (items.length > 0) {
          if (collection === 'team') {
            for (const item of items) {
              const { id, parentid, parentId = parentid || null, name = '', code = '', role = 'OPS', level = 6, email = '', password = '', ...rest } = item;
              // Clean rest
              delete rest.parentid;
              delete rest.parentId;

              // Hash password if it's set and not already hashed
              let finalPassword = password;
              if (password && !password.startsWith('$2b$') && !password.startsWith('$2a$')) {
                finalPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
              }

              await connection.query(
                // An EMPTY incoming password must NEVER overwrite the stored hash —
                // most saves (profile edits, re-mappings) carry no password and would
                // otherwise wipe the user's login. Keep the existing one in that case.
                `INSERT INTO team (id, parentId, name, code, role, level, email, password, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE parentId=VALUES(parentId), name=VALUES(name), code=VALUES(code), role=VALUES(role), level=VALUES(level), email=VALUES(email), password=IF(VALUES(password)='' OR VALUES(password) IS NULL, password, VALUES(password)), data=VALUES(data)`,
                [id, parentId, name, code, role, level, email, finalPassword, JSON.stringify(rest)]
              );
            }
          } else if (collection === 'clients') {
            const values = items.map(item => {
              const { id, primaryownerid, primaryOwnerId = primaryownerid || null, pan = '', name = '', ...rest } = item;
              // Clean rest
              delete rest.primaryownerid;
              delete rest.primaryOwnerId;

              return [id, primaryOwnerId, pan, name, JSON.stringify(rest)];
            });
            await connection.query(
              `INSERT INTO clients (id, primaryOwnerId, pan, name, data) VALUES ? 
               ON DUPLICATE KEY UPDATE primaryOwnerId=VALUES(primaryOwnerId), pan=VALUES(pan), name=VALUES(name), data=VALUES(data)`,
              [values]
            );
          } else if (collection === 'transactions') {
            const values = items.map(item => {
              const {
                id,
                batchid, batchId = batchid || '',
                pan = '',
                investorname, investorName = investorname || '',
                transactiondate, transactionDate = transactiondate || null,
                amcname, amcName = amcname || '',
                schemename, schemeName = schemename || '',
                grossamount, grossAmount = grossamount || 0,
                ...rest
              } = item;

              // Indexed columns mirrored from the JSON for fast period/client filtering.
              const brokeragePeriod = rest.brokeragePeriod || null;
              const mappedClientId = rest.mappedClientId || null;

              // Clean rest
              ['batchid', 'batchId', 'investorname', 'investorName', 'transactiondate', 'transactionDate', 'amcname', 'amcName', 'schemename', 'schemeName', 'grossamount', 'grossAmount'].forEach(k => delete rest[k]);

              return [id, batchId, pan, investorName, transactionDate, amcName, schemeName, grossAmount, brokeragePeriod, mappedClientId, JSON.stringify(rest)];
            });

            await connection.query(
              `INSERT INTO transactions (id, batchId, pan, investorName, transactionDate, amcName, schemeName, grossAmount, brokeragePeriod, mappedClientId, data) VALUES ?
               ON DUPLICATE KEY UPDATE batchId=VALUES(batchId), pan=VALUES(pan), investorName=VALUES(investorName), transactionDate=VALUES(transactionDate), amcName=VALUES(amcName), schemeName=VALUES(schemeName), grossAmount=VALUES(grossAmount), brokeragePeriod=VALUES(brokeragePeriod), mappedClientId=VALUES(mappedClientId), data=VALUES(data)`,
              [values]
            );

            // Bulk Handle payout ledger. Dedupe by (transactionId, userId): a CAMS/Karvy
            // file can contain the same transaction id twice (an identical duplicate line),
            // which produces two rows for the same (transactionId, userId) pair. Without
            // dedupe + upsert that violates the unq_tx_user UNIQUE key and, because the whole
            // POST is one DB transaction, rolls back the ENTIRE import (batch metadata saves
            // in its own POST, so the UI shows an "imported" batch with zero transactions).
            const ledgerDeletes = [];
            const ledgerMap = new Map();
            for (const item of items) {
              if (item.breakdown?.userPayouts) {
                ledgerDeletes.push(item.id);
                for (const [uid, amt] of Object.entries(item.breakdown.userPayouts)) {
                  ledgerMap.set(`${item.id} ${uid}`, [item.id, uid, amt, 0]); // last wins
                }
              }
            }
            const ledgerInserts = [...ledgerMap.values()];

            if (ledgerDeletes.length > 0) {
              await connection.query('DELETE FROM payout_ledger WHERE transactionId IN (?)', [ledgerDeletes]);
            }
            if (ledgerInserts.length > 0) {
              await connection.query(
                'INSERT INTO payout_ledger (transactionId, userId, amount, level) VALUES ? ON DUPLICATE KEY UPDATE amount=VALUES(amount), level=VALUES(level)',
                [ledgerInserts]
              );
            }
            invalidateSummaryCache();
          } else if (['amc_mappings', 'scheme_mappings'].includes(collection)) {
            const values = items.map(item => [item.original, item.standard]);
            await connection.query(`INSERT INTO ${collection} (original, standard) VALUES ? ON DUPLICATE KEY UPDATE standard=VALUES(standard)`, [values]);
          } else if (collection === 'invoices') {
            for (const item of items) {
              const { id, userid, userId = userid || '', month = '', ...rest } = item;
              delete rest.userid;
              delete rest.userId;
              await connection.query(`INSERT INTO invoices (id, userId, month, data) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE userId=VALUES(userId), month=VALUES(month), data=VALUES(data)`, [id, userId, month, JSON.stringify(rest)]);
            }
          } else if (collection === 'batches') {
            for (const item of items) {
              const { id, filename, fileName = filename || '', ...rest } = item;
              delete rest.filename;
              delete rest.fileName;
              await connection.query(`INSERT INTO batches (id, fileName, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE fileName=VALUES(fileName), data=VALUES(data)`, [id, fileName, JSON.stringify(rest)]);
            }
          } else if (collection === 'brokerage_masters') {
            const staleMasterIds = new Set();
            const values = items.map(item => {
              const {
                id,
                amcname, amcName = amcname || '',
                schemename, schemeName = schemename || '',
                category = '',
                trailrate, trailRate = trailrate || 0,
                period = 'FINAL',
                ...rest
              } = item;

              // Last line of defence: whatever path produced this row (PDF parse,
              // manual add, CSV), the AMC is stored under its canonical name so a
              // fund house can never end up with two split rate histories.
              const cleanAmc = canonicalAmcName(amcName);
              const cleanScheme = String(schemeName).trim();
              const cleanPeriod = String(period).trim();

              const safeTrailRate = Number(trailRate) || 0;
              // The identity is ALWAYS derived from the AMC and the scheme, never taken
              // from the caller. Adding a scheme that already exists therefore lands on
              // the same row and overwrites its rate instead of adding a second copy,
              // and renaming one onto another merges them. A row whose supplied id no
              // longer matches its name is left behind under the old key, so collect
              // those and drop them after the upsert.
              const safeId = masterSchemeId(cleanAmc, cleanScheme);
              if (id && id !== safeId) staleMasterIds.add(id);

              // Clean rest
              ['amcname', 'amcName', 'schemename', 'schemeName', 'category', 'trailrate', 'trailRate', 'period'].forEach(k => delete rest[k]);

              return [safeId, cleanAmc, cleanScheme, category, safeTrailRate, cleanPeriod, JSON.stringify(rest)];
            });

            await connection.query(
              `INSERT INTO brokerage_masters (id, amcName, schemeName, category, trailRate, period, data) VALUES ?
               ON DUPLICATE KEY UPDATE amcName=VALUES(amcName), schemeName=VALUES(schemeName), category=VALUES(category), trailRate=VALUES(trailRate), period=VALUES(period), data=VALUES(data)`,
              [values]
            );
            // Drop the rows the rename moved off, but never one this same save just
            // wrote — a scheme whose derived key happens to equal another row's old id
            // must survive.
            const written = new Set(values.map(v => v[0]));
            const toDrop = [...staleMasterIds].filter(x => !written.has(x));
            if (toDrop.length) {
              const [del] = await connection.query('DELETE FROM brokerage_masters WHERE id IN (?)', [toDrop]);
              console.log(`🧹 [Masters] merged ${del.affectedRows} renamed scheme row(s) into their canonical key`);
            }
          } else {
            for (const item of items) {
              const { id, ...rest } = item;
              const table = collection; // VALID_TABLES check ensures this is safe
              await connection.query(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)`, [id, JSON.stringify(rest)]);
            }
          }
        }

        await connection.commit();

        // ── Follow-the-member: migrate client placements on a level change ────
        // When a team member moves level (e.g. an RM re-graded from L3 to L2),
        // every client that had them in the OLD level slot is moved to the NEW
        // slot automatically. Without this the clients keep pointing at a slot the
        // member no longer occupies, their brokerage stops being credited to them,
        // and each client has to be re-mapped by hand.
        //   • skips a client whose target slot is already held by someone else
        //   • carries leadSourceLevel across so the lead-source add-on follows too
        //   • recomputes payouts afterwards so reports reflect it immediately
        if (levelMoves.length) {
          try {
            let moved = 0, skipped = 0;
            for (const mv of levelMoves) {
              const [rows] = await pool.query(
                `SELECT id, data FROM clients WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.hierarchy.level${mv.from}Id')) = ?`,
                [mv.userId]);
              for (const r of rows) {
                let d; try { d = JSON.parse(r.data || '{}'); } catch { continue; }
                const h = d.hierarchy || {};
                const target = h[`level${mv.to}Id`];
                if (target && target !== mv.userId) { skipped++; continue; }  // slot taken by someone else
                h[`level${mv.from}Id`] = '';
                h[`level${mv.to}Id`] = mv.userId;
                d.hierarchy = h;
                if (Number(d.leadSourceLevel) === mv.from) d.leadSourceLevel = mv.to;
                d.updatedAt = new Date().toISOString();
                await pool.query('UPDATE clients SET data=? WHERE id=?', [JSON.stringify(d), r.id]);
                moved++;
              }
            }
            if (moved || skipped) {
              const desc = levelMoves.map(m => `${m.userId} L${m.from}→L${m.to}`).join(', ')
                         + ` — ${moved} client(s) re-slotted${skipped ? `, ${skipped} skipped (slot occupied)` : ''}`;
              console.log(`[level-move] ${desc}`);
              try {
                await pool.query('INSERT INTO activity_log (userId, userName, action, description, createdAt) VALUES (?,?,?,?,NOW())',
                  [req.user?.id || 'system', req.user?.name || 'system', 'LEVEL_MOVE_REMAP', desc]);
              } catch (_) {}
              if (moved) { invalidateSummaryCache(); recomputeAllBreakdowns(); }
            }
          } catch (mvErr) {
            console.error('[level-move] client re-slot failed:', mvErr.message);
          }
        }

        // ── Audit trail for money-affecting collections ──────────────────
        try {
          const who = req.user || {};
          const uid = who.id || 'system';
          const uname = who.name || who.email || who.username || 'system';
          let action = null, desc = null;
          if (collection === 'config') {
            const c = items[0] || {};
            action = 'CONFIG_UPDATE';
            desc = `Sharing config saved — model=RESIDUAL`
                 + (c.leadSourcePct !== undefined ? `, leadSourcePct=${c.leadSourcePct}` : '')
                 + (c.companyExpensePct !== undefined ? `, companyExpense=${c.companyExpensePct}%` : '');
          } else if (collection === 'clients') {
            action = 'CLIENT_MAPPING_UPDATE';
            desc = `Client hierarchy / lead-source updated (${items.length} record${items.length !== 1 ? 's' : ''})`;
          } else if (collection === 'team') {
            action = 'TEAM_UPDATE';
            desc = `Team / user-sharing updated (${items.length} record${items.length !== 1 ? 's' : ''})`;
          }
          if (action) {
            await pool.query(
              'INSERT INTO activity_log (userId, userName, action, description, createdAt) VALUES (?,?,?,?,NOW())',
              [uid, uname, action, desc]
            );
          }
        } catch (logErr) {
          console.warn('[audit] failed to log', collection, 'change:', logErr.message);
        }

        // Report any stale writes that were skipped so the client can refresh and
        // warn the user, instead of silently believing its (reverting) save landed.
        // `stamped` = the authoritative version this write was given. The client
        // adopts it so its NEXT edit sends a current base version. Without this the
        // browser keeps the pre-save value, every following save looks stale, and
        // the user has to click Save repeatedly before one lands.
        res.json({ success: true, saved: items.length, stamped: nowISO, conflicts: staleConflicts, conflictCount: staleConflicts.length });
      } catch (e) {
        await connection.rollback();
        throw e;
      } finally {
        connection.release();
      }
      return;
    }

    if (method === 'DELETE') {
      const { type, id, action } = query;

      // All deletes (batches, clients, team, transactions, …) are ADMIN/FINANCE
      // operations. purge_batch enforces the stricter ADMIN-only check below.
      if (!isWriter(req)) {
        console.warn(`🛑 [DELETE] 403 action=${action || type || '?'} blocked user=${req.user?.id || 'none'} role=${req.user?.role || 'none'}`);
        return res.status(403).json({ error: 'Admin or Finance privileges required' });
      }

      // Soft-delete a batch — mark deletedAt in JSON, keep all data for 30-day undo window.
      // The original endpoint name `undo_import` is preserved for client compatibility.
      if (action === 'undo_import' && id) {
        const [rows] = await pool.query('SELECT data FROM batches WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
        let data = {};
        try { data = rows[0].data ? JSON.parse(rows[0].data) : {}; } catch (e) {}
        data.deletedAt = new Date().toISOString();
        data.deletedBy = req.user?.id || null;
        await pool.query('UPDATE batches SET data = ? WHERE id = ?', [JSON.stringify(data), id]);
        invalidateSummaryCache();
        console.log(`🗑️ [Soft-Delete Batch] id=${id} by user=${req.user?.id || 'system'}`);
        return res.json({ success: true, softDelete: true });
      }

      // Restore a soft-deleted batch.
      if (action === 'restore_batch' && id) {
        const [rows] = await pool.query('SELECT data FROM batches WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Batch not found' });
        let data = {};
        try { data = rows[0].data ? JSON.parse(rows[0].data) : {}; } catch (e) {}
        delete data.deletedAt;
        delete data.deletedBy;
        await pool.query('UPDATE batches SET data = ? WHERE id = ?', [JSON.stringify(data), id]);
        invalidateSummaryCache();
        console.log(`♻️  [Restore Batch] id=${id} by user=${req.user?.id || 'system'}`);
        return res.json({ success: true });
      }

      // Permanently purge a soft-deleted batch (admin only).
      if (action === 'purge_batch' && id) {
        if (!req.user || req.user.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Admin privileges required to purge batches.' });
        }
        await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (SELECT id FROM transactions WHERE batchId = ?)', [id]);
        await pool.query('DELETE FROM transactions WHERE batchId = ?', [id]);
        await pool.query('DELETE FROM batches WHERE id = ?', [id]);
        invalidateSummaryCache();
        console.log(`💣 [Purge Batch] id=${id} by admin=${req.user.id}`);
        return res.json({ success: true, purged: true });
      }
      if (type && id) {
        // `type` is interpolated into the DELETE below, so it MUST be whitelisted —
        // the GET and POST branches check VALID_TABLES but this one never did,
        // leaving an arbitrary-table DELETE reachable through a query parameter.
        if (!VALID_TABLES.includes(type)) return res.status(400).json({ error: 'Invalid table type' });
        const idCol = ['amc_mappings', 'scheme_mappings'].includes(type) ? 'original' : 'id';
        // SAFER: Don't split if ID contains '|' which indicates complex scheme ID
        const ids = id.includes('|') ? [id] : id.split(',');
        if (type === 'transactions') await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (?)', [ids]);
        const [resDel] = await pool.query(`DELETE FROM ${type} WHERE ${idCol} IN (?)`, [ids]);
        console.log(`🗑️ [Single Delete] Table: ${type}, Rows: ${resDel.affectedRows}, Result: Success`);
        return res.json({ success: true });
      }
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error(`[API Error] ${req.method} ${req.url}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Initial Health Check Route for root
app.get('/api/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/test', (req, res) => res.json({ message: 'API is responding safely' }));
app.get('/api/version', (req, res) => res.json({ version: '1.2.1-debug', time: new Date().toISOString() }));

// ── Canonical AMC names ────────────────────────────────────────────────────
// One fund house MUST have exactly one stored name. When the same AMC landed
// under two spellings ("ABSL" from ABSL.pdf, "ADITYA BIRLA SUN LIFE" from the
// full-name file), its rate history SPLIT: the Brokerage Rates screen keeps the
// latest period PER STORED NAME, so both survived "Current rate only" and every
// scheme appeared twice with conflicting rates — 115 schemes, 102 of them
// disagreeing, and no way to tell which rate was live. Folding aliases here
// makes the newest period win normally and the older one become superseded.
//
// Keys are compared upper-cased and trimmed. Add a row whenever a new short
// form or misspelling shows up rather than letting a second name take root.
const AMC_CANONICAL = {
  'ABSL': 'ADITYA BIRLA SUN LIFE',
  'ADITYA BIRLA': 'ADITYA BIRLA SUN LIFE',
  'BOI': 'BANK OF INDIA',
  'JM MF': 'JM',
  'LIC MF': 'LIC',
  'LICMF': 'LIC',
  'MAHENDRA': 'MAHINDRA',                 // misspelling seen in uploaded filenames
  'MAHINDRA MANULIFE': 'MAHINDRA',
  'PPFAS': 'PARAG PARIKH',
  'MOTILAL': 'MOTILAL OSWAL',
  'WHITE OAK': 'WHITEOAK',
  'IDFC': 'BANDHAN',                      // IDFC MF was rebranded to Bandhan
  'TEMPLETON': 'FRANKLIN',
  'ROBECO': 'CANARA',
  'TRUST MF': 'TRUST',
  // Two labels for one fund house split 63 schemes away from the other 183 and
  // showed every one of them twice in the master and the export.
  'NIPPON INDIA MF': 'NIPPON',
  'NIPPON INDIA': 'NIPPON',
  // The card is filed as "Baroda BNP"; the master had built its history under
  // "BARODA". All 46 schemes on the card already existed under the old label, so
  // without this the next upload would have started a second, parallel fund house.
  'BARODA BNP': 'BARODA',
  'BARODA BNP PARIBAS': 'BARODA',
};
function canonicalAmcName(name = '') {
  const up = String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!up) return String(name || '').trim();
  return AMC_CANONICAL[up] || up;
}

/**
 * Primary key for a master scheme: the SCHEME, not the scheme-in-a-month.
 *
 * The period used to be part of this key, so re-uploading a fund house's rate card
 * in a new month inserted a SECOND row for every scheme it already carried — 3,986
 * rows standing for 1,849 real schemes. Keying on AMC + scheme alone means a
 * re-upload overwrites the rate in place, which is what a rate card is.
 *
 * Punctuation and case are folded out, matching the export's dedupe key exactly, so
 * "360 ONE Flexi-Cap" and "360 One Flexi Cap" can never become two schemes.
 */
function masterSchemeId(amcName = '', schemeName = '') {
  return `${normAmcKey(amcName)}|${normSchemeKey(schemeName)}`;
}

/** AMC part of the key, with the canonical-name aliases folded in. */
function normAmcKey(amcName = '') {
  return String(canonicalAmcName(amcName) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Scheme part of the key, with the trailing scheme-TYPE words removed.
 *
 * Cards disagree about how much of the type to spell out, so the SAME fund arrived
 * under two names and the master carried both — "Bandhan Gilt" beside "Bandhan Gilt
 * Fund", "Mirae Asset Gold ETF Fund of Fund" beside "Mirae Asset Gold ETF Fund",
 * 109 such pairs, several with DIFFERENT rates. Folding the tail makes them one
 * scheme, so a re-upload overwrites rather than adding a second copy.
 *
 * Only a TRAILING run is stripped, and never down to fewer than 5 characters, so a
 * fund whose whole identity is the type word ("Kotak Gold Fund") keeps its name.
 */
function normSchemeKey(schemeName = '') {
  // "&" and "and" are the same word. Stripping punctuation turned "Banking &
  // Financial" into BANKINGFINANCIAL and "Banking and Financial" into
  // BANKINGANDFINANCIAL, so a card that spelled it one way and a card that spelled
  // it the other left Bank of India carrying both as separate schemes.
  const raw = String(schemeName || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]/g, '');
  const TAIL = /(FUNDOFFUNDS?|INDEXFUND|ETFFOF|FOF|ETF|FUND|SCHEME|PLAN)+$/;
  let x = raw, prev;
  do { prev = x; x = x.replace(TAIL, ''); } while (x !== prev && x.length > 4);
  return x.length > 4 ? x : raw;
}

function detectAmcNameFromFilename(filename = '') {
  const brands = [
    "ADITYA BIRLA SUN LIFE", "ADITYA BIRLA", "ABSL", "360 ONE", "FRANKLIN", "TEMPLETON",
    "HDFC", "KOTAK", "SBI", "ICICI", "AXIS", "NIPPON", "MIRAE", "TATA",
    "DSP", "UTI", "LIC MF", "LICMF", "HELIOS", "BANDHAN", "IDFC",
    "INVESCO", "WHITEOAK", "WHITE OAK", "CANARA", "ROBECO", "BOI",
    "BANK OF INDIA", "EDELWEISS", "HSBC", "TRUST", "UNION", "PPFAS",
    "QUANT", "MAHINDRA", "MAHENDRA", "MAHINDRA MANULIFE", "PGIM", "JM MF", "JM", "PARAG PARIKH", "PPFAS",
    "BARODA", "BNP", "PFRDA", "TAURUS", "ITI MF", "SAMCO", "TRUST MF", "GROWW", "NAVI", "QUANTUM", "MOTILAL OSWAL", "MOTILAL", "OLD BRIDGE", "NJ", "SHRIRAM"
  ];
  const up = filename.toUpperCase();
  for (const b of brands) {
    // Fold aliases here so "ABSL.pdf" and "Aditya Birla Sun Life.pdf" can never
    // create two separate rate histories for the same fund house.
    if (up.includes(b)) return canonicalAmcName(b);
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

/**
 * SERVER-SIDE SPREADSHEET PARSE — for files the browser cannot handle.
 *
 * CAMS ships a 45–50 MB legacy .xls every month. Parsing that in a browser
 * worker exhausts tab memory ("PARSE FAILED — FILE TOO LARGE"), and telling the
 * user to Save-As-CSV every month is a chore, not a fix. Node has no such
 * constraint, so the browser posts the raw file here and gets back the same
 * row array its own worker would have produced.
 *
 * The parse options and the scientific-notation repair MUST stay identical to
 * workers/xlsxParser.worker.ts — long folios like 910209065875 otherwise render
 * as "9.10209E+11", which mangles the folio AND merges distinct folios.
 */
app.post('/api/parse-sheet', requireAdminOrFinance, upload.single('file'), async (req, res) => {
  const t0 = Date.now();
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const workbook = XLSX.read(req.file.buffer, {
      type: 'buffer', dense: true, cellDates: false, cellNF: false,
      cellStyles: false, cellHTML: false, cellFormula: false,
    });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ ok: false, error: 'Workbook has no sheets.' });
    const worksheet = workbook.Sheets[sheetName];

    const deScientify = (cell) => {
      if (cell && cell.t === 'n' && typeof cell.w === 'string' && /\de[+-]?\d/i.test(cell.w) && Number.isFinite(cell.v)) {
        cell.w = Number.isInteger(cell.v) ? String(cell.v) : cell.v.toFixed(6).replace(/\.?0+$/, '');
      }
    };
    for (const key in worksheet) {
      if (key[0] === '!') continue;
      const entry = worksheet[key];
      if (Array.isArray(entry)) { for (const cell of entry) deScientify(cell); }
      else deScientify(entry);
    }

    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false, raw: false, defval: '' });
    const ms = Date.now() - t0;
    console.log(`[parse-sheet] ${req.file.originalname} ${(req.file.size / 1048576).toFixed(1)}MB → ${jsonData.length} rows in ${ms}ms`);
    return res.json({ ok: true, jsonData, sheetName, rowCount: jsonData.length, ms });
  } catch (e) {
    console.error('[parse-sheet] failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * NEW: AMC BROKERAGE EXTRACTOR API
 */
app.post('/api/brokerage/extract', requireAdminOrFinance, mutationLimiter, upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = {
    success: true,
    filesProcessed: req.files.length,
    inserted: 0,
    skippedDuplicates: 0,
    rows: [],
    // Per-file outcome so the UI can SHOW what each PDF produced. Previously a
    // file that yielded 0 schemes was indistinguishable from a good one, so
    // missing schemes were only discovered by reading the PDF by hand.
    files: [],
    warnings: []
  };

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    for (const file of req.files) {
      const amcName = detectAmcNameFromFilename(file.originalname);
      let extractedRows = await extractBrokerageRowsFromPdfBuffer(file.buffer, amcName, file.originalname);
      let method = 'text';

      // ── OCR fallback ────────────────────────────────────────────────────
      // Some AMCs publish the brokerage structure as a SCANNED IMAGE (e.g. one
      // Axis PDF carries 2 characters of text in total). Text extraction cannot
      // see anything there and used to return zero schemes silently. If the text
      // pass found nothing and the PDF looks image-based, run OCR instead.
      if (extractedRows.length === 0) {
        try {
          if (await isImageBasedPdf(file.buffer)) {
            console.log(`[extract] ${file.originalname}: no text layer — falling back to OCR`);
            const ocrRows = await extractBrokerageWithOcr(file.buffer, amcName, file.originalname);
            if (ocrRows && ocrRows.length) { extractedRows = ocrRows; method = 'ocr'; }
          }
        } catch (ocrErr) {
          console.warn(`[extract] OCR fallback failed for ${file.originalname}:`, ocrErr.message);
        }
      }

      results.files.push({ file: file.originalname, amc: amcName, schemes: extractedRows.length, method });
      if (extractedRows.length === 0) {
        results.warnings.push(`${file.originalname}: no schemes could be read from this PDF — it may be a scan or an unsupported layout. Nothing was saved for it.`);
      } else if (extractedRows.length < 3) {
        results.warnings.push(`${file.originalname}: only ${extractedRows.length} scheme(s) found — that looks low, please check the PDF before relying on it.`);
      }

      for (const row of extractedRows) {
        const cleanAmc = String(row.amcName || '').trim();
        const cleanScheme = String(row.schemeName || '').trim();
        const cleanPeriod = 'FINAL';
        const id = masterSchemeId(cleanAmc, cleanScheme);

        const data = JSON.stringify({
          category: row.category,
          sourceFile: row.sourceFile,
          rawLine: row.rawLine,
          parserVersion: 'v2'
        });

        // Use REPLACE INTO or INSERT ON DUPLICATE KEY to avoid duplicate schemes with different IDs
        await connection.query(
          `INSERT INTO brokerage_masters (id, amcName, schemeName, category, trailRate, period, data) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE trailRate=VALUES(trailRate), category=VALUES(category), data=VALUES(data)`,
          [id, cleanAmc, cleanScheme, row.category || 'Other', row.trailRate, cleanPeriod, data]
        );

        results.inserted++;
        results.rows.push({ id, ...row });
      }
    }

    await connection.commit();
    res.json(results);
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Extraction Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      detail: 'Extraction or Database error occurred'
    });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * COMPATIBILITY ROUTE for Existing Frontend
 */
app.post('/api/parse-brokerage', requireAdminOrFinance, mutationLimiter, upload.any(), async (req, res) => {
  console.log('[/api/parse-brokerage] Request received...');
  try {
    const files = req.files || [];
    console.log(`[Parser] Received ${files.length} files.`);

    if (files.length === 0) {
      console.warn('[Parser] No files in request body. Check FormData "files" key.');
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const results = [];
    const fileStats = [];
    const warnings = [];

    for (const file of files) {
      console.log(`[Parser] Processing file: ${file.originalname} (${file.size} bytes)`);
      const encrypted = isLikelyEncryptedPdf(file.buffer);
      try {
        let amcName = detectAmcNameFromFilename(file.originalname);

        // Fallback: detect AMC from first page of PDF content when filename gives no hint
        if (!amcName || amcName === 'Unknown AMC' || amcName.length < 3) {
          try {
            const pdfLib = (await import('pdf-parse/lib/pdf-parse.js')).default;
            const pdfData = await pdfLib(file.buffer, { max: 1 });
            const textSample = (pdfData.text || '').replace(/\s+/g, ' ').substring(0, 1000).toUpperCase();
            const DETECT_BRANDS = [
              "ADITYA BIRLA SUN LIFE", "ADITYA BIRLA", "ICICI PRUDENTIAL", "MOTILAL OSWAL",
              "MAHINDRA MANULIFE", "PARAG PARIKH", "BANK OF INDIA", "WHITE OAK",
              "HDFC", "KOTAK", "SBI", "ICICI", "AXIS", "NIPPON", "MIRAE", "TATA",
              "DSP", "UTI", "BANDHAN", "EDELWEISS", "INVESCO", "CANARA", "HSBC",
              "FRANKLIN", "PPFAS", "QUANT", "MOTILAL", "360 ONE", "HELIOS",
              "JM", "LIC MF", "BARODA", "TRUST", "UNION", "PGIM", "MAHINDRA",
              "SAMCO", "GROWW", "NAVI", "SHRIRAM", "ITI MF", "QUANTUM", "NJ", "TAURUS"
            ];
            for (const brand of DETECT_BRANDS) {
              if (textSample.includes(brand)) {
                amcName = canonicalAmcName(brand);
                console.log(`[Parser] AMC detected from PDF content: "${amcName}" for ${file.originalname}`);
                break;
              }
            }
          } catch (_) { /* ignore detection errors, proceed with filename result */ }
        }
        const rows = await withTimeout(
          extractBrokerageRowsFromPdfBuffer(file.buffer, amcName, file.originalname),
          PARSE_FILE_TIMEOUT_MS,
          `Parsing ${file.originalname}`
        );
        console.log(`[Parser] Extracted ${rows.length} rows from ${file.originalname}`);
        results.push(...rows);

        let warning = '';
        if (rows.length === 0) {
          // Check if PDF is image-based (very little text extracted)
          const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
          let textLen = 0;
          try { const d = await pdf(file.buffer); textLen = (d.text || '').trim().length; } catch(_) {}
          if (textLen < 50) {
            // Try OCR fallback for scanned PDFs
            console.log(`[Parser] ${file.originalname} appears to be image-based. Attempting OCR...`);
            try {
              const ocrResult = await withTimeout(
                extractBrokerageWithOcr(file.buffer, amcName, file.originalname),
                120000, // 2 min timeout for OCR
                `OCR for ${file.originalname}`
              );
              if (ocrResult.rows && ocrResult.rows.length > 0) {
                console.log(`[Parser] OCR extracted ${ocrResult.rows.length} rows from ${file.originalname}`);
                results.push(...ocrResult.rows);
                warning = `${file.originalname}: Extracted via OCR (scanned PDF). ${ocrResult.rows.length} rows found.`;
              } else {
                warning = ocrResult.warning || `${file.originalname}: OCR could not extract data from this scanned PDF.`;
              }
            } catch (ocrErr) {
              console.error(`[Parser] OCR failed for ${file.originalname}:`, ocrErr.message);
              warning = `${file.originalname}: Scanned PDF detected. OCR attempt failed: ${ocrErr.message}`;
            }
          } else if (encrypted) {
            warning = `${file.originalname}: encrypted/password-protected PDF (no rows extracted).`;
          } else {
            warning = `${file.originalname}: no scheme/rate rows were detected.`;
          }
          warnings.push(warning);
        }

        // ── Partial-extraction detector ────────────────────────────────────
        // A PDF that yields SOME rows used to be reported as a clean success, so
        // schemes the parser silently dropped were only found by reading the PDF
        // by hand. Re-scan the text for lines that look like "<scheme name> …
        // <rate>" and report any that produced no row, so the missing ones
        // announce themselves instead of having to be reported manually.
        let unparsed = [];
        if (rows.length > 0) {
          try {
            const pdfLib = (await import('pdf-parse/lib/pdf-parse.js')).default;
            const d = await pdfLib(file.buffer);
            const seen = new Set(rows.map(r => String(r.rawLine || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean));
            const schemeWords = /(fund|scheme|plan|yojana|advantage|opportunit|savings|equity|debt|hybrid|liquid|gilt|bond|index|etf)/i;
            for (const raw of String(d.text || '').split('\n')) {
              const line = raw.replace(/\s+/g, ' ').trim();
              if (line.length < 12 || line.length > 200) continue;
              if (!schemeWords.test(line)) continue;                 // must look like a scheme
              if (!/\d\.\d{1,4}\s*%?/.test(line)) continue;          // must carry a rate
              if (/^(sr|s\.no|page|version|total|note|disclaimer|w\.e\.f|terms)/i.test(line)) continue;
              const key = line.toLowerCase();
              if (seen.has(key)) continue;
              if ([...seen].some(s => s.includes(key) || key.includes(s))) continue; // already covered
              unparsed.push(line);
            }
            unparsed = [...new Set(unparsed)].slice(0, 40);
            if (unparsed.length) {
              warnings.push(`${file.originalname}: ${rows.length} scheme(s) captured, but ${unparsed.length} line(s) that look like schemes were NOT parsed — review them below before saving.`);
            }

            // ── Low-yield guard ────────────────────────────────────────────
            // The line-level detector above only sees schemes whose NAME and RATE
            // sit on the SAME line. Some AMCs (e.g. a WhiteOak debt structure) put
            // them on separate lines, so a 4-page document can yield 1 row and look
            // like a clean success. Catch that shape too: a substantial document
            // that produced almost nothing, or a very low hit-rate against the
            // scheme-like lines present. Calibrated on real files — healthy PDFs
            // score 0.37–1.00, the known-broken one 0.13.
            const allLines = String(d.text || '').split('\n')
              .map(s => s.replace(/\s+/g, ' ').trim())
              .filter(l => l.length > 10 && l.length < 200);
            const schemeLines = allLines.filter(l => schemeWords.test(l)).length;
            const textLen = String(d.text || '').length;
            const ratio = schemeLines > 0 ? rows.length / schemeLines : 1;
            if ((rows.length < 5 && textLen > 3000) || (schemeLines >= 10 && ratio < 0.25)) {
              warnings.push(`${file.originalname}: only ${rows.length} scheme(s) extracted from a ${Math.round(textLen / 1000)}k-character document containing ~${schemeLines} scheme-like lines. This layout is probably not being read correctly — verify against the PDF before relying on it.`);
            }
          } catch (_) { /* detector is advisory only — never block the parse */ }
        }

        fileStats.push({
          fileName: file.originalname,
          extractedRows: rows.length,
          encrypted,
          warning,
          unparsed
        });
      } catch (innerError) {
        const warning = `${file.originalname}: parse failed (${innerError.message})`;
        warnings.push(warning);
        fileStats.push({
          fileName: file.originalname,
          extractedRows: 0,
          encrypted,
          warning
        });
        console.error(`[Parser ERROR] Failed to process ${file.originalname}:`, innerError.message);
      }
    }

    // Use stable IDs based on AMC | Scheme | Period and deduplicate preview rows.
    const dedup = new Map();
    for (const r of results) {
      const stableId = `${String(r.amcName).trim()}|${String(r.schemeName).trim()}|FINAL`.toLowerCase();
      if (!dedup.has(stableId)) dedup.set(stableId, { id: stableId, ...r });
    }
    const rowsWithIds = Array.from(dedup.values());

    console.log(`[Parser] Sending back ${rowsWithIds.length} total rows.`);
    if (rowsWithIds.length === 0) {
      return res.json({
        success: false,
        error: 'No brokerage rows could be extracted from uploaded PDF(s).',
        warnings,
        fileStats
      });
    }

    res.json({
      success: true,
      extracted: rowsWithIds,
      message: `Extracted ${rowsWithIds.length} rows successfully`,
      warnings,
      fileStats
    });
  } catch (error) {
    console.error('[Legacy API CRITICAL ERROR]:', error);
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/brokerage/list', async (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brokerage/export.csv', async (req, res) => {
  try {
    const { amcName, month, year, period, latestOnly, search } = req.query;
    let query = 'SELECT * FROM brokerage_masters WHERE 1=1';
    let params = [];

    if (amcName && amcName !== 'ALL') {
      query += ' AND amcName = ?';
      params.push(amcName);
    }

    if (period) {
      query += ' AND period = ?';
      params.push(period);
    } else {
      if (month && month !== 'ALL') {
        query += ' AND period LIKE ?';
        params.push(`%-${month}`);
      }
      if (year && year !== 'ALL') {
        query += ' AND period LIKE ?';
        params.push(`${year}-%`);
      }
    }

    query += ' ORDER BY amcName ASC, schemeName ASC';
    let [rows] = await pool.query(query, params);

    // The export used to dump every row in the table while the page itself showed
    // only the current rate per scheme, so a scheme re-rated across months came out
    // once per month — 3,986 rows exported against 1,857 real schemes. The screen's
    // two remaining filters are applied here too, so what you see is what you get.
    if (search) {
      const q = String(search).toLowerCase();
      rows = rows.filter(r => String(r.amcName || '').toLowerCase().includes(q)
                           || String(r.schemeName || '').toLowerCase().includes(q));
    }
    if (latestOnly === '1' || latestOnly === 'true') {
      // The SAME key the rows are stored under, so the export can never split one
      // scheme into two lines because two cards spelled its type differently.
      const newest = new Map();
      for (const r of rows) {
        const key = masterSchemeId(r.amcName, r.schemeName);
        const prev = newest.get(key);
        // Newest period wins; on a tie keep the fuller name, which is the one that
        // actually spells the scheme out.
        const better = !prev
          || String(r.period || '') > String(prev.period || '')
          || (String(r.period || '') === String(prev.period || '')
              && String(r.schemeName || '').length > String(prev.schemeName || '').length);
        if (better) newest.set(key, r);
      }
      rows = Array.from(newest.values()).sort((a, b) =>
        String(a.amcName || '').localeCompare(String(b.amcName || ''))
        || String(a.schemeName || '').localeCompare(String(b.schemeName || '')));
    }

    // A scheme name carrying a comma or a quote used to break the row apart in
    // Excel, because the value was only wrapped, never escaped.
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let csv = 'AMC,Category,Scheme Name,Brokerage Rate (%),Period,Source File,Created At\n';
    rows.forEach(row => {
      let meta = {};
      try { meta = JSON.parse(row.data || '{}'); } catch (_) {}
      csv += [
        cell(row.amcName), cell(meta.category || ''), cell(row.schemeName),
        row.trailRate, cell(row.period || ''), cell(meta.sourceFile || ''), cell(row.createdAt),
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=brokerage_export.csv');
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/brokerage/reset', requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM brokerage_masters');
    console.log(`🧹 [Master Reset] Cleared ${result.affectedRows} master schemes (by admin=${req.user.id}).`);
    res.json({ success: true, message: `All ${result.affectedRows} brokerage data records were reset.` });
  } catch (error) {
    console.error('❌ [Master Reset Failed]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Paginated Transactions API ---
app.get('/api/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const sortBy = req.query.sortBy || 'transactionDate';
    const sortOrder = (req.query.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const batchId = req.query.batchId || '';

    // Whitelist sortable columns
    const sortableColumns = ['transactionDate', 'investorName', 'amcName', 'schemeName', 'grossAmount', 'createdAt'];
    const safeSort = sortableColumns.includes(sortBy) ? sortBy : 'transactionDate';

    let whereClause = '';
    const params = [];

    if (batchId) {
      whereClause += ' WHERE batchId = ?';
      params.push(batchId);
    }

    if (search) {
      whereClause += (whereClause ? ' AND' : ' WHERE') + ' (investorName LIKE ? OR amcName LIKE ? OR schemeName LIKE ? OR pan LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    // Get total count
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM transactions${whereClause}`, params);
    const total = countRows[0].total;

    // Get paginated data
    const dataParams = [...params, limit, offset];
    const [rows] = await pool.query(
      `SELECT * FROM transactions${whereClause} ORDER BY ${safeSort} ${sortOrder} LIMIT ? OFFSET ?`,
      dataParams
    );

    const parsedData = rows.map(row => {
      const item = { ...row };
      if (row.batchid !== undefined) { item.batchId = row.batchid; delete item.batchid; }
      if (row.investorname !== undefined) { item.investorName = row.investorname; delete item.investorname; }
      if (row.transactiondate !== undefined) { item.transactionDate = row.transactiondate; delete item.transactiondate; }
      if (row.amcname !== undefined) { item.amcName = row.amcname; delete item.amcname; }
      if (row.schemename !== undefined) { item.schemeName = row.schemename; delete item.schemename; }
      if (row.grossamount !== undefined) { item.grossAmount = row.grossamount; delete item.grossamount; }
      if (row.data) {
        try { Object.assign(item, JSON.parse(row.data)); } catch (e) { }
        delete item.data;
      }
      return item;
    });

    res.json({
      data: parsedData,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    console.error('❌ [Paginated Transactions Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server immediately to satisfy hosting health checks
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 My Earnings (Node.js) running on port ${PORT}`);
  console.log(`🔗 Local Address: http://localhost:${PORT}`);

  // Initialize DB in the background
  initDB()
    .then(() => console.log('✅ Database Initialization Complete'))
    .catch(err => console.error('⚠️ Database Initialization FAILED:', err.message));

  // ── In-app daily backup safety net ───────────────────────────────────────
  // Hostinger shared hosting has no shell crontab, so we self-schedule: every 6h
  // check whether today's daily dump exists; if not, run the backup script. This
  // guarantees backups while the app is alive even before a hPanel cron is set.
  try {
    const { exec } = require('child_process');
    const fs = require('fs');
    const HOME = process.env.HOME || process.env.HOMEPATH || '';
    const BK = `${HOME}/backups`;
    const runBackupIfNeeded = () => {
      try {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const has = fs.existsSync(BK) && fs.readdirSync(BK).some(f => f.startsWith(`nflx_daily_${today}`));
        if (has) return;
        exec(`/bin/bash ${HOME}/backup_db.sh daily`, { timeout: 300000 }, (e, so, se) => {
          if (e) console.warn('[backup] auto-backup failed:', e.message);
          else console.log('[backup] auto daily backup done');
        });
      } catch (e) { console.warn('[backup] scheduler error:', e.message); }
    };
    setTimeout(runBackupIfNeeded, 60_000);          // once, a minute after boot
    setInterval(runBackupIfNeeded, 6 * 60 * 60 * 1000); // then every 6h
  } catch (e) { console.warn('[backup] scheduler init failed:', e.message); }
});

// --- Graceful shutdown ---
const shutdown = async (signal) => {
  console.log(`\n📦 [${signal}] Graceful shutdown initiated...`);
  server.close(async () => {
    console.log('   → HTTP server closed.');
    try {
      await pool.end();
      console.log('   → Database pool drained.');
    } catch (e) {
      console.error('   → Pool drain error:', e.message);
    }
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => {
    console.error('   → Forced exit after 10s timeout.');
    process.exit(1);
  }, 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Serve Frontend (at the end so api routes take precedence)
const staticPath = path.join(__dirname, 'public');
if (fs.existsSync(staticPath)) {
  app.use(express.static(staticPath, {
    etag: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  }));
  app.get('*', (req, res) => {
    const indexPath = path.join(staticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Frontend Assets Missing (index.html not found in public)');
    }
  });
} else {
  // Graceful fallback if public is missing
  app.get('/', (req, res) => res.json({ status: 'API Only', info: 'Frontend folder (public) not found.' }));
}
