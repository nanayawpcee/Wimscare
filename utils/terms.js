// Single source of truth for which Terms & Data Policy version is currently
// in force. Bumping this re-prompts every signed-in user at their next
// request (see public/js/app.js requireSession) even if they'd already
// accepted an older version — routes/auth.js stamps this value onto
// acceptedTermsVersion whenever a user accepts.
const TERMS_VERSION = '2026-07-26';

module.exports = { TERMS_VERSION };
