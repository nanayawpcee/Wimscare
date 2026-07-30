const cron = require('node-cron');
const License = require('../models/License');
const Organization = require('../models/Organization');
const Invitation = require('../models/Invitation');
const { createOrgBackup } = require('../utils/backupService');

// Surfaced on the superadmin console's system-health panel.
const state = { started: false };

function startScheduler() {
  state.started = true;
  // Hourly: expire licenses and stale invitations.
  cron.schedule('15 * * * *', async () => {
    try {
      const now = new Date();
      const { modifiedCount } = await License.updateMany(
        { status: 'active', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } }
      );
      if (modifiedCount) console.log(`[cron] expired ${modifiedCount} license(s)`);
      await Invitation.updateMany(
        { status: 'sent', expiresAt: { $lte: now } },
        { $set: { status: 'expired' } }
      );
    } catch (err) {
      console.error('[cron] license sweep failed:', err.message);
    }
  });

  // Nightly (configurable): automatic backup of every active organization.
  const backupCron = process.env.BACKUP_CRON || '0 2 * * *';
  cron.schedule(backupCron, async () => {
    try {
      const orgs = await Organization.find({ status: 'active' }).select('_id name');
      for (const org of orgs) {
        try {
          await createOrgBackup(org._id, { trigger: 'scheduled' });
          console.log(`[cron] backup completed for ${org.name}`);
        } catch (err) {
          console.error(`[cron] backup failed for ${org.name}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[cron] scheduled backups failed:', err.message);
    }
  });

  console.log(`[cron] scheduler started (backups: "${backupCron}")`);
}

module.exports = { startScheduler, schedulerState: state };
