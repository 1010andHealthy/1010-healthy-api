// Run ONLY as a post-deploy smoke test. Creates UNPAID Stripe Checkout Sessions;
// never enters a card, confirms payment, or triggers a refund.
const API = process.env.CHECKOUT_SMOKE_API || 'https://1010-healthy-api-production-b8c3.up.railway.app';
const prices = {
  exactly125: 'price_1UMdLmGaIkBjCnN2Ig6sezca',
  over125: 'price_1U9pFXGaIkBjCnN2lRBNqkKr',
  exactly150: 'price_1U9pFSGaIkBjCnN2OZj8vXcC',
  seventy: 'price_1U9pFQGaIkBjCnN2Z2fcWh29',
  sixtyFive: 'price_1U9pFQGaIkBjCnN2nD8BYKvB'
};
const inLafayette = { line1:'20 N 6th St', city:'Lafayette',state:'IN',postalCode:'47901' };
const inWestLafayette = { line1:'101 N Grant St',city:'West Lafayette',state:'IN',postalCode:'47906' };
const outside = { line1:'200 E Washington St',city:'Indianapolis',state:'IN',postalCode:'46204' };
const unknown = { line1:'999999 Impossible Mystery Road',city:'Lafayette',state:'IN',postalCode:'47901' };

let failures = [];
let completed = 0;
function expect(label, pass, details = '') {
  completed++;
  console.log((pass?'PASS':'FAIL')+' '+label+(details?' — '+details:''));
  if (!pass) failures.push(label + (details?' ['+details+']':''));
}
function cart(priceId=prices.exactly125, qty=1, fulfillment='ship', other={}) {
  return { items:[{priceId,quantity:qty}],fulfillment,...other };
}
async function post(body){
  const r=await fetch(API+'/api/create-checkout-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  const json=await r.json();
  return {status:r.status,data:json};
}
async function details(checkoutResponse){
  if(checkoutResponse.status!==200 || !checkoutResponse.data.clientSecret) return null;
  const secret=checkoutResponse.data.clientSecret;
  const ix=secret.indexOf('_secret_');
  if(ix<0) return null;
  const sid=secret.slice(0,ix);
  const response=await fetch(API+'/api/checkout-session/'+encodeURIComponent(sid),{signal:AbortSignal.timeout(12000)});
  return response.ok ? await response.json() : null;
}
async function accepted(name,body,expected){
  try{
    const response=await post(body);
    const session=await details(response);
    const paid=session?.payment_status;
    const amount=session?.amount_total;
    const shipping=session?.shipping_cost?.amount_total;
    const subtotal=session?.amount_subtotal;
    const metadata=session?.metadata;
    expect(name,response.status===200 && !!session && paid==='unpaid'
      && amount===expected.amount && shipping===expected.shipping
      && (expected.subtotal==null || subtotal===expected.subtotal)
      && (expected.address==null || String(metadata?.delivery_address).includes(expected.address)),
      'HTTP='+response.status+' total='+amount+' shipping='+shipping+' paid='+paid);
  }catch(e){expect(name,false,'exception='+e.message)}
}
async function rejected(name,body,expectedHttp=400){
  try{
    const response=await post(body);
    expect(name,response.status===expectedHttp && typeof response.data.error==='string' && !response.data.clientSecret,'HTTP='+response.status);
  }catch(e){expect(name,false,'exception='+e.message)}
}
async function waitForRevision(){
  for(let attempt=0;attempt<90;attempt++){
    try{
      const response=await fetch(API+'/health',{signal:AbortSignal.timeout(7000)});
      const body=await response.json();
      if(body.checkout_revision==='local-delivery-v1') return;
    }catch(e){}
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  throw Error('Railway did not report the new checkout_revision in time; check deployment');
}
await waitForRevision();
console.log('Railway reports checkout_revision=local-delivery-v1. Beginning unpaid provider checks.');
await accepted('exactly $125 subtotal => $8.95 standard shipping',
  cart(prices.exactly125),{amount:13395,subtotal:12500,shipping:895});
await accepted('$130 subtotal => free standard shipping',
  cart(prices.over125),{amount:13000,subtotal:13000,shipping:0});
await accepted('$150 SUBARU15 => $127.50 with free shipping',
  cart(prices.exactly150,1,'ship',{discountCode:'SUBARU15'}),{amount:12750,subtotal:15000,shipping:0});
await accepted('$140 SUBARU15 => $119 + $8.95 shipping',
  cart(prices.seventy,2,'ship',{discountCode:'subaru15'}),{amount:12795,subtotal:14000,shipping:895});
await accepted('Lafayette street address => free local delivery',
  cart(prices.exactly125,1,'local_delivery',{deliveryAddress:inLafayette}),{amount:12500,shipping:0,address:'20 N 6th St'});
await accepted('West Lafayette street address => free local delivery',
  cart(prices.sixtyFive,1,'local_delivery',{deliveryAddress:inWestLafayette}),{amount:6500,shipping:0,address:'101 N Grant St'});
await accepted('different local delivery address overrides other customer metadata',
  cart(prices.sixtyFive,1,'local_delivery',{deliveryAddress:inLafayette,metadata:{notes:'original order address was elsewhere'}}),{amount:6500,shipping:0,address:'20 N 6th St'});
await rejected('Indianapolis address outside both 15-mile circles',
  cart(prices.exactly125,1,'local_delivery',{deliveryAddress:outside}));
await rejected('unverifiable street address must not get free delivery',
  cart(prices.exactly125,1,'local_delivery',{deliveryAddress:unknown}));
await rejected('stale pickup request rejected',cart(prices.exactly125,1,'pickup'));
for (const code of ['SUBARU20','WELCOME10','LOCALPICKUP','PAULA15']) {
  await rejected('reject '+code,cart(prices.exactly125,1,'ship',{discountCode:code}));
}
await rejected('tampered forged price ID',cart('price_forged_invalid'));
await rejected('tampered fractional quantity',cart(prices.exactly125,1.5));
console.log('SUMMARY '+(completed-failures.length)+'/'+completed+' checks passed. No payment attempts, charges, or refunds.');
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
