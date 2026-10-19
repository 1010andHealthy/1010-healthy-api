# Website checkout handoff — local delivery (draft, not deployed)

**Do not deploy the frontend until backend staging tests pass.**

## Customer experience
- Replace all references to "Market on Main pickup" with **Free local delivery**.
- Fulfillment choices: `ship` (standard shipping) and `local_delivery`.
- Local delivery: customer chooses **Use my order address** or **Enter a different delivery address**. Prefill the first option from existing checkout address; make both editable before submitting. Require street number, street, city, state, ZIP; capture apartment/suite as optional line2.
- For `local_delivery`, send the **selected delivery address** as `deliveryAddress: {line1,line2?,city,state,postalCode}` with checkout session request. Do not treat billing address as delivery address automatically.
- Show **Free local delivery — verified addresses within 15 miles of downtown Lafayette OR downtown West Lafayette, Indiana**.
- If backend returns 400 (ineligible/unverifiable address) prompt customer to correct address or select shipping; if 503, show shipping fallback.
- For `ship`, preserve existing Stripe shipping-address collection.
- No pickup option anywhere, including confirmation and marketing copy.
- Keep SUBARU15 as only entered discount. The backend accepts it case-insensitively; other codes return an error.
- Standard shipping is $8.95 if discounted merchandise subtotal <= $125; free if > $125.

## Backend dependency
- Backend requires Railway variable `GOOGLE_MAPS_GEOCODING_API_KEY` (Google Maps Geocoding API enabled, billing configured); do not paste the secret into a chat or source code.
- Address verification is server-side and checks street-level geocoding and 15-mile straight-line distance from either downtown reference point.
- Test real local addresses, addresses just outside both circles, PO boxes, and addresses with ambiguous geocoding. No charges.
- TAX_ENABLED must remain unset/false until Indiana registration is approved.
- The backend is in draft PR #1; NOT production-ready yet.
