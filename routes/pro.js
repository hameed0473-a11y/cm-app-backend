const express = require('express');
const bcrypt = require('bcryptjs');

const supabase = require('../lib/supabase');
const razorpay = require('../lib/razorpay');
const gateways = require('../lib/gateways');
const { rateLimit } = require('../middleware/rateLimit');
const { requireAdmin, requireProToken, issueProAppToken } = require('../middleware/auth');
const { getDefaultBreakup, getRemainingBreakup, breakupTotal } = require('../utils/arrears');
const { mirrorContribution, mirrorPledge, mirrorFullSyncBatch } = require('../utils/mirrorWrite');
const { fetchNormalizedUserData, compareUserData } = require('../utils/readFromNormalized');

const router = express.Router();

// ===============================================================
// PRO CLOUD ENDPOINTS (Supabase backed)
// ===============================================================

// ---------------------------------------------------------------
// LOOKUP DUES — public, self-service. Subscriber enters their own
// mobile number; this searches every Pro user's cloud data for a
// matching contributor/pledge and returns their pending dues across
// however many societies/goals they belong to.
//
// NOTE: deliberately unauthenticated for now (testing phase) — this
// means anyone who knows a mobile number can look up its dues, not
// just the real owner. Rate-limited to slow down scraping, but the
// underlying exposure is a known, accepted tradeoff until SMS-OTP
// verification is added later.
// ---------------------------------------------------------------
router.get('/pro/lookup-dues', rateLimit(20, 10 * 60000), async (req, res) => {
  const { mobile } = req.query;
  if (!mobile) return res.status(400).json({ error: 'mobile is required' });

  try {
    const { data: allUserData, error } = await supabase
      .from('pro_user_data')
      .select('user_id, contributors, targets, contributions, pledges');

    if (error) return res.status(500).json({ error: error.message });

    const dues = [];

    (allUserData || []).forEach(row => {
      const contributors = row.contributors || [];
      const targets = row.targets || [];
      const contributions = row.contributions || [];
      const pledges = row.pledges || [];

      // Monthly/yearly goals — via matching contributor record
      const contributor = contributors.find(c => c.mobile === mobile);
      if (contributor) {
        (contributor.targetIds || []).forEach(targetId => {
          const target = targets.find(t => t.id === targetId && t.status === 'active');
          if (!target || target.category === 'event') return;

          const fallbackAmount = contributor.targetAmounts?.[targetId] ?? 0;
          const originalBreakup = contributor.targetBreakups?.[targetId] || getDefaultBreakup(target, fallbackAmount);
          const totalPaid = contributions
            .filter(c => c.contributorId === contributor.id && c.targetId === targetId && !c.deleted)
            .reduce((s, c) => s + c.amountPaid, 0);
          const amountDue = breakupTotal(getRemainingBreakup(originalBreakup, totalPaid));

          if (amountDue > 0) {
            dues.push({
              proUserId: row.user_id,
              contributorId: contributor.id,
              targetId: target.id,
              targetName: target.name,
              targetCategory: target.category,
              contributorName: contributor.name,
              amountDue
            });
          }
        });
      }

      // Event pledges — matched directly by mobile
      pledges
        .filter(p => p.mobile === mobile && p.status !== 'fully_paid')
        .forEach(p => {
          const target = targets.find(t => t.id === p.targetId && t.status === 'active');
          if (!target) return;
          const amountDue = p.promisedAmount - p.amountPaid;
          if (amountDue > 0) {
            dues.push({
              proUserId: row.user_id,
              contributorId: p.contributorId || p.id,
              targetId: p.targetId,
              targetName: target.name,
              targetCategory: 'event',
              contributorName: p.name,
              amountDue
            });
          }
        });
    });

    res.json({ success: true, dues });
  } catch (err) {
    console.error('Lookup dues error:', err?.message || err);
    res.status(500).json({ error: 'Could not look up dues right now.' });
  }
});

