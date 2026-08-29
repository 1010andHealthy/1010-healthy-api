require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allow requests from your website and localhost for testing
const allowedOrigins = [
  'https://www.1010andhealthy.com',
  'https://1010andhealthy.com',
  'https://brandon-mullen-health.sintra.site',
  'http://localhost:3000',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. Stripe webhooks, curl, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));

// ─── BODY PARSING ────────────────────────────────────────────────────────────
// Webhook endpoint needs raw body for signature verification — must come BEFORE express.json()
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// All other routes get JSON parsing
app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: '10:10 and Healthy API', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '10:10 and Healthy API is running.' });
});

// ─── CREATE CHECKOUT SESSION ─────────────────────────────────────────────────
/**
 * POST /api/create-checkout-session
 *
 * Body:
 * {
 *   items: [{ priceId: "price_xxx", quantity: 2 }, ...],
 *   fulfillment: "ship" | "pickup",
 *   discountCode: "WELCOME10" | null,
 *   customerEmail: "jane@example.com" | null,
 *   metadata: { firstName, lastName, phone, notes, address1, city, state, zip }
 * }
 *
 * Returns: { clientSecret: "..." }  (used by Stripe Embedded Checkout)
 */
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, fulfillment, discountCode, customerEmail, metadata } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

    // Validate all items have a priceId and quantity
    for (const item of items) {
      if (!item.priceId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ error: 'Invalid item: each item must have priceId and quantity >= 1.' });
      }
    }

    // Build line items for Stripe
    const lineItems = items.map(item => ({
      price: item.priceId,
      quantity: item.quantity,
    }));

    // Determine shipping options
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
          // Standard shipping
          { shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 895, currency: 'usd' },
              display_name: 'Standard Shipping (3–7 business days)',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 7 },
              },
          }},
          // Free shipping option — Stripe will show both; we handle threshold via coupon or conditional
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

    // Build session params
    const sessionParams = {
      ui_mode: 'embedded',
      line_items: lineItems,
      mode: 'payment',
      shipping_address_collection: fulfillment === 'ship'
        ? { allowed_countries: ['US'] }
        : undefined,
      shipping_options: shippingOptions,
      // Stripe Tax — calculates applicable sales tax automatically if enabled on your Stripe account
      automatic_tax: { enabled: true },
      // Return URL shown after successful payment
      return_url: `${process.env.CLIENT_URL}/shop/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      // Pre-fill customer email if provided
      customer_email: customerEmail || undefined,
      // Metadata stored with the order in Stripe
      metadata: {
        fulfillment_type: fulfillment || 'ship',
        customer_first_name: metadata?.firstName || '',
        customer_last_name: metadata?.lastName || '',
        customer_phone: metadata?.phone || '',
        order_notes: metadata?.notes || '',
        source: '10:10andhealthy.com',
      },
      // Payment methods
      payment_method_types: ['card', 'link'],
      // Allow applying promotion codes at checkout
      allow_promotion_codes: true,
    };

    // Apply a specific discount code if provided (must be a Stripe coupon/promo code)
    if (discountCode) {
      try {
        // Look up promo code in Stripe
        const promoCodes = await stripe.promotionCodes.list({ code: discountCode, active: true, limit: 1 });
        if (promoCodes.data.length > 0) {
          sessionParams.discounts = [{ promotion_code: promoCodes.data[0].id }];
          // Can't use allow_promotion_codes AND discounts together
          delete sessionParams.allow_promotion_codes;
        }
      } catch (promoErr) {
        // Don't fail the checkout if promo code lookup fails — just skip it
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

// ─── RETRIEVE SESSION (for order confirmation page) ──────────────────────────
/**
 * GET /api/checkout-session/:sessionId
 * Used on the order confirmation page to display order details.
 */
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
        const session = event.data.object;
        console.log(`Checkout session expired: ${session.id}`);
        // No inventory was reserved, so nothing to release
        break;
      }

      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        console.log(`Payment succeeded: ${paymentIntent.id} — $${(paymentIntent.amount_received / 100).toFixed(2)}`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object;
        const failReason = paymentIntent.last_payment_error?.message || 'Unknown reason';
        console.log(`Payment failed: ${paymentIntent.id} — ${failReason}`);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        console.log(`Refund processed for charge: ${charge.id}`);
        // TODO: Update order status to REFUNDED in your order management system
        break;
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object;
        console.log(`Dispute opened for charge: ${dispute.charge} — reason: ${dispute.reason}`);
        // TODO: Flag order in your system for manual review
        break;
      }

      default:
        // Unhandled event type — log and ignore
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (handlerErr) {
    console.error(`Error handling event ${event.type}:`, handlerErr);
    // Return 200 anyway so Stripe doesn't retry — log the error and investigate
  }

  res.json({ received: true });
}

// ─── CHECKOUT COMPLETED HANDLER ──────────────────────────────────────────────
async function handleCheckoutCompleted(session) {
  console.log('=== ORDER RECEIVED ===');
  console.log('Session ID:', session.id);
  console.log('Payment status:', session.payment_status);
  console.log('Customer email:', session.customer_details?.email);
  console.log('Customer name:', session.customer_details?.name);
  console.log('Amount total:', `$${((session.amount_total || 0) / 100).toFixed(2)}`);
  console.log('Fulfillment type:', session.metadata?.fulfillment_type);
  console.log('Metadata:', session.metadata);

  if (session.payment_status !== 'paid') {
    console.log('Payment not yet confirmed — waiting for payment_intent.succeeded');
    return;
  }

  // Retrieve full session with line items
  const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ['line_items', 'line_items.data.price.product'],
  });

  const lineItems = fullSession.line_items?.data || [];
  console.log('Items ordered:');
  lineItems.forEach(item => {
    const productName = typeof item.price?.product === 'object' ? item.price.product.name : 'Unknown';
    console.log(`  - ${productName} x${item.quantity} = $${((item.amount_total || 0) / 100).toFixed(2)}`);
  });

  // ── ORDER CAPTURE ──────────────────────────────────────────────────────────
  // This is where you would:
  // 1. Save the order to your database
  // 2. Decrease inventory counts
  // 3. Send a confirmation email to the customer
  // 4. Send an order notification to Brandon
  // 5. Add the customer to your CRM
  //
  // For now, all order details are logged above and visible in Stripe Dashboard.
  // Brandon can view all orders at: https://dashboard.stripe.com/payments
  //
  // To send Brandon an email notification when an order comes in,
  // add your email service (e.g. Resend, Mailgun, SendGrid) here:
  //
  // await sendOrderNotificationEmail({
  //   to: '1010andhealthy@gmail.com',
  //   subject: `New Order — ${session.customer_details?.name}`,
  //   orderDetails: fullSession,
  // });

  console.log('=== ORDER PROCESSING COMPLETE ===');
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`10:10 and Healthy API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('⚠️  STRIPE_SECRET_KEY is not set — checkout sessions will fail');
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set — webhooks will fail');
  }
  if (!process.env.CLIENT_URL) {
    console.warn('⚠️  CLIENT_URL is not set — using fallback');
  }
});
