const express = require('express');
const { runRolloverForAllUsers } = require('../utils/rolloverEngine');

const router = express.Router();

// ---------------------------------------------------------------
// MANUAL/EXTERNAL ROLLOVER TRIGGER — the normal path is the in-process
// daily scheduler in server.js, which needs no setup. This endpoint is
// a fallback for manually kicking off a run (e.g. testing, or an
// external scheduler) and is protected by a shared secret since it has
// no per-user auth of its own — it acts across every account at once.
// ---------------------------------------------------------------
router.post('/cron/run-rollovers', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'CRON_SECRET is not configured on the server.' });
  }
  if (req.get('x-cron-secret') !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const summary = await runRolloverForAllUsers();
    res.json({ success: true, ...summary });
  } catch (err) {
    console.error('Manual rollover run error:', err?.message || err);
    res.status(500).json({ error: 'Rollover run failed.' });
  }
});

module.exports = router;
