const DEFAULT_SHORTAGE_RATE = 0.02;
const DEFAULT_SHORTAGE_SLAB_PERCENT = 2;

function normalizeShortagePercent(rawValue) {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === "") {
    return null;
  }

  const num = Number(rawValue);
  if (!Number.isFinite(num)) {
    return null;
  }

  // The company account field stores percentage-as-number, e.g. 1, 50, 0.75.
  // Convert it to a ratio for the shared shortage formula.
  return Math.max(0, num / 100);
}

function getAutoShortageRate(monthsDiff) {
  const slabIndex = Math.max(0, Math.ceil((Number(monthsDiff) || 1) / 1) - 1);
  return (DEFAULT_SHORTAGE_SLAB_PERCENT * (slabIndex + 1)) / 100;
}

function resolveShortageRate(rawValue) {
  const normalized = normalizeShortagePercent(rawValue);
  return normalized === null ? null : normalized;
}

function calculateAppliedShortageRate(rawValue, monthsDiff) {
  // Empty/manual-unset → automatic 2% per month slab. Explicit company % stays flat.
  const baseRate =
    rawValue === null || rawValue === undefined || String(rawValue).trim() === ""
      ? getAutoShortageRate(monthsDiff)
      : resolveShortageRate(rawValue);
  return Number((baseRate || 0).toFixed(4));
}

function calculateShortageQty(grossQty, monthsDiff, rawValue) {
  const qty = Number(grossQty) || 0;
  const rate = calculateAppliedShortageRate(rawValue, monthsDiff);
  return Number((qty * rate).toFixed(4));
}

module.exports = {
  DEFAULT_SHORTAGE_RATE,
  DEFAULT_SHORTAGE_SLAB_PERCENT,
  normalizeShortagePercent,
  getAutoShortageRate,
  resolveShortageRate,
  calculateAppliedShortageRate,
  calculateShortageQty,
};
