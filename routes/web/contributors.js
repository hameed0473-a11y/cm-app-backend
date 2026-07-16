const express = require('express');
require('dotenv').config();

const supabase = require('../../lib/supabase');
const { requireProToken } = require('../../middleware/auth');
const { mirrorContributor, mirrorEditContributor, mirrorDeleteContributor } = require('../../utils/mirrorWrite');

const router = express.Router();

// ===============================================================
// PRO WEB DASHBOARD — add/edit/delete contributors (the general
// Subscribers list, used for Monthly/Yearly goals).
// ===============================================================

// ---------------------------------------------------------------
// WEB ADD CONTRIBUTORS — used for both the website's manual "+ Add"
// form (one contributor) and the Import flow (many at once, after
// the file has already been parsed by the existing
// /import-contributors endpoint). Safely appends to whatever the
// server currently has, skipping any mobile number that's already
// a contributor rather than creating a duplicate.
// ---------------------------------------------------------------
router.post('/web-add-contributors', requireProToken, async (req, res) => {
  const { contributors: newOnes } = req.body;
  console.log('web-add-contributors called — user:', req.proUserId, 'count:', newOnes?.length);
  if (!Array.isArray(newOnes) || newOnes.length === 0) {
    return res.status(400).json({ error: 'contributors (a non-empty array) is required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributors')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const contributors = userData.contributors || [];
    const existingMobiles = new Set(contributors.map(c => c.mobile));

    let nextIdNum = contributors.reduce((m, c) => {
      const n = parseInt(String(c.id).replace(/\D/g, '')) || 0;
      return Math.max(m, n);
    }, 1000);

    let addedCount = 0, skippedCount = 0;
    const newlyAdded = [];
    newOnes.forEach(nc => {
      const mobile = String(nc.mobile || '').trim();
      const name = String(nc.name || '').trim();
      if (!name || !mobile || existingMobiles.has(mobile)) {
        skippedCount++;
        return;
      }
      nextIdNum++;
      const newContributor = {
        id: `CONTR-${nextIdNum}`,
        name,
        mobile,
        type: nc.type || 'monthly',
        createdAt: new Date().toISOString().slice(0, 10)
      };
      contributors.push(newContributor);
      newlyAdded.push(newContributor);
      existingMobiles.add(mobile);
      addedCount++;
    });

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributors, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror each newly added contributor into the new table too.
    for (const c of newlyAdded) {
      await mirrorContributor(supabase, req.proUserId, c);
    }

    console.log('web-add-contributors success — user:', req.proUserId, 'added:', addedCount, 'skipped:', skippedCount);
    res.json({ success: true, added: addedCount, skipped: skippedCount });
  } catch (err) {
    console.error('Web add contributors error:', err?.message || err);
    res.status(500).json({ error: 'Failed to add contributors.' });
  }
});

// ---------------------------------------------------------------
// WEB EDIT CONTRIBUTOR
// ---------------------------------------------------------------
router.post('/web-edit-contributor', requireProToken, async (req, res) => {
  const { contributorId, name, mobile } = req.body;
  if (!contributorId || !name || !mobile) {
    return res.status(400).json({ error: 'contributorId, name, and mobile are required' });
  }

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributors')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const contributors = userData.contributors || [];
    const idx = contributors.findIndex(c => c.id === contributorId);
    if (idx === -1) return res.status(404).json({ error: 'Contributor not found.' });

    contributors[idx] = { ...contributors[idx], name: name.trim(), mobile: mobile.trim() };

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributors, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the edit into the new table too.
    await mirrorEditContributor(supabase, contributorId, name.trim(), mobile.trim());

    res.json({ success: true });
  } catch (err) {
    console.error('Web edit contributor error:', err?.message || err);
    res.status(500).json({ error: 'Failed to update contributor.' });
  }
});

// ---------------------------------------------------------------
// WEB DELETE CONTRIBUTOR — removes the contributor record only;
// their historical contributions/pledges stay intact, matching the
// app's own delete behavior.
// ---------------------------------------------------------------
router.post('/web-delete-contributor', requireProToken, async (req, res) => {
  const { contributorId } = req.body;
  if (!contributorId) return res.status(400).json({ error: 'contributorId is required' });

  try {
    const { data: userData, error } = await supabase
      .from('pro_user_data')
      .select('contributors')
      .eq('user_id', req.proUserId)
      .single();

    if (error || !userData) return res.status(404).json({ error: 'Could not find your data.' });

    const contributors = (userData.contributors || []).filter(c => c.id !== contributorId);

    const { error: updateError } = await supabase
      .from('pro_user_data')
      .update({ contributors, updated_at: new Date().toISOString() })
      .eq('user_id', req.proUserId);

    if (updateError) return res.status(500).json({ error: updateError.message });

    // Dual-write: mirror the deletion. This is a real DELETE, not an archive —
    // the schema's ON DELETE SET NULL on contributions/pledges already
    // preserves payment history even once the contributor row itself is gone.
    await mirrorDeleteContributor(supabase, contributorId);

    res.json({ success: true });
  } catch (err) {
    console.error('Web delete contributor error:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete contributor.' });
  }
});


module.exports = router;
