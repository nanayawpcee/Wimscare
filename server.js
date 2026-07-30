require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { connectDB } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { startScheduler } = require('./jobs/scheduler');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- Global middleware ---
app.use(cors({ origin: process.env.APP_URL || true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Security headers. CSP is left off: every page inlines its styles/scripts
// and loads Google Fonts, so a real policy needs a dedicated pass; helmet's
// remaining headers (nosniff, frame denial, referrer policy, HSTS behind
// HTTPS, etc.) apply as-is.
app.use(helmet({ contentSecurityPolicy: false }));

// Credential endpoints get tight per-IP limits; everything else under /api
// shares a generous safety net against runaway clients.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes' },
});
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests — try again in a few minutes' },
});
// OTP send/verify: tighter than the general auth limiter since a code is
// only 6 digits and both sending and guessing need to be curbed.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a few minutes' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down a little' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
// Pre-login email → institutions lookup: also an enumeration surface.
app.use('/api/auth/organizations', lookupLimiter);
app.use('/api/auth/login-otp', otpLimiter);
app.use('/api/profile/phone/send-otp', otpLimiter);
app.use('/api/profile/phone/verify-otp', otpLimiter);
app.use('/api', apiLimiter);

// --- API routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/claims', require('./routes/claims'));
app.use('/api/claim-types', require('./routes/claimTypes'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/payment-modes', require('./routes/paymentModes'));
app.use('/api/reversals', require('./routes/reversals'));
app.use('/api/invitations', require('./routes/invitations'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/accounts', require('./routes/accountEntries'));
app.use('/api/fund-accounts', require('./routes/fundAccounts'));
app.use('/api/organization', require('./routes/organization'));
app.use('/api/backups', require('./routes/backup'));
app.use('/api/developer', require('./routes/developer'));

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- Static frontend ---
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));

app.use('/api', notFound);
app.use(errorHandler);

// --- Bootstrap superadmin on first boot ---
async function ensureSuperadmin() {
  const User = require('./models/User');
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
