const FREE_OVER_CENTS = 12500;
const STANDARD_CENTS = 895;
const ALLOWED_PRICE_IDS = new Set([
'price_1U9pFQGaIkBjCnN2nD8BYKvB','price_1U9pFSGaIkBjCnN2aLUlDGrl','price_1U9pFSGaIkBjCnN2OZj8vXcC','price_1U9pFSGaIkBjCnN2oWCmgTVQ','price_1U9pFPGaIkBjCnN2xWaDfZG8','price_1US5JiGaIkBjCnN2j4GJdggr','price_1U9pFPGaIkBjCnN2Y1ByxKIV','price_1U9pFSGaIkBjCnN26JtUQLGm','price_1U9pFQGaIkBjCnN2lgEIzRFv','price_1U9pFQGaIkBjCnN2Z2fcWh29','price_1UMdLmGaIkBjCnN2Ig6sezca','price_1U9pFQGaIkBjCnN2ZOST5WE4','price_1US5JqGaIkBjCnN2vNseeOau','price_1U9pFSGaIkBjCnN2shv1Ilzv','price_1U9pFQGaIkBjCnN2Cz3wBKIO','price_1U9pFUGaIkBjCnN2HJjaD1OD','price_1US5JsGaIkBjCnN2vyPVNwRf','price_1US5JuGaIkBjCnN2WWtzJTPR','price_1U9pFRGaIkBjCnN26z7zLODS','price_1U9pFPGaIkBjCnN2odxfYH52','price_1U9pFTGaIkBjCnN2PJYuw4HB','price_1U9pFXGaIkBjCnN2lRBNqkKr','price_1U9pFPGaIkBjCnN2tDGa13qE','price_1U9pFSGaIkBjCnN2NFwN3J2n','price_1US5JvGaIkBjCnN2iXBvrfDf','price_1U9pFPGaIkBjCnN2doJXxoX9','price_1US5JxGaIkBjCnN2Z7rHzNAu','price_1U9pFSGaIkBjCnN2V7RKmbqt','price_1U9pFSGaIkBjCnN2hpgeT9R6','price_1U9pFSGaIkBjCnN2UdR2pTxm','price_1U9pFPGaIkBjCnN2gSBDL9vZ'
]);
function validateItems(items) {
 if (!Array.isArray(items) || !items.length || items.length > 99) throw new Error('invalid_items');
 for (const item of items) {
  if (!item || !ALLOWED_PRICE_IDS.has(item.priceId)) throw new Error('unknown_price');
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) throw new Error('invalid_quantity');
 }
}
function shippingOptions(qualifyingCents, fulfillment) {
 if (fulfillment === 'pickup') return undefined;
 const free = qualifyingCents > FREE_OVER_CENTS;
 return [{shipping_rate_data:{type:'fixed_amount',fixed_amount:{amount:free?0:STANDARD_CENTS,currency:'usd'},display_name:free?'Free standard shipping (orders over $125)':'Standard shipping (3–7 business days)',delivery_estimate:{minimum:{unit:'business_day',value:3},maximum:{unit:'business_day',value:7}},tax_behavior:'exclusive',tax_code:'txcd_92010001'}}];
}
module.exports={ALLOWED_PRICE_IDS,validateItems,shippingOptions};
