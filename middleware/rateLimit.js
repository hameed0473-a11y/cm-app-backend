// ---------------------------------------------------------------
// SECURITY — In-memory rate limiting
// Moved unchanged from routes/auth.js. Kept as ONE shared store
// (rateLimitStore) that every route file imports via rateLimit() —
// each route file declaring its own Map would silently fragment
// this protection instead of sharing one counter per IP+path.
// ---------------------------------------------------------------
const rateLimitStore = new Map();

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, []);
    }

    // Remove old entries outside window
    const requests = rateLimitStore.get(key).filter(t => t > windowStart);
    requests.push(now);
    rateLimitStore.set(key, requests);

    if (requests.length > maxRequests) {
      return res.status(429).json({
        error: 'Too many requests. Please wait a moment and try again.'
      });
    }
    next();
  };
}

// Clean up old rate limit entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, times] of rateLimitStore.entries()) {
    const fresh = times.filter(t => t > cutoff);
    if (fresh.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, fresh);
  }
}, 10 * 60 * 1000);

module.exports = { rateLimit };
