// One-time-per-boot setup shared by the persistent server (server.js) and
// the Vercel serverless entrypoint (api/index.js).
async function ensureSuperadmin() {
  const User = require('../models/User');
  const email = (process.env.SUPERADMIN_EMAIL || 'developer@wimscare.app').toLowerCase();
  const existing = await User.findOne({ role: 'superadmin', email });
  if (existing) return;
  const [firstName, ...rest] = (process.env.SUPERADMIN_NAME || 'WIMScare Developer').split(' ');
  const superadmin = new User({
    organizationId: null,
    firstName,
    lastName: rest.join(' ') || 'Admin',
    email,
    role: 'superadmin',
    status: 'active',
  });
  await superadmin.setPassword(process.env.SUPERADMIN_PASSWORD || 'ChangeMe!2026');
  await superadmin.save();
  console.log(`[boot] superadmin created: ${email}`);
}

module.exports = { ensureSuperadmin };
