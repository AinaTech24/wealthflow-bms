/**
 * Invoice Routes
 * Generate printable HTML invoices for distributor payouts.
 */
import { Router } from 'express';
import pool from '../lib/db.js';
import { generateInvoiceHtml } from '../lib/invoiceGenerator.js';

const router = Router();

// POST /api/invoices/generate
// Body: { userId, userName, period, schemes: [{schemeName, amcName, grossAmount, trailRate, commission}], tdsRate }
router.post('/generate', async (req, res) => {
  const { userId, userName, period, schemes = [], tdsRate = 10, notes = '' } = req.body || {};

  if (!userId || !period) {
    return res.status(400).json({ error: 'userId and period are required' });
  }

  try {
    // Fetch user details
    const [userRows] = await pool.query('SELECT * FROM team WHERE id = ?', [userId]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userData = user.data ? JSON.parse(user.data) : {};
    const invoiceData = {
      invoiceNo: `INV-${userId.toUpperCase()}-${period.replace('-', '')}-${Date.now().toString(36).toUpperCase()}`,
      generatedAt: new Date().toISOString(),
      period,
      distributor: {
        id: user.id,
        name: userName || user.name,
        code: user.code,
        email: user.email,
        bankDetails: userData.bankDetails || {}
      },
      schemes,
      tdsRate: Number(tdsRate) || 10,
      notes
    };

    // Calculate totals with proper rounding
    const grossTotal = Math.round(schemes.reduce((sum, s) => sum + (Number(s.commission) || 0), 0) * 100) / 100;
    const tdsAmount = Math.round(grossTotal * invoiceData.tdsRate) / 100;
    invoiceData.grossTotal = grossTotal;
    invoiceData.tdsAmount = tdsAmount;
    invoiceData.netPayable = Math.round((grossTotal - tdsAmount) * 100) / 100;

    // Save invoice record to DB
    const invId = invoiceData.invoiceNo.toLowerCase();
    await pool.query(
      `INSERT INTO invoices (id, userId, month, data) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data=VALUES(data)`,
      [invId, userId, period, JSON.stringify(invoiceData)]
    );

    // Return both the data and the HTML
    const html = generateInvoiceHtml(invoiceData);
    res.json({ success: true, invoiceId: invId, invoiceData, html });
  } catch (err) {
    console.error('[Invoices] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

// GET /api/invoices — list invoices
router.get('/', async (req, res) => {
  try {
    const userId = req.query.userId;
    let query = 'SELECT id, userId, month, createdAt FROM invoices';
    const params = [];
    if (userId) { query += ' WHERE userId = ?'; params.push(userId); }
    query += ' ORDER BY createdAt DESC LIMIT 100';
    const [rows] = await pool.query(query, params);
    const mapped = rows.map(r => ({ id: r.id, userId: r.userid || r.userId, month: r.month, createdAt: r.createdAt }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// GET /api/invoices/:id/html — download invoice as HTML
router.get('/:id/html', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const invoiceData = JSON.parse(rows[0].data || '{}');
    const html = generateInvoiceHtml(invoiceData);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="invoice_${req.params.id}.html"`);
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invoice' });
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM invoices WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

export default router;
