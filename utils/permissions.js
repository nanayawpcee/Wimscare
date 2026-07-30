// Central permission catalogue. Roles get a default set of permissions;
// admins may grant/revoke individual permissions per user on top of that
// default (stored on User.permissions). admin/superadmin always pass every
// check regardless of the stored list.
const PERMISSIONS = [
  'manage_users',
  'invite_users',
  'manage_permissions',
  'view_contributions',
  'record_contributions',
  'view_accounts',
  'manage_accounts',
  'view_claims',
  'process_claims',
  'approve_claims',
  'view_reports',
  'manage_backups',
];

const ROLE_DEFAULTS = {
  admin: [...PERMISSIONS],
  superadmin: [...PERMISSIONS],
  accountant: [
    'view_contributions', 'record_contributions',
    'view_accounts', 'manage_accounts',
    'view_claims', 'process_claims',
    'view_reports',
  ],
  supervisor: [
    'view_contributions', 'record_contributions',
    'view_accounts',
    'view_claims', 'process_claims',
    'view_reports',
  ],
  user: [],
};

function hasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'superadmin') return true;
  if (Array.isArray(user.permissions) && user.permissions.includes(key)) return true;
  return (ROLE_DEFAULTS[user.role] || []).includes(key);
}

function effectivePermissions(user) {
  return PERMISSIONS.filter((key) => hasPermission(user, key));
}

module.exports = { PERMISSIONS, ROLE_DEFAULTS, hasPermission, effectivePermissions };
