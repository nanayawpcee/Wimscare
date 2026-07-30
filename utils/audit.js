const AuditLog = require('../models/AuditLog');

// Fire-and-forget audit trail. Never blocks or fails the main request.
function audit(req, action, { entityType, entityId, detail } = {}) {
  AuditLog.create({
    organizationId: req.orgId || null,
    actorId: req.user ? req.user._id : null,
    action,
    entityType,
    entityId,
    detail,
    ip: req.ip,
  }).catch((err) => console.error('[audit] failed:', err.message));
}

module.exports = { audit };
