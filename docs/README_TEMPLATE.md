# CampusLoop

> Campus services marketplace: laundry, food, printing, tutoring, books, cleaning and rentals.

**Live demo:** https://YOUR-APP.onrender.com  ·  **Demo logins:** shown on the sign-in screen

![Home page](docs/screenshots/home.png)
![Student dashboard](docs/screenshots/student-dashboard.png)
![Vendor earnings](docs/screenshots/vendor-earnings.png)

▶ Demo video: https://YOUR-VIDEO-LINK

## Highlights
- Razorpay checkout (UPI/cards) with server-side signature verification and automatic refunds
- Group orders with hostel discounts, coupons and referral codes
- Pickup slots, order chat, email notifications (Brevo), WhatsApp click-to-chat
- Vendor profiles, earnings dashboard, CSV export for payouts, schedule
- Admin: vendor approval, coupons, refunds, audit log
- Installable PWA, dark mode, English/Hindi/Kannada

## Tech
Node.js (no framework), SQLite, vanilla JS front end, Razorpay (test mode), Brevo, Docker, Render (free tier).

> Note: the free Render demo sleeps after 15 minutes idle (first load can take about a minute) and resets its data on restart.

## Run locally
```
cd CampusLoop
node --env-file=.env --watch server.js --demo
```
