const jwt = require('jsonwebtoken');
require('dotenv').config();

// ---------------------------------------------------------------
// Admin auth middleware — moved unchanged from routes/auth.js.
// ---------------------------------------------------------------
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------
// Pro Web Dashboard auth middleware — moved unchanged from
// routes/auth.js.
// ---------------------------------------------------------------
function requireProWebToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'pro_web') return res.status(403).json({ error: 'Invalid token type' });
    req.proMobile = decoded.mobile;
    req.proUserId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------
// Pro APP token middleware — protects /pro/sync (called by the
// mobile app itself, not the website). Accepts tokens issued at
// login time by /pro/register, /pro/login, /verify-password, and
// /verify-mpin. Separate from requireProWebToken so a website
// session token can never be reused to touch /pro/sync directly.
// Moved unchanged from routes/auth.js.
// ---------------------------------------------------------------
function requireProToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    console.log('requireProToken: no token provided —', req.method, req.originalUrl);
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'pro_app' && decoded.type !== 'pro_web') {
      console.log('requireProToken: invalid token type —', decoded.type);
      return res.status(403).json({ error: 'Invalid token type' });
    }
    req.proMobile = decoded.mobile;
    req.proUserId = decoded.userId;
    next();
  } catch (err) {
    console.log('requireProToken: invalid/expired token —', err?.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function issueProAppToken(userId, mobile) {
  return jwt.sign({ type: 'pro_app', userId, mobile }, process.env.JWT_SECRET, { expiresIn: '90d' });
}

module.exports = { requireAdmin, requireProWebToken, requireProToken, issueProAppToken };
