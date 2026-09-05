/* ============================================================================
 *  ⚠️  RETIRED — DO NOT EDIT, DO NOT DEPLOY.
 *
 *  Production runs `server.js` (verified: public_html/.htaccess →
 *  PassengerStartupFile server.js). This legacy backend is kept only for
 *  historical reference. It is missing the hardened auth, the FINANCE role,
 *  the server-side payout recompute engine, team_payouts and map_rm_folios.
 *  Any change made here has ZERO effect in production.
 *
 *  ➜  Make all backend changes in `server.js`.
 * ========================================================================== */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pool from './src/lib/db.js';
import { sendEmail } from './src/lib/emailService.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { extractBrokerageWithOcr } from './src/lib/ocrExtractor.js';
import authRouter from './src/routes/auth.js';

process.on('uncaughtException', (err) => {
  console.error('🔥 [CRITICAL] Uncaught Exception:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
import multer from 'multer';
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
if (!JWT_SECRET) {
  console.error('❌ [FATAL] JWT_SECRET environment variable is not set. Set it in your .env file before starting the server.');
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
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000'];

// CORS Configuration - Allow localhost for development
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, etc.)
    if (!origin) return callback(null, true);

    // Allow all localhost/127.0.0.1 origins for development
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      return callback(null, true);
    }

    // Check against whitelist
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`🛑 [CORS BLOCKED] Origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

// Apply CORS only to API routes, not static files
app.use('/api', cors(corsOptions));

// --- Security Headers (helmet-lite) ---
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(express.json({ limit: '50mb' }));

// --- Serve Frontend Static Assets early ---
const staticPath = path.join(__dirname, 'public');
if (fs.existsSync(staticPath)) {
  console.log('📂 [Setup] Serving static files from:', staticPath);
  app.use(express.static(staticPath, {
    etag: true,
    setHeaders: (res, filePath) => {
      // Hashed bundles in /assets/ are content-addressed — cache forever.
      // index.html holds the bundle-hash pointer — never cache; browser must revalidate.
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  }));
}

// --- Rate Limiter for Login ---
const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Too many login attempts. Please try again after 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Rate Limiter for File Upload / Data Export ---
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: { error: 'Too many upload/export requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- JWT Auth Middleware ---
const authMiddleware = (req, res, next) => {
  // Skip auth for health check, ping, static files, and PDF extraction (for local debug)
  const exemptPaths = ['/api/health', '/api/ping', '/test-extractor'];
  if (exemptPaths.includes(req.path)) return next();
  if (!req.path.startsWith('/api/')) return next();

  // Allow login POST through
  if (req.method === 'POST' && req.path === '/api/data') {
    const { action } = req.body || {};
    if (action === 'auth') return next();
  }

  // Allow OTP endpoints without auth (public password reset flow)
  if (req.path.startsWith('/api/auth/')) return next();

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
    console.warn(`🛑 [AUTH] Invalid token for ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

app.use(authMiddleware);
app.use('/api/auth', authRouter);

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
      configStatus: {
        db_host: !!process.env.DB_HOST,
        db_user: !!process.env.DB_USER,
        db_pass: !!process.env.DB_PASSWORD,
        db_name: !!process.env.DB_NAME,
        jwt_secret: !!process.env.JWT_SECRET
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      database: 'disconnected',
      error: err.message,
      errorCode: err.code,
      hint: 'Verify DB_HOST and ensure Hostinger allows remote connections if not local.'
    });
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
    "CREATE TABLE IF NOT EXISTS transactions (id VARCHAR(100) PRIMARY KEY, batchId VARCHAR(100), pan VARCHAR(50), investorName VARCHAR(255), transactionDate DATE, amcName VARCHAR(255), schemeName VARCHAR(255), grossAmount DECIMAL(15,2), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_batch (batchId), INDEX idx_pan (pan))",
    "CREATE TABLE IF NOT EXISTS batches (id VARCHAR(100) PRIMARY KEY, fileName VARCHAR(255), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS amc_mappings (original VARCHAR(255) PRIMARY KEY, standard VARCHAR(255))",
    "CREATE TABLE IF NOT EXISTS scheme_mappings (original VARCHAR(255) PRIMARY KEY, standard VARCHAR(255))",
    "CREATE TABLE IF NOT EXISTS config (id VARCHAR(100) PRIMARY KEY, data LONGTEXT)",
    "CREATE TABLE IF NOT EXISTS invoices (id VARCHAR(100) PRIMARY KEY, userId VARCHAR(100), month VARCHAR(20), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_user (userId))",
    "CREATE TABLE IF NOT EXISTS activity_log (id INT AUTO_INCREMENT PRIMARY KEY, userId VARCHAR(100), userName VARCHAR(255), action VARCHAR(255), description TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_user (userId))",
    "CREATE TABLE IF NOT EXISTS payout_ledger (transactionId VARCHAR(100), userId VARCHAR(100), amount DECIMAL(15,4), level INT, UNIQUE KEY unq_tx_user (transactionId, userId), INDEX idx_user (userId))",
    "CREATE TABLE IF NOT EXISTS brokerage_masters (id VARCHAR(100) PRIMARY KEY, amcName VARCHAR(255), schemeName VARCHAR(255), category VARCHAR(100), trailRate DECIMAL(10,4), period VARCHAR(50), data LONGTEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_amc (amcName))",
    "CREATE TABLE IF NOT EXISTS brokerage_rate_history (id VARCHAR(100) PRIMARY KEY, masterId VARCHAR(100) NOT NULL, amcName VARCHAR(255), schemeName VARCHAR(255), oldRate DECIMAL(10,4), newRate DECIMAL(10,4), changedBy VARCHAR(100), changedByName VARCHAR(255), changedAt DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_brh_master (masterId), INDEX idx_brh_amc (amcName))"
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
    { table: 'brokerage_masters', column: 'period', type: 'VARCHAR(50)' }
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
    { table: 'transactions', name: 'idx_tx_amc', col: 'amcName' },
    { table: 'clients', name: 'idx_pan', col: 'pan' },
    { table: 'clients', name: 'idx_client_name', col: 'name' },
    { table: 'team', name: 'idx_email', col: 'email' },
    { table: 'team', name: 'idx_team_role', col: 'role' },
    { table: 'team', name: 'idx_team_level', col: 'level' },
    { table: 'activity_log', name: 'idx_log_created', col: 'createdAt' },
    { table: 'brokerage_masters', name: 'idx_bm_scheme', col: 'schemeName' },
    { table: 'brokerage_masters', name: 'idx_bm_period', col: 'period' },
    { table: 'invoices', name: 'idx_inv_user_month', col: 'userId, month' },
  ];
  for (const idx of indexes) {
    try {
      await pool.query(`ALTER TABLE ${idx.table} ADD INDEX ${idx.name} (${idx.col})`);
      console.log(`✅ [Index] Added ${idx.name} on ${idx.table}.(${idx.col})`);
    } catch (e) { /* Index likely exists */ }
  }

  // Composite index for activity_log (userId, createdAt)
  try {
    await pool.query(`ALTER TABLE activity_log ADD INDEX idx_log_user_date (userId, createdAt)`);
  } catch (e) { /* exists */ }

  // Composite index for brokerage_masters (amcName, schemeName)
  try {
    await pool.query(`ALTER TABLE brokerage_masters ADD INDEX idx_bm_amc_scheme (amcName, schemeName)`);
  } catch (e) { /* exists */ }

  // ADD UNIQUE CONSTRAINT on payout_ledger to prevent duplicates (Priority 1 Fix)
  try {
    await pool.query(`ALTER TABLE payout_ledger ADD UNIQUE KEY unq_tx_user (transactionId, userId)`);
    console.log(`✅ [Constraint] Added unique constraint unq_tx_user on payout_ledger`);
  } catch (e) {
    // Constraint might already exist or there might be duplicate data
    if (e.code === 'ER_DUP_KEYNAME') {
      // Constraint already exists - this is fine
    } else if (e.code === 'ER_DUP_ENTRY') {
      console.warn(`⚠️ [Constraint] Cannot add unique constraint - duplicate entries exist in payout_ledger. Run cleanup first.`);
    }
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

console.log('--- ENV DEBUG ---');
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('------------------');

// initDB(); // Moved to app.listen

// SUMMARY ENDPOINT — fast server-side aggregation for instant dashboard display
app.get('/api/summary', async (req, res) => {
  try {
    const [[totals]] = await pool.query(
      'SELECT COUNT(*) as totalTx, COALESCE(SUM(grossAmount), 0) as totalGross FROM transactions'
    );
    const [[userPayout]] = await pool.query(
      'SELECT COALESCE(SUM(amount), 0) as myTotal FROM payout_ledger WHERE userId = ?',
      [req.user.id]
    );
    const [[clientCount]] = await pool.query('SELECT COUNT(*) as cnt FROM clients');
    const [monthly] = await pool.query(
      `SELECT DATE_FORMAT(transactionDate, '%Y-%m') as month,
              COALESCE(SUM(grossAmount), 0) as gross,
              COUNT(*) as cnt
       FROM transactions
       GROUP BY month
       ORDER BY month`
    );
    res.json({
      totalTx: Number(totals.totalTx),
      totalGross: Number(totals.totalGross),
      myTotal: Number(userPayout.myTotal),
      clientCount: Number(clientCount.cnt),
      monthly: monthly.map(r => ({ month: r.month, gross: Number(r.gross), cnt: Number(r.cnt) }))
    });
  } catch (e) {
    console.error('[Summary] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


app.all('/api/data', async (req, res) => {
  const { method, body, query } = req;

  try {
    if (method === 'GET') {
      const { type, action, id } = query;

      if (action === 'summary') {
        const [[totals]] = await pool.query('SELECT COUNT(*) as totalTx, COALESCE(SUM(grossAmount), 0) as totalGross FROM transactions');
        const [[userPayout]] = await pool.query('SELECT COALESCE(SUM(amount), 0) as myTotal FROM payout_ledger WHERE userId = ?', [req.user?.id]);
        const [[clientCount]] = await pool.query('SELECT COUNT(*) as cnt FROM clients');
        const [monthly] = await pool.query("SELECT DATE_FORMAT(transactionDate, '%Y-%m') as month, COALESCE(SUM(grossAmount),0) as gross, COUNT(*) as cnt FROM transactions GROUP BY month ORDER BY month");
        return res.json({
          totalTx: Number(totals.totalTx),
          totalGross: Number(totals.totalGross),
          myTotal: Number(userPayout.myTotal),
          clientCount: Number(clientCount.cnt),
          monthly: monthly.map(r => ({ month: r.month, gross: Number(r.gross), cnt: Number(r.cnt) }))
        });
      }

      if (action === 'reset_db_confirm') {
        if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
        for (const t of ['clients', 'team', 'transactions', 'batches', 'amc_mappings', 'scheme_mappings', 'config', 'invoices', 'activity_log', 'payout_ledger']) {
          await pool.query(`TRUNCATE TABLE ${t}`);
        }
        await initDB();
        return res.json({ success: true, message: 'Database reset complete' });
      }

      if (!type || !VALID_TABLES.includes(type)) return res.status(400).json({ error: 'Invalid table type' });

      let sqlQuery = `SELECT * FROM ${type}`;
      if (type === 'transactions') sqlQuery += ' ORDER BY transactionDate DESC LIMIT 100000';
      const [rows] = await pool.query(sqlQuery);
      const parsedData = rows.map(row => {
        const item = { ...row };

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
        if (type === 'team') delete item.password;
        return item;
      });
      return res.json(parsedData);
    }

    if (method === 'POST') {
      const { action, userId, userName, activityAction, description, identifier, password, collection, payload } = body;

      // Bulk Deletion
      if (action === 'bulk_delete' && collection && payload) {
        if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
        if (!VALID_TABLES.includes(collection)) {
          console.warn(`❌ [Bulk Delete] Rejected invalid table: ${collection}`);
          return res.status(400).json({ error: `Invalid table: ${collection}` });
        }

        const type = collection;
        const ids = Array.isArray(payload) ? payload : [payload];
        if (ids.length === 0) return res.json({ success: true, count: 0 });

        console.log(`🗑️ [Bulk Delete Request] Table: ${type}, IDs: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '...' : ''} (Total: ${ids.length})`);

        try {
          const idCol = ['amc_mappings', 'scheme_mappings'].includes(type) ? 'original' : 'id';

          if (type === 'transactions') {
            await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (?)', [ids]);
          }

          // Use the internal row count to be sure
          const [result] = await pool.query(`DELETE FROM ${type} WHERE ${idCol} IN (?)`, [ids]);
          const affected = result.affectedRows || 0;

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
        try {
          const [rows] = await withTimeout(
            pool.query('SELECT * FROM team WHERE (email = ? OR code = ?)', [identifier, identifier]),
            AUTH_TIMEOUT_MS,
            'Authentication query'
          );
          if (rows.length > 0) {
            const dbUser = rows[0];
            let passwordMatch = false;

            if (dbUser.password && (dbUser.password.startsWith('$2b$') || dbUser.password.startsWith('$2a$'))) {
              passwordMatch = await bcrypt.compare(password, dbUser.password);
            } else {
              passwordMatch = (dbUser.password === password);
              if (passwordMatch) {
                const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
                await pool.query('UPDATE team SET password = ? WHERE id = ?', [hashed, dbUser.id]);
              }
            }

            if (passwordMatch) {
              const user = { ...dbUser };
              if (user.data) Object.assign(user, JSON.parse(user.data));
              delete user.data;
              delete user.password;

              const token = jwt.sign(
                { id: user.id, role: user.role, level: user.level },
                JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
              );

              return res.json({ success: true, user, token });
            }
          }
        } catch (dbErr) {
          if (dbErr.code === 'ECONNREFUSED' || dbErr.message.includes('timeout') || dbErr.message.includes('ECONNREFUSED')) {
            return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.', code: 'DATABASE_OFFLINE' });
          }
          throw dbErr;
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Bulk Data Persistence
      if (!collection || !VALID_TABLES.includes(collection)) return res.status(400).json({ error: 'Invalid collection' });
      const items = Array.isArray(payload) ? payload : [payload];

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

              if (finalPassword) {
                // Password provided — full upsert including password
                await connection.query(
                  `INSERT INTO team (id, parentId, name, code, role, level, email, password, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE parentId=VALUES(parentId), name=VALUES(name), code=VALUES(code), role=VALUES(role), level=VALUES(level), email=VALUES(email), password=VALUES(password), data=VALUES(data)`,
                  [id, parentId, name, code, role, level, email, finalPassword, JSON.stringify(rest)]
                );
              } else {
                // No password in payload (frontend strips it) — never overwrite existing password
                await connection.query(
                  `INSERT INTO team (id, parentId, name, code, role, level, email, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE parentId=VALUES(parentId), name=VALUES(name), code=VALUES(code), role=VALUES(role), level=VALUES(level), email=VALUES(email), data=VALUES(data)`,
                  [id, parentId, name, code, role, level, email, JSON.stringify(rest)]
                );
              }
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

              // Clean rest
              ['batchid', 'batchId', 'investorname', 'investorName', 'transactiondate', 'transactionDate', 'amcname', 'amcName', 'schemename', 'schemeName', 'grossamount', 'grossAmount'].forEach(k => delete rest[k]);

              return [id, batchId, pan, investorName, transactionDate, amcName, schemeName, grossAmount, JSON.stringify(rest)];
            });

            await connection.query(
              `INSERT INTO transactions (id, batchId, pan, investorName, transactionDate, amcName, schemeName, grossAmount, data) VALUES ? 
               ON DUPLICATE KEY UPDATE batchId=VALUES(batchId), pan=VALUES(pan), investorName=VALUES(investorName), transactionDate=VALUES(transactionDate), amcName=VALUES(amcName), schemeName=VALUES(schemeName), grossAmount=VALUES(grossAmount), data=VALUES(data)`,
              [values]
            );

            // Bulk Handle payout ledger
            const ledgerDeletes = [];
            const ledgerInserts = [];
            for (const item of items) {
              if (item.breakdown?.userPayouts) {
                ledgerDeletes.push(item.id);
                for (const [uid, amt] of Object.entries(item.breakdown.userPayouts)) {
                  ledgerInserts.push([item.id, uid, amt, 0]);
                }
              }
            }

            if (ledgerDeletes.length > 0) {
              await connection.query('DELETE FROM payout_ledger WHERE transactionId IN (?)', [ledgerDeletes]);
            }
            if (ledgerInserts.length > 0) {
              await connection.query('INSERT INTO payout_ledger (transactionId, userId, amount, level) VALUES ?', [ledgerInserts]);
            }
          } else if (['amc_mappings', 'scheme_mappings'].includes(collection)) {
            const values = items.map(item => [item.original, item.standard]);
            await connection.query(`INSERT INTO ${collection} (original, standard) VALUES ? ON DUPLICATE KEY UPDATE standard=VALUES(standard)`, [values]);
          } else if (collection === 'invoices') {
            for (const item of items) {
              const { id, userid, userId = userid || '', month = '', ...rest } = item;
              delete rest.userid;
              delete rest.userId;

              // Detect status change for email notifications
              const newStatus = rest.status;
              if (newStatus) {
                const [existing] = await connection.query('SELECT data FROM invoices WHERE id = ?', [id]);
                const oldStatus = existing[0] ? JSON.parse(existing[0].data || '{}').status : null;
                if (oldStatus && oldStatus !== newStatus) {
                  const invoiceName = rest.invoiceNo || id;
                  const ownerEmail = rest.distributor?.email || null;
                  if (newStatus === 'PAID' && ownerEmail) {
                    sendEmail({ to: ownerEmail, subject: `Invoice ${invoiceName} has been settled`, html: `<p>Your invoice <strong>${invoiceName}</strong> for period <strong>${month}</strong> has been marked as <strong>PAID</strong>.</p>` });
                  } else if (newStatus === 'REJECTED' && ownerEmail) {
                    sendEmail({ to: ownerEmail, subject: `Invoice ${invoiceName} requires attention`, html: `<p>Your invoice <strong>${invoiceName}</strong> has been <strong>REJECTED</strong> and requires attention. Please contact your admin.</p>` });
                  } else if (newStatus === 'SUBMITTED') {
                    const [adminRows] = await connection.query(`SELECT email, name FROM team WHERE role = 'ADMIN' AND email IS NOT NULL AND email != ''`);
                    const adminEmails = adminRows.map(r => r.email).filter(Boolean);
                    if (adminEmails.length) {
                      const submitterName = rest.distributor?.name || userId;
                      sendEmail({ to: adminEmails, subject: `New invoice from ${submitterName} – ${month}`, html: `<p><strong>${submitterName}</strong> has submitted invoice <strong>${invoiceName}</strong> for period <strong>${month}</strong>. Please review it in the system.</p>` });
                    }
                  }
                }
              }

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

              const cleanAmc = String(amcName).trim();
              const cleanScheme = String(schemeName).trim();
              const cleanPeriod = String(period).trim();

              const safeTrailRate = Number(trailRate) || 0;
              const safeId = id || `${cleanAmc}|${cleanScheme}|${cleanPeriod}`.toLowerCase();

              // Clean rest
              ['amcname', 'amcName', 'schemename', 'schemeName', 'category', 'trailrate', 'trailRate', 'period'].forEach(k => delete rest[k]);

              return [safeId, cleanAmc, cleanScheme, category, safeTrailRate, cleanPeriod, JSON.stringify(rest)];
            });

            // Save rate history before upsert (detect rate changes)
            for (const [safeId, cleanAmc, cleanScheme, , safeTrailRate] of values) {
              const [existing] = await connection.query('SELECT trailRate, amcName, schemeName FROM brokerage_masters WHERE id = ?', [safeId]);
              if (existing[0] && Number(existing[0].trailRate) !== Number(safeTrailRate)) {
                const histId = `${safeId}_${Date.now()}`;
                await connection.query(
                  'INSERT INTO brokerage_rate_history (id, masterId, amcName, schemeName, oldRate, newRate, changedBy, changedByName) VALUES (?,?,?,?,?,?,?,?)',
                  [histId, safeId, cleanAmc, cleanScheme, existing[0].trailRate, safeTrailRate, req.user?.id || 'system', req.user?.name || 'System']
                );
              }
            }

            await connection.query(
              `INSERT INTO brokerage_masters (id, amcName, schemeName, category, trailRate, period, data) VALUES ?
               ON DUPLICATE KEY UPDATE amcName=VALUES(amcName), schemeName=VALUES(schemeName), category=VALUES(category), trailRate=VALUES(trailRate), period=VALUES(period), data=VALUES(data)`,
              [values]
            );
          } else {
            for (const item of items) {
              const { id, ...rest } = item;
              const table = collection; // VALID_TABLES check ensures this is safe
              await connection.query(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)`, [id, JSON.stringify(rest)]);
            }
          }
        }

        await connection.commit();
        res.json({ success: true });
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
      if (action === 'undo_import' && id) {
        await pool.query('DELETE FROM batches WHERE id = ?', [id]);
        await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (SELECT id FROM transactions WHERE batchId = ?)', [id]);
        await pool.query('DELETE FROM transactions WHERE batchId = ?', [id]);
        return res.json({ success: true });
      }
      if (type && id) {
        const idCol = ['amc_mappings', 'scheme_mappings'].includes(type) ? 'original' : 'id';
        const ids = id.includes('|') ? [id] : id.split(',');
        if (type === 'transactions') await pool.query('DELETE FROM payout_ledger WHERE transactionId IN (?)', [ids]);
        const [resDel] = await pool.query(`DELETE FROM ${type} WHERE ${idCol} IN (?)`, [ids]);
        console.log(`🗑️ [Single Delete] Table: ${type}, Rows: ${resDel.affectedRows}, Result: Success`);
        return res.json({ success: true });
      }
    }

    res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
      console.warn(`[Graceful Degradation] DB Offline for ${req.method} ${req.url}`);
      if (method === 'GET') return res.json([]);
      return res.json({ success: false, error: 'Offline Mode: Database not connected.' });
    }
    console.error(`[API Error] ${req.method} ${req.url}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Initial Health Check Route for root
app.get('/api/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/test', (req, res) => res.json({ message: 'API is responding safely' }));
app.get('/api/version', (req, res) => res.json({ version: '1.3.0-enhanced', time: new Date().toISOString() }));

/**
 * POST /api/calculations/verify
 * Verifies calculation accuracy for a single transaction or batch
 */
app.post('/api/calculations/verify', async (req, res) => {
  try {
    const { transactionId, recalculate = false } = req.body;

    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required' });
    }

    // Fetch transaction
    const [txRows] = await pool.query('SELECT * FROM transactions WHERE id = ?', [transactionId]);
    if (txRows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const tx = txRows[0];
    const txData = tx.data ? JSON.parse(tx.data) : {};
    const breakdown = txData.breakdown;

    if (!breakdown) {
      return res.json({
        success: false,
        message: 'Transaction has no breakdown calculated',
        transactionId: tx.id
      });
    }

    // Validate the existing breakdown
    const totalDistributed = Object.values(breakdown.levelPayouts || {}).reduce((sum, val) => sum + val, 0);
    const variance = Math.abs(breakdown.netPool - totalDistributed);

    const validation = {
      isValid: variance <= 0.01,
      netPool: breakdown.netPool,
      totalDistributed,
      variance,
      grossAmount: tx.grossAmount || txData.grossAmount,
      expenseAmount: breakdown.expenseAmount
    };

    if (recalculate) {
      // Fetch client and config to recalculate
      const [clientRows] = await pool.query('SELECT * FROM clients WHERE id = ?', [tx.mappedClientId || txData.mappedClientId]);
      const [configRows] = await pool.query('SELECT * FROM config WHERE id = ?', ['global_config']);

      if (clientRows.length > 0 && configRows.length > 0) {
        // Note: Full recalculation would require the calculation service
        // For now, just return validation status
        validation.recalculationAvailable = true;
      }
    }

    res.json({
      success: true,
      transactionId: tx.id,
      validation
    });
  } catch (error) {
    console.error('[Verify Calculation Error]', error);
    res.status(500).json({ error: 'Verification failed', message: error.message });
  }
});

/**
 * GET /api/calculations/reconciliation
 * Generates a reconciliation report for all transactions or filtered set
 */
app.get('/api/calculations/reconciliation', async (req, res) => {
  try {
    const { month, year } = req.query;

    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (month && year) {
      query += ' AND (brokeragePeriod = ? OR DATE_FORMAT(transactionDate, "%Y-%m") = ?)';
      const period = `${year}-${month.padStart(2, '0')}`;
      params.push(period, period);
    }

    const [rows] = await pool.query(query, params);

    let validCount = 0;
    let invalidCount = 0;
    let totalGross = 0;
    let totalNetPool = 0;
    let totalDistributed = 0;
    let totalVariance = 0;
    const errors = [];

    rows.forEach(row => {
      const data = row.data ? JSON.parse(row.data) : {};
      const breakdown = data.breakdown;
      const grossAmount = row.grossAmount || data.grossAmount || 0;

      totalGross += grossAmount;

      if (!breakdown) {
        invalidCount++;
        errors.push({ transactionId: row.id, error: 'No breakdown available' });
        return;
      }

      const netPool = breakdown.netPool || 0;
      const distributed = Object.values(breakdown.levelPayouts || {}).reduce((sum, val) => sum + val, 0);
      const variance = Math.abs(netPool - distributed);

      totalNetPool += netPool;
      totalDistributed += distributed;
      totalVariance += variance;

      if (variance <= 0.01) {
        validCount++;
      } else {
        invalidCount++;
        errors.push({
          transactionId: row.id,
          error: `Variance ${variance.toFixed(4)}`,
          netPool,
          distributed
        });
      }
    });

    res.json({
      success: true,
      report: {
        totalTransactions: rows.length,
        validTransactions: validCount,
        invalidTransactions: invalidCount,
        totalGross: Math.round(totalGross * 100) / 100,
        totalNetPool: Math.round(totalNetPool * 100) / 100,
        totalDistributed: Math.round(totalDistributed * 100) / 100,
        systemVariance: Math.round(totalVariance * 100) / 100,
        errors: errors.slice(0, 100) // Limit to first 100 errors
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Reconciliation Error]', error);
    res.status(500).json({ error: 'Reconciliation failed', message: error.message });
  }
});

/**
 * POST /api/calculations/cleanup-duplicates
 * Removes duplicate payout ledger entries (admin only)
 */
app.post('/api/calculations/cleanup-duplicates', async (req, res) => {
  try {
    // Find and remove duplicate entries, keeping the first one
    const [duplicates] = await pool.query(`
      SELECT transactionId, userId, COUNT(*) as count
      FROM payout_ledger
      GROUP BY transactionId, userId
      HAVING count > 1
    `);

    if (duplicates.length === 0) {
      return res.json({ success: true, message: 'No duplicates found', cleaned: 0 });
    }

    let cleaned = 0;
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      for (const dup of duplicates) {
        // Delete all but keep one
        await connection.query(
          `DELETE FROM payout_ledger WHERE transactionId = ? AND userId = ? LIMIT ?`,
          [dup.transactionId, dup.userId, dup.count - 1]
        );
        cleaned += (dup.count - 1);
      }

      await connection.commit();
      console.log(`✅ [Cleanup] Removed ${cleaned} duplicate payout ledger entries`);

      res.json({
        success: true,
        message: `Cleaned up ${cleaned} duplicate entries`,
        cleaned,
        duplicateGroups: duplicates.length
      });
    } catch (e) {
      await connection.rollback();
      throw e;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[Cleanup Error]', error);
    res.status(500).json({ error: 'Cleanup failed', message: error.message });
  }
});

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

/**
 * NEW: AMC BROKERAGE EXTRACTOR API
 */
app.post('/api/brokerage/extract', uploadLimiter, upload.array('files'), async (req, res) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = {
    success: true,
    filesProcessed: req.files.length,
    inserted: 0,
    skippedDuplicates: 0,
    rows: []
  };

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
        const cleanPeriod = 'FINAL';
        const id = `${cleanAmc}|${cleanScheme}|${cleanPeriod}`.toLowerCase();

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
app.post('/api/parse-brokerage', uploadLimiter, upload.any(), async (req, res) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
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
      console.log(`🔍 [Parser] Starting file: ${file.originalname} (${(file.size/1024).toFixed(1)} KB)`);
      const encrypted = isLikelyEncryptedPdf(file.buffer);
      if (encrypted) console.warn(`🔒 [Parser] ${file.originalname} appears to be password-protected.`);

      let warning = '';
      try {
        const amcName = detectAmcNameFromFilename(file.originalname);
        console.log(`📍 [Parser] Target AMC auto-detected: ${amcName || 'UNKNOWN'}`);
        
        const rows = await withTimeout(
          extractBrokerageRowsFromPdfBuffer(file.buffer, amcName, file.originalname),
          PARSE_FILE_TIMEOUT_MS,
          `Parsing ${file.originalname}`
        );
        
        console.log(`✅ [Parser] Successfully extracted ${rows.length} rows using standard text buffer.`);
        results.push(...rows);

        if (rows.length === 0) {
          console.log(`⚠️ [Parser] No rows found in text layer. Checking for image-based content or OCR fallback...`);
          const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
          let textLen = 0;
          try { 
            const d = await pdf(file.buffer); 
            textLen = (d.text || '').trim().length; 
            console.log(`[Parser] Text layer length: ${textLen} chars.`);
          } catch (_) { }

          // Even if textLen > 50, if we found 0 rows, it might be a scanned PDF or weirdly encoded.
          // We trigger OCR fallback if rows.length is 0.
          console.log(`🔍 [Parser] ${file.originalname} has 0 rows. Attempting OCR fallback now...`);
          try {
            const ocrResult = await withTimeout(
              extractBrokerageWithOcr(file.buffer, amcName, file.originalname),
              240000, // 4 min timeout for OCR
              `OCR for ${file.originalname}`
            );
            if (ocrResult.rows && ocrResult.rows.length > 0) {
              console.log(`✅ [Parser] OCR successful! Extracted ${ocrResult.rows.length} rows.`);
              results.push(...ocrResult.rows);
              warning = `${file.originalname}: Extracted via OCR fallback. ${ocrResult.rows.length} rows found.`;
            } else {
              warning = ocrResult.warning || `${file.originalname}: no scheme/rate rows were detected (even via OCR).`;
              console.warn(`❌ [Parser] OCR also returned 0 rows for ${file.originalname}`);
            }
          } catch (ocrErr) {
            console.error(`[Parser ERROR] OCR failed for ${file.originalname}:`, ocrErr.message);
            warning = `${file.originalname}: parse failed. OCR attempt also failed: ${ocrErr.message}`;
          }
          warnings.push(warning);
        }

        fileStats.push({
          fileName: file.originalname,
          extractedRows: rows.length,
          encrypted,
          warning
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
        trailRate: row.trailRate,
        finalRate: row.trailRate,
        period: row.period,
        category: row.category,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...meta
      };
    });
    res.json(normalized);
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
      console.warn('⚠️ [Brokerage List] Database offline. Serving empty array for offline mode.');
      return res.json([]);
    }
    console.error('❌ [Brokerage List Error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brokerage/export.csv', uploadLimiter, async (req, res) => {
  try {
    const { amcName, month, year, period } = req.query;
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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/brokerage/reset', async (req, res) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
  try {
    const [result] = await pool.query('DELETE FROM brokerage_masters');
    console.log(`🧹 [Master Reset] Cleared ${result.affectedRows} master schemes.`);
    res.json({ success: true, message: `All ${result.affectedRows} brokerage data records were reset.` });
  } catch (error) {
    console.error('❌ [Master Reset Failed]', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/brokerage/:id/history — rate change history for a master record
app.get('/api/brokerage/:id/history', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM brokerage_rate_history WHERE masterId = ? ORDER BY changedAt DESC LIMIT 100',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
      return res.json({ data: [], pagination: { page: 1, limit: parseInt(req.query.limit) || 50, total: 0, totalPages: 0 } });
    }
    console.error('❌ [Paginated Transactions Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Global Error Handler (MUST BE AFTER ALL ROUTES) ---
app.use((err, req, res, next) => {
  if (err.message && err.message.includes('CORS')) {
    console.warn(`🛑 [CORS BLOCKED] Origin: ${req.headers.origin} for ${req.method} ${req.url}`);
    return res.status(403).json({ error: 'CORS policy: Origin not allowed' });
  }
  console.error('🔥 [ERROR]', err.stack || err);
  res.status(err.statusCode || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server immediately to satisfy hosting health checks
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 My Earnings (Node.js) running on port ${PORT}`);
  console.log(`🔗 Local Address: http://localhost:${PORT}`);

  // Initialize DB in the background
  initDB()
    .then(() => console.log('✅ Database Initialization Complete'))
    .catch(err => console.error('⚠️ Database Initialization FAILED:', err.message));
});

// SPA Fallback: Serve index.html for unknown routes (only if public folder exists)
if (fs.existsSync(staticPath)) {
  app.get('*', (req, res) => {
    // Skip API routes
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found' });
    
    const indexPath = path.join(staticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Frontend Assets Missing (index.html not found in public)');
    }
  });
} else {
  app.get('/', (req, res) => res.json({ status: 'API Only', info: 'Frontend folder (public) not found.' }));
}
