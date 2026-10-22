// One-off 2026 Swim-A-Thon checkout verification. No payment attempts.
 // Scheduled in GitHub Actions; will NOT change the backend clock, prices, coupons, or website.
import assert from 'node:assert/strict';

const API = 'https://1010-healthy-api-production-b8c3.up.railway.app';
const MAX2 = 'price_1U9pFQGaIkBjCnN2nD8BYKvB';
const MOA = 'price_1U9pFSGaIkBjCnN26JtUQLGm';
const PROMO = 'SWIM15';
const START = Date.parse('2026-10-24T04:00:00Z');
const EXCLUSIVE_END = Date.parse('2026-10-26T04:00:00Z');
const current = Date.now();
const day = new Date(current).toISOString().slice(0,10);
const acceptedDays = current >= START && current < EXCLUSIVE_END;
const expiryDay = day === '2026-10-26' && current >= EXCLUSIVE_END;

if (!((day === '2026-10-24' && acceptedDays) || expiryDay)) {
  console.log('SKIP: outside the intended one-time October 24 or October 26, 2026 run window.');
  process.exit(0);
}
async function request(body) {
  const r = await fetch(API + '/api/create-checkout-session', {
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(15000)
  });
  const data=await r.json();
  return {status:r.status,data};
}
const max2=(quantity,fulfillment='ship',extra=[])=>({
  items:[{priceId:MAX2,quantity},...extra],fulfillment,discountCode:PROMO
});
async function readBack(response) {
  assert.equal(response.status,200,'checkout create HTTP status');
  assert.equal(typeof response.data.clientSecret,'string','missing client secret');
  const secret=response.data.clientSecret;
  const marker=secret.indexOf('_secret_');
  assert.ok(marker>0,'invalid checkout client secret');
  const sessionId=secret.slice(0,marker);
  const r=await fetch(API+'/api/checkout-session/'+encodeURIComponent(sessionId),{
    signal:AbortSignal.timeout(15000)
  });
  assert.equal(r.status,200,'Stripe checkout read-back HTTP status');
  const s=await r.json();
  assert.equal(s.payment_status,'unpaid','payment_status must remain unpaid');
  assert.equal(s.status,'open','checkout session must remain open/unpaid');
  return s;
}
async function accepted(name,cart,{subtotal,discount,shipping,total,address,quantity}) {
  const response=await request(cart);
  const session=await readBack(response);
  assert.equal(session.amount_subtotal,subtotal,name+' merchandise subtotal');
  assert.equal(session.total_details?.amount_discount,discount,name+' actual Stripe discount');
  assert.equal(session.shipping_cost?.amount_total,shipping,name+' shipping');
  assert.equal(session.amount_total,total,name+' checkout total');
  assert.equal(session.currency,'usd',name+' currency');
  if (address) assert.ok(session.metadata?.delivery_address?.includes(address),name+' local-delivery address metadata');
  if (quantity) assert.equal(session.line_items?.find(x=>x.price?.id===MAX2)?.quantity,quantity,name+' Max2 quantity');
  console.log('PASS '+name+
    ' | subtotal=$'+(subtotal/100).toFixed(2)+
    ' discount=$'+(discount/100).toFixed(2)+
    ' shipping=$'+(shipping/100).toFixed(2)+
    ' total=$'+(total/100).toFixed(2)+
    ' payment_status=unpaid');
}
async function rejected(name,cart,expectedMessage) {
  const result=await request(cart);
  assert.equal(result.status,400,name+' HTTP should be 400');
  assert.equal(result.data.error,expectedMessage,name+' error text');
  assert.ok(!result.data.clientSecret,name+' must NOT create a session');
  console.log('PASS '+name+' | HTTP 400 | no Checkout Session created');
}
async function verifyWindow(){
  console.log('SWIM15 ONE-TIME OCTOBER 24 UNPAID CHECKOUT TEST — live API, real Stripe session readbacks');
  await accepted('1 Max2O standard shipping',max2(1),{
    subtotal:6500,discount:975,shipping:895,total:6420,quantity:1
  });
  const local=max2(1,'local_delivery');
  local.deliveryAddress={line1:'20 N 6th St',city:'Lafayette',state:'IN',postalCode:'47901'};
  await accepted('1 Max2O verified local delivery',local,{
    subtotal:6500,discount:975,shipping:0,total:5525,address:'20 N 6th St',quantity:1
  });
  await accepted('3 Max2O free standard shipping',max2(3),{
    subtotal:19500,discount:2925,shipping:0,total:16575,quantity:3
  });
  await accepted('2 Max2O plus 1 MOA (MOA full price)',max2(2,'ship',[{priceId:MOA,quantity:1}]),{
    subtotal:26000,discount:1950,shipping:0,total:24050,quantity:2
  });
  await rejected('MOA only cannot use SWIM15',{
    items:[{priceId:MOA,quantity:1}],fulfillment:'ship',discountCode:PROMO
  },'SWIM15 applies only to Max2.0. Add at least one box to use it.');
}
async function verifyExpiry(){
  console.log('SWIM15 ONE-TIME OCTOBER 26 LIVE EXPIRY TEST — no session creation');
  console.log('Time now (UTC): '+new Date().toISOString()+'; expiration exclusive at 2026-10-26T04:00:00Z');
  await rejected('SWIM15 expired at October 26 04:00:00 UTC',max2(1),
    'SWIM15 is valid only on October 24-25, 2026.');
}
try {
  if (day === '2026-10-24') await verifyWindow();
  else await verifyExpiry();
  console.log('RESULT: ALL REQUESTED LIVE CHECKS PASSED. No payment confirmation, charges or refunds.');
} catch(error) {
  console.error('RESULT: FAIL — '+error.message);
  process.exitCode=1;
}