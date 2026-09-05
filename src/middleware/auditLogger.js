/**
 * Audit Logger Middleware
 * Automatically logs all data mutations (POST/DELETE) to activity_log.
 */
import pool from '../lib/db.js';

const LOGGED_ROUTES = ['/api/data', '/api/brokerage/reset', '/api/brokerage/extract'];

export function auditLogger(req, res, next) {
  // Only log mutating methods on relevant routes
  const isLoggable = ['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method) &&
    LOGGED_ROUTES.some(r => req.path.startsWith(r));

  if (!isLoggable || !req.user) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    // Log only successful operations
    if (res.statusCode < 400 && body?.success !== false) {
      const action = deriveAction(req);
      const description = deriveDescription(req, body);
      if (action) {
        pool.query(
          'INSERT INTO activity_log (userId, userName, action, description) VALUES (?, ?, ?, ?)',
          [req.user.id, req.user.id, action, description]
        ).catch(err => console.error('[AuditLogger] Failed to write log:', err.message));
      }
    }
    return originalJson(body);
  };

  next();
}

function deriveAction(req) {
  const { method, path, body } = req;
  if (method === 'DELETE') return 'DELETE';
  if (path === '/api/brokerage/reset') return 'BROKERAGE_RESET';
  if (path === '/api/brokerage/extract') return 'BROKERAGE_EXTRACT';
  if (path === '/api/data' && method === 'POST') {
    if (body?.action === 'bulk_delete') return 'BULK_DELETE';
    if (body?.collection) return `UPSERT_${body.collection.toUpperCase()}`;
  }
  return null;
}

function deriveDescription(req, body) {
  const { path, body: reqBody } = req;
  if (path === '/api/brokerage/reset') return 'Reset all brokerage master data';
  if (path === '/api/brokerage/extract') return `Extracted brokerage from ${body?.filesProcessed || 1} file(s)`;
  if (reqBody?.action === 'bulk_delete') {
    const ids = Array.isArray(reqBody.payload) ? reqBody.payload : [reqBody.payload];
    return `Bulk deleted ${ids.length} record(s) from ${reqBody.collection}`;
  }
  if (reqBody?.collection) {
    const count = Array.isArray(reqBody.payload) ? reqBody.payload.length : 1;
    return `Saved ${count} record(s) to ${reqBody.collection}`;
  }
  return 'Data mutation';
}
