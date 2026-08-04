function normalizeDashboardList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

function normalizeDashboardSummary(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.summary)) return value.summary;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

module.exports = {
  normalizeDashboardList,
  normalizeDashboardSummary,
};
