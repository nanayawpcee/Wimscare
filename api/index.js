require('dotenv').config();
const app = require('../app');
const { connectDB } = require('../config/db');
const { startScheduler } = require('../jobs/scheduler');
const { ensureSuperadmin } = require('../utils/bootstrap');

// Runs once per cold start, then the same module-scope promise is reused by
// every request handled by this warm function instance.
let readyPromise = null;

function ready() {
  if (!readyPromise) {
    readyPromise = connectDB()
      .then(async () => {
        await ensureSuperadmin();
        await require('../utils/superadminCredentials').ensureCredential();
        startScheduler(); // no-op on Vercel — see jobs/scheduler.js
      })
      .catch((err) => {
        readyPromise = null; // let the next request retry instead of wedging forever
        throw err;
      });
  }
  return readyPromise;
}

module.exports = async (req, res) => {
  try {
    await ready();
  } catch (err) {
    console.error('[boot] failed to initialize:', err.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
    return;
  }
  return app(req, res);
};
