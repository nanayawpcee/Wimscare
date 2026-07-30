const License = require('../models/License');
const Organization = require('../models/Organization');
const Invitation = require('../models/Invitation');
const { createOrgBackup } = require('../utils/backupService');

// Surfaced on the superadmin console's system-health panel.
const state = { started: false, mode: null, lastRun: null };

// Expire licenses and stale invitations.
async function runLicenseSweep() {
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
}

// Automatic backup of every active organization.
async function runNightlyBackups() {
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
}

// On a persistent host (Render, local dev) this drives node-cron directly.
// On Vercel there's no long-running process for node-cron to live in — the
// same two functions above are instead invoked once daily by Vercel Cron via
// routes/cron.js (see vercel.json), so this becomes a no-op there.
function startScheduler() {
  if (process.env.VERCEL) {
    state.started = true;
    state.mode = 'vercel-cron';
    console.log('[cron] running on Vercel — node-cron skipped, routes/cron.js handles scheduling instead');
    return;
  }

  const cron = require('node-cron');
  state.started = true;
  state.mode = 'node-cron';

  cron.schedule('15 * * * *', runLicenseSweep);

  const backupCron = process.env.BACKUP_CRON || '0 2 * * *';
  cron.schedule(backupCron, runNightlyBackups);

  console.log(`[cron] scheduler started (backups: "${backupCron}")`);
}

module.exports = { startScheduler, runLicenseSweep, runNightlyBackups, schedulerState: state };
