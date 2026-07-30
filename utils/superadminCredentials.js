const crypto = require('crypto');
const SuperadminCredential = require('../models/SuperadminCredential');

// Monthly rotating superadmin password with a grace period: for the first
// GRACE_DAYS of a new month the previous month's password still works, so a
// rotation never locks anyone out mid-handover. The seeded superadmin
// password (SUPERADMIN_PASSWORD) is checked separately in the login route
// and always remains valid.
const GRACE_DAYS = 5;

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function previousMonthKey(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  return monthKey(d);
}

// Readable but strong: Xxxx#0000xXx style, ~62 bits from crypto randomness.
function generatePassword() {
  const consonants = 'bcdfghjkmnpqrstvwxz';
  const vowels = 'aeiou';
  const symbols = '!@#$%&*';
  const pick = (set) => set[crypto.randomInt(set.length)];
  let word = '';
  for (let i = 0; i < 3; i += 1) word += pick(consonants) + pick(vowels);
  word = word[0].toUpperCase() + word.slice(1);
  const digits = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${word}${pick(symbols)}${digits}${pick(consonants).toUpperCase()}${pick(vowels)}`;
}

// Fetch-or-create the credential for the given month.
async function ensureCredential(month = monthKey()) {
  let cred = await SuperadminCredential.findOne({ month });
  if (!cred) {
    try {
      cred = await SuperadminCredential.create({ month, password: generatePassword() });
      console.log(`[credentials] superadmin password rotated for ${month}`);
    } catch (err) {
      // Concurrent creation (two requests racing on a new month): re-read.
      if (err.code === 11000) cred = await SuperadminCredential.findOne({ month });
      else throw err;
    }
  }
  return cred;
}

// Current credential plus the dates the console displays.
async function getCurrent(now = new Date()) {
  const cred = await ensureCredential(monthKey(now));
  const validThrough = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const graceEnds = new Date(now.getFullYear(), now.getMonth() + 1, GRACE_DAYS);
  return { month: cred.month, password: cred.password, validThrough, graceEnds, graceDays: GRACE_DAYS };
}

// True when the supplied password matches this month's credential, or last
// month's while still inside the grace window.
async function verifyMonthlyPassword(password, now = new Date()) {
  if (!password) return false;
  const current = await ensureCredential(monthKey(now));
  if (password === current.password) return true;
  if (now.getDate() <= GRACE_DAYS) {
    const prev = await SuperadminCredential.findOne({ month: previousMonthKey(now) });
    if (prev && password === prev.password) return true;
  }
  return false;
}

module.exports = { GRACE_DAYS, monthKey, ensureCredential, getCurrent, verifyMonthlyPassword };
