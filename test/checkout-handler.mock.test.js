const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../checkout-policy');

const ids = [...policy.ALLOWED_PRICE_IDS];
const priceCents = new Map([
  [ids[0], 12500], [ids[1], 12501], [ids[2], 14000],
  [ids[3], 15000], [ids[4], 10000], ['price_1U9pFPGaIkBjCnN2doJXxoX9', 6000],
  ['price_1U9pFQGaIkBjCnN2nD8BYKvB', 6500],
  ['price_1U9pFSGaIkBjCnN26JtUQLGm', 13000]
]);

function harness({ geocoding = 'local', couponValid = true, babyCouponValid = true, babyPromoActive = true, babyTimesRedeemed = 0, swimCouponValid = true, swimPromoActive = true, nowISO = null } = {}) {
  const routes = new Map();
  const app = {
    use() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
    get(path, handler) { routes.set(path, handler); },
    listen(_port, cb) { cb?.(); }
  };
  function express() { return app; }
  express.raw = () => (_req,_res,next) => next?.();
  express.json = () => (_req,_res,next) => next?.();
  const sessions = [];
  const stripe = {
    prices: { retrieve: async id => ({
      id, currency: 'usd', active: true, type: 'one_time', unit_amount: priceCents.get(id) ?? 10000
    }) },
    coupons: { retrieve: async id => id === 'BABYGIRL37' ? ({
      id, valid: babyCouponValid, percent_off: 37, duration: 'once',
      max_redemptions: 1, times_redeemed: babyTimesRedeemed
    }) : id === 'SWIM15_MAX2_20261025' ? ({
      id, valid: swimCouponValid, percent_off:15, duration:'once',
      max_redemptions:null, redeem_by:1792987199
    }) : ({
      id, valid: couponValid, percent_off: 15, duration: 'once'
    }) },
    promotionCodes: {
      list: async () => ({ data: [{
        id:'promo_new_swim15_mock', code:'SWIM15', active:swimPromoActive,
        promotion:{type:'coupon',coupon:'SWIM15_MAX2_20261025'},
        max_redemptions:null, expires_at:1792987199, times_redeemed:0
      }] }),
      retrieve: async id => ({
        id, code:'BABYGIRL37', active:babyPromoActive,
        max_redemptions:1, times_redeemed:babyTimesRedeemed
      })
    },
    checkout: { sessions: {
      create: async params => {
        sessions.push(params);
        return { id: 'cs_mock_unpaid', client_secret: 'cs_mock_secret' };
      }
    } },
    webhooks: { constructEvent() { throw Error('not used'); } }
  };
  const logger = {log(){}, info(){}, warn(){}, error(){}};
  const components = (kind) => [
    { long_name: '765', short_name: '765', types: ['street_number'] },
    { long_name: kind === 'outside' ? '46204' : '47901',
      short_name: kind === 'outside' ? '46204' : '47901', types: ['postal_code'] },
    { long_name: 'Indiana', short_name: 'IN', types: ['administrative_area_level_1'] },
    { long_name: 'United States', short_name: 'US', types: ['country'] },
  ];
  async function fakeFetch(url) {
    const query = new URL(url).searchParams.get('address');
    const kind = geocoding === 'dynamic'
      ? (query.includes('Indianapolis') ? 'outside' : query.includes('NoResult') ? 'missing' : 'local')
      : geocoding;
    if (kind === 'unavailable') return { ok: false, status: 500 };
    if (kind === 'missing') return { ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) };
    if (kind === 'quota') return { ok: true, json: async () => ({ status: 'OVER_QUERY_LIMIT', results: [] }) };
    const location = kind === 'outside'
      ? { lat: 39.7684, lng: -86.1581 }
      : { lat: 40.4173, lng: -86.8753 };
    return { ok: true, json: async () => ({ status: 'OK', results: [{
      address_components: components(kind === 'wrongzip' ? 'outside' : kind),
      partial_match: kind === 'partial',
      geometry: {location_type: 'ROOFTOP', location},
    }] }) };
  }
  function customRequire(name) {
    if (name === 'dotenv') return { config() {} };
    if (name === 'express') return express;
    if (name === 'cors') return () => (_req,_res,next)=>next?.();
    if (name === 'stripe') return () => stripe;
    if (name === 'resend') return { Resend: class {} };
    if (name === './checkout-policy') return policy;
    if (name === './checkout-session-utils') return require('../checkout-session-utils');
    if (name === 'crypto') return {randomUUID: () => 'mock-request-id'};
    throw Error('Unexpected require: '+name);
  }
  const src = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  vm.runInNewContext(src, {
    require:customRequire, process:{env:{
      STRIPE_SECRET_KEY:'sk_mock', CLIENT_URL:'https://www.1010andhealthy.com',
      GOOGLE_MAPS_GEOCODING_API_KEY:'google_mock_key',
    }}, console:logger, URLSearchParams, AbortSignal, fetch:fakeFetch,
    Date: nowISO === null ? Date : class extends Date { static now() { return Date.parse(nowISO); } },
  }, {filename:'server.js'});
  return {
    sessions,
    async submit(body) {
      let statusCode = 200;
      let response;
      const res = {
        status(code) { statusCode = code; return this; },
        json(value) { response = value; return this; },
      };
      await routes.get('/api/create-checkout-session')({body},res);
      return {statusCode, response, session:sessions.at(-1)};
    },
  };
}
const ship = (priceId, discountCode) => ({
  items:[{priceId,quantity:1}], fulfillment:'ship', discountCode
});
const local = (city='Lafayette',postalCode='47901',line1='765 Main St')=>({
  items:[{priceId:ids[0],quantity:1}], fulfillment:'local_delivery',
  deliveryAddress:{line1,line2:'Apt 2',city,state:'IN',postalCode},
});
const cents = result => result.session?.shipping_options?.[0]?.shipping_rate_data?.fixed_amount?.amount;

