// PR preflight against CURRENT live backend, before shipping the new PR.
// Creates one UNPAID Stripe Checkout Session; no payment attempt or charge.
const url = 'https://1010-healthy-api-production-b8c3.up.railway.app/api/create-checkout-session';
const payload = {items:[{priceId:'price_1UMdLmGaIkBjCnN2Ig6sezca',quantity:1}],fulfillment:'ship'};
const response = await fetch(url,{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)
});
const data=await response.json();
if(response.status!==200 || !data.clientSecret?.startsWith('cs_live_')){
  console.error('Preflight failed: HTTP='+response.status+' error='+(data.error || '(no public error)'));
  process.exitCode=1;
}else{
  console.log('Preflight PASS: deployed legacy Stripe SDK created one unpaid checkout session (no card, no charge)');
}
