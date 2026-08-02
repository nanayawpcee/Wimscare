// Unified file storage: Vercel Blob when BLOB_READ_WRITE_TOKEN is set
// (required in production on Vercel, whose filesystem is read-only/ephemeral),
// otherwise local disk under uploads/ (local dev / Render, where disk persists).
//
// Blob objects are stored PRIVATE. Nothing here ever hands out a durable public
// URL: reads go through a presigned GET that expires in PRESIGN_TTL_MS. The
// value persisted on a document is an opaque storage key (`<org>/<subdir>/<name>`),
// identical in shape for both backends.
//
// Documents written before this change hold a full public blob URL instead.
// Those objects are readable by URL alone — scripts/rotate-public-blobs.js
// re-uploads them privately and rewrites the references. Until it has run, the
// legacy branches below keep those files reachable for signed-in users.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const PRESIGN_TTL_MS = 5 * 60 * 1000;
// Stored names carry a timestamp, so an object at a given key never changes.
const OBJECT_CACHE_MAX_AGE = 365 * 24 * 60 * 60;

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

// A legacy reference: a full public blob URL persisted before the private switch.
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

// A presigned GET for a private object, valid for PRESIGN_TTL_MS and scoped to
// that single key.
async function presignedGet(key, { download = false } = {}) {
  const { issueSignedToken, presignUrl } = require('@vercel/blob');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const validUntil = Date.now() + PRESIGN_TTL_MS;
  const signed = await issueSignedToken({ pathname: key, operations: ['get'], validUntil, token });
  const { presignedUrl } = await presignUrl(signed, { operation: 'get', pathname: key, validUntil, access: 'private' });
  return download ? `${presignedUrl}${presignedUrl.includes('?') ? '&' : '?'}download=1` : presignedUrl;
}

// A redirect to a presigned URL must never be stored by a cache — the target
// outlives neither the TTL nor the caller's authorization.
function redirectPrivate(res, url) {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.redirect(url);
}

// Save a buffer under <org>/<subdir>/<name>. Returns the opaque storage key to
// persist on the document.
async function save(orgId, subdir, buffer, { originalName, contentType, fileName } = {}) {
  const org = orgId || 'system';
  const name = fileName || randomName(originalName);
  const key = `${org}/${subdir}/${name}`;

  if (blobEnabled()) {
    const { put } = require('@vercel/blob');
    const blob = await put(key, buffer, {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      cacheControlMaxAge: OBJECT_CACHE_MAX_AGE,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return blob.pathname;
  }

  const abs = path.join(UPLOAD_ROOT, key);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, buffer);
  return path.relative(UPLOAD_ROOT, abs);
}

// Delete a previously-saved file. Best-effort: swallows not-found errors.
async function remove(keyOrUrl) {
  if (!keyOrUrl) return;
  try {
    if (isRemote(keyOrUrl) || blobEnabled()) {
      const { del } = require('@vercel/blob');
      await del(keyOrUrl, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } else {
      fs.unlinkSync(localAbs(keyOrUrl));
    }
  } catch {
    // already gone — fine
  }
}

async function readBuffer(keyOrUrl) {
  if (isRemote(keyOrUrl)) {
    const res = await fetch(keyOrUrl);
    if (!res.ok) throw new Error(`Failed to fetch stored file (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (blobEnabled()) {
    const res = await fetch(await presignedGet(keyOrUrl));
    if (!res.ok) throw new Error(`Failed to fetch stored file (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFileSync(localAbs(keyOrUrl));
}

// Serve a file inline (e.g. an <img> tag). Redirects for blob-backed objects so
// the bytes never pass through this process.
async function serveInline(keyOrUrl, res) {
  if (isRemote(keyOrUrl)) return redirectPrivate(res, keyOrUrl);
  if (blobEnabled()) return redirectPrivate(res, await presignedGet(keyOrUrl));
  return res.sendFile(localAbs(keyOrUrl));
}

// Serve a file as a download with a chosen filename.
async function serveDownload(keyOrUrl, filename, res) {
  if (isRemote(keyOrUrl)) {
    const { getDownloadUrl } = require('@vercel/blob');
    return redirectPrivate(res, getDownloadUrl(keyOrUrl));
  }
  if (blobEnabled()) return redirectPrivate(res, await presignedGet(keyOrUrl, { download: true }));
  return res.download(localAbs(keyOrUrl), filename);
}

module.exports = {
  UPLOAD_ROOT,
  PRESIGN_TTL_MS,
  blobEnabled,
  isRemote,
  presignedGet,
  save,
  remove,
  readBuffer,
  serveInline,
  serveDownload,
};
