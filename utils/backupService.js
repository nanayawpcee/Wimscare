const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Backup = require('../models/Backup');

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

function backupDir() {
  const dir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

  // Uploaded files (claim documents, receipts, avatars, brand logos) live
  // under uploads/<orgId>; embed them (base64, gzipped with the rest) so a
  // restore round-trips attachments, not just database rows.
  const orgUploadDir = path.join(UPLOAD_ROOT, String(organizationId));
  payload.files = [];
  if (fs.existsSync(orgUploadDir)) {
    for (const { rel, abs } of walkFiles(orgUploadDir)) {
      payload.files.push({ path: rel, data: fs.readFileSync(abs).toString('base64') });
    }
  }
  counts.push({ name: 'files', count: payload.files.length });

  const fileName = `org-${org.code || organizationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
  const filePath = path.join(backupDir(), fileName);
  fs.writeFileSync(filePath, zlib.gzipSync(JSON.stringify(payload)));

  return Backup.create({
    organizationId,
    fileName,
    filePath,
    sizeBytes: fs.statSync(filePath).size,
    scope: 'organization',
    trigger,
    collections: counts,
    createdBy,
  });
}

// Restore an organization's data from a backup file.
// Replaces current tenant data with the snapshot (destructive, admin-confirmed).
async function restoreOrgBackup(backupDoc, organizationId) {
  const raw = zlib.gunzipSync(fs.readFileSync(backupDoc.filePath)).toString('utf8');
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

  // v2 backups carry the uploads tree; replace the org's files with the
  // snapshot. v1 backups have no files key — leave current files alone
  // rather than deleting attachments the snapshot knows nothing about.
  if (Array.isArray(payload.files)) {
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

module.exports = { createOrgBackup, restoreOrgBackup, backupDir };
