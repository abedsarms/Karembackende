'use strict';
/**
 * Entry point for hosting (npm start). Restores the database from the Telegram backup channel when the
 * local file is missing (free hosts wipe the disk), then starts the real server.
 */
const fs = require('node:fs');
const path = require('node:path');

(function loadDotEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const { restoreIfNeeded } = require('./backup');
const env = process.env;

(async () => {
  let restored = { status: 'disabled' };
  try {
    restored = await restoreIfNeeded({
      dbPath: env.DB_PATH || path.join(__dirname, 'data', 'karem.db'),
      token: env.BOT_TOKEN || '', chat: env.BACKUP_CHAT_ID || '', passphrase: env.BACKUP_PASSPHRASE || '',
      api: env.TG_API_BASE || 'https://api.telegram.org',
    });
  } catch (e) {
    console.error('\nFATAL: a backup exists (or the backup channel is set up wrongly) but it could not be restored:');
    console.error('  ' + e.message);
    console.error('The server will NOT start with an empty database, because that would overwrite your good backup.');
    console.error('Fix BACKUP_CHAT_ID / BACKUP_PASSPHRASE / bot admin rights and redeploy.\n');
    process.exit(1);
  }
  globalThis.__KAREM_RESTORED = restored;
  require('./server.js');
})();
