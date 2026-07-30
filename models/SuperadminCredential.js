const mongoose = require('mongoose');

// One document per calendar month. The password is stored in clear text by
// design: the superadmin console must be able to reveal and copy it, and it
// is only ever readable through superadmin-guarded endpoints. The seeded
// SUPERADMIN_PASSWORD remains a permanent fallback login independent of
// these rotating credentials.
const superadminCredentialSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, unique: true }, // e.g. "2026-07"
    password: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SuperadminCredential', superadminCredentialSchema);
