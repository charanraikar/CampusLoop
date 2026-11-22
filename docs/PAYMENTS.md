# Razorpay payments

CampusLoop uses Razorpay Standard Checkout. If `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are not set, it falls back to simulated payments.

## Flow
1. Student clicks **Pay now** → `POST /api/orders/:id/pay` creates a Razorpay order (amount comes from the database, never from the browser).
2. Razorpay's popup collects UPI / card / netbanking.
3. Browser sends the result to `POST /api/orders/:id/verify`; the server checks the HMAC-SHA256 signature with your key secret, then marks the order `paid`.
4. Optional webhook `POST /api/razorpay/webhook` (signed with `RAZORPAY_WEBHOOK_SECRET`) marks the order paid even if the student closes the tab early.
5. If a vendor rejects or a student cancels a paid order, the server calls Razorpay's refund API. If that fails the order shows `refund_due`; refund it from the Razorpay dashboard.

## Test locally
1. Create a Razorpay account and copy the **Test Mode** keys.
2. Copy `.env.example` to `.env`, fill in the two key lines, then run:
   `node --env-file=.env --watch server.js --demo`
3. Pay with Razorpay's test UPI id `success@razorpay` or test card 4111 1111 1111 1111 (any future expiry, any CVV).

## Going live
- Complete Razorpay KYC and switch to Live keys.
- Use persistent storage (see render-persistent.yaml): free-tier SQLite resets on restart, which would lose real orders.
- Keep payment auto-capture enabled in Razorpay settings.
- Only students pay in-app; vendor payouts are not automated (use Razorpay Route or pay vendors manually).
- Replace the "college project" wording and add Terms, Refund and Privacy pages, which Razorpay requires.

## Vendor payouts (not automated)
Customer payments land in your Razorpay account. Paying vendors automatically needs Razorpay Route (a separate product Razorpay must enable) plus a KYC-verified linked account per vendor. Until then use the vendor earnings dashboard to pay vendors manually.
