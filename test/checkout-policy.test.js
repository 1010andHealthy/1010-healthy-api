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
