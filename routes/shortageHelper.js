const DEFAULT_SHORTAGE_RATE = 0.02;

function normalizeShortagePercent(rawValue) {
  const num = Number(rawValue);
  if (!Number.isFinite(num) || num === 0) {
    return null;
  }

  // The company account field stores percentage-as-number, e.g. 1, 50, 0.75.
  // Convert it to a ratio for the shared shortage formula.
  return Math.max(0, num / 100);
}

function resolveShortageRate(rawValue) {
  const normalized = normalizeShortagePercent(rawValue);
  return normalized === null ? DEFAULT_SHORTAGE_RATE : normalized;
}

function calculateShortageQty(grossQty, monthsDiff, rawValue) {
  const qty = Number(grossQty) || 0;
  const months = Number(monthsDiff) || 1;
  const rate = resolveShortageRate(rawValue);
  return Number((qty * rate * months).toFixed(4));
}

module.exports = {
  DEFAULT_SHORTAGE_RATE,
  normalizeShortagePercent,
  resolveShortageRate,
  calculateShortageQty,
};
