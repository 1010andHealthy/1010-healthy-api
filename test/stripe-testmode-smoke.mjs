// Real Stripe *test-mode* integration; no card details, confirmations or charges.
// Execute only with STRIPE_TEST_SECRET_KEY=sk_test_...; never run using a live key.
import Stripe from 'stripe';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
const key=process.env.STRIPE_TEST_SECRET_KEY;
if(!key || !key.startsWith('sk_test_')){
  console.error('STRIPE_TEST_SECRET_KEY must be a Stripe sk_test_ key. No live-mode fallback.');
  process.exit(2);
}
const stripe=new Stripe(key,{apiVersion:'2023-10-16'});
const now=new Date();
const today=now.toLocaleDateString('en-CA',{timeZone:'America/Indiana/Indianapolis'});
if(today < '2026-11-01' || today > '2026-12-31'){
  console.error('Holiday test-mode integration requires running during Nov 1–Dec 31, 2026. Boundaries are separately mocked.');
  process.exit(2);
}
let child;
const resources={products:[],coupons:[],sessions:[]};
let checked=0;
function equal(actual,expected,label) {
  checked++;
  if(actual!==expected) throw Error(label+': expected '+JSON.stringify(expected)+', got '+JSON.stringify(actual));
  console.log('PASS '+label);
}
const getPort=()=>new Promise((resolve,reject)=>{
  const server=createServer();server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
});
async function createProduct(name,unit_amount){
  const p=await stripe.products.create({name,metadata:{integration_test:'holiday_checkout_2026'}});
  resources.products.push(p.id);
  const price=await stripe.prices.create({product:p.id,currency:'usd',unit_amount});
  return {p,price};
}
async function submit(base,body){
  const response=await fetch(base+'/api/create-checkout-session',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  const payload=await response.json();
  if(response.status!==200) return {status:response.status,error:payload.error};
  if(!payload.clientSecret?.startsWith('cs_test_'))throw Error('Expected test-mode embedded Checkout clientSecret');
  const mark=payload.clientSecret.indexOf('_secret_');
  if(mark<0)throw Error('Missing Checkout Session ID');
  const sid=payload.clientSecret.slice(0,mark);
  resources.sessions.push(sid);
  const session=await stripe.checkout.sessions.retrieve(sid,{expand:['line_items']});
  const lines=await stripe.checkout.sessions.listLineItems(sid,{limit:20});
  equal(session.payment_status,'unpaid','No payment was attempted');
  return {status:response.status,session,lines:lines.data};
}
try{
  const suffix=String(Date.now());
  const slender=await createProduct('Slenderiiz Drops test fixture',15000);
  const other=await createProduct('Other wellness test fixture',10000);
  const holidayCouponId='H26_TEST_'+suffix;
  await stripe.coupons.create({
    id:holidayCouponId,name:'Slenderiiz test-only $51 off',amount_off:5100,
    currency:'usd',duration:'once',redeem_by:1798779599,
    applies_to:{products:[slender.p.id]},metadata:{product_id:slender.p.id}
  });
  resources.coupons.push(holidayCouponId);
  const subaruCouponId='S15_TEST_'+suffix;
  await stripe.coupons.create({id:subaruCouponId,percent_off:15,duration:'once'});
  resources.coupons.push(subaruCouponId);
  const port=await getPort();
  const base='http://127.0.0.1:'+port;
  const env={...process.env,
    NODE_ENV:'test',PORT:String(port),STRIPE_SECRET_KEY:key,
    STRIPE_WEBHOOK_SECRET:'',RESEND_API_KEY:'',CLIENT_URL:'https://www.1010andhealthy.com',
    SLENDERIIZ_PRICE_ID:slender.price.id,SLENDERIIZ_PRODUCT_ID:slender.p.id,
    HOLIDAY_COUPON_ID:holidayCouponId,TEST_SUBARU_COUPON_ID:subaruCouponId,
    TEST_EXTRA_PRICE_IDS:other.price.id,
  };
  child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});
  let childStderr='';
  child.stderr.on('data',b=>{childStderr=(childStderr+b.toString()).slice(-1800);});
  let started=false;
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)break;
    try{const r=await fetch(base+'/health');if(r.ok){started=true;break;}}catch{}
    await delay(150);
  }
  if(!started)throw Error('Backend startup failed: '+childStderr);
  const status=await(await fetch(base+'/api/holiday-slenderiiz')).json();
  equal(status.saleActive,true,'Public flag active');
  equal(status.currentUnitCents,9900,'Public unit price $99');
  const one=(q,code)=>({items:[{priceId:slender.price.id,quantity:q}],fulfillment:'ship',discountCode:code});
  for(const [qty,subtotal,shipping] of [[1,9900,895],[2,19800,0],[3,29700,0]]){
    const r=await submit(base,one(qty));
    equal(r.status,200,'Quantity '+qty+' session created');
    equal(r.session.amount_subtotal,subtotal,'Quantity '+qty+' merchandise subtotal');
    equal(r.session.shipping_cost.amount_total,shipping,'Quantity '+qty+' shipping');
    equal(r.session.amount_total,subtotal+shipping,'Quantity '+qty+' payable total');
    equal(r.lines[0].price.unit_amount,9900,'Quantity '+qty+' Stripe per-unit price');
    equal(r.session.metadata.holiday_offer,holidayCouponId,'Quantity '+qty+' campaign metadata');
  }
  const mixed=await submit(base,{
    items:[{priceId:slender.price.id,quantity:1},{priceId:other.price.id,quantity:1}],
    fulfillment:'ship',discountCode:'SUBARU15'
  });
  equal(mixed.status,200,'Mixed cart created');
  equal(mixed.session.amount_total,18400,'Mixed cart $99 + other $85 with free shipping');
  const amounts=mixed.lines.map(i=>i.price.unit_amount).sort((a,b)=>a-b);
  equal(amounts.join(','),'8500,9900','SUBARU15 only applied to other product');
  const subaruOnly=await submit(base,one(1,'SUBARU15'));
  equal(subaruOnly.status,400,'SUBARU15 cannot stack with only Slenderiiz');
  const old=await submit(base,one(1,'NOV2026_SLENDERIIZ_51'));
  equal(old.status,400,'Old coupon rejected');
  console.log('REAL STRIPE TEST-MODE CHECKOUT PASS: '+checked+' assertions; all sessions unpaid, no charges.');
} finally {
  if(child){child.kill('SIGTERM');await delay(200);}
  for(const sid of resources.sessions){
    try{await stripe.checkout.sessions.expire(sid);}catch{}
  }
  for(const id of resources.coupons){try{await stripe.coupons.del(id);}catch{}}
  for(const id of resources.products){try{await stripe.products.update(id,{active:false});}catch{}}
}
