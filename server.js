require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { checkoutShippingDetails } = require('./checkout-session-utils');
let Resend;
try { Resend = require('resend').Resend; } catch(e) { console.warn('Resend not installed'); }

const app = express();
const PORT = process.env.PORT || 3001;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://www.1010andhealthy.com',
  'https://1010andhealthy.com',
  'https://brandon-mullen-health.sintra.site',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

// ─── BODY PARSING ────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: '10:10 and Healthy API', checkout_revision: 'local-delivery-v1', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '10:10 and Healthy API is running.' });
});

// ─── CREATE CHECKOUT SESSION ─────────────────────────────────────────────────
const { validateItems, shippingOptions, isLocalDelivery } = require('./checkout-policy');
async function verifyLocalDeliveryAddress(address) {
  if (!process.env.GOOGLE_MAPS_GEOCODING_API_KEY) throw new Error('geocoding_not_configured');
  if (!address || typeof address !== 'object') return false;
  const { line1, line2, city, state, postalCode } = address;
  if (![line1,city,state,postalCode].every(x => typeof x === 'string' && x.trim() && x.length < 150)) return false;
  if (line2 != null && (typeof line2 !== 'string' || line2.length > 150)) return false;
  if (!/^\d{5}(-\d{4})?$/.test(postalCode.trim())) return false;
  if (!/^(IN|Indiana)$/i.test(state.trim())) return false;
  if (/\bP\s*\.?\s*O\s*\.?\s*Box\b/i.test(line1)) return false;
  const postalFive = postalCode.trim().slice(0,5);
  const q = new URLSearchParams({address:[line1,city,state,postalCode,'USA'].join(', '),key:process.env.GOOGLE_MAPS_GEOCODING_API_KEY});
  const response = await fetch('https://maps.googleapis.com/maps/api/geocode/json?'+q,{signal:AbortSignal.timeout(7000)});
  if (!response.ok) throw new Error('geocoding_unavailable');
  const data = await response.json();
  if (data.status === 'ZERO_RESULTS') return false;
  if (data.status !== 'OK' || !Array.isArray(data.results)) throw new Error('geocoding_error');
  return data.results.some(r => {
    if (r.partial_match) return false;
    const components=r.address_components||[];
    const part=t=>components.find(c=>c.types.includes(t));
    return ['ROOFTOP','RANGE_INTERPOLATED'].includes(r.geometry?.location_type)
      && part('administrative_area_level_1')?.short_name==='IN'
      && part('country')?.short_name==='US'
      && part('postal_code')?.long_name?.slice(0,5)===postalFive
      && !!part('street_number')
      && isLocalDelivery(r.geometry.location.lat,r.geometry.location.lng);
  });
}