test('Checkout is card-only without Link authentication payment method',async()=>{
  const result=await harness().submit(ship(ids[0]));
  assert.equal(result.statusCode,200);
  assert.deepEqual(Array.from(result.session.payment_method_types),['card']);
  assert.ok(!result.session.payment_method_types.includes('link'));
});
test('standard shipping uses one rate, $8.95 at exactly $125',async()=>{
  const h=harness(); const r=await h.submit(ship(ids[0]));
  assert.equal(r.statusCode,200); assert.equal(cents(r),895);
  assert.equal(r.session.shipping_options.length,1);
  assert.equal(r.session.shipping_address_collection.allowed_countries[0],'US');
});
test('standard shipping free at $125.01',async()=>{
  const r=await harness().submit(ship(ids[1]));
  assert.equal(r.statusCode,200); assert.equal(cents(r),0);
  assert.equal(r.session.shipping_options.length,1);
});
test('SUBARU15 15% discount changes $140 -> $119, shipping $8.95',async()=>{
  const r=await harness().submit(ship(ids[2],'subaru15'));
  assert.equal(r.statusCode,200);assert.equal(cents(r),895);
  assert.equal(r.session.discounts[0].coupon,'eBftR5rn');
  assert.equal(r.session.allow_promotion_codes,undefined);
  assert.equal(r.session.allow_promotion_codes,undefined);
});
test('SUBARU15 15% discount changes $150 -> $127.50, free shipping',async()=>{
  const r=await harness().submit(ship(ids[3],'SUBARU15'));
  assert.equal(r.statusCode,200);assert.equal(cents(r),0);
});
test('all other entered discounts are rejected without a Checkout Session',async()=>{
  for (const code of ['SUBARU20','WELCOME10','LOCALPICKUP','PAULA15']) {
    const h=harness();
    const r=await h.submit(ship(ids[0],code));
    assert.equal(r.statusCode,400,code);
    assert.match(r.response.error,/not supported/i);
    assert.equal(h.sessions.length,0);
  }
});
test('old pickup requests rejected clearly',async()=>{
  const h=harness();const r=await h.submit({
    items:[{priceId:ids[0],quantity:1}],fulfillment:'pickup'
  });
  assert.equal(r.statusCode,400);assert.match(r.response.error,/shipping or local delivery/i);
  assert.equal(h.sessions.length,0);
});
test('tampered unknown price and malformed quantity rejected',async()=>{
  for (const item of [{priceId:'price_attacker',quantity:1},{priceId:ids[0],quantity:-3},
   {priceId:ids[0],quantity:1.5},{priceId:ids[0],quantity:100}]) {
    const h=harness();const r=await h.submit({items:[item],fulfillment:'ship'});
    assert.equal(r.statusCode,400);assert.equal(h.sessions.length,0);
  }
});
test('local address inside Lafayette radius is accepted, address recorded',async()=>{
  const r=await harness({geocoding:'local'}).submit(local());
  assert.equal(r.statusCode,200);assert.equal(cents(r),0);
  assert.equal(r.session.shipping_address_collection,undefined);
  assert.equal(r.session.metadata.fulfillment_type,'local_delivery');
  assert.match(r.session.metadata.delivery_address,/Apt 2/);
});
test('different delivery address is the selected address, not other metadata',async()=>{
  const h=harness({geocoding:'local'});
  const request=local();request.metadata={address:'other order address'};
  const r=await h.submit(request);
  assert.equal(r.statusCode,200);
  assert.match(r.session.metadata.delivery_address,/765 Main St/);
  assert.doesNotMatch(r.session.metadata.delivery_address,/other order/);
});
test('outside address is a 400, no free delivery session',async()=>{
  const h=harness({geocoding:'outside'});
  const r=await h.submit(local('Indianapolis','46204'));
  assert.equal(r.statusCode,400);assert.match(r.response.error,/delivery area/);
  assert.equal(h.sessions.length,0);
});
test('geocoder zero results is a 400 with an error field',async()=>{
  const h=harness({geocoding:'missing'});
  const r=await h.submit(local('NoResult','47901'));
  assert.equal(r.statusCode,400);assert.equal(typeof r.response.error,'string');
  assert.equal(h.sessions.length,0);
});
test('Google Maps outage is a 503, no checkout session',async()=>{
  const h=harness({geocoding:'unavailable'});
  const r=await h.submit(local());
  assert.equal(r.statusCode,503);assert.match(r.response.error,/temporarily unavailable/i);
  assert.equal(h.sessions.length,0);
});
test('invalid delivery address fields rejected with 400',async()=>{
  const h=harness({geocoding:'local'});const r=await h.submit({
    ...local(),deliveryAddress:{line1:'',city:'Lafayette',state:'IN',postalCode:'47901'}
  });
  assert.equal(r.statusCode,400);assert.equal(h.sessions.length,0);
});
test('tax stays off until registration; Stripe coupon inactive blocks SUBARU15',async()=>{
  const h=harness();const r=await h.submit(ship(ids[0]));
  assert.equal(r.session.automatic_tax.enabled,false);
  const h2=harness({couponValid:false});const r2=await h2.submit(ship(ids[0],'SUBARU15'));
  assert.equal(r2.statusCode,400);assert.equal(h2.sessions.length,0);
});

