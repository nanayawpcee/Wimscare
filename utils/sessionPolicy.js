// How long a signed-in session may sit idle before the client signs it out.
// Set per organization (Profile → System settings → Session timeout), read by
// the idle timer in public/js/app.js via /api/auth/me.
//
// These bounds are the contract between three places that used to each carry
// their own copy of the numbers: the schema default, the PATCH validator, and
// the client's sanity-check on the value it caches.
const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;
const MIN_SESSION_TIMEOUT_MINUTES = 5;
const MAX_SESSION_TIMEOUT_MINUTES = 480;

// Returns the value when it's a usable number inside the bounds, else null —
// so callers can tell "not supplied / nonsense" from a legitimate setting.
function validSessionTimeout(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_SESSION_TIMEOUT_MINUTES || n > MAX_SESSION_TIMEOUT_MINUTES) return null;
  return n;
}

module.exports = {
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  MIN_SESSION_TIMEOUT_MINUTES,
  MAX_SESSION_TIMEOUT_MINUTES,
  validSessionTimeout,
};
