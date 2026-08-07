// The department list offered when assigning a member, and the dimension
// reports group by (routes/reports.js — "Members by department" and
// "Contributions by department").
//
// Organizations start from this hospital-oriented catalogue and extend it:
// an administrator adding a department writes to Organization.departments,
// and from that point the organization's own list is the one in force. An
// organization that has never customized the list has no `departments`
// array, so it falls through to these defaults — which means changing this
// file changes what those organizations see, and is the intended way to
// improve the starting set.
//
// Note this is unrelated to AccountEntry.department, an accounting bucket
// that happens to share the name.
const DEFAULT_DEPARTMENTS = [
  // Clinical
  'Accident & Emergency',
  'Anaesthesia',
  'Cardiology',
  'Dental',
  'Dermatology',
  'Dietetics & Nutrition',
  'Ear, Nose & Throat',
  'General Surgery',
  'Internal Medicine',
  'Intensive Care',
  'Laboratory',
  'Maternity',
  'Mental Health',
  'Neurology',
  'Nursing',
  'Obstetrics & Gynaecology',
  'Oncology',
  'Ophthalmology',
  'Orthopaedics',
  'Paediatrics',
  'Pharmacy',
  'Physiotherapy',
  'Public Health',
  'Radiology',
  'Theatre',
  'Urology',
  // Non-clinical
  'Administration',
  'Catering',
  'Finance',
  'Health Records',
  'Housekeeping',
  'Human Resources',
  'Information Technology',
  'Maintenance',
  'Procurement & Stores',
  'Security',
  'Transport',
];

// An organization's effective list: its own once it has one, the defaults
// until then. Always sorted, so the dropdown reads predictably however the
// custom entries were added.
function departmentsFor(org) {
  const own = org && Array.isArray(org.departments) ? org.departments : [];
  const list = own.length ? own : DEFAULT_DEPARTMENTS;
  return [...list].sort((a, b) => a.localeCompare(b));
}

// Normalizes a submitted department name: trims, collapses inner whitespace
// and caps the length. Returns '' for anything that isn't usable.
function normalizeDepartment(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

module.exports = { DEFAULT_DEPARTMENTS, departmentsFor, normalizeDepartment };
