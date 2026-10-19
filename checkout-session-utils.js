// Stripe Checkout migrated fulfillment addresses from session.shipping_details
// to session.collected_information.shipping_details. Support both API shapes.
function checkoutShippingDetails(session) {
  return session?.collected_information?.shipping_details
    || session?.shipping_details
    || null;
}
module.exports = { checkoutShippingDetails };
