const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { checkoutShippingDetails } = require('../checkout-session-utils');

const sampleAddress = {line1:'10 Example St',line2:'Unit 5',city:'Lafayette',state:'IN',postal_code:'47905',country:'US'};
const newShape = {collected_information:{shipping_details:{name:'Example Recipient',address:sampleAddress}},shipping_details:null};
const legacyShape = {shipping_details:{name:'Example Recipient',address:sampleAddress}};
test('reads collected_information shipping_details on current Stripe API',()=>{
 assert.deepEqual(checkoutShippingDetails(newShape),newShape.collected_information.shipping_details);
});
test('accepts older shipping_details API shape',()=>{
 assert.deepEqual(checkoutShippingDetails(legacyShape),legacyShape.shipping_details);
});
test('prefers collected_information when both fields exist',()=>{
 assert.deepEqual(checkoutShippingDetails({...legacyShape,...newShape}),newShape.collected_information.shipping_details);
});
test('returns null when no physical shipping address is collected',()=>{
 assert.equal(checkoutShippingDetails({metadata:{fulfillment_type:'local_delivery'}}),null);
 assert.equal(checkoutShippingDetails(null),null);
});

function backend(session){
 const handlers=new Map();
 const app={use(){},get(route,handler){handlers.set(route,handler)},post(route,...fns){handlers.set(route,fns.at(-1))},listen(_port,cb){cb?.()}};
 function express(){return app}
 express.json=()=>()=>{};
 express.raw=()=>()=>{};
 const stripe={checkout:{sessions:{retrieve:async()=>session}},webhooks:{}};
 const fakeRequire=(name)=>{
  if(name==='dotenv')return {config(){}};
  if(name==='express')return express;
  if(name==='cors')return ()=>()=>{};
  if(name==='stripe')return ()=>stripe;
  if(name==='./checkout-session-utils')return {checkoutShippingDetails};
  if(name==='./checkout-policy')return {validateItems(){},shippingOptions(){},isLocalDelivery(){return true}};
  if(name==='resend')return {Resend:class{}};
  throw Error('unexpected dependency '+name);
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8'),{
   require:fakeRequire,process:{env:{CLIENT_URL:'https://www.1010andhealthy.com',PORT:'3001'}},
   console:{log(){},warn(){},error(){},info(){}},fetch:()=>Promise.reject(Error('unused')),
   URLSearchParams,AbortSignal,
 },{filename:'server.js'});
 return async()=>{
  let body,statusCode=200;
  const res={json(x){body=x;return this;},status(x){statusCode=x;return this;}};
  const handler=handlers.get('/api/checkout-session/:sessionId');
  assert.equal(typeof handler,'function');
  await handler({params:{sessionId:'cs_mock_test'}},res);
  return {body,statusCode};
 };
}
test('GET checkout session returns paid modern shipping address',async()=>{
 const get=backend({id:'cs_mock_test',status:'complete',payment_status:'paid',
   collected_information:{shipping_details:{address:sampleAddress}},
   metadata:{fulfillment_type:'ship'},shipping_cost:{amount_total:895},
   amount_total:13395,amount_subtotal:12500,total_details:{amount_discount:0,amount_tax:0},currency:'usd',
   line_items:{data:[]}});
 const r=await get();
 assert.equal(r.statusCode,200);
 assert.equal(r.body.shipping.address.line1,sampleAddress.line1);
 assert.equal(r.body.shipping.address.line2,'Unit 5');
 assert.equal(r.body.payment_status,'paid');
 assert.equal(r.body.metadata.fulfillment_type,'ship');
});
test('GET checkout session returns local delivery address from persisted metadata',async()=>{
 const get=backend({id:'cs_mock_test',status:'complete',payment_status:'paid',
   collected_information:{shipping_details:null},metadata:{fulfillment_type:'local_delivery',delivery_address:'25 Example Ave, West Lafayette, IN 47906'},
   amount_total:6500,amount_subtotal:6500,shipping_cost:{amount_total:0},currency:'usd',line_items:{data:[]}});
 const r=await get();
 assert.equal(r.statusCode,200);
 assert.equal(r.body.shipping,null);
 assert.equal(r.body.metadata.fulfillment_type,'local_delivery');
 assert.match(r.body.metadata.delivery_address,/West Lafayette/);
});
test('GET returns unpaid status rather than falsely claiming confirmed payment',async()=>{
 const get=backend({id:'cs_mock_test',status:'open',payment_status:'unpaid',metadata:{fulfillment_type:'ship'},
   amount_total:15000,amount_subtotal:15000,shipping_cost:{amount_total:0},currency:'usd',line_items:{data:[]}});
 const r=await get();
 assert.equal(r.statusCode,200);
 assert.equal(r.body.payment_status,'unpaid');
 assert.equal(r.body.status,'open');
});
