/* Seeds a demo organization with members, contributions and claims.
   Run: npm run seed */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Profile = require('../models/Profile');
const Contribution = require('../models/Contribution');
const Claim = require('../models/Claim');
const ClaimType = require('../models/ClaimType');
const PaymentMode = require('../models/PaymentMode');
const License = require('../models/License');
const LedgerEntry = require('../models/LedgerEntry');
const ReversalRequest = require('../models/ReversalRequest');
const FundAccount = require('../models/FundAccount');

const PASSWORD = 'Password!234';

async function main() {
  await connectDB();

  const existing = await Organization.findOne({ name: 'Unity Welfare Association' });
  if (existing) {
    console.log('Demo organization already exists. Wiping and re-seeding…');
    const orgId = existing._id;
    await Promise.all([
      User.deleteMany({ organizationId: orgId }),
      Profile.deleteMany({ organizationId: orgId }),
      Contribution.deleteMany({ organizationId: orgId }),
      Claim.deleteMany({ organizationId: orgId }),
      ClaimType.deleteMany({ organizationId: orgId }),
      PaymentMode.deleteMany({ organizationId: orgId }),
      License.deleteMany({ organizationId: orgId }),
      LedgerEntry.deleteMany({ organizationId: orgId }),
      ReversalRequest.deleteMany({ organizationId: orgId }),
      Organization.deleteOne({ _id: orgId }),
    ]);
  }

  const org = await Organization.create({
    name: 'Unity Welfare Association',
    code: 'UNITY-WELFARE',
    contactEmail: 'admin@unitywelfare.org',
    settings: { monthlyDueAmount: 150 },
  });

  const mkUser = async (firstName, lastName, email, role, extra = {}) => {
    const u = new User({ organizationId: org._id, firstName, lastName, email, role, status: 'active', ...extra });
    await u.setPassword(PASSWORD);
    await u.save();
    await Profile.create({ organizationId: org._id, userId: u._id });
    return u;
  };

  const admin = await mkUser('Kwame', 'Asante', 'kwame.asante@unitywelfare.org', 'admin', { phone: '+233 24 000 0001' });
  const supervisor = await mkUser('Efua', 'Boateng', 'efua.boateng@unitywelfare.org', 'supervisor');
  const accountant = await mkUser('Yaw', 'Mensah', 'yaw.mensah@unitywelfare.org', 'accountant');
  const memberNames = [
    ['Abena', 'Owusu'], ['Kofi', 'Adjei'], ['Ama', 'Darko'], ['Kwabena', 'Osei'],
    ['Akosua', 'Agyeman'], ['Kojo', 'Antwi'], ['Adwoa', 'Frimpong'], ['Yaa', 'Asantewaa'],
  ];
  const members = [];
  for (let i = 0; i < memberNames.length; i++) {
    const [f, l] = memberNames[i];
    members.push(await mkUser(f, l, `${f.toLowerCase()}.${l.toLowerCase()}@example.com`, 'user', {
      memberNumber: `UW-${String(i + 1).padStart(4, '0')}`,
      phone: `+233 24 555 0${100 + i}`,
      department: ['Operations', 'Finance', 'Field', 'Programs'][i % 4],
    }));
  }

  const { bootstrapOrganizationDefaults } = require('../routes/auth');
  await bootstrapOrganizationDefaults(org._id, admin._id);
  const modes = await PaymentMode.find({ organizationId: org._id });
  const types = await ClaimType.find({ organizationId: org._id });

  // 12 months of contributions for each member
  let receiptSeq = 1;
  const now = new Date();
  const contributions = [];
  const ledger = [];
  for (const member of members) {
    for (let m = 11; m >= 0; m--) {
      const date = new Date(now.getFullYear(), now.getMonth() - m, 3 + Math.floor(Math.random() * 8));
      const mode = modes[Math.floor(Math.random() * modes.length)];
      const amount = Math.random() < 0.15 ? 300 : 150;
      const receiptNumber = `RCT-${date.getFullYear()}-${String(receiptSeq++).padStart(5, '0')}`;
      contributions.push({
        organizationId: org._id,
        receiptNumber,
        memberId: member._id,
        amount,
        paymentModeId: mode._id,
        method: mode.name,
        reference: mode.requiresReference ? `TX${Math.random().toString(36).slice(2, 10).toUpperCase()}` : undefined,
        note: amount > 150 ? 'Monthly dues + arrears' : 'Monthly dues',
        contributionDate: date,
        month: date.getMonth() + 1,
        year: date.getFullYear(),
        status: 'paid',
        recordedBy: [admin, accountant, supervisor][Math.floor(Math.random() * 3)]._id,
      });
    }
  }
  const saved = await Contribution.insertMany(contributions);
  const generalFund = await FundAccount.findOne({ organizationId: org._id, name: 'General Fund' });
  for (const c of saved) {
    const mode = modes.find((m) => String(m._id) === String(c.paymentModeId));
    ledger.push(
      { organizationId: org._id, entryDate: c.contributionDate, account: mode.ledgerAccount, fundAccountId: generalFund?._id, category: 'member_dues', direction: 'debit', amount: c.amount, description: `Contribution ${c.receiptNumber}`, sourceType: 'contribution', sourceId: c._id, memberId: c.memberId, createdBy: c.recordedBy },
      { organizationId: org._id, entryDate: c.contributionDate, account: 'contributions', fundAccountId: generalFund?._id, category: 'member_dues', direction: 'credit', amount: c.amount, description: `Contribution ${c.receiptNumber}`, sourceType: 'contribution', sourceId: c._id, memberId: c.memberId, createdBy: c.recordedBy }
    );
  }
  await LedgerEntry.insertMany(ledger);

  // A few claims in different states
  const medical = types.find((t) => t.slug === 'medical_support');
  const bereavement = types.find((t) => t.slug === 'bereavement_support');
  const education = types.find((t) => t.slug === 'education_grant');
  let claimSeq = 1;
  const mkClaim = async (member, type, amount, status, extra = {}) => {
    const chain = type.approvalChain === 'admin' ? ['admin'] : type.approvalChain === 'committee' ? ['committee'] : ['supervisor', 'accountant', 'admin'];
    const approvals = chain.map((step) => ({
      step,
      decision: ['approved', 'paid'].includes(status) ? 'approved' : 'pending',
      actedBy: ['approved', 'paid'].includes(status) ? admin._id : undefined,
      actedAt: ['approved', 'paid'].includes(status) ? new Date() : undefined,
    }));
    return Claim.create({
      organizationId: org._id,
      claimNumber: `CLM-${now.getFullYear()}-${String(claimSeq++).padStart(4, '0')}`,
      memberId: member._id,
      claimTypeId: type._id,
      amountRequested: amount,
      amountApproved: ['approved', 'paid'].includes(status) ? amount : undefined,
      description: `${type.name} application`,
      status,
      approvals,
      submittedAt: status !== 'draft' ? new Date(now.getTime() - 14 * 86400000) : undefined,
      timeline: [{ actor: member._id, event: 'Claim created' }, ...(status !== 'draft' ? [{ actor: member._id, event: 'Claim submitted for review' }] : [])],
      ...extra,
    });
  };
  await mkClaim(members[0], medical, 800, 'approved');
  await mkClaim(members[0], bereavement, 1200, 'paid', { paidAt: new Date(now.getTime() - 60 * 86400000) });
  await mkClaim(members[0], education, 500, 'under_review');
  await mkClaim(members[1], medical, 950, 'submitted');
  await mkClaim(members[3], education, 400, 'submitted');
  // A medical claim sitting at the accountant's step, for exercising the
  // supervisor -> accountant -> admin chain end to end.
  await Claim.create({
    organizationId: org._id,
    claimNumber: `CLM-${now.getFullYear()}-${String(claimSeq++).padStart(4, '0')}`,
    memberId: members[2]._id,
    claimTypeId: medical._id,
    amountRequested: 700,
    description: `${medical.name} application`,
    status: 'under_review',
    approvals: [
      { step: 'supervisor', decision: 'approved', actedBy: supervisor._id, actedAt: new Date(now.getTime() - 2 * 86400000), comment: 'Verified against hospital bill' },
      { step: 'accountant', decision: 'pending' },
      { step: 'admin', decision: 'pending' },
    ],
    submittedAt: new Date(now.getTime() - 3 * 86400000),
    timeline: [
      { actor: members[2]._id, event: 'Claim created' },
      { actor: members[2]._id, event: 'Claim submitted for review' },
      { actor: supervisor._id, event: 'Approved at supervisor step', note: 'Verified against hospital bill' },
    ],
  });

  // Example permission grants — Efua (supervisor) can also manage users;
  // demonstrates the Permissions & Roles page overriding role defaults.
  supervisor.permissions = ['manage_users'];
  await supervisor.save();

  // A couple of office-operations entries exercising the new categories.
  // Created one at a time (not insertMany) so nextRef() sees each prior
  // insert before computing the next sequence number.
  const AccountEntry = require('../models/AccountEntry');
  await AccountEntry.create({
    organizationId: org._id,
    ref: await AccountEntry.nextRef(org._id),
    title: '91-day Treasury bill purchase',
    category: 'investment',
    department: 'Investment Account',
    amount: 5000,
    entryDate: new Date(now.getTime() - 20 * 86400000),
    status: 'paid',
    payoutAccount: 'bank',
    preparedBy: accountant._id,
    decidedBy: admin._id,
    decidedAt: new Date(now.getTime() - 19 * 86400000),
    paidBy: accountant._id,
    paidAt: new Date(now.getTime() - 19 * 86400000),
  });
  await AccountEntry.create({
    organizationId: org._id,
    ref: await AccountEntry.nextRef(org._id),
    title: 'Bank charges reconciliation',
    category: 'other',
    department: 'General Fund',
    amount: 45,
    entryDate: new Date(now.getTime() - 5 * 86400000),
    status: 'pending',
    preparedBy: accountant._id,
  });

  console.log('\n=== Seed complete ===');
  console.log(`Organization: ${org.name}`);
  console.log(`Admin:       kwame.asante@unitywelfare.org / ${PASSWORD}`);
  console.log(`Supervisor:  efua.boateng@unitywelfare.org / ${PASSWORD} (granted: manage_users)`);
  console.log(`Accountant:  yaw.mensah@unitywelfare.org / ${PASSWORD}`);
  console.log(`Member:      abena.owusu@example.com / ${PASSWORD}`);
  console.log(`Superadmin:  ${process.env.SUPERADMIN_EMAIL || 'developer@wimscare.app'} / ${process.env.SUPERADMIN_PASSWORD || 'ChangeMe!2026'}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
