import { chromium } from 'playwright';
// Read-only product view + unpaid checkout; do not enter card data or submit payment.
const BASE='https://www.1010andhealthy.com';
const API='https://1010-healthy-api-production-b8c3.up.railway.app';
const expected=[[1,9900,895,10795],[2,19800,0,19800],[3,29700,0,29700]];
const browser=await chromium.launch({headless:true});
let failures=0, successes=0;
function check(name,value,detail=''){console.log((value?'PASS':'FAIL')+' '+name+(detail?' — '+detail:''));if(value)successes++;else failures++;}
for(const [qty,subtotal,ship,total] of expected){
 const ctx=await browser.newContext({viewport:{width:390,height:844}});
 const page=await ctx.newPage(), seen=[], reqs=[];
 page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('create-checkout-session')){try{reqs.push(r.postDataJSON())}catch{}}});
 page.on('response',async r=>{if(r.request().method()==='POST'&&r.url().includes('create-checkout-session')){try{const v=await r.json();seen.push({status:r.status(),clientSecret:v.clientSecret,error:v.error})}catch{}}});
 try{
  const pageResponse=await page.goto(BASE+'/shop/product/slenderiiz-drops?utm_source=wellness_letter&utm_medium=qr&utm_campaign=november_2026_slenderiiz&utm_content=featured_product_page7',{waitUntil:'domcontentloaded',timeout:35000});
  await page.waitForTimeout(3500);
  const body=await page.locator('body').innerText();
  console.log('STORE PAGE qty='+qty+' http='+pageResponse.status()+' '+page.url());
  console.log('PRICE TEXT qty='+qty+' '+body.split('\n').filter(x=>/99|150|holiday|special|cart|checkout/i.test(x)).slice(0,25).join(' | ').slice(0,1200));
  check('product page http 200, qty '+qty,pageResponse.status()===200);
  check('visible $99 offer, qty '+qty,/\$99(?:\.00)?\b/.test(body));
  for(let i=1;i<qty;i++){
    const plus=page.getByRole('button',{name:/^\+$/});
    if(await plus.count())await plus.first().click();else {console.log('No plus button found, qty '+qty);break}
  }
  await page.waitForTimeout(300);
  const buyLink=page.getByRole('link',{name:/buy now/i});
  const buyBtn=page.getByRole('button',{name:/buy now/i});
  const addBtn=page.getByRole('button',{name:/add to cart/i});
  if(await buyLink.count())await buyLink.first().click();
  else if(await buyBtn.count())await buyBtn.first().click();
  else if(await addBtn.count())await addBtn.first().click();
  else console.log('No buy/add button found');
  await page.waitForTimeout(2500);
  if(!seen.length){
    // Buy Now leads first to /shop/cart. Proceed from cart to the contact form.
    if(page.url().includes('/shop/cart')){
      const fromCart=page.getByRole('button',{name:/checkout|proceed to checkout/i});
      const fromCartLink=page.getByRole('link',{name:/checkout|proceed to checkout/i});
      if(await fromCart.count())await fromCart.first().click();
      else if(await fromCartLink.count())await fromCartLink.first().click();
    }
    await page.waitForURL(/\/shop\/checkout(?:\?|$)/,{timeout:12000}).catch(()=>{});
    console.log('FORM_PREP qty='+qty+' url='+page.url());
    if(page.url().includes('/shop/checkout')){
      console.log('FORM_FIELDS '+JSON.stringify(await page.locator('input,select').evaluateAll(els=>els.map(x=>({tag:x.tagName,name:x.name,id:x.id,placeholder:x.placeholder,type:x.type})))));
      await page.getByPlaceholder('Jane',{exact:true}).fill('Unpaid QA');
      await page.getByPlaceholder('Smith',{exact:true}).fill('Verification');
      await page.getByPlaceholder('jane@example.com',{exact:true}).fill('unpaid-qa-'+qty+'@example.com');
      await page.getByPlaceholder('123 Main Street',{exact:true}).fill('20 N 6th St');
      await page.getByPlaceholder('Lafayette',{exact:true}).fill('Lafayette');
      await page.locator('select').first().selectOption('IN');
      await page.getByPlaceholder('47901',{exact:true}).fill('47901');
    }
    const checkout=page.getByRole('button',{name:/continue to payment|checkout|proceed to checkout/i});
    const checkoutLink=page.getByRole('link',{name:/continue to payment|checkout|proceed to checkout/i});
    if(await checkout.count())await checkout.first().click();
    else if(await checkoutLink.count())await checkoutLink.first().click();
    await page.waitForTimeout(4000);
  }
  console.log('AFTER CLICK qty='+qty+' url='+page.url()+' buttons='+JSON.stringify((await page.locator('button').allTextContents()).map(x=>x.trim()).filter(Boolean).slice(0,25)));
  console.log('PAYLOAD qty='+qty+' '+JSON.stringify(reqs).slice(0,1500));
  const response=seen.find(x=>x.status===200&&x.clientSecret);
  check('storefront created unpaid checkout, qty '+qty,!!response,'responses='+JSON.stringify(seen.map(x=>({status:x.status,error:x.error}))));
  if(response){
    const id=response.clientSecret.split('_secret_')[0];
    const r=await ctx.request.get(API+'/api/checkout-session/'+encodeURIComponent(id),{timeout:15000});
    const session=await r.json();
    check('Stripe session unpaid, qty '+qty,r.status()===200&&session.payment_status==='unpaid');
    check('Stripe session exact amount, qty '+qty,session.amount_subtotal===subtotal&&session.shipping_cost?.amount_total===ship&&session.amount_total===total,JSON.stringify({subtotal:session.amount_subtotal,shipping:session.shipping_cost?.amount_total,total:session.amount_total}));
  } else console.log('CHECKOUT PAGE qty='+qty+' '+(await page.locator('body').innerText()).slice(0,1600));
 }catch(e){check('browser flow qty '+qty,false,String(e.message).slice(0,700))}
 finally{await ctx.close()}
}
await browser.close();
console.log('SUMMARY '+successes+' passed, '+failures+' failed; no cards or charges.');
if(failures)process.exitCode=1;