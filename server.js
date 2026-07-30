require('dotenv').config();
const app = require('./app');
const { connectDB } = require('./config/db');
const { startScheduler } = require('./jobs/scheduler');
const { ensureSuperadmin } = require('./utils/bootstrap');

const PORT = process.env.PORT || 5000;

connectDB()
  .then(async () => {
    await ensureSuperadmin();
    // Make sure this month's rotating superadmin password exists.
    await require('./utils/superadminCredentials').ensureCredential();
    startScheduler();
    app.listen(PORT, () => console.log(`[server] WIMScare running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('[boot] failed to start:', err.message);
    process.exit(1);
  });

module.exports = app;
