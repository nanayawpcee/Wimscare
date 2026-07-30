// Unified file storage: Vercel Blob when BLOB_READ_WRITE_TOKEN is set
// (required in production on Vercel, whose filesystem is read-only/ephemeral),
// otherwise local disk under uploads/ (local dev / Render, where disk persists).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function isRemote(pathOrUrl) {
  return typeof pathOrUrl === 'string' && /^https?:\/\//.test(pathOrUrl);
}

function randomName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase().slice(0, 8) || '';
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function localAbs(relPath) {
  const abs = path.resolve(UPLOAD_ROOT, relPath);
  if (!abs.startsWith(UPLOAD_ROOT)) throw new Error('Invalid file path');
  return abs;
}

// Save a buffer under <org>/<subdir>/<name>. Returns the value to persist on
// the document (a full blob URL, or a path relative to uploads/).
async function save(orgId, subdir, buffer, { originalName, contentType, fileName } = {}) {
  const org = orgId || 'system';
  const name = fileName || randomName(originalName);
  const key = `${org}/${subdir}/${name}`;

  if (blobEnabled()) {
    const { put } = require('@vercel/blob');
    const blob = await put(key, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return blob.url;
  }

  const abs = path.join(UPLOAD_ROOT, key);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, buffer);
  return path.relative(UPLOAD_ROOT, abs);
}

// Delete a previously-saved file. Best-effort: swallows not-found errors.
async function remove(pathOrUrl) {
  if (!pathOrUrl) return;
  try {
    if (isRemote(pathOrUrl)) {
      const { del } = require('@vercel/blob');
      await del(pathOrUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } else {
      fs.unlinkSync(localAbs(pathOrUrl));
    }
  } catch {
    // already gone — fine
  }
}

async function readBuffer(pathOrUrl) {
  if (isRemote(pathOrUrl)) {
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`Failed to fetch stored file (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(localAbs(pathOrUrl));
}

// Serve a file inline (e.g. an <img> tag) — redirect for blob URLs, sendFile locally.
function serveInline(pathOrUrl, res) {
  if (isRemote(pathOrUrl)) return res.redirect(pathOrUrl);
  return res.sendFile(localAbs(pathOrUrl));
}

// Serve a file as a download with a chosen filename.
async function serveDownload(pathOrUrl, filename, res) {
  if (isRemote(pathOrUrl)) {
    const buffer = await readBuffer(pathOrUrl);
    res.setHeader('Content-Disposition', `attachment; filename="${(filename || 'file').replace(/"/g, '')}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.send(buffer);
  }
  return res.download(localAbs(pathOrUrl), filename);
}

module.exports = { UPLOAD_ROOT, blobEnabled, isRemote, save, remove, readBuffer, serveInline, serveDownload };
