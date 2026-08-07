// Single source of truth for which Terms & Data Policy version is currently
// in force. Bumping this re-prompts every signed-in user at their next
// request (see public/js/app.js requireSession) even if they'd already
// accepted an older version — routes/auth.js stamps this value onto
// acceptedTermsVersion whenever a user accepts, and middleware/auth.js
// refuses everything but the endpoints needed to accept until they have.
const TERMS_VERSION = '2026-07-26';

// Shown in the re-acceptance modal, above the link to the full text. It
// describes WHAT CHANGED in this version, so it belongs next to the version
// string rather than in the frontend — the two have to be updated together
// or the modal ends up describing a previous revision. Keep it to a sentence
// or two; the detail lives in public/terms.html.
const TERMS_SUMMARY =
  "We've updated how we describe account and data handling on WIMScare — including what happens to your records if an account is ever deleted. Please review and accept before continuing.";

// The stamp for a user who has just accepted the current version: `fields`
// is the current-state denormalization the gate compares against, `entry` is
// the append-only history row that goes with it. One call so both carry the
// same timestamp.
function acceptance(at = new Date()) {
  return {
    fields: { acceptedTermsAt: at, acceptedTermsVersion: TERMS_VERSION },
    entry: { version: TERMS_VERSION, at },
  };
}

// Whether this user has accepted the version currently in force.
function hasAcceptedCurrentTerms(user) {
  return !!user && user.acceptedTermsVersion === TERMS_VERSION;
}

module.exports = { TERMS_VERSION, TERMS_SUMMARY, acceptance, hasAcceptedCurrentTerms };
