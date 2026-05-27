'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');

const BACKUP_DIR  = path.join(__dirname, '../../backups');
const MAX_BACKUPS = 16; // 4 días a 6h por backup

function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return {
      host:     u.hostname,
      port:     u.port || '5432',
      database: u.pathname.replace(/^\//, ''),
      user:     u.username,
      password: u.password,
    };
  } catch {
    throw new Error('DATABASE_URL inválida o no definida');
  }
}

function rotateBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.dump'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of files.slice(MAX_BACKUPS)) {
    fs.unlinkSync(path.join(BACKUP_DIR, file.name));
    console.log(`[backup] rotated out: ${file.name}`);
  }
}

async function runBackup() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no definida');

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const db = parseDbUrl(process.env.DATABASE_URL);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `backup_${timestamp}.dump`;
  const filepath  = path.join(BACKUP_DIR, filename);

  const args = [
    '-h', db.host,
    '-p', db.port,
    '-U', db.user,
    '-d', db.database,
    '-F', 'c',   // custom format — comprimido, restaurable con pg_restore
    '-f', filepath,
  ];

  await new Promise((resolve, reject) => {
    execFile('pg_dump', args, { env: { ...process.env, PGPASSWORD: db.password } }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`pg_dump falló: ${stderr || err.message}`));
        return;
      }
      resolve();
    });
  });

  const sizeKb = Math.round(fs.statSync(filepath).size / 1024);
  console.log(`[backup] guardado: ${filename} (${sizeKb} KB)`);

  rotateBackups();
  return filepath;
}

module.exports = { runBackup };

// Ejecutar directamente: node src/db/backup.js
if (require.main === module) {
  runBackup()
    .then(fp => { console.log(`[backup] OK → ${fp}`); })
    .catch(err => { console.error('[backup] ERROR:', err.message); process.exit(1); });
}