// ---------------------------------------------------------------
// CREATE PAYMENT LINK (public, self-service) — subscriber-initiated,
// for the generic "enter your mobile number and pay" page. The amount
// is always recomputed fresh from current data here, never trusted
// from the client, so nobody can pay less (or more) than what the
// lookup above actually shows.
// ---------------------------------------------------------------
router.post('/pro/create-payment-link-public', rateLimit(20, 10 * 60000), async (req, res) => {
  const { proUserId, contributorId, targetId, targetCategory, mobile } = req.body;
  if (!proUserId || !contributorId || !targetId || !mobile) {
    return res.status(400).json({ error: 'proUserId, contributorId, targetId, and mobile are required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributors, targets, contributions, pledges')
      .eq('user_id', proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find this due.' });

    const targets = userData.targets || [];
    const target = targets.find(t => t.id === targetId && t.status === 'active');
    if (!target) return res.status(404).json({ error: 'This goal is no longer active.' });

    let amountDue = 0;
    let contributorName = 'Subscriber';

    if (targetCategory === 'event') {
      const pledge = (userData.pledges || []).find(p => p.targetId === targetId && p.mobile === mobile);
      if (!pledge) return res.status(404).json({ error: 'Could not find this pledge.' });
      amountDue = pledge.promisedAmount - pledge.amountPaid;
      contributorName = pledge.name;
    } else {
      const contributor = (userData.contributors || []).find(c => c.id === contributorId && c.mobile === mobile);
      if (!contributor) return res.status(404).json({ error: 'Could not find this contributor.' });
      const fallbackAmount = contributor.targetAmounts?.[targetId] ?? 0;
      const originalBreakup = contributor.targetBreakups?.[targetId] || getDefaultBreakup(target, fallbackAmount);
      const totalPaid = (userData.contributions || [])
        .filter(c => c.contributorId === contributor.id && c.targetId === targetId && !c.deleted)
        .reduce((s, c) => s + c.amountPaid, 0);
      amountDue = breakupTotal(getRemainingBreakup(originalBreakup, totalPaid));
      contributorName = contributor.name;
    }

    if (amountDue <= 0) {
      return res.status(400).json({ error: 'This due has already been paid.' });
    }

    // Pick the treasurer's gateway (caller may request one; else default).
    const provider = await gateways.resolveProvider(proUserId, req.body.provider);
    if (!provider) {
      return res.status(409).json({ error: 'Online payments are not set up for this group yet. Please pay the treasurer directly.' });
    }

    let link;
    try {
      link = await gateways.createContributionLink(proUserId, provider, {
        amountPaise: Math.round(amountDue * 100),
        description: `${target.name} — ${contributorName}`,
        notes: {
          type: 'contribution',
          proUserId,
          contributorId,
          targetId,
          targetCategory: targetCategory || 'monthly',
          mobile
        }
      });
    } catch (e) {
      if (e.message === 'gateway_not_connected') {
        return res.status(409).json({ error: 'Online payments are not set up for this group yet.' });
      }
      throw e;
    }

    // Map the link back to its owner + provider so /pro/payment-link-details can
    // fetch it from the right gateway later. Best-effort.
    supabase.from('pro_payment_links')
      .upsert({ payment_link_id: link.id, user_id: proUserId, provider, notes: { type: 'contribution', proUserId, contributorId, targetId, targetCategory: targetCategory || 'monthly', mobile } }, { onConflict: 'payment_link_id' })
      .then(({ error }) => { if (error) console.error('pro_payment_links insert (public):', error.message); });

    res.json({ success: true, payment_link_id: link.id, short_url: link.url, provider });
  } catch (err) {
    console.error('Create public payment link error:', JSON.stringify(err));
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

// ---------------------------------------------------------------
// PAYMENT LINK DETAILS — public (no login), used by the subscriber-
// facing landing page on aftechs.in. Security comes from the Razorpay
// payment_link_id being a long, unguessable ID (Razorpay generates
// it, not us) — same trust model as a password-reset link. Only
// returns a masked contributor name, never full contributor data.
// ---------------------------------------------------------------
router.get('/pro/payment-link-details', async (req, res) => {
  const { payment_link_id } = req.query;
  if (!payment_link_id) return res.status(400).json({ error: 'payment_link_id is required' });

  try {
    // Find which Pro user + gateway owns this link, then fetch from that gateway.
    const { data: linkMap } = await supabase
      .from('pro_payment_links')
      .select('user_id, provider')
      .eq('payment_link_id', payment_link_id)
      .single();

    if (!linkMap?.user_id) {
      return res.status(404).json({ error: 'Payment link not found or expired' });
    }

    const details = await gateways.fetchLinkDetails(linkMap.user_id, linkMap.provider || 'razorpay', payment_link_id);
    if (!details) {
      return res.status(404).json({ error: 'Payment link not found or expired' });
    }
    const notes = details.notes || {};

    if (notes.type !== 'contribution') {
      return res.status(404).json({ error: 'Payment link not found' });
    }

    const { proUserId, contributorId, targetId } = notes;
    const { data: userData } = await supabase
      .from('pro_user_data')
      .select('contributors, targets')
      .eq('user_id', proUserId)
      .single();

    const contributor = (userData?.contributors || []).find(c => c.id === contributorId);
    const target = (userData?.targets || []).find(t => t.id === targetId);

    const maskName = (name) => {
      if (!name) return 'Subscriber';
      return name.split(' ')
        .map(w => (w.length > 1 ? w[0] + '*'.repeat(w.length - 1) : w))
        .join(' ');
    };

    res.json({
      success: true,
      maskedName: maskName(contributor?.name),
      targetName: target?.name || 'Contribution',
      amount: details.amountPaise, // paise
      status: details.status,      // 'created' | 'paid' | 'cancelled' | 'expired'
      shortUrl: details.url,
      provider: details.provider
    });
  } catch (err) {
    console.error('Payment link details error:', err?.message || err);
    res.status(404).json({ error: 'Payment link not found or expired' });
  }
});

// ---------------------------------------------------------------
// CREATE CONTRIBUTION PAYMENT LINK — Pro-only. Lets a treasurer
// generate a payment link for one specific subscriber's pending due,
// which they then share (WhatsApp/SMS) via the app's share sheet.
// Tagged with type: 'contribution' so the webhook routes it
// correctly instead of treating it as a subscription-upgrade payment.
// ---------------------------------------------------------------
router.post('/pro/create-payment-link', requireProToken, async (req, res) => {
  const { contributorId, contributorName, mobile, targetId, targetName, targetCategory, amount } = req.body;

  if (!contributorId || !targetId || !amount) {
    return res.status(400).json({ error: 'contributorId, targetId, and amount are required' });
  }

  try {
    // Pick the treasurer's gateway (they may pass provider to choose Razorpay
    // for Indian payers vs Stripe for overseas; else the default is used).
    const provider = await gateways.resolveProvider(req.proUserId, req.body.provider);
    if (!provider) {
      return res.status(409).json({ error: 'Connect a payment gateway first — go to Integrations in the dashboard to link Razorpay or Stripe.' });
    }

    let link;
    try {
      link = await gateways.createContributionLink(req.proUserId, provider, {
        amountPaise: amount, // already paise
        description: `${targetName || 'Contribution'} — ${contributorName || 'Subscriber'}`,
        notes: {
          type: 'contribution',
          proUserId: req.proUserId,
          contributorId,
          targetId,
          targetCategory: targetCategory || 'monthly',
          mobile: mobile || ''
        }
      });
    } catch (e) {
      if (e.message === 'gateway_not_connected') {
        return res.status(409).json({ error: 'Connect a payment gateway first in Integrations.' });
      }
      throw e;
    }

    supabase.from('pro_payment_links')
      .upsert({ payment_link_id: link.id, user_id: req.proUserId, provider, notes: { type: 'contribution', proUserId: req.proUserId, contributorId, targetId, targetCategory: targetCategory || 'monthly', mobile: mobile || '' } }, { onConflict: 'payment_link_id' })
      .then(({ error }) => { if (error) console.error('pro_payment_links insert:', error.message); });

    res.json({ success: true, payment_link_id: link.id, short_url: link.url, provider });
  } catch (err) {
    console.error('Create contribution payment link error:', JSON.stringify(err));
    res.status(500).json({
      error: 'Failed to create payment link',
      detail: err?.error?.description || err?.message || String(err)
    });
  }
});

// PRO REGISTER — creates Pro user + seeds their cloud data
router.post('/pro/register', async (req, res) => {
  const { name, mobile, email, password, countryCode, initialData } = req.body;

  if (!name || !mobile || !email || !password) {
    return res.status(400).json({ error: 'All profile details are required.' });
  }

  try {
    // Check if Pro user already exists
    const { data: existing } = await supabase
      .from('pro_users')
      .select('id')
      .eq('mobile', mobile)
      .single();

    if (existing) {
      return res.status(400).json({ error: 'A Pro account with this mobile number already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUserId = `pro-${Date.now().toString().slice(-8)}`;
    const now = new Date().toISOString();

    // Insert Pro user
    const { data: newUser, error: userError } = await supabase
      .from('pro_users')
      .insert([{
        id: newUserId,
        name: name.trim(),
        mobile: mobile.trim(),
        email: email.trim().toLowerCase(),
        password: hashedPassword,
        country_code: countryCode || null,
        tier: 'pro',
        joined_at: now,
        last_login_at: now,
        // 30-day free trial — matches routes/web/auth.js's web-register.
        // This used to be 365 days here; that's why any account that
        // signed up through the app (not the website) before this fix
        // may still show far more than 30 days remaining.
        subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }])
      .select()
      .single();

    if (userError) return res.status(400).json({ error: userError.message });

    // Seed initial data
    const { error: dataError } = await supabase
      .from('pro_user_data')
      .insert([{
        user_id: newUserId,
        contributors: initialData?.contributors || [],
        targets: initialData?.targets || [],
        contributions: initialData?.contributions || [],
        pledges: initialData?.pledges || [],
        updated_at: now
      }]);

    if (dataError) {
      // Rollback user if data seed fails
      await supabase.from('pro_users').delete().eq('id', newUserId);
      return res.status(500).json({ error: 'Failed to set up your cloud data. Please try again.' });
    }

    // Also mark user as Pro in the basic users tracking table (for tier verification)
    await supabase
      .from('users')
      .update({ tier: 'pro', is_paid: true })
      .eq('mobile', mobile)
      .then(() => {}); // silent — user may not be in basic table

    const safeUser = {
      id: newUser.id,
      name: newUser.name,
      mobile: newUser.mobile,
      email: newUser.email,
      role: 'admin',
      tier: 'pro',
      joinedAt: newUser.joined_at,
      lastLoginAt: newUser.last_login_at
    };

    const seedData = {
      contributors: initialData?.contributors || [],
      targets: initialData?.targets || [],
      contributions: initialData?.contributions || [],
      pledges: initialData?.pledges || []
    };

    res.json({ success: true, user: safeUser, data: seedData, proSyncToken: issueProAppToken(newUser.id, newUser.mobile) });
  } catch (err) {
    console.error('Pro registration error:', err);
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
});

// PRO LOGIN — verifies credentials and returns user + their cloud data
router.post('/pro/login', async (req, res) => {
  const { mobile, password } = req.body;

  if (!mobile || !password) {
    return res.status(400).json({ error: 'Mobile number and password are required.' });
  }

  try {
    const { data: user, error } = await supabase
      .from('pro_users')
      .select('*')
      .eq('mobile', mobile.trim())
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'No Pro account found with this mobile number. Please register first.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    // Check subscription validity
    const isExpired = user.subscription_expires_at &&
      new Date(user.subscription_expires_at) < new Date();

    if (isExpired) {
      return res.status(403).json({
        error: 'Your Pro subscription has expired. Please renew to continue using cloud sync.',
        code: 'SUBSCRIPTION_EXPIRED'
      });
    }

    // Save previous login time before updating
    const previousLoginTime = user.last_login_at;
    const currentLoginTime = new Date().toISOString();

    // Update last login to current time
    await supabase
      .from('pro_users')
      .update({ last_login_at: currentLoginTime })
      .eq('id', user.id);

    // Fetch user's cloud data
    const { data: userData, error: dataError } = await supabase
      .from('pro_user_data')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (dataError || !userData) {
      await supabase.from('pro_user_data').insert([{
        user_id: user.id,
        contributors: [], targets: [], contributions: [], pledges: [],
        updated_at: currentLoginTime
      }]);
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      role: 'admin',
      tier: 'pro',
      joinedAt: user.joined_at,
      lastLoginAt: currentLoginTime,
      previousLoginAt: previousLoginTime, // send previous login separately
      subscriptionExpiresAt: user.subscription_expires_at
    };

    const oldData = userData || { contributors: [], targets: [], contributions: [], pledges: [] };

    // CUTOVER: serve reconstructed data from the new tables, falling back to
    // old JSON automatically if that fetch fails for any reason.
    let responseData = oldData;
    let servedFromNewTables = false;
    try {
      responseData = await fetchNormalizedUserData(supabase, user.id);
      servedFromNewTables = true;
    } catch (err) {
      console.warn('[cutover] new-table read failed on pro/login, falling back to old JSON:', err?.message || err);
    }

    res.json({
      success: true,
      user: safeUser,
      previousLogin: previousLoginTime,
      data: responseData,
      proSyncToken: issueProAppToken(user.id, user.mobile)
    });

    // Ongoing monitoring — runs AFTER the response is already sent.
    if (servedFromNewTables) {
      const diffs = compareUserData(oldData, responseData);
      if (diffs.length > 0) {
        console.warn(`[post-cutover] drift detected for user ${user.id} (pro/login):`);
        diffs.forEach(d => console.warn(`  - ${d}`));
      }
    }
  } catch (err) {
    console.error('Pro login error:', err);
    res.status(500).json({ error: 'Internal server error occurred.' });
  }
});

// PRO SYNC SAVE — saves user's latest data to cloud
router.post('/pro/sync', requireProToken, async (req, res) => {
  const { userId, mobile, contributors, targets, contributions, pledges } = req.body;

  if (!userId && !mobile) {
    return res.status(400).json({ error: 'userId or mobile is required.' });
  }
  // The token's identity must match whichever identity is being written to.
  // Without this check, a valid token for YOUR account could still be used
  // to overwrite someone else's data just by changing the mobile/userId
  // in the request body.
  if ((userId && userId !== req.proUserId) || (mobile && mobile !== req.proMobile)) {
    console.log('pro/sync POST: ownership mismatch — token:', req.proUserId, req.proMobile, 'body:', userId, mobile);
    return res.status(403).json({ error: 'Not authorized to modify this data.' });
  }

  try {
    // Verify user exists — try userId first, then mobile as fallback
    let user = null;
    let userError = null;

    if (userId) {
      const { data, error } = await supabase
        .from('pro_users')
        .select('id, mobile, subscription_expires_at')
        .eq('id', userId)
        .single();
      user = data;
      userError = error;
    }

    // Fallback to mobile if userId not found
    if ((!user || userError) && mobile) {
      const { data, error } = await supabase
        .from('pro_users')
        .select('id, mobile, subscription_expires_at')
        .eq('mobile', mobile)
        .single();
      user = data;
      userError = error;
    }

    if (userError || !user) {
      console.error('Pro sync user not found — userId:', userId, 'mobile:', mobile);
      return res.status(404).json({ error: 'Pro user not found.' });
    }

    // Only block if expiry is explicitly set AND in the past
    // null = no expiry set = treat as active (test/admin accounts)
    const isExpired = user.subscription_expires_at
      && new Date(user.subscription_expires_at) < new Date();

    if (isExpired) {
      return res.status(403).json({
        error: 'Subscription expired. Please renew to sync data.',
        code: 'SUBSCRIPTION_EXPIRED'
      });
    }

    // Upsert user data
    console.log('Pro sync saving — user:', user.id,
      'contributors:', (contributors || []).length,
      'targets:', (targets || []).length,
      'pledges:', (pledges || []).length,
      'contributions:', (contributions || []).length);
    if ((pledges || []).length > 0) {
      console.log('Pledges data:', JSON.stringify(pledges));
    }

    // First check if row exists
    const { data: existingRow } = await supabase
      .from('pro_user_data')
      .select('user_id')
      .eq('user_id', user.id)
      .single();

    let syncError;
    if (existingRow) {
      // Row exists — update
      const { error } = await supabase
        .from('pro_user_data')
        .update({
          contributors: contributors || [],
          targets: targets || [],
          contributions: contributions || [],
          pledges: pledges || [],
          updated_at: new Date().toISOString()
        })
        .eq('user_id', user.id);
      syncError = error;
      console.log('Pro sync UPDATE for user:', user.id, 'error:', error?.message || 'none');
    } else {
      // Row doesn't exist — insert
      const { error } = await supabase
        .from('pro_user_data')
        .insert({
          user_id: user.id,
          contributors: contributors || [],
          targets: targets || [],
          contributions: contributions || [],
          pledges: pledges || [],
          updated_at: new Date().toISOString()
        });
      syncError = error;
      console.log('Pro sync INSERT for user:', user.id, 'error:', error?.message || 'none');
    }

    if (syncError) {
      console.error('Pro sync error:', syncError.message, syncError.details, syncError.hint);
      return res.status(500).json({ error: syncError.message });
    }

    // Dual-write: mirror this whole sync into the new normalized tables too,
    // as one batched upsert per table (not one call per row — this endpoint
    // pushes the account's entire state, so batching is what keeps this from
    // reintroducing the same per-write cost problem we're solving).
    await mirrorFullSyncBatch(supabase, user.id, {
      contributors: contributors || [],
      targets: targets || [],
      contributions: contributions || [],
      pledges: pledges || []
    });

    console.log('Pro sync success for user:', user.id);
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Pro sync error:', err);
    res.status(500).json({ error: 'Failed to sync data to cloud.' });
  }
});

// PRO SYNC FETCH — gets latest cloud data for user
router.get('/pro/sync', requireProToken, async (req, res) => {
  const { userId, mobile } = req.query;

  if (!userId && !mobile) {
    return res.status(400).json({ error: 'userId or mobile is required.' });
  }
  if ((userId && userId !== req.proUserId) || (mobile && mobile !== req.proMobile)) {
    console.log('pro/sync GET: ownership mismatch — token:', req.proUserId, req.proMobile, 'query:', userId, mobile);
    return res.status(403).json({ error: 'Not authorized to access this data.' });
  }

  try {
    let userQuery = supabase.from('pro_users').select('id, subscription_expires_at');
    if (userId) userQuery = userQuery.eq('id', userId);
    else userQuery = userQuery.eq('mobile', mobile);

    const { data: user, error: userError } = await userQuery.single();

    if (userError || !user) {
      console.error('Pro sync GET user not found:', userError?.message);
      return res.status(404).json({ error: 'Pro user not found.' });
    }

    console.log('Pro sync GET for user:', user.id);
    const { data: userData, error: dataError } = await supabase
      .from('pro_user_data')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (dataError) return res.status(500).json({ error: dataError.message });

    const oldData = userData || { contributors: [], targets: [], contributions: [], pledges: [] };

    // CUTOVER: serve reconstructed data from the new tables, falling back to
    // old JSON automatically if that fetch fails for any reason. This is the
    // endpoint the app calls most often (its own sync-fetch), so the
    // fallback matters most here.
    let responseData = oldData;
    let servedFromNewTables = false;
    try {
      responseData = await fetchNormalizedUserData(supabase, user.id);
      servedFromNewTables = true;
    } catch (err) {
      console.warn('[cutover] new-table read failed on pro/sync GET, falling back to old JSON:', err?.message || err);
    }

    res.json({
      success: true,
      data: responseData,
      updatedAt: userData?.updated_at
    });

    // Ongoing monitoring — runs AFTER the response is already sent.
    if (servedFromNewTables) {
      const diffs = compareUserData(oldData, responseData);
      if (diffs.length > 0) {
        console.warn(`[post-cutover] drift detected for user ${user.id} (pro/sync GET):`);
        diffs.forEach(d => console.warn(`  - ${d}`));
      }
    }
  } catch (err) {
    console.error('Pro sync fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch cloud data.' });
  }
});

// PRO VERIFY — checks if a mobile number has an active Pro subscription
router.get('/pro/verify', async (req, res) => {
  const { mobile } = req.query;
  if (!mobile) return res.status(400).json({ error: 'mobile is required' });

  try {
    const { data: user, error } = await supabase
      .from('pro_users')
      .select('id, name, mobile, tier, subscription_expires_at, last_login_at')
      .eq('mobile', mobile)
      .single();

    if (error || !user) {
      return res.json({ success: false, isPro: false });
    }

    const isActive = user.subscription_expires_at &&
      new Date(user.subscription_expires_at) > new Date();

    res.json({
      success: true,
      isPro: isActive,
      user: isActive ? {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        tier: 'pro',
        subscriptionExpiresAt: user.subscription_expires_at
      } : null,
      // This is called right after a fresh OTP verification (registration or
      // new-device login) — no proSyncToken exists yet at this point in the
      // flow, so we issue one here too, or the follow-up /pro/sync call
      // right after this would get rejected by requireProToken.
      proSyncToken: isActive ? issueProAppToken(user.id, user.mobile) : undefined
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET ALL PRO USERS (admin only)
router.get('/pro/users', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pro_users')
      .select('id, name, mobile, email, tier, joined_at, last_login_at, subscription_expires_at, country_code')
      .order('joined_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true, users: data, count: data.length });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------
// APPEND CONTRIBUTION — used by the mobile app's own Collect flow.
// The app computes the full Contribution object locally (including
// multi-month arrears breakup, receipt number, etc.) — this endpoint
// just safely appends that already-built object to the *current*
// server state, fetched fresh, rather than the app pushing its whole
// (possibly stale) local array and overwriting anything the website
// or online-payment webhook added in the meantime.
// ---------------------------------------------------------------
router.post('/pro/append-contribution', requireProToken, async (req, res) => {
  const { contribution } = req.body;
  console.log('append-contribution called — user:', req.proUserId, 'contribution:', contribution?.id);
  if (!contribution || !contribution.id) {
    return res.status(400).json({ error: 'contribution is required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributions, contributors, targets')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const contributions = userData.contributions || [];

    // Same guard as web-collect-payment, for the opposite direction: if the
    // website (or an online payment) already fully settled this due in the
    // moments since the app last synced, reject rather than double-recording.
    // Skipped only if we can't find the contributor/target to check against —
    // never blocks on missing data, only on a confirmed already-settled due.
    const contributor = (userData.contributors || []).find(c => c.id === contribution.contributorId);
    const target = (userData.targets || []).find(t => t.id === contribution.targetId);
    if (contributor && target && !contributions.some(c => c.id === contribution.id)) {
      const fallbackAmount = contributor.targetAmounts?.[contribution.targetId] ?? 0;
      const originalBreakup = contributor.targetBreakups?.[contribution.targetId] || getDefaultBreakup(target, fallbackAmount);
      const totalPaidSoFar = contributions
        .filter(c => c.contributorId === contribution.contributorId && c.targetId === contribution.targetId && !c.deleted)
        .reduce((s, c) => s + c.amountPaid, 0);
      const stillDue = breakupTotal(getRemainingBreakup(originalBreakup, totalPaidSoFar));

      if (stillDue <= 0) {
        return res.status(409).json({ error: 'This due has already been fully collected — please sync/refresh.' });
      }
    }

    // Avoid double-appending the same record if this request is retried
    if (!contributions.some(c => c.id === contribution.id)) {
      contributions.push(contribution);
    }

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributions, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror into the new normalized table too. Best-effort —
    // the write above (old JSON) is what just made this payment officially
    // recorded; this is purely additive and never blocks the response.
    await mirrorContribution(supabase, req.proUserId, contribution);

    console.log('append-contribution success — user:', req.proUserId);
    res.json({ success: true });
  } catch (err) {
    console.error('Append contribution error:', err?.message || err);
    res.status(500).json({ error: 'Failed to save payment.' });
  }
});

// ---------------------------------------------------------------
// APPEND PLEDGE PAYMENT — same idea, for the app's pledge collection.
// Takes the AMOUNT BEING ADDED (a delta), not a final total, and
// applies it to whatever the server currently has — so it stays
// correct even if the server's figure has moved since the app last
// fetched it.
// ---------------------------------------------------------------
router.post('/pro/append-pledge-payment', requireProToken, async (req, res) => {
  const { pledgeId, amountDelta, receiptNo, deletedPayments } = req.body;
  console.log('append-pledge-payment called — user:', req.proUserId, 'pledge:', pledgeId, 'delta:', amountDelta);
  if (!pledgeId || !amountDelta) {
    return res.status(400).json({ error: 'pledgeId and amountDelta are required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('pledges')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const pledges = userData.pledges || [];
    const idx = pledges.findIndex(p => p.id === pledgeId);
    if (idx === -1) return res.status(404).json({ error: 'Pledge not found.' });

    const p = pledges[idx];

    // Same guard as web-collect-payment's pledge branch, opposite direction:
    // if the website already fully settled this pledge moments ago, reject
    // an attempt to add MORE money on top of a settled record. A negative
    // or zero delta is a correction/deletion (undoing a previous payment),
    // never an over-collection risk, so it's always allowed through even
    // when the pledge is currently fully paid — that's often exactly when
    // a correction is needed.
    const alreadyDue = p.promisedAmount - (p.amountPaid || 0);
    if (alreadyDue <= 0 && Number(amountDelta) > 0) {
      return res.status(409).json({ error: 'This pledge has already been fully collected — please sync/refresh.' });
    }

    const newAmountPaid = (p.amountPaid || 0) + Number(amountDelta);
    pledges[idx] = {
      ...p,
      amountPaid: newAmountPaid,
      status: newAmountPaid >= p.promisedAmount ? 'fully_paid' : (newAmountPaid > 0 ? 'partially_paid' : 'pending'),
      lastPaymentDate: new Date().toISOString(),
      lastReceiptNo: receiptNo || p.lastReceiptNo,
      // The app sends its full current deletedPayments array (it's the
      // authoritative local state at the moment of this correction) — this
      // was previously missing entirely from this endpoint, silently
      // dropping the audit trail for any payment deletion that synced
      // through this fast path instead of a full sync.
      ...(deletedPayments !== undefined ? { deletedPayments } : {})
    };

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ pledges, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the updated pledge into the new normalized table too.
    await mirrorPledge(supabase, req.proUserId, pledges[idx]);

    console.log('append-pledge-payment success — user:', req.proUserId);
    res.json({ success: true });
  } catch (err) {
    console.error('Append pledge payment error:', err?.message || err);
    res.status(500).json({ error: 'Failed to save payment.' });
  }
});

module.exports = router;
