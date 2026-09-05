// MUST be imported BEFORE any module that reads process.env at top level
// (e.g. ./src/lib/db.js, which builds the mysql pool at module-init time).
//
// ES modules evaluate import dependencies' top-level code BEFORE the importer's
// own top-level code, so doing `dotenv.config()` in server.js top-level happens
// too late — db.js has already snapshotted the (possibly stale) password.
//
// Phusion Passenger / LiteSpeed inject service env vars at process spawn time;
// dotenv's default behavior is to NOT overwrite existing process.env entries,
// so we use `override: true` to force the .env file values to win.
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __srvDir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  join(__srvDir, '.env'),
  join(process.cwd(), '.env'),
];

let loaded = false;
for (const p of candidates) {
  const r = dotenv.config({ path: p, override: true });
  if (r.parsed && Object.keys(r.parsed).length > 0) {
    console.log(`✅ [bootstrap-env] Loaded ${Object.keys(r.parsed).length} keys from ${p} (override=true)`);
    loaded = true;
    break;
  }
}
if (!loaded) {
  console.log(`⚠️  [bootstrap-env] No .env found. cwd=${process.cwd()} __srvDir=${__srvDir}. Relying on injected env.`);
}
