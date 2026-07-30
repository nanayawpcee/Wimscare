# WIMScare — Welfare Information Management System

A multi-tenant contribution tracker for welfare associations: member contributions, benefit claims with approval workflows, double-entry accounting ledger, reports, license plans and backups.

**Stack:** Node.js + Express · MongoDB + Mongoose · Vanilla HTML/CSS/JS · JWT in HTTP-only cookies

## Quick start

```bash
# 1. MongoDB must be running locally (or set MONGO_URI in .env)
cp .env.example .env          # then edit JWT_SECRET etc.
npm install
npm run seed                  # demo organization + users (optional)
npm run dev                   # http://localhost:5001
npm test                      # unit tests (node:test)
```

### Seeded logins (password: `Password!234`)

| Role       | Email                              |
|------------|------------------------------------|
| Admin      | kwame.asante@unitywelfare.org      |
| Supervisor | efua.boateng@unitywelfare.org      |
| Accountant | yaw.mensah@unitywelfare.org        |
| Member     | abena.owusu@example.com            |
| Superadmin | from `.env` (`SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD`) |

In development (no SMTP configured) activation/reset emails are printed to the server console instead of being sent.

## Folder structure

```
server.js               Express bootstrap (helmet, rate limits, static hosting)
config/db.js            Mongoose connection
models/                 Organization, User, Profile, Contribution, Claim,
                        ClaimType, LedgerEntry, PaymentMode, License,
                        Invitation, ReversalRequest, Backup, AuditLog,
                        SystemUpdate, SuperadminCredential
middleware/             auth (JWT cookie, roles, permissions, plan features,
                        maintenance mode), upload (multer+sharp), errors
routes/                 auth, users, contributions, claims, claim-types, profile,
                        dashboard, payment-modes, reversals, invitations,
                        reports (PDF/XLSX), accounting, fund-accounts, backups,
                        organization, developer
utils/                  plans (tiers/features/seat caps), email, audit,
                        backupService, permissions, superadminCredentials
jobs/scheduler.js       node-cron: license expiry sweep, nightly org backups
scripts/seed.js         demo data
test/                   node:test unit tests (plans, ledger math, claim chain)
public/                 vanilla HTML/CSS/JS frontend
  member/               member portal (mobile-responsive)
  admin/                admin console (Administrator/Supervisor/Accountant)
  developer/            superadmin console
uploads/                per-organization file uploads   (gitignored)
backups/                gzipped JSON org snapshots incl. files (gitignored)
```

## Multi-tenancy

- Every tenant model carries an indexed `organizationId`; queries always filter through `orgFilter(req)`.
- The same email can exist in several organizations (e.g. a hospital fund and a church fund on one deployment), each with its own password. The login page detects this and asks for the institution — a typeahead over that email's organizations — before the password.
- The superadmin (`role: superadmin`, `organizationId: null`) passes every gate and may act on a tenant via the `X-Org-Id` header ("Open as superadmin" in the console).

## License plans

`utils/plans.js` defines three tiers; the superadmin console issues licenses per organization:

| | Free | Standard | Pro |
|---|---|---|---|
| Staff / members | 3 / 100 | 15 / 500 | 100 / 5,000 |
| Contributions + claims | ✓ | ✓ | ✓ |
| Accounting workspace + reports | — | ✓ | ✓ |
| Audit trail, API access, multi-facility | — | — | ✓ |
| Interface branding (logo, name, 3 colours) | — | — | ✓ |

- Enforcement is two-sided: `requireFeature()` middleware on the API, nav/tab hiding in the UI. Seat caps count users **and open invitations**.
- Legacy plans (trial/professional/enterprise/premium) are grandfathered with all features.
- Pro branding: `WIMS.applyBranding` recolours the design system from facility colours and swaps in the org's uploaded logo + short name across both consoles.

## Superadmin console (`/developer/`)

Overview (stats, health, activity) · Licenses (issue/renew/suspend/cancel, feature flags) · Organizations (open-as, backups) · Credentials (monthly rotating password with 5-day grace; seeded password stays as fallback) · Backups (download/restore any org) · Audit log · System updates.

## Key flows

- **Activation:** admin creates user or sends invites (seat-capped) → hashed token → email link → `/activate.html` sets password.
- **Claims:** member drafts → uploads documents → submits → approval chain (`supervisor → accountant → admin`, or short `admin`/`committee` chains) → each stage sees a "your turn" dashboard banner → final approval banners for the member → accountant prepares payout, admin releases → double-entry posted to ledger.
- **Contributions:** staff records payment → receipt number + email receipt → debit cash/bank/momo, credit contributions.
- **Reversals:** accountant/supervisor requests → admin decides → approved reversals post mirror-image ledger entries.
- **Backups:** manual or nightly cron; gzipped JSON per organization **including uploaded files**; restore is destructive and requires typing `RESTORE`.
- **Maintenance mode:** an admin toggle (Profile → System settings) that 503s every non-admin request and blocks non-admin sign-ins until switched off.

## Security notes

- Helmet headers (CSP off — pages inline their styles/scripts), per-IP rate limits on login/password/lookup endpoints and a general `/api` ceiling.
- Passwords bcrypt-hashed; activation/reset/invite tokens stored hashed; JWT in an HTTP-only cookie.
- Role gates + a 12-key permission catalogue with per-user overrides; privilege-escalation guards keep role changes and restores admin-only.
- Every sensitive action lands in the tenant-scoped audit log.
