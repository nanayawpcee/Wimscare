const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

const ALLOWED_DOCS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function storageFor(subdir) {
  return multer.diskStorage({
    destination(req, _file, cb) {
      const org = req.orgId || 'system';
      const dir = path.join(UPLOAD_ROOT, org, subdir);
      ensureDir(dir);
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 8) || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
}

function fileFilterFor(allowed) {
  return (_req, file, cb) => {
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  };
}

// Claim supporting documents: PDF or image, up to 8 MB each, max 10 files.
const claimDocs = multer({
  storage: storageFor('claims'),
  fileFilter: fileFilterFor(ALLOWED_DOCS),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
});

// Contribution receipt image/PDF.
const receipt = multer({
  storage: storageFor('receipts'),
  fileFilter: fileFilterFor(ALLOWED_DOCS),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// Avatars go to memory first, then sharp resizes them to a small square webp.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: fileFilterFor(ALLOWED_IMAGES),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// Organization logo (Pro branding): memory upload, then sharp fits it
// inside 512px preserving transparency.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: fileFilterFor(ALLOWED_IMAGES),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

async function processLogo(req) {
  if (!req.file) return null;
  const org = req.orgId || 'system';
  const dir = path.join(UPLOAD_ROOT, org, 'branding');
  ensureDir(dir);
  const fileName = `logo-${Date.now()}.webp`;
  const abs = path.join(dir, fileName);
  await sharp(req.file.buffer).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(abs);
  return path.relative(path.join(__dirname, '..'), abs);
}

async function processAvatar(req) {
  if (!req.file) return null;
  const org = req.orgId || 'system';
  const dir = path.join(UPLOAD_ROOT, org, 'avatars');
  ensureDir(dir);
  const fileName = `${req.user._id}-${Date.now()}.webp`;
  const abs = path.join(dir, fileName);
  await sharp(req.file.buffer).rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toFile(abs);
  return path.relative(path.join(__dirname, '..'), abs);
}

// Relative upload path -> absolute, refusing anything outside uploads/.
function resolveUploadPath(relPath) {
  const abs = path.resolve(path.join(__dirname, '..'), relPath);
  if (!abs.startsWith(UPLOAD_ROOT)) throw new Error('Invalid file path');
  return abs;
}

module.exports = { UPLOAD_ROOT, claimDocs, receipt, avatarUpload, processAvatar, logoUpload, processLogo, resolveUploadPath };
