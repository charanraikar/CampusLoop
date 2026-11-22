# CampusLoop v1.4 features

| Area | What it does | Where |
|---|---|---|
| Legal pages | `/terms`, `/privacy`, `/refund-policy` (edit the contact placeholders) | `public/*.html` |
| Password reset | "Forgot password?" → emailed one-hour link | `/api/forgot`, `/api/reset-password` |
| Email verification | Link emailed on sign-up. Enforced for new orders only when email is configured | `/api/verify-email` |
| Pickup slots | Student picks a day + time window; vendors see a schedule | `orders.slot` |
| Ready step | pending → accepted → in progress → **ready** → completed, with email to the student | `server.js` status route |
| Notifications | Email on status changes, new paid orders and new chat messages. Uses Brevo (free, no domain needed) or Resend | `sendMail()` |
| WhatsApp chat links | Vendors add an optional number; students get a "Chat on WhatsApp" link on the vendor page and on their orders (opens WhatsApp, no API needed) | `vendor_profiles.whatsapp` |
| Earnings export | Vendors download completed orders as a CSV spreadsheet (gross, fee, net, "payout done?" column) with optional date range | `/api/vendor/earnings.csv` |
| Vendor profiles | Bio, hours, area, reviews, services at `#vendor/ID` | `/api/vendors/:id`, `/api/profile` |
| Coupons | Admin-created codes (1–50%, max uses, first-order-only) | `/api/admin/coupons` |
| Referrals | Each student has a `REF…` code: friend gets 10% off first order, referrer gets a 10% `THANKS…` coupon when it completes | `users.ref_code` |
| Book again | One-click reorder from past orders | `public/app.js` |
| Order chat | Student ↔ vendor messages per order (admin read-only) | `/api/orders/:id/messages` |
| Refund screen | Admin sees `refund_due` orders: retry via Razorpay or mark refunded | `/api/admin/orders/:id/refund` |
| Earnings | Vendor totals, 14-day chart, upcoming schedule | `/api/vendor/earnings` |
| Installable app | Manifest + service worker (network-first, API never cached) | `public/manifest.webmanifest`, `public/sw.js` |
| Dark mode / languages | Follows system theme, 🌓 toggle; English, Hindi, Kannada for the main screens | `public/app.js` (`I18N`) |
| Category tiles, stars, sorting | Coloured icon tile per category, star ratings with review counts, sort by price / rating / most reviewed | `serviceCard()`, `#sort` in `public/app.js` |
| Favourites | Heart on every service, "♥ Saved" filter, stored per account | `/api/favorites` |
| Notification bell | In-app list of order updates, payments, messages and refunds, with unread badge (polls every 45 s) | `/api/notifications` |
| Motion | Cards fade up on scroll, lift on hover, grey skeleton loaders, confetti after payment (all off for reduced-motion) | `revealCards()`, `skeleton()`, `confetti()` |
| Admin charts | Orders per day, completed sales per day, orders by category and status | `/api/admin/charts` |
| Safety | 600 requests/min/IP, 20 auth-related attempts/10 min, admin audit log (latest 100) | `limited()`, `audit()` |

## Not included (needs accounts or decisions outside the code)
- **Vendor payouts via Razorpay Route**: needs Route enabled by Razorpay, plus KYC-verified linked accounts for each vendor. Until then, pay vendors manually using the earnings dashboard.
- **Automatic WhatsApp alerts**: needs a WhatsApp Business API provider (Twilio, Meta Cloud API). Click-to-chat links are included instead.
- **Vendor photos**: file/image storage was left out to keep the database small.
- **Deployment, README screenshots and demo video**: do these yourself, see `docs/DEPLOY_RENDER.md` and `docs/README_TEMPLATE.md`.
