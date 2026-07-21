const jwt = require('jsonwebtoken');
require('dotenv').config();

const supabase = require('../lib/supabase');

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

// ownerMobile is embedded at issuance (set once, at login) so
// requireProOrStaffToken can populate req.proMobile for a staff
// request without an extra DB round trip on every call — same trust
// model as the other tokens here, which also carry data set at login.
function issueStaffToken(staffId, ownerUserId, staffUserId, name, ownerMobile) {
  return jwt.sign({ type: 'pro_staff', staffId, ownerUserId, staffUserId, name, ownerMobile }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// ---------------------------------------------------------------
// STAFF-AWARE auth — deliberately opt-in, route by route. Every
// existing requireProToken/requireProWebToken call site keeps
// rejecting `pro_staff` tokens exactly as before (their type checks
// only ever matched 'pro_app'/'pro_web'), so a staff account is
// default-denied everywhere. Only the handful of endpoints a staff
// member is actually allowed to use (dashboard read, add contributor,
// subscribe-to-goal, collect payment) should use this instead.
//
// Sets req.proUserId to the OWNER's id in both cases, so downstream
// handlers keep reading/writing the owner's pro_user_data exactly as
// they do today — a staff member always operates on their owner's
// data, never their own. req.isStaff / req.staffId / req.staffName
// let a handler attribute an action (e.g. collectedBy on a receipt)
// to the actual staff member.
//
// Staff status is re-checked against the DB on every request (not
// just trusted from the JWT) so disabling/removing a staff account
// takes effect immediately, not just at their next login.
// req.proMobile comes from the JWT (set at issuance), so endpoints
// that compare a request body/query `mobile` against req.proMobile
// (e.g. /pro/sync's ownership check) work for staff too.
// ---------------------------------------------------------------
async function requireProOrStaffToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type === 'pro_web' || decoded.type === 'pro_app') {
      req.proMobile = decoded.mobile;
      req.proUserId = decoded.userId;
      req.isStaff = false;
      return next();
    }
    if (decoded.type === 'pro_staff') {
      const { data: staff } = await supabase
        .from('staff_users')
        .select('id, owner_user_id, name, staff_user_id, status')
        .eq('id', decoded.staffId)
        .single();
      if (!staff || staff.status !== 'active') {
        return res.status(403).json({ error: 'This staff account is no longer active.' });
      }
      req.proUserId = staff.owner_user_id;
      req.proMobile = decoded.ownerMobile;
      req.isStaff = true;
      req.staffId = staff.id;
      req.staffName = staff.name;
      req.staffUserId = staff.staff_user_id;
      return next();
    }
    return res.status(403).json({ error: 'Invalid token type' });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAdmin, requireProWebToken, requireProToken, requireProOrStaffToken, issueProAppToken, issueStaffToken };
