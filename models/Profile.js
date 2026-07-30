const mongoose = require('mongoose');

const familyMemberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    relationship: { type: String, required: true, trim: true },
    dateOfBirth: { type: Date },
    phone: { type: String, trim: true },
    isBeneficiary: { type: Boolean, default: false },
  },
  { _id: true }
);

const profileSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    personal: {
      dateOfBirth: { type: Date },
      gender: { type: String, enum: ['male', 'female', 'other', ''], default: '' },
      nationalId: { type: String, trim: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      region: { type: String, trim: true },
      occupation: { type: String, trim: true },
      maritalStatus: { type: String, enum: ['single', 'married', 'divorced', 'widowed', ''], default: '' },
    },
    bank: {
      bankName: { type: String, trim: true },
      branch: { type: String, trim: true },
      accountName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      mobileMoneyProvider: { type: String, trim: true },
      mobileMoneyNumber: { type: String, trim: true },
    },
    emergencyContact: {
      name: { type: String, trim: true },
      relationship: { type: String, trim: true },
      phone: { type: String, trim: true },
    },
    family: [familyMemberSchema],
  },
  { timestamps: true }
);

profileSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Profile', profileSchema);
