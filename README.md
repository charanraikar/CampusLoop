# CampusLoop

A working college project: students book campus services, vendors fulfil orders, and administrators approve vendors and inspect activity. Includes hostel group discounts, order histories, reviews and simulated checkout. No real money is collected.

## Version 1.1 — hosting and GitHub preparation

New: protected print PDF uploads/downloads (3 MB), downloadable demo receipts, vendor rejection with a reason and simulated refund, password changes with session revocation, hosting health checks, optional private admin bootstrap, Docker/Render configurations and GitHub Actions checks.

- **Learn the code:** [Step-by-step code guide](docs/CODE_GUIDE.md)
- **Publish:** [Windows GitHub and hosting instructions](docs/HOSTING_AND_GITHUB.md)
- **Design and viva:** [Project architecture](docs/PROJECT.md)
- **Verification:** [Validation notes](docs/VALIDATION.md)

The default Render configuration is a free, temporary-data portfolio demo. The optional persistent configuration is paid. Neither file means the site has already been deployed.

## Start in three steps

1. Install **Node.js 24 LTS** (npm is included).
2. Extract this project and open a terminal in the `CampusLoop` folder containing `package.json`.
3. Run:

```sh
npm run demo
```

Open **http://localhost:3000** in your browser. Do not double-click `public/index.html`: the app needs its server. No npm install, external database, API key or paid service is required. Stop with Ctrl+C. Node may display a warning about its built-in SQLite API.

## Demo login

| Role | Email | Password |
| --- | --- | --- |
| Student | student@campusloop.test | CampusLoop123! |
| Vendor | vendor@campusloop.test | CampusLoop123! |
| Admin | admin@campusloop.test | CampusLoop123! |

These are public demonstration credentials. `npm run demo` seeds them and three example services. Regular `npm start` does not seed accounts; already seeded accounts remain in the database. Use separate browser profiles/private windows to demonstrate multiple roles at once, because each browser session has one active account.

## Demo walkthrough

1. Sign in as the student; book two kilograms of laundry. The server computes ₹98.
2. In Dashboard, select Demo checkout and confirm. No payment gateway is contacted.
3. Sign out and sign in as the vendor. Accept the order, mark it in progress, then completed.
4. Sign in as the student and submit a review. The catalog now shows the service's average rating.
5. Sign in as admin. See ₹98 in completed demo sales and ₹9.80 in demo commission.
6. Register a new vendor. They cannot publish until the admin approves them. Once approved, they can list a service.
7. Register two student accounts. Create a two-person hostel group with one and join with the other. Both can now book once with a 10% discount. Bookings use the group's pickup location.

## Implemented features

- Student and vendor registration; password hashing with per-user salts and scrypt.
- Persistent SQLite database, foreign keys, transactions and parameterized queries.
- HttpOnly sessions with expiration; server-side role and ownership checks.
- Vendor approval and service listings; search and category filters (laundry, printing, repairs, food, tutoring, books, cleaning, rentals).
- Server-priced bookings, simulated payment/refund and enforced order transitions.
- Group formation, unique memberships, capacity, 24-hour expiry and quorum-based 10% discount.
- Order timeline, completed-order reviews and service rating aggregation.
- Protected print PDF uploads and downloads; text demo receipts.
- Vendor rejection with a reason and simulated refund; account password change.
- Admin totals and 10% simulated platform commission on completed orders.
- Responsive UI, native accessible dialogs, escaped user content and a content security policy.
- API integration tests.

Prices are stored in integer paise. An order snapshots its total and commission; a client cannot supply an accepted price. Group discounts apply before the commission is calculated. All vendors opt into the project's fixed group-discount policy when listing services. Groups represent purchase intent, not a guarantee that every member will complete an order.

## Tests

```sh
npm test
```

Tests use isolated in-memory/temporary databases, not your local project data. See `tests/api.test.js` and `tests/hosting.test.js`. The ten tests cover API, database and hosting additions. Browser smoke checks, if included in delivery validation, are separate from this built-in test command.

## Structure

```text
CampusLoop/
  server.js             HTTP API, database schema, auth and business rules
  public/index.html     Application shell
  public/styles.css    Responsive styling
  public/app.js        Student, vendor and admin views
  tests/api.test.js     API integration tests
  docs/PROJECT.md       Design, database, API and viva guide
  Dockerfile           Optional container deployment
  data/                Database generated on first start (not committed)
```

## Hosting a project demo

Use a Node.js 24 server/container with a persistent writable disk. Static-only hosting cannot run this backend. Set `HOST=0.0.0.0` for hosted containers, `PORT` to the host's assigned port, and optionally `DB_PATH` to a mounted persistent disk path. Set `SECURE_COOKIES=true` when the external site uses HTTPS. SQLite is appropriate for a single application instance; do not run separate replicas with separate local databases.

Optional Docker:

```sh
docker build -t campusloop .
docker run --rm -p 3000:3000 -e DEMO_MODE=true -v campusloop-data:/app/data campusloop
```

The Docker default does not seed accounts; the example explicitly enables public demo accounts with DEMO_MODE=true. Use only fictitious data on a publicly accessible project demo. This delivery is not a commercial launch: real payments/refunds, identity/email verification, notifications, automated backups, email password reset, production monitoring and formal service agreements are not implemented. Password changes and protected print PDF uploads are implemented. The system offers device inspection bookings, not AI diagnosis or guaranteed repairs. Commission totals are simulated, not revenue.

## Resume wording — use after you can demonstrate it

**CampusLoop — Campus Services Marketplace | JavaScript, Node.js, SQLite, REST APIs**

- Built a three-role campus marketplace with service listings, vendor approval, persistent bookings and order fulfilment workflows.
- Implemented session authentication, server-side authorization, group discounts, simulated checkout and commission analytics.
- Added API integration tests covering ownership isolation, price validation, order transitions, vendor approval and group eligibility.

Do not claim real customers, revenue, payment-gateway integration or measured business improvements without evidence.

## v1.4 additions
Legal pages, password reset, email verification, pickup slots, a "ready" order step, vendor profiles, coupons and referrals, order chat, admin refund screen, vendor earnings, installable app, dark mode, Hindi/Kannada and an audit log. See `docs/FEATURES.md`, `docs/DEPLOY_RENDER.md` and `docs/README_TEMPLATE.md`.
