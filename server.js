require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
  res.json({ status: 'ok', service: '10:10 and Healthy API', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '10:10 and Healthy API is running.' });
});

// ─── CREATE CHECKOUT SESSION ─────────────────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, fulfillment, discountCode, customerEmail, metadata } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

    for (const item of items) {
      if (!item.priceId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: 'Invalid item: each item must have priceId and quantity >= 1.' });
      }
    }

    const lineItems = items.map(item => ({
      price: item.priceId,
      quantity: item.quantity,
    }));

    const shippingOptions = fulfillment === 'pickup'
      ? [{ shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: 0, currency: 'usd' },
          display_name: 'Local Pickup — Market on Main, Lafayette IN',
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 1 },
            maximum: { unit: 'business_day', value: 3 },
          },
        }}]
      : [
          { shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 895, currency: 'usd' },
              display_name: 'Standard Shipping (3–7 business days)',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
          }},
          { shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency: 'usd' },
              display_name: 'Free Standard Shipping (orders $75+)',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
          }},
        ];

    const sessionParams = {
      ui_mode: 'embedded',
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: fulfillment === 'ship'
        ? { allowed_countries: ['US'] }
        : undefined,
      shipping_options: shippingOptions,
      automatic_tax: { enabled: false },
      return_url: `${process.env.CLIENT_URL}/shop/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      customer_email: customerEmail || undefined,
      metadata: {
        fulfillment_type: fulfillment || 'ship',
        customer_first_name: metadata?.firstName || '',
        customer_last_name: metadata?.lastName || '',
        customer_phone: metadata?.phone || '',
        order_notes: metadata?.notes || '',
        source: '1010andhealthy.com',
      },
      payment_method_types: ['card', 'link'],
      allow_promotion_codes: true,
    };

    if (discountCode) {
      try {
        const promoCodes = await stripe.promotionCodes.list({ code: discountCode, active: true, limit: 1 });
        if (promoCodes.data.length > 0) {
          sessionParams.discounts = [{ promotion_code: promoCodes.data[0].id }];
          delete sessionParams.allow_promotion_codes;
        }
      } catch (promoErr) {
        console.warn('Promo code lookup failed:', promoErr.message);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ clientSecret: session.client_secret });

  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).json({ error: err.message || 'Failed to create checkout session.' });
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
      currency: session.currency,
      line_items: session.line_items?.data || [],
      shipping: session.shipping_details,
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
  const shipping = session.shipping_details;
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
  const addressText = fulfillment === 'pickup'
    ? 'LOCAL PICKUP — Market on Main, 525 Main St, Lafayette, IN 47901'
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
          ${fulfillment === 'pickup' ? '🏪 Local Pickup' : '🚚 Ship To'}
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
          ${fulfillment === 'pickup' ? '🏪 Pickup Details' : '🚚 Shipping To'}
        </h3>
        <p style="margin:0;font-size:14px;color:#444;">${addressText}</p>
        ${fulfillment === 'pickup'
          ? '<p style="margin:8px 0 0;font-size:13px;color:#666;">Brandon will contact you to arrange a pickup time at Market on Main, 525 Main St, Lafayette, IN.</p>'
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
