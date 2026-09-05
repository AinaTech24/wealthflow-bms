/**
 * Auth Routes
 * Handles login, activity logging.
 */
import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import pool from '../lib/db.js';
import { sendEmail } from '../lib/emailService.js';

// In-memory OTP store: email → { code, expires, userId }
const otpStore = new Map();

const router = Router();

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS) || 8000;

function withTimeout(promise, timeoutMs, label = 'Operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// Strict login rate limiter: 5 attempts per minute per IP
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again after 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { identifier, password } = req.body || {};
  const JWT_SECRET = process.env.JWT_SECRET;

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifier and password are required' });
  }

  try {
    const [rows] = await withTimeout(
      pool.query('SELECT * FROM team WHERE (email = ? OR code = ?)', [identifier, identifier]),
      AUTH_TIMEOUT_MS,
      'Authentication query'
    );

    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

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

    if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

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
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    return res.status(500).json({ error: 'Authentication failed. Please try again.' });
  }
});

// POST /api/auth/log-activity
router.post('/log-activity', async (req, res) => {
  const { userId, userName, activityAction, description } = req.body || {};
  try {
    await pool.query(
      'INSERT INTO activity_log (userId, userName, action, description) VALUES (?, ?, ?, ?)',
      [userId, userName, activityAction, description]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Activity log error:', err.message);
    return res.status(500).json({ error: 'Failed to log activity' });
  }
});

// POST /api/auth/reset-password (admin only)
router.post('/reset-password', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let caller;
  try {
    caller = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (caller.role !== 'ADMIN') return res.status(403).json({ error: 'Admins only' });

  const { userId, newPassword } = req.body || {};
  if (!userId || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'userId and newPassword (min 6 chars) required' });
  }

  try {
    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const [result] = await pool.query('UPDATE team SET password = ? WHERE id = ?', [hashed, userId]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      'INSERT INTO activity_log (userId, userName, action, description) VALUES (?, ?, ?, ?)',
      [caller.id, 'Admin', 'password_reset', `Admin reset password for userId: ${userId}`]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] Password reset error:', err.message);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/send-otp  — publicly accessible (no auth required)
router.post('/send-otp', async (req, res) => {
  const { identifier } = req.body || {};
  if (!identifier) return res.status(400).json({ error: 'Email or ID required' });

  try {
    const id = identifier.trim().toLowerCase();
    const [rows] = await pool.query(
      'SELECT id, email, name FROM team WHERE email = ? OR code = ?',
      [id, identifier.trim()]
    );
    // Always return success to avoid user enumeration
    if (rows.length === 0) return res.json({ success: true });

    const user = rows[0];
    if (!user.email) return res.json({ success: true });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
    otpStore.set(user.email.toLowerCase(), { code, expires, userId: user.id });

    sendEmail({
      to: user.email,
      subject: 'My Earnings — Password Reset OTP',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px">
          <h2 style="color:#1e293b">Password Reset</h2>
          <p style="color:#475569">Hi ${user.name || 'User'},</p>
          <p style="color:#475569">Your one-time password reset code is:</p>
          <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
            <span style="font-size:36px;font-weight:900;letter-spacing:12px;color:#3b82f6">${code}</span>
          </div>
          <p style="color:#94a3b8;font-size:12px">This code expires in 5 minutes. If you did not request this, ignore this email.</p>
        </div>
      `
    });

    console.log(`📧 [OTP] Sent to ${user.email}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] OTP send error:', err.message);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp  — publicly accessible
router.post('/verify-otp', async (req, res) => {
  const { identifier, otp, newPassword } = req.body || {};
  if (!identifier || !otp || !newPassword) {
    return res.status(400).json({ error: 'identifier, otp, and newPassword required' });
  }
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });

  try {
    const id = identifier.trim().toLowerCase();
    const [rows] = await pool.query(
      'SELECT id, email FROM team WHERE email = ? OR code = ?',
      [id, identifier.trim()]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Account not found' });

    const user = rows[0];
    const emailKey = (user.email || '').toLowerCase();
    const stored = otpStore.get(emailKey);

    if (!stored || stored.code !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    if (Date.now() > stored.expires) {
      otpStore.delete(emailKey);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    otpStore.delete(emailKey);
    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE team SET password = ? WHERE id = ?', [hashed, user.id]);
    await pool.query(
      'INSERT INTO activity_log (userId, userName, action, description) VALUES (?, ?, ?, ?)',
      [user.id, 'System', 'password_reset', 'Password reset via OTP email verification']
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] OTP verify error:', err.message);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/auth/activity
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const userId = req.query.userId || null;
    let query = 'SELECT * FROM activity_log';
    const params = [];
    if (userId) { query += ' WHERE userId = ?'; params.push(userId); }
    query += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(limit);
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

export default router;
