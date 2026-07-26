const express = require('express');
const crypto = require('crypto');
require('dotenv').config();

const supabase = require('../lib/supabase');
const gateways = require('../lib/gateways');
const { mirrorContribution, mirrorPledge } = require('../utils/mirrorWrite');
const { nextId } = require('../utils/idGen');

const router = express.Router();

// RAZORPAY WEBHOOK
// NOTE: express.raw({ type: 'application/json' }) here is a second,
// redundant safety net for this path — server.js already applies the
// same raw-body middleware to /api/auth/webhook globally, before this
// router even runs, which is what actually lets the signature check
// below see the unparsed body. That server.js ordering must never move.
router.post('/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];

  // Parse first (untrusted) ONLY to decide which secret to verify against.
  // We never act on the contents until the signature check below passes, so
  // reading proUserId from the unverified body is safe — an attacker still
  // can't produce a valid signature without the real secret.
  let event;
  try {
    event = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const notes = event?.payload?.payment_link?.entity?.notes || {};

  // Contribution events belong to a Pro user's OWN Razorpay account → verify
  // with that user's webhook secret. Everything else is a platform
  // subscription event → verify with the platform secret.
  let webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (notes.type === 'contribution' && notes.proUserId) {
    const userSecret = await gateways.getWebhookSecret(notes.proUserId, 'razorpay');
    if (userSecret) {
      webhookSecret = userSecret;
    } else {
      console.error('Webhook: contribution event but no webhook secret set for user', notes.proUserId);
    }
  }

  if (!webhookSecret) {
    console.error('Webhook: no secret available to verify signature');
    return res.status(400).json({ error: 'Webhook not configured' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.body)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('Webhook signature mismatch');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log('Razorpay webhook event:', event.event);

  if (event.event === 'payment_link.paid') {
    const notes = event.payload?.payment_link?.entity?.notes || {};

    if (notes.type === 'contribution') {
      // A subscriber paid online via a link the treasurer sent — record it into
      // the Pro user's cloud data. Fire-and-forget (shared with the Stripe webhook).
      const rupees = Math.round((event.payload?.payment_link?.entity?.amount || 0) / 100);
      recordOnlineContribution(notes, rupees);
    }
  }

  res.status(200).json({ received: true });
});

// ===============================================================
// Shared: record an online contribution/pledge payment into the Pro
// user's cloud data. Used by BOTH the Razorpay and Stripe webhooks so
// the recording behaviour is identical regardless of gateway.
// notes = { proUserId, contributorId, targetId, targetCategory, mobile }
// ===============================================================
function recordOnlineContribution(notes, rupees) {
  (async () => {
    try {
      const { proUserId, contributorId, targetId, targetCategory, mobile } = notes;
      const receiptNo = `REC-${Date.now().toString().slice(-4)}${Math.floor(Math.random() * 10)}`;

      const { data: userData, error } = await supabase
        .from('pro_user_data')
        .select('*')
        .eq('user_id', proUserId)
        .single();

      if (error || !userData) {
        console.error('Online payment: pro_user_data not found for', proUserId);
        return;
      }

      if (targetCategory === 'event') {
        const pledges = userData.pledges || [];
        // Pledge-QR flows (see routes/pledgeQr.js) pass the pledge's own `id`
        // through as `contributorId` — necessary once more than one pledge on
        // the same goal can share a mobile number (every anonymous donation
        // uses the same fixed placeholder mobile), so matching by mobile
        // alone would be ambiguous.
        const idx = pledges.findIndex(p =>
          p.targetId === targetId && (p.id === contributorId || p.contributorId === contributorId || p.mobile === mobile)
        );
        if (idx === -1) {
          console.error('Online payment: pledge not found for', contributorId, mobile, targetId);
          return;
        }
        const p = pledges[idx];
        const newAmountPaid = (p.amountPaid || 0) + rupees;
        pledges[idx] = {
          ...p,
          amountPaid: newAmountPaid,
          status: newAmountPaid >= p.promisedAmount ? 'fully_paid' : 'partially_paid',
          lastPaymentDate: new Date().toISOString(),
          lastReceiptNo: receiptNo
        };
        await supabase.from('pro_user_data')
          .update({ pledges, updated_at: new Date().toISOString() })
          .eq('user_id', proUserId);
        // Mirror into the normalized `pledges` table too — the web dashboard
        // reads from there, so without this the payment stays invisible on the site.
        await mirrorPledge(supabase, proUserId, pledges[idx]);
        console.log('Online pledge payment recorded:', proUserId, targetId, contributorId);
      } else {
        const contributions = userData.contributions || [];
        const newContribution = {
          // Prefixed with the owning pro user's own ID (see utils/idGen.js).
          id: await nextId(supabase, proUserId, 'contribution'),
          contributorId,
          targetId,
          amountPaid: rupees,
          date: new Date().toISOString(),
          collectedBy: 'Online Payment',
          receiptNo
        };
        contributions.push(newContribution);
        await supabase.from('pro_user_data')
          .update({ contributions, updated_at: new Date().toISOString() })
          .eq('user_id', proUserId);
        // Mirror into the normalized `contributions` table too (what the dashboard reads).
        await mirrorContribution(supabase, proUserId, newContribution);
        console.log('Online contribution recorded:', proUserId, targetId, contributorId);
      }
    } catch (err) {
      console.error('Online payment processing error:', err);
    }
  })();
}

// ===============================================================
// STRIPE WEBHOOK — for treasurers collecting from overseas members.
// Verified against that treasurer's OWN Stripe webhook signing secret.
// Mounted under /api/auth, so the raw-body middleware in server.js
// (applied to the /api/auth/webhook prefix) covers this path too.
// ===============================================================
const stripeLib = require('stripe')('sk_placeholder'); // only used for webhooks.constructEvent (no API calls)

router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Parse untrusted body just to find which Pro user this belongs to, so we
  // can load THEIR Stripe webhook secret to verify against.
  let peek;
  try {
    peek = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const meta = peek?.data?.object?.metadata || {};
  if (meta.type !== 'contribution' || !meta.proUserId) {
    return res.status(200).json({ received: true }); // not one of ours — ignore
  }

  const secret = await gateways.getWebhookSecret(meta.proUserId, 'stripe');
  if (!secret) {
    console.error('Stripe webhook: no webhook secret set for user', meta.proUserId);
    return res.status(400).json({ error: 'Webhook not configured' });
  }

  let event;
  try {
    event = stripeLib.webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('Stripe webhook signature mismatch:', e?.message || e);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log('Stripe webhook event:', event.type);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      const notes = session.metadata || {};
      const rupees = Math.round((session.amount_total || 0) / 100);
      recordOnlineContribution(notes, rupees);
    }
  }

  res.status(200).json({ received: true });
});