app.post('/api/create-checkout-session', async (req, res) => {
  const requestId = require('crypto').randomUUID();
  const log = { requestId, event: 'checkout_create', taxEnabled: process.env.TAX_ENABLED === 'true' };
  const bad = (reason, message) => {
    console.warn(JSON.stringify({ ...log, result: 'rejected', reason }));
    return res.status(400).json({ error: message, requestId });
  };
  try {
    const { items, fulfillment, discountCode, customerEmail, metadata, deliveryAddress } = req.body || {};
    log.itemCount = Array.isArray(items) ? items.length : 0;
    log.priceIds = Array.isArray(items) ? items.map(i => i?.priceId) : [];
    try { validateItems(items); } catch (err) {
      return bad(err.message, 'Your cart contains an invalid item. Please refresh and try again.');
    }
    if (fulfillment !== 'ship' && fulfillment !== 'local_delivery') {
      return bad('invalid_fulfillment', 'Please select shipping or local delivery.');
    }
    if (fulfillment === 'local_delivery') {
      let eligible;
      try { eligible = await verifyLocalDeliveryAddress(deliveryAddress); }
      catch (error) {
        console.error(JSON.stringify({ ...log, event: 'delivery_verification_failed', reason: error.message }));
        return res.status(503).json({error:'Delivery verification is temporarily unavailable. Please select shipping.',requestId});
      }
      if (!eligible) return bad('ineligible_delivery_address','Address is outside the verified local delivery area. Please select shipping.');
    }
    const prices = await Promise.all([...new Set(items.map(i => i.priceId))].map(id => stripe.prices.retrieve(id)));
    const priceById = new Map(prices.map(p => [p.id, p]));
    if (prices.some(p => !p.active || p.currency !== 'usd' || !Number.isSafeInteger(p.unit_amount) || p.type !== 'one_time')) {
      return bad('inactive_or_invalid_price', 'A product in your cart is currently unavailable.');
    }
    const subtotalCents = items.reduce((sum, i) => sum + priceById.get(i.priceId).unit_amount * i.quantity, 0);
    if (!Number.isSafeInteger(subtotalCents)) return bad('subtotal_overflow', 'Please reduce your cart quantity.');
    let discountCents = 0;
    let discounts;
    if (discountCode != null && String(discountCode).trim()) {
      const code = String(discountCode).trim().toUpperCase();
      if (code === 'SUBARU15') {
        const coupon = await stripe.coupons.retrieve('eBftR5rn');
        if (!coupon.valid || coupon.percent_off !== 15) {
          return bad('inactive_discount', 'SUBARU15 is temporarily unavailable.');
        }
        discountCents = Math.round(subtotalCents * 0.15);
        discounts = [{ coupon: coupon.id }];
      } else if (code === 'BABYGIRL37') {
        // Unique one-time offer. Never discount another product or an altered cart.
        const vinaliPriceId = 'price_1U9pFPGaIkBjCnN2doJXxoX9';
        if (items.length !== 1 || items[0].priceId !== vinaliPriceId || items[0].quantity !== 2) {
          return bad('babygirl37_cart_restriction', 'BABYGIRL37 is valid only when your cart contains exactly two bottles of Vińali.');
        }
        const [coupon, promo] = await Promise.all([
          stripe.coupons.retrieve('BABYGIRL37'),
          stripe.promotionCodes.retrieve('promo_1USJxnGaIkBjCnN227OlEj6I'),
        ]);
        if (!coupon.valid || coupon.percent_off !== 37 || coupon.max_redemptions !== 1 ||
            coupon.times_redeemed >= 1 || !promo.active || promo.code?.toUpperCase() !== 'BABYGIRL37' ||
            promo.max_redemptions !== 1 || promo.times_redeemed >= 1) {
          return bad('inactive_discount', 'BABYGIRL37 has already been used or is no longer available.');
        }
        discountCents = Math.round(subtotalCents * 0.37);
        discounts = [{ promotion_code: promo.id }];
      } else if (code === 'SWIM15') {
        // Swim-A-Thon: both Oct 24 and Oct 25, 2026, inclusive through 23:59:59
        // in America/Indiana/Indianapolis. Do not hard-code a UTC offset.
        const eventLocal = Object.fromEntries(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/Indiana/Indianapolis',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hourCycle: 'h23',
          }).formatToParts(new Date(Date.now()))
            .filter(p => p.type !== 'literal')
            .map(p => [p.type, p.value])
        );
        const localClock = [eventLocal.year, eventLocal.month, eventLocal.day,
          eventLocal.hour, eventLocal.minute, eventLocal.second].join('');
        if (localClock < '20261024000000' || localClock > '20261025235959') {
          return bad('swim15_outside_event', 'SWIM15 is valid only on October 24-25, 2026.');
        }
        const max2PriceId = 'price_1U9pFQGaIkBjCnN2nD8BYKvB';
        const eligibleSubtotalCents = items.reduce((sum, item) =>
          sum + (item.priceId === max2PriceId ? priceById.get(item.priceId).unit_amount * item.quantity : 0), 0);
        if (eligibleSubtotalCents === 0) {
          return bad('swim15_product_required', 'SWIM15 applies only to Max2.0. Add at least one box to use it.');
        }
        const expectedCouponId = 'SWIM15_MAX2_20261025';
        const expectedExpiration = 1792987199; // 2026-10-26 03:59:59 UTC
        // Resolve by active code and expected coupon so replacing the old promotion
        // does not require hard-coding an unrelated Stripe-generated promo ID.
        const [coupon, promoList] = await Promise.all([
          stripe.coupons.retrieve(expectedCouponId),
          stripe.promotionCodes.list({ code: 'SWIM15', active: true, limit: 100 }),
        ]);
        const promo = promoList.data.find(p => {
          const reference = p.promotion?.coupon ?? p.coupon;
          const id = typeof reference === 'string' ? reference : reference?.id;
          return id === expectedCouponId;
        });
        if (!coupon.valid || coupon.percent_off !== 15 ||
            coupon.redeem_by !== expectedExpiration ||
            coupon.max_redemptions != null ||
            !promo || !promo.active || promo.code?.toUpperCase() !== 'SWIM15' ||
            promo.expires_at !== expectedExpiration ||
            promo.max_redemptions != null) {
          return bad('swim15_unavailable', 'SWIM15 is currently unavailable. Please contact us.');
        }
        // Only Max2.0 line items are discounted. The replacement Stripe coupon
        // must also be restricted to product prod_VA72rCQojj8rBW.
        discountCents = Math.round(eligibleSubtotalCents * 0.15);
        discounts = [{ promotion_code: promo.id }];
      } else {
        return bad('unsupported_discount', 'This discount code is not supported.');
      }
      log.discountCodeApplied = true;
    }
    const qualifyingCents = Math.max(0, subtotalCents - discountCents);
    log.subtotalCents = subtotalCents;
    log.discountCents = discountCents;
    log.qualifyingCents = qualifyingCents;
    log.shippingCents = fulfillment === 'local_delivery' ? 0 : (qualifyingCents > 12500 ? 0 : 895);
    log.fulfillment = fulfillment;
    const params = {
      ui_mode: 'embedded', mode: 'payment',
      line_items: items.map(i => ({ price: i.priceId, quantity: i.quantity })),
      // Stripe defaults to no in-checkout promotion code entry. Do not combine discounts with allow_promotion_codes.
      discounts,
      shipping_address_collection: fulfillment === 'ship' ? { allowed_countries: ['US'] } : undefined,
      shipping_options: shippingOptions(qualifyingCents, fulfillment),
      automatic_tax: { enabled: log.taxEnabled },
      return_url: `${process.env.CLIENT_URL}/shop/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      customer_email: customerEmail || undefined,
      metadata: {
        fulfillment_type: fulfillment,
        delivery_address: fulfillment === 'local_delivery' ? [deliveryAddress.line1,deliveryAddress.line2,deliveryAddress.city,deliveryAddress.state,deliveryAddress.postalCode].filter(Boolean).join(', ').slice(0,500) : '',
        customer_first_name: metadata?.firstName || '',
        customer_last_name: metadata?.lastName || '',
        customer_phone: metadata?.phone || '',
        order_notes: metadata?.notes || '',
        source: '1010andhealthy.com',
      },
      // Card-only Checkout: do not request Link's accelerated verification flow.
      payment_method_types: ['card'],
    };
    const session = await stripe.checkout.sessions.create(params);
    console.info(JSON.stringify({ ...log, result: 'created', sessionId: session.id }));
    return res.json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error(JSON.stringify({ ...log, result: 'error', stripeErrorCode: err.code || null, stripeErrorParam: err.param || null, message: err.message }));
    return res.status(500).json({ error: 'Checkout is temporarily unavailable. Please try again or contact us.', requestId });
  }
});

// ─── RETRIEVE SESSION ─────────────────────────────────────────────────────────
app.get('/api/checkout-session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId, {
      expand: ['line_items', 'line_items.data.price.product', 'customer'],
    });
    res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email,
      customer_name: session.customer_details?.name,
      amount_total: session.amount_total,
      amount_subtotal: session.amount_subtotal,
      shipping_cost: session.shipping_cost,
      total_details: session.total_details,
      currency: session.currency,
      line_items: session.line_items?.data || [],
      shipping: checkoutShippingDetails(session),
      metadata: session.metadata,
    });
  } catch (err) {
    console.error('Error retrieving session:', err);
    res.status(500).json({ error: 'Failed to retrieve session.' });
  }
});

// ─── STRIPE WEBHOOK HANDLER ──────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  console.log(`Received Stripe event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }
      case 'checkout.session.expired': {
        console.log(`Checkout session expired: ${event.data.object.id}`);
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        console.log(`Payment succeeded: ${pi.id} — $${(pi.amount_received / 100).toFixed(2)}`);
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        console.log(`Payment failed: ${pi.id} — ${pi.last_payment_error?.message || 'Unknown reason'}`);
        break;
      }
      case 'charge.refunded': {
        console.log(`Refund processed for charge: ${event.data.object.id}`);
        break;
      }
      case 'charge.dispute.created': {
        console.log(`Dispute opened: ${event.data.object.charge} — reason: ${event.data.object.reason}`);
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (handlerErr) {
    console.error(`Error handling event ${event.type}:`, handlerErr);
  }

  res.json({ received: true });
}

// ─── CHECKOUT COMPLETED ───────────────────────────────────────────────────────
async function handleCheckoutCompleted(session) {
  console.log('=== NEW ORDER ===');
  console.log('Session:', session.id);
  console.log('Customer:', session.customer_details?.email);
  console.log('Total:', `$${((session.amount_total || 0) / 100).toFixed(2)}`);

  if (session.payment_status !== 'paid') {
    console.log('Payment not yet confirmed — skipping order processing');
    return;
  }

  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items', 'line_items.data.price.product'],
  });

  const lineItems = fullSession.line_items?.data || [];
  const customerName = session.customer_details?.name || 'Customer';
  const customerEmail = session.customer_details?.email || '';
  const fulfillment = session.metadata?.fulfillment_type || 'ship';
  const shipping = checkoutShippingDetails(fullSession) || checkoutShippingDetails(session);
  const orderTotal = ((session.amount_total || 0) / 100).toFixed(2);
  const orderNotes = session.metadata?.order_notes || '';
  const phone = session.metadata?.customer_phone || '';

  // Build items list
  const itemsText = lineItems.map(item => {
    const name = typeof item.price?.product === 'object' ? item.price.product.name : 'Product';
    const qty = item.quantity;
    const amount = ((item.amount_total || 0) / 100).toFixed(2);
    return `${name} × ${qty} — $${amount}`;
  }).join('\n');

  const itemsHtml = lineItems.map(item => {
    const name = typeof item.price?.product === 'object' ? item.price.product.name : 'Product';
    const qty = item.quantity;
    const amount = ((item.amount_total || 0) / 100).toFixed(2);
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;">${name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">$${amount}</td>
    </tr>`;
  }).join('');

  // Shipping address
  const addr = shipping?.address;
  const addressText = fulfillment === 'local_delivery'
    ? 'FREE LOCAL DELIVERY — ' + (session.metadata?.delivery_address || 'Address missing')
    : addr
      ? `${addr.line1}${addr.line2 ? ', ' + addr.line2 : ''}, ${addr.city}, ${addr.state} ${addr.postal_code}`
      : 'Address not provided';

  console.log('Items:', itemsText);
  console.log('Fulfillment:', fulfillment);
  console.log('Address:', addressText);

  // ─── SEND ORDER NOTIFICATION EMAIL TO BRANDON ────────────────────────────
  if (resend) {
    try {
      await resend.emails.send({
        from: 'orders@1010andhealthy.com',
        to: '1010andhealthy@gmail.com',
        subject: `🛒 New Order — ${customerName} — $${orderTotal}`,
        html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">

    <!-- Header -->
    <div style="background:#336E42;padding:24px 30px;">
      <h1 style="color:#fff;margin:0;font-size:22px;">🛒 New Order Received</h1>
      <p style="color:#85C879;margin:4px 0 0;font-size:14px;">10:10 and Healthy</p>
    </div>

    <!-- Order Summary -->
    <div style="padding:24px 30px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr style="background:#f0f9f1;">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#336E42;text-transform:uppercase;letter-spacing:1px;">Product</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#336E42;text-transform:uppercase;letter-spacing:1px;">Qty</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#336E42;text-transform:uppercase;letter-spacing:1px;">Amount</th>
        </tr>
        ${itemsHtml}
        <tr>
          <td colspan="2" style="padding:12px;text-align:right;font-weight:bold;font-size:15px;">Total</td>
          <td style="padding:12px;text-align:right;font-weight:bold;font-size:15px;color:#336E42;">$${orderTotal}</td>
        </tr>
      </table>

      <!-- Customer Info -->
      <div style="background:#f7f7f7;border-radius:8px;padding:16px 20px;margin-bottom:16px;">
        <h3 style="margin:0 0 12px;font-size:14px;color:#333;text-transform:uppercase;letter-spacing:1px;">Customer</h3>
        <p style="margin:4px 0;font-size:14px;color:#444;"><strong>Name:</strong> ${customerName}</p>
        <p style="margin:4px 0;font-size:14px;color:#444;"><strong>Email:</strong> <a href="mailto:${customerEmail}" style="color:#336E42;">${customerEmail}</a></p>
        ${phone ? `<p style="margin:4px 0;font-size:14px;color:#444;"><strong>Phone:</strong> ${phone}</p>` : ''}
      </div>

      <!-- Fulfillment -->
      <div style="background:#f7f7f7;border-radius:8px;padding:16px 20px;margin-bottom:16px;">
        <h3 style="margin:0 0 12px;font-size:14px;color:#333;text-transform:uppercase;letter-spacing:1px;">
          ${fulfillment === 'local_delivery' ? '🚗 Local Delivery' : '🚚 Ship To'}
        </h3>
        <p style="margin:4px 0;font-size:14px;color:#444;">${addressText}</p>
      </div>

      ${orderNotes ? `
      <div style="background:#fff8e1;border-radius:8px;padding:16px 20px;margin-bottom:16px;border-left:4px solid #ffc107;">
        <h3 style="margin:0 0 8px;font-size:14px;color:#333;">📝 Order Notes</h3>
        <p style="margin:0;font-size:14px;color:#444;">${orderNotes}</p>
      </div>` : ''}

      <!-- Stripe Link -->
      <div style="text-align:center;margin-top:24px;">
        <a href="https://dashboard.stripe.com/payments/${session.payment_intent}"
           style="display:inline-block;background:#336E42;color:#fff;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:bold;font-size:14px;">
          View in Stripe Dashboard →
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#f0f9f1;padding:16px 30px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#666;">10:10 and Healthy · Brandon Mullen · Lafayette, IN</p>
      <p style="margin:4px 0 0;font-size:12px;color:#999;">Because Food Is Medicine</p>
    </div>
  </div>
</body>
</html>`,
      });
      console.log('✅ Order notification email sent to 1010andhealthy@gmail.com');
    } catch (emailErr) {
      console.error('Failed to send order notification email:', emailErr.message);
    }

    // ─── SEND CONFIRMATION EMAIL TO CUSTOMER ───────────────────────────────
    if (customerEmail) {
      try {
        await resend.emails.send({
          from: 'orders@1010andhealthy.com',
          to: customerEmail,
          subject: `Your 10:10 and Healthy order is confirmed! 🌿`,
          html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:30px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">

    <div style="background:#336E42;padding:24px 30px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:24px;">Order Confirmed! ✅</h1>
      <p style="color:#85C879;margin:8px 0 0;font-size:15px;">Thank you for your order, ${customerName.split(' ')[0]}!</p>
    </div>

    <div style="padding:24px 30px;">
      <p style="font-size:15px;color:#444;line-height:1.6;">
        Your order has been received and I'm getting it ready for you.
        I'll send you tracking information as soon as your order ships.
      </p>

      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr style="background:#f0f9f1;">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#336E42;text-transform:uppercase;">Product</th>
          <th style="padding:10px 12px;text-align:center;font-size:12px;color:#336E42;text-transform:uppercase;">Qty</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#336E42;text-transform:uppercase;">Amount</th>
        </tr>
        ${itemsHtml}
        <tr>
          <td colspan="2" style="padding:12px;text-align:right;font-weight:bold;">Total</td>
          <td style="padding:12px;text-align:right;font-weight:bold;color:#336E42;">$${orderTotal}</td>
        </tr>
      </table>

      <div style="background:#f7f7f7;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
        <h3 style="margin:0 0 8px;font-size:14px;color:#333;">
          ${fulfillment === 'local_delivery' ? '🚗 Local Delivery Details' : '🚚 Shipping To'}
        </h3>
        <p style="margin:0;font-size:14px;color:#444;">${addressText}</p>
        ${fulfillment === 'local_delivery'
          ? '<p style="margin:8px 0 0;font-size:13px;color:#666;">Brandon will contact you to arrange delivery.</p>'
          : '<p style="margin:8px 0 0;font-size:13px;color:#666;">Orders typically ship within 1–3 business days. You\'ll receive tracking info by email.</p>'
        }
      </div>

      <div style="text-align:center;background:#f0f9f1;border-radius:8px;padding:20px;">
        <p style="font-size:14px;color:#444;margin:0 0 12px;">Questions about your order?</p>
        <a href="sms:8152161946" style="display:inline-block;background:#336E42;color:#fff;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:bold;font-size:14px;margin:0 6px;">
          💬 Text Brandon
        </a>
        <a href="mailto:1010andhealthy@gmail.com" style="display:inline-block;border:2px solid #336E42;color:#336E42;padding:10px 24px;border-radius:50px;text-decoration:none;font-weight:bold;font-size:14px;margin:0 6px;">
          📧 Email
        </a>
      </div>
    </div>

    <div style="background:#f0f9f1;padding:16px 30px;text-align:center;">
      <p style="margin:0;font-size:12px;color:#666;">10:10 and Healthy · Brandon Mullen · Lafayette, IN</p>
      <p style="margin:4px 0 0;font-size:12px;color:#999;font-style:italic;">Because Food Is Medicine</p>
    </div>
  </div>
</body>
</html>`,
        });
        console.log(`✅ Order confirmation email sent to ${customerEmail}`);
      } catch (emailErr) {
        console.error('Failed to send customer confirmation email:', emailErr.message);
      }
    }
  } else {
    console.warn('⚠️ RESEND_API_KEY not set — email notifications are disabled');
  }

  console.log('=== ORDER PROCESSING COMPLETE ===');
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`10:10 and Healthy API running on port ${PORT}`);
  if (!process.env.STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY not set');
  if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set');
  if (!process.env.RESEND_API_KEY) console.warn('⚠️  RESEND_API_KEY not set — email notifications disabled');
});
