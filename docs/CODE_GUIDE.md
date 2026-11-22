# CampusLoop: step-by-step code guide

Open the **CampusLoop folder containing package.json** in VS Code. The outer ZIP folder is not the project root. Search for the function or endpoint below with Ctrl+Shift+F; function names remain useful when line numbers change.

## 1. Start the project

`package.json` maps `npm run demo` to `node server.js --demo`. Node runs `server.js`, opens or creates `data/campusloop.db`, sets up tables, and optionally creates three sample accounts. The last block calls `server.listen(...)` to accept browser requests.

`npm start` starts without seeding demo accounts unless `DEMO_MODE=true`. `npm test` runs the two test files. `npm run check` verifies JavaScript syntax.

## 2. Understand the frontend

| File / function | What you see or what it does |
| --- | --- |
| public/index.html | Header, navigation, main content container, dialog and footer |
| public/styles.css | Colours, layouts, cards, mobile breakpoints and button styling |
| public/app.js → init | Loads current login state and displays the first screen |
| api | Calls the backend with JSON and a request header |
| render | Switches views based on #home, #groups or #orders |
| home / serviceCard | Catalog, search, category filter, service cards |
| auth / account | Registration, login, account controls |
| modal / field / submit | Reusable form/dialog helpers and errors |
| book | Collects quantity/location and creates an order |
| groups / createGroup | Shows group counts and creates hostel groups |
| dashboard / orderCard | Student orders, vendor workflow and admin metrics |
| addService | Vendor listing form |
| click listeners near the bottom | Payment, review, status, rejection, PDF upload and password actions |
| esc | Escapes user text before inserting it into HTML |

To change colours, edit `:root` in styles.css. To change the homepage wording, edit `home()` in app.js. To add a button, give it `data-action`, then handle that action in a click listener. The browser may display controls by role, but the server must still check permissions.

## 3. Understand the backend

| server.js section / search term | Responsibility |
| --- | --- |
| createApp | Creates the database and HTTP server; exported so tests can use an isolated database |
| CREATE TABLE | Users, sessions, services, groups, memberships, orders, reviews, events and PDF attachments |
| one / all / run | Parameterized SQL helpers: one row, many rows, or mutation |
| atomic | Commit related writes together or roll them back together |
| passwordHash / passwordMatches | Salted scrypt passwords and constant-time hash comparison |
| session / requireRole | Secure cookie creation and role authorization |
| /api/register, /api/login | Validates input, creates users and signs in |
| /api/password | Checks current password, changes it, revokes old sessions |
| /api/services | Reads approved listings or creates a vendor's service |
| /api/groups | Creates groups and exposes counts; join endpoint prevents duplicates |
| /api/orders | Server computes price and commission, saves bookings and history |
| pay / status / review route | Simulated payment, allowed state transitions, completed-order reviews |
| fileRoute | Protected PDF upload/download and text receipt download |
| /api/admin | Vendor approval list and completed-order totals |
| /api/health | Database connectivity check for the hosting provider |
| server.listen | Host/port configuration and startup |

## 4. Trace a booking end to end

1. A student clicks a catalog button. Its `data-action="book"` handler calls `book(id)`.
2. `book()` opens a form. Submitting calls `api('/orders', body)`.
3. The server reads the session cookie, identifies the student, and validates service and quantity.
4. It checks group membership/quorum if a group ID was supplied.
5. It calculates the total in paise, then calculates the 10% commission.
6. `atomic()` inserts the order and its first timeline event in one transaction.
7. The browser opens Dashboard and fetches `/api/orders`.
8. The SQL query filters rows by student ID. The UI renders each `orderCard()`.

Example: laundry ₹49 × 2 kg = ₹98. With a full group, total = ₹88.20. The simulated 10% platform commission = ₹8.82. These amounts are computed on the server; editing browser HTML cannot change them.

## 5. Trace a print upload

After booking a print service, the student selects **Upload print PDF**. `FileReader` encodes the file, and the server checks the role, order ownership, pending status, extension, size and `%PDF-` signature. The bytes are stored in `attachments`, linked to one order. Download repeats the access check and forces a download instead of rendering the PDF inline.

This signature check is not malware scanning or full PDF validation. Use sample documents for public demonstrations. The maximum file size is 3 MB.

## 6. Understand hosting files

- `Dockerfile`: packages Node 24, backend and public assets; starts `node server.js`.
- `render.yaml`: free portfolio demo; enables demo accounts and HTTPS cookies. Data is temporary.
- `render-persistent.yaml`: optional paid configuration with disk storage and private admin bootstrap.
- `.github/workflows/ci.yml`: runs syntax checks and tests on GitHub pushes and pull requests.
- `.gitignore`: excludes passwords, environment files, local databases and logs from Git.
- `.env.example`: shows supported settings without containing real secrets.

See `HOSTING_AND_GITHUB.md` for the exact Windows commands and hosting choices.

## 7. Test and explain it in interviews

Run `npm test`. Read the test titles and identify the scenario each one protects: another student's order, an unpaid order, a duplicate group booking, a bad PDF, an unauthorized vendor or a password change. Then run the README walkthrough with separate browser profiles for different accounts.

Describe this project accurately as a **Node.js and SQLite campus marketplace with simulated checkout**, not a React app, live payment gateway or deployed business unless you later add those features.
