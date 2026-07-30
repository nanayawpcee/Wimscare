const express = require('express');
const { schedulerState, runLicenseSweep, runNightlyBackups } = require('../jobs/scheduler');

const router = express.Router();

// Vercel invokes cron paths with `Authorization: Bearer $CRON_SECRET`
// automatically once CRON_SECRET is set as an env var. Reject anything else
// so this endpoint can't be triggered by a random request.
function requireCronSecret(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/cron/daily — combines the hourly license/invitation sweep and the
// nightly org backups into a single once-a-day job, since Vercel's Hobby
// plan only allows cron schedules with daily (not hourly) granularity.
router.get('/daily', requireCronSecret, async (req, res) => {
  await runLicenseSweep();
  await runNightlyBackups();
  schedulerState.lastRun = new Date();
  res.json({ ok: true, ranAt: schedulerState.lastRun });
});

module.exports = router;
