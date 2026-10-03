import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
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

// TLS to the database. AWS RDS refuses unencrypted connections
// (require_secure_transport=ON), so there DB_SSL_CA points at the RDS CA bundle
// and the server certificate is verified. Unset (Hostinger, local), the
// connection stays exactly as it was.
let ssl;
if (process.env.DB_SSL_CA) {
  ssl = { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8'), rejectUnauthorized: true };
  console.log(`🔒 DB TLS on (CA: ${process.env.DB_SSL_CA})`);
}

/**
 * DATABASE CONNECTION POOL
 * Hostinger shared hosting, or AWS RDS when DB_SSL_CA is set.
 */
const pool = mysql.createPool({
  ssl,
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
