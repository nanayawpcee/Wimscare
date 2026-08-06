const multer = require('multer');
const sharp = require('sharp');
const storage = require('../utils/storage');

const ALLOWED_DOCS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

function fileFilterFor(allowed) {
  return (_req, file, cb) => {
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  };
}

// All uploads land in memory first; route handlers persist the buffer via
// utils/storage (Vercel Blob or local disk, depending on environment).
const memory = multer.memoryStorage();

// Claim supporting documents: PDF or image, up to 1 MB each, max 5 files.
const claimDocs = multer({
  storage: memory,
  fileFilter: fileFilterFor(ALLOWED_DOCS),
  limits: { fileSize: 1 * 1024 * 1024, files: 5 },
});

// Contribution receipt image/PDF.
const receipt = multer({
  storage: memory,
  fileFilter: fileFilterFor(ALLOWED_DOCS),
  limits: { fileSize: 1 * 1024 * 1024, files: 1 },
});

// Avatars: resized to a small square webp before storing.
const avatarUpload = multer({
  storage: memory,
  fileFilter: fileFilterFor(ALLOWED_IMAGES),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

// Organization logo (Pro branding): fit inside 512px preserving transparency.
const logoUpload = multer({
  storage: memory,
  fileFilter: fileFilterFor(ALLOWED_IMAGES),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

async function processLogo(req) {
  if (!req.file) return null;
  const buffer = await sharp(req.file.buffer).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  return storage.save(req.orgId, 'branding', buffer, { fileName: `logo-${Date.now()}.webp`, contentType: 'image/webp' });
}

async function processAvatar(req) {
  if (!req.file) return null;
  const buffer = await sharp(req.file.buffer).rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
  return storage.save(req.orgId, 'avatars', buffer, { fileName: `${req.user._id}-${Date.now()}.webp`, contentType: 'image/webp' });
}

module.exports = { claimDocs, receipt, avatarUpload, processAvatar, logoUpload, processLogo };
