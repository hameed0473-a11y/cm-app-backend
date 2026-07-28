const express = require('express');
const XLSX = require('xlsx');

const supabase = require('../lib/supabase');
const { mirrorContributor } = require('../utils/mirrorWrite');
const { nextId } = require('../utils/idGen');

const router = express.Router();

// ===============================================================
// IMPORT CONTRIBUTORS FROM EXCEL
// Receives base64 encoded Excel file, parses it, saves to Supabase
// ===============================================================
router.post('/import-contributors', async (req, res) => {
  const { mobile, fileBase64, fileName } = req.body;

  if (!fileBase64) {
    return res.status(400).json({ error: 'fileBase64 is required' });
  }

  try {
    // Decode base64 to buffer
    const buffer = Buffer.from(fileBase64, 'base64');

    // Parse Excel/CSV
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'File is empty or has no data.' });
    }

    // Find Name and Mobile columns
    const firstRow = rows[0];
    const keys = Object.keys(firstRow);
    const nameKey = keys.find(k => k.toLowerCase().includes('name'));
    const mobileKey = keys.find(k =>
      k.toLowerCase().includes('mobile') ||
      k.toLowerCase().includes('phone') ||
      k.toLowerCase().includes('number')
    );

    if (!nameKey) {
      return res.status(400).json({
        error: 'Could not find a Name column. Please ensure your Excel has a "Name" column.'
      });
    }

    // Build the parsed name/mobile rows first — every user is Pro, so ids
    // (assigned below via nextId, see utils/idGen.js) always need a real
    // owning pro_users.id to be prefixed with.
    const parsedRows = [];
    rows.forEach(row => {
      const name = String(row[nameKey] || '').trim();
      const mob = mobileKey ? String(row[mobileKey] || '').replace(/\D/g, '') : '';
      if (!name) return;
      parsedRows.push({ name, mobile: mob });
    });

    if (parsedRows.length === 0) {
      return res.status(400).json({ error: 'No valid contributors found in file.' });
    }

    const { data: proUser } = await supabase
      .from('pro_users')
      .select('id')
      .eq('mobile', mobile)
      .single();

    if (!proUser) {
      return res.status(404).json({ error: 'No Pro account found for this mobile number.' });
    }

    const { data: existing } = await supabase
      .from('pro_user_data')
      .select('contributors')
      .eq('user_id', proUser.id)
      .single();

    const existingContributors = existing?.contributors || [];
    const merged = [...existingContributors];
    const newlyAdded = [];
    let added = 0;
    let skipped = 0;

    for (const row of parsedRows) {
      // Only deduplicate by mobile number — names can repeat legitimately
      const isDuplicate = row.mobile && merged.some(ec => ec.mobile === row.mobile);
      if (isDuplicate) { skipped++; continue; }
      const nc = {
        // Prefixed with the owning pro user's own ID (see utils/idGen.js).
        id: await nextId(supabase, proUser.id, 'contributor'),
        name: row.name,
        mobile: row.mobile,
        type: 'monthly',
        createdAt: new Date().toISOString().slice(0, 10)
      };
      merged.push(nc);
      newlyAdded.push(nc);
      added++;
    }

    await supabase
      .from('pro_user_data')
      .update({ contributors: merged, updated_at: new Date().toISOString() })
      .eq('user_id', proUser.id);

    // Dual-write: mirror each newly imported contributor into the new table too.
    for (const c of newlyAdded) {
      await mirrorContributor(supabase, proUser.id, c);
    }

    res.json({
      success: true,
      added,
      skipped,
      total: merged.length,
      message: `${added} contributors imported, ${skipped} duplicates skipped.`
    });

  } catch (err) {
    console.error('Import contributors error:', err);
    res.status(500).json({ error: 'Failed to process file. Please ensure it is a valid Excel or CSV file.' });
  }
});

