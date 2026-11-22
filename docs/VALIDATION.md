# Validation for version 1.1

Executed with Node.js 24.22.3.

- Ten automated API/database tests pass using `npm test`.
- JavaScript syntax check passes for `public/app.js`.
- The demo server starts and serves its HTML, JavaScript and CSS.
- Tests cover order lifecycle, ownership, vendor approvals, group discount eligibility, refund simulation, input validation, protected routes, logout and database persistence across reopen.
- Additional tests cover PDF signature/extension checks, protected downloads/receipts, vendor rejection, password changes and session revocation, health checks and private admin bootstrap.
- `npm run check` verifies frontend and backend JavaScript syntax.

Browser validation remains outstanding: during earlier testing, automated Chromium could not start because the execution environment denied a required socket operation. No claim of a completed browser or mobile visual test is made. The README's manual walkthrough should be completed on your laptop before a college demonstration. Docker and Render configurations are included but have not been deployed or built in this environment. GitHub Actions has not run remotely because no repository has been supplied yet.
