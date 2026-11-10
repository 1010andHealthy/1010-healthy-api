const test = require('node:test');
const assert = require('node:assert/strict');
const { validateItems, shippingOptions, isLocalDelivery, milesBetween, ALLOWED_PRICE_IDS } = require('../checkout-policy');
const priceId = [...ALLOWED_PRICE_IDS][0];
test('all approved price IDs are present', () => { assert.equal(ALLOWED_PRICE_IDS.size, 31); });
test('valid quantities and products are accepted', () => { assert.doesNotThrow(()=>validateItems([{priceId,quantity:1},{priceId,quantity:99}])); });
test('unrecognized prices and fractional / excessive quantities are rejected', () => {
  for(const items of [[],[{priceId:'price_fake',quantity:1}],[{priceId,quantity:0}],[{priceId,quantity:100}],[{priceId,quantity:1.5}],[{priceId,quantity:'2'}]]) {
    assert.throws(()=>validateItems(items));
  }
});
test('shipping: exactly 125.00 still costs $8.95, above 125 is free',()=>{
  for(const [amount,expected] of [[0,895],[12499,895],[12500,895],[12501,0],[20000,0]]) {
    const options=shippingOptions(amount,'ship');
    assert.equal(options.length,1);
    assert.equal(options[0].shipping_rate_data.fixed_amount.amount,expected);
  }
});
test('local delivery offers a single free rate',()=>{
  const options=shippingOptions(0,'local_delivery');
  assert.equal(options.length,1);
  assert.equal(options[0].shipping_rate_data.fixed_amount.amount,0);
});
test('15-mile circles include both downtown reference points',()=>{
  assert.equal(isLocalDelivery(40.4173,-86.8753),true);
  assert.equal(isLocalDelivery(40.4259,-86.9081),true);
  assert.equal(isLocalDelivery(39.7684,-86.1581),false);
  assert.equal(isLocalDelivery(NaN,-86.8753),false);
  assert.equal(isLocalDelivery(90.01,-86.8753),false);
});
test('haversine result is zero for the same point and symmetric',()=>{
  const a={lat:40.4173,lon:-86.8753},b={lat:40.4259,lon:-86.9081};
  assert.equal(milesBetween(a,a),0);
  assert.ok(Math.abs(milesBetween(a,b)-milesBetween(b,a))<1e-8);
});

const {
  holidaySaleWindowActive, holidayCouponValid, discountedSubaruUnitCents, discountedLine,
  HOLIDAY_COUPON_ID, HOLIDAY_COUPON_REDEEM_BY, SLENDERIIZ_PRODUCT_ID,
} = require('../checkout-policy');

test('holiday clock handles November DST switch and precise January 1 cutoff in Indianapolis', () => {
  for (const [date,expected] of [
    ['2026-10-31T23:59:59-04:00',false],
    ['2026-11-01T00:00:00-04:00',true],
    ['2026-11-01T01:30:00-04:00',true],
    ['2026-11-01T01:30:00-05:00',true],
    ['2026-12-31T23:59:59-05:00',true],
    ['2027-01-01T00:00:00-05:00',false],
  ]) assert.equal(holidaySaleWindowActive(new Date(date)),expected,date);
});
test('holiday coupon must exactly authorize correct product, $51 and expiry', () => {
  const coupon={id:HOLIDAY_COUPON_ID,valid:true,amount_off:5100,currency:'usd',
    duration:'once',redeem_by:HOLIDAY_COUPON_REDEEM_BY,metadata:{product_id:SLENDERIIZ_PRODUCT_ID},
    applies_to:{products:[SLENDERIIZ_PRODUCT_ID]}};
  assert.equal(holidayCouponValid(coupon),true);
  assert.equal(holidayCouponValid({...coupon,amount_off:5000}),false);
  assert.equal(holidayCouponValid({...coupon,redeem_by:0}),false);
  assert.equal(holidayCouponValid({...coupon,valid:false}),false);
  assert.equal(holidayCouponValid({...coupon,applies_to:{products:['prod_wrong']}}),false);
});
test('inline discounted prices are cents-precise and retain original Stripe product',()=>{
  assert.equal(discountedSubaruUnitCents(10000),8500);
  assert.equal(discountedSubaruUnitCents(9999),8499);
  assert.deepEqual(discountedLine({product:SLENDERIIZ_PRODUCT_ID},9900,2),{
    price_data:{currency:'usd',product:SLENDERIIZ_PRODUCT_ID,unit_amount:9900},quantity:2,
  });
});