test('partial-match geocoding is rejected instead of sending to an uncertain address',async()=>{
  const h=harness({geocoding:'partial'});const r=await h.submit(local());
  assert.equal(r.statusCode,400);assert.equal(h.sessions.length,0);
});
test('Google Maps quota or authorization outage is a 503, not outside radius',async()=>{
  const h=harness({geocoding:'quota'});const r=await h.submit(local());
  assert.equal(r.statusCode,503);assert.equal(h.sessions.length,0);
});
test('ZIP mismatches and PO boxes are rejected',async()=>{
  for (const [mode,address] of [['wrongzip',local()],['local',local('Lafayette','47901','PO Box 123')]]) {
    const h=harness({geocoding:mode});const r=await h.submit(address);
    assert.equal(r.statusCode,400);assert.equal(h.sessions.length,0);
  }
});
test('valid ZIP+4 remains eligible when geocoder returns the 5-digit ZIP',async()=>{
  const h=harness({geocoding:'local'});const r=await h.submit(local('Lafayette','47901-1234'));
  assert.equal(r.statusCode,200);assert.equal(cents(r),0);
});

const vinaliPriceId = 'price_1U9pFPGaIkBjCnN2doJXxoX9';
test('BABYGIRL37 gives 37% off exactly two bottles of Vińali, with $8.95 shipping',async()=>{
  const h=harness();
  const r=await h.submit({items:[{priceId:vinaliPriceId,quantity:2}],fulfillment:'ship',discountCode:'babygirl37'});
  assert.equal(r.statusCode,200);
  assert.equal(r.session.line_items[0].quantity,2);
  assert.equal(r.session.discounts[0].promotion_code,'promo_1USJxnGaIkBjCnN227OlEj6I');
  assert.equal(cents(r),895);
  assert.equal(r.session.allow_promotion_codes,undefined);
  assert.equal(h.sessions.length,1);
});
test('BABYGIRL37 is valid for free local delivery of exactly two bottles',async()=>{
  const r=await harness().submit({
    items:[{priceId:vinaliPriceId,quantity:2}],
    fulfillment:'local_delivery',discountCode:'BABYGIRL37',
    deliveryAddress:{line1:'765 Main St',city:'Lafayette',state:'IN',postalCode:'47901'}
  });
  assert.equal(r.statusCode,200);
  assert.equal(cents(r),0);
});
test('BABYGIRL37 rejects other products, one bottle, three bottles, and mixed carts',async()=>{
  const badCarts=[
    [{priceId:vinaliPriceId,quantity:1}],
    [{priceId:vinaliPriceId,quantity:3}],
    [{priceId:ids[0],quantity:2}],
    [{priceId:vinaliPriceId,quantity:2},{priceId:ids[0],quantity:1}],
  ];
  for (const items of badCarts) {
    const h=harness();
    const r=await h.submit({items,fulfillment:'ship',discountCode:'BABYGIRL37'});
    assert.equal(r.statusCode,400);
    assert.match(r.response.error,/exactly two bottles/i);
    assert.equal(h.sessions.length,0);
  }
});
test('BABYGIRL37 rejects inactive, expired or redeemed coupons/promotion codes',async()=>{
  for(const props of [
    {babyCouponValid:false},
    {babyPromoActive:false},
    {babyTimesRedeemed:1},
  ]){
    const h=harness(props);
    const r=await h.submit({items:[{priceId:vinaliPriceId,quantity:2}],fulfillment:'ship',discountCode:'BABYGIRL37'});
    assert.equal(r.statusCode,400);
    assert.match(r.response.error,/already been used|no longer available/);
    assert.equal(h.sessions.length,0);
  }
});

