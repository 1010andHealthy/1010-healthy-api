// Server-authoritative holiday offer. The Stripe coupon is an eligibility guard;
// checkout implements the $51 discount PER UNIT using ephemeral line-item prices.
const SLENDERIIZ_PRICE_ID = process.env.SLENDERIIZ_PRICE_ID || 'price_1U9pFSGaIkBjCnN2aLUlDGrl';
const SLENDERIIZ_PRODUCT_ID = process.env.SLENDERIIZ_PRODUCT_ID || 'prod_VA6ZFPxC17XZAv';
const HOLIDAY_COUPON_ID = process.env.HOLIDAY_COUPON_ID || 'HOLIDAY2026_SLENDERIIZ_51';
const HOLIDAY_COUPON_REDEEM_BY = 1798779599; // 2026-12-31 23:59:59 EST
const HOLIDAY_REGULAR_CENTS = 15000;
const HOLIDAY_SALE_CENTS = 9900;
const HOLIDAY_SAVINGS_CENTS = HOLIDAY_REGULAR_CENTS - HOLIDAY_SALE_CENTS;
function holidaySaleWindowActive(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const clock = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].join('');
  return clock >= '20261101000000' && clock < '20270101000000';
}
function holidayCouponValid(coupon) {
  if (!coupon || coupon.id !== HOLIDAY_COUPON_ID || !coupon.valid ||
      coupon.amount_off !== HOLIDAY_SAVINGS_CENTS || coupon.currency !== 'usd' ||
      coupon.duration !== 'once' || coupon.redeem_by !== HOLIDAY_COUPON_REDEEM_BY ||
      coupon.metadata?.product_id !== SLENDERIIZ_PRODUCT_ID) return false;
  const productRestrictions = coupon.applies_to?.products;
  return !Array.isArray(productRestrictions) || productRestrictions.includes(SLENDERIIZ_PRODUCT_ID);
}
function discountedSubaruUnitCents(unitCents) {
  return Math.round(unitCents * 0.85);
}
function discountedLine(price, unitCents, quantity) {
  const product = typeof price.product === 'string' ? price.product : price.product?.id;
  if (!product) throw new Error('missing_product_for_discounted_line');
  const priceData = { currency: 'usd', product, unit_amount: unitCents };
  if (price.tax_behavior === 'inclusive' || price.tax_behavior === 'exclusive') {
    priceData.tax_behavior = price.tax_behavior;
  }
  return { price_data: priceData, quantity };
}

const FREE_OVER_CENTS = 12500;
const STANDARD_CENTS = 895;
const ALLOWED_PRICE_IDS = new Set([
'price_1U9pFQGaIkBjCnN2nD8BYKvB','price_1U9pFSGaIkBjCnN2aLUlDGrl','price_1U9pFSGaIkBjCnN2OZj8vXcC','price_1U9pFSGaIkBjCnN2oWCmgTVQ','price_1U9pFPGaIkBjCnN2xWaDfZG8','price_1US5JiGaIkBjCnN2j4GJdggr','price_1U9pFPGaIkBjCnN2Y1ByxKIV','price_1U9pFSGaIkBjCnN26JtUQLGm','price_1U9pFQGaIkBjCnN2lgEIzRFv','price_1U9pFQGaIkBjCnN2Z2fcWh29','price_1UMdLmGaIkBjCnN2Ig6sezca','price_1U9pFQGaIkBjCnN2ZOST5WE4','price_1US5JqGaIkBjCnN2vNseeOau','price_1U9pFSGaIkBjCnN2shv1Ilzv','price_1U9pFQGaIkBjCnN2Cz3wBKIO','price_1U9pFUGaIkBjCnN2HJjaD1OD','price_1US5JsGaIkBjCnN2vyPVNwRf','price_1US5JuGaIkBjCnN2WWtzJTPR','price_1U9pFRGaIkBjCnN26z7zLODS','price_1U9pFPGaIkBjCnN2odxfYH52','price_1U9pFTGaIkBjCnN2PJYuw4HB','price_1U9pFXGaIkBjCnN2lRBNqkKr','price_1U9pFPGaIkBjCnN2tDGa13qE','price_1U9pFSGaIkBjCnN2NFwN3J2n','price_1US5JvGaIkBjCnN2iXBvrfDf','price_1U9pFPGaIkBjCnN2doJXxoX9','price_1US5JxGaIkBjCnN2Z7rHzNAu','price_1U9pFSGaIkBjCnN2V7RKmbqt','price_1U9pFSGaIkBjCnN2hpgeT9R6','price_1U9pFSGaIkBjCnN2UdR2pTxm','price_1U9pFPGaIkBjCnN2gSBDL9vZ'
]);
// Test-only Stripe price IDs, never enabled on production.
if (process.env.NODE_ENV === 'test' && process.env.TEST_EXTRA_PRICE_IDS) {
  for (const id of process.env.TEST_EXTRA_PRICE_IDS.split(',').map(s => s.trim()).filter(Boolean)) {
    ALLOWED_PRICE_IDS.add(id);
  }
}
ALLOWED_PRICE_IDS.add(SLENDERIIZ_PRICE_ID);
function validateItems(items) {
 if (!Array.isArray(items) || !items.length || items.length > 99) throw new Error('invalid_items');
 for (const item of items) {
  if (!item || !ALLOWED_PRICE_IDS.has(item.priceId)) throw new Error('unknown_price');
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new Error('invalid_quantity');
 }
}
function shippingOptions(qualifyingCents, fulfillment) {
 if (fulfillment === 'local_delivery') return [{shipping_rate_data:{type:'fixed_amount',fixed_amount:{amount:0,currency:'usd'},display_name:'Free local delivery (verified 15-mile area)'}}];
 const free = qualifyingCents > FREE_OVER_CENTS;
 return [{shipping_rate_data:{type:'fixed_amount',fixed_amount:{amount:free?0:STANDARD_CENTS,currency:'usd'},display_name:free?'Free standard shipping (orders over $125)':'Standard shipping (3–7 business days)',delivery_estimate:{minimum:{unit:'business_day',value:3},maximum:{unit:'business_day',value:7}},tax_behavior:'exclusive',tax_code:'txcd_92010001'}}];
}
// Approximate downtown reference points; confirm exact centers before deployment.
const CENTERS = [{lat:40.4173,lon:-86.8753},{lat:40.4259,lon:-86.9081}];
function milesBetween(a,b) {
 const rad=Math.PI/180, dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad;
 const h=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
 return 3958.7613*2*Math.asin(Math.min(1,Math.sqrt(h)));
}
function isLocalDelivery(lat,lon) {
 if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat< -90||lat>90||lon< -180||lon>180) return false;
 return CENTERS.some(center=>milesBetween(center,{lat,lon})<=15);
}
module.exports={ALLOWED_PRICE_IDS,validateItems,shippingOptions,milesBetween,isLocalDelivery,
  SLENDERIIZ_PRICE_ID, SLENDERIIZ_PRODUCT_ID, HOLIDAY_COUPON_ID,
  HOLIDAY_COUPON_REDEEM_BY, HOLIDAY_REGULAR_CENTS, HOLIDAY_SALE_CENTS,
  HOLIDAY_SAVINGS_CENTS, holidaySaleWindowActive, holidayCouponValid,
  discountedSubaruUnitCents, discountedLine};
