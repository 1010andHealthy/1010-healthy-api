// One-time offer audit. Creates UNPAID Checkout Sessions only. NO payment methods, charges or refunds.
const base = 'https://1010-healthy-api-production-b8c3.up.railway.app';
const vinali='price_1U9pFPGaIkBjCnN2doJXxoX9';
const moa='price_1U9pFSGaIkBjCnN26JtUQLGm';
const vital='price_1U9pFSGaIkBjCnN2OZj8vXcC';
let tested=0,failed=[];
const row=(description,pass,detail)=>{
  tested++; console.log((pass?'PASS':'FAIL')+' '+description+' '+detail);
  if(!pass)failed.push(description+' '+detail);
};
async function post(body){
  const result=await fetch(base+'/api/create-checkout-session',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(18000)
  });
  return {status:result.status,body:await result.json()};
}
async function getSession(response){
  if(response.status!==200 || !response.body.clientSecret) return;
  const ix=response.body.clientSecret.indexOf('_secret_');
  if(ix<0) return;
  const id=response.body.clientSecret.slice(0,ix);
  const result=await fetch(base+'/api/checkout-session/'+encodeURIComponent(id),{signal:AbortSignal.timeout(12000)});
  return result.ok ? await result.json():undefined;
}
const shipping=(items,code='BABYGIRL37')=>({items,fulfillment:'ship',discountCode:code});
try {
 const healthy=await fetch(base+'/health',{signal:AbortSignal.timeout(10000)});
 row('backend health',healthy.ok,'http='+healthy.status);
 for(const [name,body,expected] of [
  ['two Vinali standard shipping',shipping([{priceId:vinali,quantity:2}]),{subtotal:12000,discount:4440,shipping:895,total:8455}],
  ['two Vinali free local delivery',{items:[{priceId:vinali,quantity:2}],discountCode:'babygirl37',fulfillment:'local_delivery',deliveryAddress:{line1:'20 N 6th St',city:'Lafayette',state:'IN',postalCode:'47901'}},{subtotal:12000,discount:4440,shipping:0,total:7560}],
  ['SUBARU15 unchanged',shipping([{priceId:vital,quantity:1}],'SUBARU15'),{subtotal:15000,discount:2250,shipping:0,total:12750}]
 ]) {
  const res=await post(body); const sess=await getSession(res);
  const actual={subtotal:sess?.amount_subtotal,discount:sess?.total_details?.amount_discount,shipping:sess?.shipping_cost?.amount_total,total:sess?.amount_total};
  row(name,res.status===200 && sess?.payment_status==='unpaid' && Object.keys(expected).every(k=>actual[k]===expected[k]),'http='+res.status+' details='+JSON.stringify(actual)+' payment='+sess?.payment_status);
 }
 for(const [name,items] of [
  ['one Vińali must be rejected',[{priceId:vinali,quantity:1}]],
  ['three Vińali must be rejected',[{priceId:vinali,quantity:3}]],
  ['two MOA must be rejected',[{priceId:moa,quantity:2}]],
  ['mixed cart must be rejected',[{priceId:vinali,quantity:2},{priceId:moa,quantity:1}]],
 ]) {
  const res=await post(shipping(items));
  row(name,res.status===400 && !!res.body.error && !res.body.clientSecret,'http='+res.status+' error='+res.body.error);
 }
 for(const code of ['SUBARU20','WELCOME10','LOCALPICKUP']){
  const res=await post(shipping([{priceId:vinali,quantity:2}],code));
  row(code+' remains blocked',res.status===400 && !!res.body.error,'http='+res.status);
 }
}catch(error){row('audit failed unexpectedly',false,error.message)}
console.log('SUMMARY '+(tested-failed.length)+'/'+tested+' passed; only unpaid sessions created; no payment attempt.');
if(failed.length){console.error(failed.join('\n'));process.exitCode=1}
