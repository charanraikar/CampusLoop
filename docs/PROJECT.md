# CampusLoop — project design and viva guide

## Problem and scope

Students coordinate laundry, printing and repairs through disconnected contacts. Vendors lack structured order tracking. CampusLoop centralizes discovery, reservations and fulfilment, with hostel groups offering a common pickup location and a group price. This is a single-campus educational prototype; it does not verify university membership.

## Architecture

Browser views call same-origin JSON endpoints. The Node HTTP server authenticates the session, checks roles and ownership, validates inputs, computes prices, and accesses SQLite. Only three public assets are served, preventing database or source-code downloads. Session tokens are random; only their hashes are stored in the database. Passwords have unique salts and use scrypt. Production would benefit from asynchronous password hashing, shared rate-limit storage and more extensive abuse controls.

## Database relationships

| Table | Purpose and links |
| --- | --- |
| users | Student/vendor/admin identity, hashed password, approval |
| sessions | Hashed session token → user; 24-hour expiry |
| services | Vendor → listing; integer price in paise |
| groups | Service + creator + hostel + target + expiry |
| members | Unique group/user pair |
| orders | Student + service + optional group; price snapshot, status, payment |
| events | Order + actor + action + timestamp |
| reviews | One review per completed order |
| attachments | One PDF per print order, stored as database bytes; protected downloads |

Order creation and its timeline event are atomic. Status/payment updates and corresponding events are also atomic. `UNIQUE(student_id,group_id)` prevents repeated discounted bookings in one group. Ordinary bookings use a null group ID and can be repeated.

## State transitions

| Current state | Allowed action | Who |
| --- | --- | --- |
| pending + unpaid | Simulate payment | Owning student |
| pending + simulated_paid | accepted | Assigned, approved vendor |
| accepted | in_progress | Assigned, approved vendor |
| in_progress | completed | Assigned, approved vendor |
| pending | cancelled | Owning student; simulated refund if paid |
| pending | rejected | Assigned approved vendor, with reason; simulated refund if paid |
| completed | Submit one review | Owning student |

No completion before acceptance, no vendor access to others' orders, no review before completion. Admins can view all orders but do not bypass the fulfilment state machine.

## API reference

All mutations require JSON and `X-CampusLoop-Request: 1`. Session cookie is set on login/registration. Errors use `{ "error": "message" }`. Money values are integer paise. Requests are capped at 16 KiB, except PDF upload requests capped at 4,200,000 bytes for base64-encoded files of at most 3 MiB.

| Method | Path | Access / request |
| --- | --- | --- |
| GET | /api/me | Current user and demo flag |
| POST | /api/register | name, email, password, role (student/vendor) |
| POST | /api/login | email, password |
| POST | /api/logout | Current browser session |
| POST | /api/password | Current and new password; revokes previous sessions |
| GET | /api/health | Database health and version |
| GET | /api/services | Public catalog of approved vendors |
| POST | /api/services | Approved vendor: title, category, description, price, unit |
| GET | /api/groups | Active groups and current user's membership |
| POST | /api/groups | Student: service_id, location, target |
| POST | /api/groups/:id/join | Student; unique membership and capacity enforced |
| GET | /api/orders | Own orders; vendor's orders; all for admin |
| POST | /api/orders | Student: service_id, quantity, location, notes, optional group_id |
| POST | /api/orders/:id/pay | Student; simulated only |
| POST | /api/orders/:id/status | status; enforced actor and transition |
| POST | /api/orders/:id/review | Student: rating (1–5), comment |
| POST | /api/orders/:id/attachment | Owning student, pending print order: filename and base64 PDF |
| GET | /api/orders/:id/attachment | Owning student, assigned approved vendor or admin |
| GET | /api/orders/:id/receipt | Same access restriction; downloadable text demo receipt |
| GET | /api/admin | Admin vendor list and metrics |
| POST | /api/vendors/:id/approve | Admin approves vendor |

## Decisions you should be able to explain

1. **Why SQLite?** Easy setup, real relational constraints and transactions, suitable for one college demo instance. PostgreSQL would be a reasonable later choice for larger deployments.
2. **Why integer paise?** Avoid floating-point ambiguity in money; group totals and commissions use explicit rounding.
3. **Why a server?** Users can edit browser data. Authorization and prices must be enforced independently of the UI.
4. **What makes group bookings different?** A matching service, shared hostel location, minimum membership and server-checked discount eligibility.
5. **Why not JWT?** Opaque sessions allow immediate logout/revocation and keep role information on the server.
6. **What do tests prove?** Key business rules and access restrictions under the tested scenarios, not production security certification or real-world scale.
7. **What is simulated?** Payment and refund records. There are no bank transfers, settlement or gateway webhooks.
8. **What would you improve next?** Email verification, email password reset, reliable notifications, PostgreSQL migration, real payment gateway with signed/idempotent webhooks, and multi-campus filtering.

## Known limitations

- Manual refresh updates other accounts' order status; no WebSocket delivery.
- Group members can join without buying; discounts are an educational policy rather than a proven financial model.
- Group booking retries are deduplicated, but ordinary order creation has no idempotency key.
- Vendors can reject pending orders, but post-acceptance dispute resolution is not implemented.
- No real student identity checks. Print uploads check extension, size and PDF signature, but do not scan for malware or validate all PDF internals.
- Password hashing is synchronous and login throttling is in memory; these need review before heavy traffic.
- User deletion, service editing, exports, notifications and production recovery are outside version 1.

Use the README walkthrough as the presentation script, then show one failing authorization test and explain why the server rejects it.
