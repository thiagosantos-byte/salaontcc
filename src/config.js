const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const at = clean.indexOf('=');
    if (at < 1) continue;
    const key = clean.slice(0, at).trim();
    let value = clean.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

module.exports = { loadEnv };
