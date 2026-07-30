const express = require('express');
const PaymentMode = require('../models/PaymentMode');
const { protect, requireRoles, requireOrg, orgFilter } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = express.Router();

router.use(protect, requireOrg);

router.get('/', async (req, res, next) => {
  try {
    const filter = orgFilter(req);
    if (!['admin', 'accountant', 'superadmin'].includes(req.user.role)) filter.status = 'active';
    const items = await PaymentMode.find(filter).sort({ name: 1 });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRoles('admin'), async (req, res, next) => {
  try {
    const { name, ledgerAccount = 'cash', requiresReference = false } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const mode = await PaymentMode.create({
      organizationId: req.orgId,
      name: String(name).trim(),
      ledgerAccount,
      requiresReference: !!requiresReference,
    });
    audit(req, 'payment_mode.create', { entityType: 'PaymentMode', entityId: mode._id });
    res.status(201).json({ paymentMode: mode });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireRoles('admin'), async (req, res, next) => {
  try {
    const mode = await PaymentMode.findOne(orgFilter(req, { _id: req.params.id }));
    if (!mode) return res.status(404).json({ error: 'Payment mode not found' });
    for (const key of ['name', 'ledgerAccount', 'requiresReference', 'status']) {
      if (req.body[key] !== undefined) mode[key] = req.body[key];
    }
    await mode.save();
    audit(req, 'payment_mode.update', { entityType: 'PaymentMode', entityId: mode._id });
    res.json({ paymentMode: mode });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