const max2PriceId = 'price_1U9pFQGaIkBjCnN2nD8BYKvB';
const moaPriceId = 'price_1U9pFSGaIkBjCnN26JtUQLGm';
const swimWindow = '2026-10-24T12:00:00-04:00';
function swimCart(max2Quantity=1, extraItems=[], discountCode='SWIM15') {
  return { items:[{priceId:max2PriceId,quantity:max2Quantity},...extraItems],fulfillment:'ship',discountCode };
}
test('SWIM15 applies 15% only to Max2.0 on October 24 and keeps shipping $8.95',async()=>{
  const h=harness({nowISO:swimWindow});
  const r=await h.submit(swimCart(2));
  assert.equal(r.statusCode,200);
  assert.equal(r.session.discounts[0].promotion_code,'promo_new_swim15_mock');
  assert.equal(r.session.allow_promotion_codes,undefined);
  assert.equal(cents(r),895); // $130 less $19.50 => $110.50; no free shipping
});
test('SWIM15 allows unlimited Max2.0 boxes and qualifying discounted subtotal gets free shipping',async()=>{
  const h=harness({nowISO:swimWindow});
  const r=await h.submit(swimCart(10));
  assert.equal(r.statusCode,200);
  assert.equal(r.session.line_items[0].quantity,10);
  assert.equal(cents(r),0); // $650 less $97.50 => $552.50 > $125
});
test('SWIM15 mixed carts retain regular prices for other items and discount only Max2.0',async()=>{
  const h=harness({nowISO:swimWindow});
  const r=await h.submit(swimCart(1,[{priceId:moaPriceId,quantity:1}]));
  assert.equal(r.statusCode,200); // $65 Max2.0 + $130 MOA, discount $9.75
  assert.equal(cents(r),0); // $185.25 after discount, qualifies for free shipping
  assert.equal(r.session.line_items.length,2);
});
test('SWIM15 rejects carts without any Max2.0',async()=>{
  const h=harness({nowISO:swimWindow});
  const r=await h.submit({items:[{priceId:moaPriceId,quantity:2}],fulfillment:'ship',discountCode:'SWIM15'});
  assert.equal(r.statusCode,400);
  assert.match(r.response.error,/only to Max2.0/i);
  assert.equal(h.sessions.length,0);
});
test('SWIM15 rejects before October 24 and from October 26 midnight onward',async()=>{
  for(const nowISO of ['2026-10-23T23:59:59-04:00','2026-10-26T00:00:00-04:00','2026-10-27T12:00:00-04:00']) {
    const h=harness({nowISO});
    const r=await h.submit(swimCart());
    assert.equal(r.statusCode,400,nowISO);
    assert.match(r.response.error,/October 24-25/i);
    assert.equal(h.sessions.length,0);
  }
});
test('SWIM15 accepts all eight requested boundary checks during October 24-25',async()=>{
  for(const nowISO of [
    '2026-10-24T00:00:00-04:00',
    '2026-10-24T23:59:59-04:00',
    '2026-10-25T00:00:00-04:00',
    '2026-10-25T20:00:00-04:00',
    '2026-10-25T23:59:59-04:00'
  ]) {
    const r=await harness({nowISO}).submit(swimCart());
    assert.equal(r.statusCode,200,nowISO);
    assert.equal(cents(r),895); // $65 - $9.75 + $8.95 = $64.20 before tax
  }
});
test('SWIM15 blocks inactive or inconsistent Stripe offer',async()=>{
  for(const props of [{swimCouponValid:false},{swimPromoActive:false}]){
    const h=harness({nowISO:swimWindow,...props});
    const r=await h.submit(swimCart());
    assert.equal(r.statusCode,400);
    assert.match(r.response.error,/unavailable/i);
    assert.equal(h.sessions.length,0);
  }
});
test('SUBARU15 and BABYGIRL37 are unchanged by the event offer',async()=>{
  const h=harness({nowISO:swimWindow});
  const a=await h.submit(ship(ids[3],'SUBARU15'));
  assert.equal(a.statusCode,200);
  assert.equal(a.session.discounts[0].coupon,'eBftR5rn');
  const b=await h.submit({items:[{priceId:vinaliPriceId,quantity:2}],fulfillment:'ship',discountCode:'BABYGIRL37'});
  assert.equal(b.statusCode,200);
  assert.equal(b.session.discounts[0].promotion_code,'promo_1USJxnGaIkBjCnN227OlEj6I');
});
