# Put CampusLoop on GitHub and host it

The source code is ready for these steps. A ZIP download does not publish a repository or create a hosting account.

## A. Upgrade your local copy without losing data

1. Stop the running server in PowerShell with Ctrl+C.
2. Back up your original project folder, including `data` (do not upload this backup).
3. Extract the new ZIP into a new location. Open its `CampusLoop` subfolder.
4. For a clean demo, run `npm run demo`. To keep your old accounts/orders, copy the entire old `data` folder into this new project while both servers are stopped, then run `npm run demo`. Existing tables are preserved and the new attachment table is created automatically.
5. Open http://localhost:3000. Use a hard refresh (Ctrl+F5) if the old UI remains.

## B. Create a GitHub repository

1. Sign in to your `charanraikar` GitHub account.
2. Create a repository named `CampusLoop`. Choose Public for a resume portfolio or Private while developing. Do not include real student data.
3. For the commands below, leave Add README, .gitignore and license unchecked: the local project already has files. Do not use an unrelated existing repository.
4. Open PowerShell inside the project folder that contains `package.json`:

```powershell
Get-ChildItem
node --version
git --version
npm run check
npm test
git init -b main
git add .
git status
```

Inspect `git status`: no `data`, `.env`, PDF uploads, tokens or local database files should be staged. `.env.example` is intentionally safe to commit.

If Git needs your identity, set it for this repository (use your GitHub-approved email or your private GitHub noreply address):

```powershell
git config user.name "Charan Raikar"
git config user.email "YOUR_GITHUB_COMMIT_EMAIL"
git commit -m "Build CampusLoop campus services marketplace"
git remote add origin https://github.com/charanraikar/CampusLoop.git
git push -u origin main
```

The URL above is the intended repository address, not proof it already exists. Complete Git's browser sign-in if prompted; never paste tokens into chat. If a remote already exists, run `git remote -v` and inspect it instead of blindly replacing it. If push is rejected because GitHub contains another commit, do not force-push: inspect and reconcile the histories.

Later changes:

```powershell
npm test
git add .
git commit -m "Describe your change"
git push
```

Alternative if you use GitHub CLI: `gh auth login`, then `gh repo create CampusLoop --private --source=. --remote=origin --push` after committing locally. Use this only for a new repository; choose `--public` deliberately if you want it public.

## C. Host a free portfolio demo on Render

1. Sign in or create an account at https://dashboard.render.com. Account setup and provider terms are yours to complete.
2. Choose **New → Blueprint**, connect your GitHub account and select the CampusLoop repository. Review the requested repository access.
3. Use the default `render.yaml`. Review that it proposes the free demo web service before deploying.
4. Wait for the build/deploy log to finish. Copy the actual HTTPS URL shown by Render; do not assume a URL before creation.
5. Open `/api/health` on that URL; expect `status: ok`.
6. Sign in, create a sample order, simulate payment, then fulfil it with the vendor account.
7. Add the verified website URL to your repository's About section and, after testing, your resume.

Fallback manual setup: New → Web Service → connect repository → runtime Docker → Dockerfile `./Dockerfile` → free instance → health check `/api/health`. Set `DEMO_MODE=true`, `HOST=0.0.0.0`, `SECURE_COOKIES=true`. These settings match render.yaml. Keep the source directory at the repository root where package.json and Dockerfile are stored.

**Free hosting limitation:** Render's free web services use temporary local storage. Your SQLite accounts, orders and uploaded PDFs can disappear when the instance restarts, redeploys or sleeps. The sample accounts/services are recreated on startup. This is suitable for a portfolio demonstration using fictitious data, not durable service operation. Free services can also take time to wake up.

## D. Hosting that keeps your data

Render supports persistent disks on paid services. If you choose to pay, review `render-persistent.yaml` and the cost in the provider dashboard first. Select this file as the Blueprint path, or add the equivalent configuration manually. It mounts `/app/data` and stores SQLite there.

Set your private `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` of at least 14 characters in the hosting dashboard, not in GitHub or chat. With a fresh database and no admin, the app creates the initial admin. It never changes an existing account on restart. After bootstrap you can remove these two environment variables; the account remains in the database. If you lose access, the project does not yet have an email password-reset service.

For a fresh persistent deployment, demo accounts are disabled. Register vendor/student accounts, approve vendors as admin, and have approved vendors create listings. Do not reuse a publicly seeded demo database for private operation. Payments still remain simulated in both configurations.

GitHub Pages cannot run the Node server or SQLite database. Deploy the whole application to a Node/Docker host, not only the public folder.

## E. Verify after publishing

- GitHub Actions checks pass.
- Homepage, login, booking and role changes work on the HTTPS address.
- Upload a non-sensitive sample PDF; verify an unrelated student cannot download it.
- Test group creation/join with two accounts.
- Confirm the chosen storage plan meets your needs before entering useful data.
- For a persistent service, restart the service and check a test order survives.

## Official reference pages

- https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github
- https://render.com/docs/blueprint-spec
- https://render.com/docs/free
- https://render.com/docs/disks

Provider details were checked on 21 November 2026. Review current prices/limits on the deployment screen before accepting a paid service.
