const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Backup = require('../models/Backup');
const storage = require('./storage');

// Every tenant-scoped collection that participates in backup/restore.
const ORG_MODELS = () => ({
  users: require('../models/User'),
  profiles: require('../models/Profile'),
  contributions: require('../models/Contribution'),
  claims: require('../models/Claim'),
  claimtypes: require('../models/ClaimType'),
  ledgerentries: require('../models/LedgerEntry'),
  accountentries: require('../models/AccountEntry'),
  fundaccounts: require('../models/FundAccount'),
  paymentmodes: require('../models/PaymentMode'),
  invitations: require('../models/Invitation'),
  reversalrequests: require('../models/ReversalRequest'),
  licenses: require('../models/License'),
});

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

// Recursively list files under dir as paths relative to it.
function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else if (entry.isFile()) out.push({ rel: path.relative(base, abs), abs });
  }
  return out;
}

// Serialize one organization's data to a gzipped JSON file.
async function createOrgBackup(organizationId, { trigger = 'manual', createdBy = null } = {}) {
  const Organization = require('../models/Organization');
  const org = await Organization.findById(organizationId).lean();
  if (!org) throw new Error('Organization not found');

  const models = ORG_MODELS();
  const payload = { format: 'wimscare-org-backup', version: 2, exportedAt: new Date().toISOString(), organization: org, collections: {} };
  const counts = [];
  for (const [name, Model] of Object.entries(models)) {
    const docs = await Model.find({ organizationId }).select('+passwordHash +tokenHash').lean();
    payload.collections[name] = docs;
    counts.push({ name, count: docs.length });
  }

  // Uploaded files (claim documents, receipts, avatars, brand logos) are only
  // embedded when running in local-disk mode, where they'd otherwise live
  // solely on this ephemeral machine. In Blob mode the files already persist
  // independently in cloud storage, so there's nothing to snapshot here.
  payload.files = [];
  if (!storage.blobEnabled()) {
    const orgUploadDir = path.join(UPLOAD_ROOT, String(organizationId));
    if (fs.existsSync(orgUploadDir)) {
      for (const { rel, abs } of walkFiles(orgUploadDir)) {
        payload.files.push({ path: rel, data: fs.readFileSync(abs).toString('base64') });
      }
    }
  }
  counts.push({ name: 'files', count: payload.files.length });

  const fileName = `org-${org.code || organizationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
  const gzipped = zlib.gzipSync(JSON.stringify(payload));
  const filePath = await storage.save(organizationId, 'backups', gzipped, { fileName, contentType: 'application/gzip' });

  return Backup.create({
    organizationId,
    fileName,
    filePath,
    sizeBytes: gzipped.length,
    scope: 'organization',
    trigger,
    collections: counts,
    createdBy,
  });
}

// Restore an organization's data from a backup file.
// Replaces current tenant data with the snapshot (destructive, admin-confirmed).
async function restoreOrgBackup(backupDoc, organizationId) {
  const raw = zlib.gunzipSync(await storage.readBuffer(backupDoc.filePath)).toString('utf8');
  const payload = JSON.parse(raw);
  if (payload.format !== 'wimscare-org-backup') throw new Error('Unrecognized backup format');
  if (String(payload.organization._id) !== String(organizationId)) {
    throw new Error('This backup belongs to a different organization');
  }

  const models = ORG_MODELS();
  const restored = [];
  for (const [name, Model] of Object.entries(models)) {
    const docs = payload.collections[name] || [];
    await Model.deleteMany({ organizationId });
    if (docs.length) await Model.insertMany(docs, { rawResult: false });
    restored.push({ name, count: docs.length });
  }

  // Embedded files only exist on disk-mode backups (see createOrgBackup) and
  // only make sense to replay back onto local disk — in Blob mode the live
  // files were never touched by backup/restore, so there's nothing to do.
  if (!storage.blobEnabled() && Array.isArray(payload.files) && payload.files.length) {
    const orgUploadDir = path.join(UPLOAD_ROOT, String(organizationId));
    fs.rmSync(orgUploadDir, { recursive: true, force: true });
    for (const file of payload.files) {
      const abs = path.resolve(orgUploadDir, file.path);
      if (!abs.startsWith(path.resolve(orgUploadDir) + path.sep)) continue; // traversal guard
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(file.data, 'base64'));
    }
    restored.push({ name: 'files', count: payload.files.length });
  }
  return restored;
}

module.exports = { createOrgBackup, restoreOrgBackup };
