/* eslint-disable no-console */
/**
 * dmcg.co: runs at the end of every Vercel build (vercel.json), after the migrations.
 *
 * Sets the admin password from UMAMI_ADMIN_PASSWORD, so the default admin/umami login is never live,
 * registers the CMS's API key (UMAMI_SETUP_API_KEY, stored only as its hash, as Umami itself does),
 * makes sure the dmcg.co website exists with a fixed id (UMAMI_SETUP_WEBSITE_ID), and keeps each query
 * on one worker so the small database doesn't run out of memory. Every step is idempotent; a missing
 * variable skips its step.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const ADMIN_ID = '41e2b680-648e-4b09-bcd7-3e2b10c06264';
const { UMAMI_ADMIN_PASSWORD, UMAMI_SETUP_API_KEY, UMAMI_SETUP_WEBSITE_ID } = process.env;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const statements = [];

if (UMAMI_ADMIN_PASSWORD) {
  if (UMAMI_ADMIN_PASSWORD.length < 16) throw new Error('UMAMI_ADMIN_PASSWORD must be at least 16 characters.');
  statements.push(
    `UPDATE "user" SET password = ${quote(bcrypt.hashSync(UMAMI_ADMIN_PASSWORD, 10))} WHERE user_id = ${quote(ADMIN_ID)};`,
  );
}

if (UMAMI_SETUP_API_KEY) {
  if (!/^umami_[A-Za-z0-9]{32}$/.test(UMAMI_SETUP_API_KEY)) throw new Error('UMAMI_SETUP_API_KEY must look like umami_ + 32 letters/digits.');
  const keyHash = crypto.createHash('sha512').update(UMAMI_SETUP_API_KEY).digest('hex');
  statements.push(
    `INSERT INTO api_key (api_key_id, user_id, name, key_hash, key_prefix) VALUES (${quote(crypto.randomUUID())}, ${quote(ADMIN_ID)}, 'dmcg.co CMS', ${quote(keyHash)}, ${quote(UMAMI_SETUP_API_KEY.slice(0, 14))}) ON CONFLICT (key_hash) DO NOTHING;`,
  );
}

if (UMAMI_SETUP_WEBSITE_ID) {
  if (!/^[0-9a-f-]{36}$/.test(UMAMI_SETUP_WEBSITE_ID)) throw new Error('UMAMI_SETUP_WEBSITE_ID must be a UUID.');
  statements.push(
    `INSERT INTO website (website_id, name, domain, user_id, created_by) VALUES (${quote(UMAMI_SETUP_WEBSITE_ID)}, 'dmcg.co', 'dmcg.co', ${quote(ADMIN_ID)}, ${quote(ADMIN_ID)}) ON CONFLICT (website_id) DO NOTHING;`,
  );
}

// Neon's small compute ran out of memory once the dashboard's queries came in parallel, each one
// also splitting across parallel workers. One worker per query keeps each query's memory to itself.
statements.push(
  `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET max_parallel_workers_per_gather = 0', current_database()); END $$;`,
);

if (statements.length) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dmcg-setup-')), 'setup.sql');
  fs.writeFileSync(file, statements.join('\n'), { mode: 0o600 });
  try {
    execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], { stdio: ['ignore', 'ignore', 'inherit'] });
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  console.log(`dmcg setup: ${statements.length} step(s) applied.`);
} else {
  console.log('dmcg setup: nothing to do.');
}