// ===============================================================
// PAYPAL WEBHOOK — for treasurers collecting from overseas members.
// PayPal events don't carry our metadata and aren't HMAC-signed, so we:
//   1. read the order id from the (untrusted) event,
//   2. look up which Pro user + notes it belongs to (stored at link creation),
//   3. verify the event via PayPal's verify-webhook-signature API using that
//      user's webhook id,
//   4. on CHECKOUT.ORDER.APPROVED, capture the order and record the payment.
// ===============================================================
router.post('/webhook/paypal', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const orderId = event?.resource?.id;
  if (!orderId) return res.status(200).json({ received: true });

  // Which Pro user + contribution does this order belong to?
  const { data: linkMap } = await supabase
    .from('pro_payment_links')
    .select('user_id, notes')
    .eq('payment_link_id', orderId)
    .single();

  if (!linkMap?.user_id) {
    return res.status(200).json({ received: true }); // not one of ours
  }

  // Verify authenticity against that treasurer's PayPal webhook id.
  const ok = await gateways.verifyPaypalWebhook(linkMap.user_id, req.headers, event);
  if (!ok) {
    console.error('PayPal webhook verification failed for order', orderId);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log('PayPal webhook event:', event.event_type);

  if (event.event_type === 'CHECKOUT.ORDER.APPROVED') {
    const captured = await gateways.capturePaypalOrder(linkMap.user_id, orderId);
    if (captured != null && linkMap.notes) {
      recordOnlineContribution(linkMap.notes, Math.round(captured));
    }
  }

  res.status(200).json({ received: true });
});

module.exports = router;
