// ---------------------------------------------------------------
// SECURITY — In-memory brute-force protection
// Moved unchanged from routes/auth.js. Kept as ONE shared store
// (bruteForceStore) — imported by mpinDevice.js, emailOtp.js, and
// web.js so a locked-out identifier (e.g. "mpin:9876543210") is
// tracked in exactly one place, same as it was in the monolithic
// file. Splitting this into per-file stores would silently weaken
// the lockout that protects Pro accounts.
// ---------------------------------------------------------------
const bruteForceStore = new Map();

function checkBruteForce(identifier, maxAttempts, lockoutMs) {
  const now = Date.now();
  const record = bruteForceStore.get(identifier) || { count: 0, lockedUntil: 0 };

  if (record.lockedUntil > now) {
    const remainingMins = Math.ceil((record.lockedUntil - now) / 60000);
    return { blocked: true, message: `Too many failed attempts. Try again in ${remainingMins} minute(s).` };
  }

  return { blocked: false, record };
}

function recordFailedAttempt(identifier, maxAttempts, lockoutMs) {
  const record = bruteForceStore.get(identifier) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= maxAttempts) {
    record.lockedUntil = Date.now() + lockoutMs;
    record.count = 0;
  }
  bruteForceStore.set(identifier, record);
}

function clearBruteForce(identifier) {
  bruteForceStore.delete(identifier);
}

module.exports = { checkBruteForce, recordFailedAttempt, clearBruteForce };
