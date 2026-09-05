/**
 * Transactions Routes
 * Paginated transaction queries.
 */
import { Router } from 'express';
import pool from '../lib/db.js';

const router = Router();

// GET /api/transactions
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const batchId = req.query.batchId || '';

    const sortableColumns = ['transactionDate', 'investorName', 'amcName', 'schemeName', 'grossAmount', 'createdAt'];
    const sortBy = req.query.sortBy || 'transactionDate';
    const sortOrder = (req.query.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const safeSort = sortableColumns.includes(sortBy) ? sortBy : 'transactionDate';

    let whereClause = '';
    const params = [];

    if (batchId) {
      whereClause += ' WHERE batchId = ?';
      params.push(batchId);
    }

    if (search) {
      whereClause += (whereClause ? ' AND' : ' WHERE') +
        ' (investorName LIKE ? OR amcName LIKE ? OR schemeName LIKE ? OR pan LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM transactions${whereClause}`, params);
    const total = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT * FROM transactions${whereClause} ORDER BY ${safeSort} ${sortOrder} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
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
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('[Transactions] Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

export default router;
