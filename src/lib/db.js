import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Pre-load env so it's ready for the pool
const envPaths = [
  path.join(__dirname, '..', '.env'),
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '.env')
];
for (const p of envPaths) {
  const result = dotenv.config({ path: p });
  if (result.parsed) {
    console.log(`✅ Loaded .env from ${p}`);
  }
}

console.log('--- DB CONFIG DEBUG ---');
console.log('HOST:', process.env.DB_HOST || '127.0.0.1');
console.log('USER:', process.env.DB_USER || 'NOT SET');
console.log('DB:', process.env.DB_NAME || 'NOT SET');
console.log('-----------------------');

/**
 * DATABASE CONNECTION POOL
 * Configured for Hostinger Premium Shared Hosting
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'test',
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
  connectTimeout: 10000, // 10s
  dateStrings: true,
  decimalNumbers: true
});

// Connection testing is now handled by the server's health check or explicitly by initDB

export default pool;
