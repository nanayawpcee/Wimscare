const express = require('express');
const Backup = require('../models/Backup');
const { protect, requirePermission, requireOrg, orgFilter } = require('../middleware/auth');
const { createOrgBackup, restoreOrgBackup } = require('../utils/backupService');
const { audit } = require('../utils/audit');
const storage = require('../utils/storage');

const router = express.Router();

router.use(protect, requireOrg, requirePermission('manage_backups'));

// GET /api/backups — this organization's backups
router.get('/', async (req, res, next) => {
  try {
    const items = await Backup.find(orgFilter(req)).sort({ createdAt: -1 }).populate('createdBy', 'firstName lastName');
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /api/backups — take a backup now
router.post('/', async (req, res, next) => {
  try {
    const backup = await createOrgBackup(req.orgId, { trigger: 'manual', createdBy: req.user._id });
    audit(req, 'backup.create', { entityType: 'Backup', entityId: backup._id });
    res.status(201).json({ backup });
  } catch (err) {
    next(err);
  }
});

// GET /api/backups/:id/download
router.get('/:id/download', async (req, res, next) => {
  try {
    const backup = await Backup.findOne(orgFilter(req, { _id: req.params.id }));
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    await storage.serveDownload(backup.filePath, backup.fileName, res);
  } catch (err) {
    next(err);
  }
});

// POST /api/backups/:id/restore — destructive; requires confirm: "RESTORE"
// Restoring wipes and replaces all organization data — kept administrator-
// only even when 'manage_backups' has been granted to another role.
router.post('/:id/restore', (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an administrator can restore a backup' });
  }
  next();
}, async (req, res, next) => {
  try {
    if (req.body.confirm !== 'RESTORE') {
      return res.status(400).json({ error: 'Type RESTORE to confirm — this replaces all current organization data' });
    }
    const backup = await Backup.findOne(orgFilter(req, { _id: req.params.id, status: 'completed' }));
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    const restored = await restoreOrgBackup(backup, req.orgId);
    audit(req, 'backup.restore', { entityType: 'Backup', entityId: backup._id, detail: { restored } });
    res.json({ message: 'Restore completed — all users must sign in again', restored });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
