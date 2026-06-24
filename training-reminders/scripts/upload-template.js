#!/usr/bin/env node

// Upload one or all day templates to the Worker's KV store.
//
// Single template:
//   node scripts/upload-template.js monday "../1 Monday email.txt"
//
// All five from the parent KitTemplates folder (seed or daily live-update):
//   node scripts/upload-template.js --all
//
// Env:
//   WORKER_URL    Worker base URL (default http://localhost:8787 for `wrangler dev`)
//   ADMIN_TOKEN   shared secret; required by the Worker for /template PUT
//
// Live updates: editing a day's email is the same command — re-run it and the
// next reminder for that day picks up the new HTML.

const fs = require('fs');
const path = require('path');

const VALID = ['monday', 'tuesday', 'thursday', 'ibgs', 'friday'];

// Default mapping from template type -> source file in the parent folder.
const PARENT = path.resolve(__dirname, '..', '..');
const ALL_FILES = {
  monday:   path.join(PARENT, '1 Monday email.txt'),
  tuesday:  path.join(PARENT, '2 Tuesday email.txt'),
  thursday: path.join(PARENT, '3 Thursday email.txt'),
  friday:   path.join(PARENT, '4 Friday email.txt'),
  ibgs:     path.join(PARENT, 'IBGS reminder email.txt'),
};

const workerUrl = process.env.WORKER_URL || 'http://localhost:8787';
const adminToken = process.env.ADMIN_TOKEN;

async function uploadOne(type, filePath) {
  if (!VALID.includes(type)) {
    throw new Error(`Template type must be one of: ${VALID.join(', ')}`);
  }
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${fullPath}`);

  const html = fs.readFileSync(fullPath, 'utf-8');
  const url = `${workerUrl}/template/${type}`;
  console.log(`Uploading ${type} (${html.length} bytes) from ${path.basename(fullPath)} -> ${url}`);

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/html',
      ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
    },
    body: html,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Failed (${resp.status}): ${JSON.stringify(data)}`);
  console.log('  Done:', data);
}

async function main() {
  if (!adminToken) {
    console.error('Warning: ADMIN_TOKEN not set — the Worker will reject this unless running unauthenticated locally.');
  }

  const args = process.argv.slice(2);

  if (args[0] === '--all') {
    for (const [type, file] of Object.entries(ALL_FILES)) {
      await uploadOne(type, file);
    }
    return;
  }

  const [type, filePath] = args;
  if (!type || !filePath) {
    console.error('Usage:');
    console.error('  node scripts/upload-template.js <monday|tuesday|thursday|ibgs|friday> <path-to-html>');
    console.error('  node scripts/upload-template.js --all');
    process.exit(1);
  }
  await uploadOne(type, filePath);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