// ===============================================================
// IMPORT GOALS DATA FROM CSV
// Receives base64 CSV, parses it, returns structured goals + subscribers
// ===============================================================
router.post('/import-goals', async (req, res) => {
  const { fileBase64, fileName } = req.body;
  if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });

  try {
    const buffer = Buffer.from(fileBase64, 'base64');

    // Parse Excel (.xlsx/.xls) or CSV — same approach as /import-contributors
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'File is empty or has no data rows.' });
    }

    // Find columns by matching header keywords (case-insensitive, ignoring punctuation)
    const keys = Object.keys(rows[0]);
    const norm = (k) => k.toLowerCase().replace(/[^a-z ]/g, '');
    const goalKey = keys.find(k => { const h = norm(k); return h.includes('goal') || h.includes('pledge') || h.includes('name of'); });
    const contribKey = keys.find(k => { const h = norm(k); return (h.includes('contributor') || h.includes('name of cont')) && !h.includes('mobile'); });
    const mobileKey = keys.find(k => { const h = norm(k); return h.includes('mobile') || h.includes('phone') || h.includes('number'); });
    const amountKey = keys.find(k => norm(k).includes('amount'));
    // Optional — not required, unlike the four columns above.
    const addressKey = keys.find(k => norm(k).includes('address'));

    if (!goalKey || !contribKey || !amountKey) {
      return res.status(400).json({
        error: 'Could not find required columns. Please use the downloaded template.'
      });
    }
    if (!mobileKey) {
      return res.status(400).json({
        error: 'Could not find a Mobile Number column. Please use the downloaded template.'
      });
    }

    const goalMap = {};
    const blankRows = [];
    const invalidMobileRows = [];

    rows.forEach((row, idx) => {
      const goalName = String(row[goalKey] || '').trim();
      const contribName = String(row[contribKey] || '').trim();
      const mobileRaw = String(row[mobileKey] || '').trim();
      const mobile = mobileRaw.replace(/\D/g, '').slice(-10); // digits only, last 10
      const amountRaw = row[amountKey];
      const amount = String(amountRaw ?? '').trim();
      const address = addressKey ? String(row[addressKey] || '').trim() : '';

      if (!goalName || !contribName || !mobileRaw || !amount) {
        blankRows.push(idx + 2); // +2: header row + 1-indexing
        return;
      }
      if (mobile.length !== 10) {
        invalidMobileRows.push(idx + 2);
        return;
      }

      if (!goalMap[goalName]) goalMap[goalName] = [];
      goalMap[goalName].push({
        name: contribName,
        mobile,
        amount: Number(amount) || 0,
        ...(address ? { address } : {})
      });
    });

    if (blankRows.length > 0) {
      return res.status(400).json({
        error: `Goal name, contributor name, mobile number, and amount are mandatory (Address is optional) — some are left blank at rows: ${blankRows.slice(0,5).join(', ')}${blankRows.length > 5 ? '...' : ''}. Please fill and upload again.`
      });
    }
    if (invalidMobileRows.length > 0) {
      return res.status(400).json({
        error: `Mobile Number must be 10 digits — invalid at rows: ${invalidMobileRows.slice(0,5).join(', ')}${invalidMobileRows.length > 5 ? '...' : ''}. Please fix and upload again.`
      });
    }

    res.json({ success: true, goals: goalMap });
  } catch (err) {
    console.error('Import goals error:', err);
    res.status(500).json({ error: 'Failed to process file. Please use the downloaded template.' });
  }
});

// ===============================================================
// IMPORT PAYEES FROM EXCEL — parsing only, same pattern as
// import-contributors/import-goals above: this endpoint just reads the
// file and returns structured rows. It does NOT touch the database —
// the frontend takes the parsed rows and calls the already-authenticated
// /web-add-payee for each one (which dedupes by mobile automatically),
// same separation of concerns as the goal-import flow.
// ===============================================================
router.post('/import-payees', async (req, res) => {
  const { fileBase64 } = req.body;

  if (!fileBase64) {
    return res.status(400).json({ error: 'fileBase64 is required' });
  }

  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'File is empty or has no data.' });
    }

    const firstRow = rows[0];
    const keys = Object.keys(firstRow);
    const nameKey = keys.find(k => k.toLowerCase().includes('name'));
    const mobileKey = keys.find(k =>
      k.toLowerCase().includes('mobile') ||
      k.toLowerCase().includes('phone') ||
      k.toLowerCase().includes('number')
    );
    const categoryKey = keys.find(k => k.toLowerCase().includes('category'));

    if (!nameKey || !mobileKey || !categoryKey) {
      return res.status(400).json({
        error: 'Could not find Name, Mobile Number, and Category columns. Please check your file\'s header row.'
      });
    }

    const payees = [];
    rows.forEach(row => {
      const name = String(row[nameKey] || '').trim();
      const mobile = String(row[mobileKey] || '').replace(/\D/g, '');
      const category = String(row[categoryKey] || '').trim();
      if (!name || !mobile || !category) return; // skip incomplete rows silently — summarized by the frontend as "skipped"
      payees.push({ name, mobile, category });
    });

    if (payees.length === 0) {
      return res.status(400).json({ error: 'No valid rows found — each row needs a Name, a Mobile Number, and a Category.' });
    }

    res.json({ success: true, payees });
  } catch (err) {
    console.error('import-payees error:', err?.message || err);
    res.status(500).json({ error: 'Could not read this file. Please check the format and try again.' });
  }
});

module.exports = router;
