# Deploy CampusLoop on Render for free

This guide uses the **free** plan (`render.yaml`). Total cost: ₹0. If any screen asks for card details or a paid plan, stop and re-check that you chose **Free**.

## What to expect from the free plan
- The site **sleeps after 15 minutes without visitors**. The next visitor waits about a minute while it wakes up (the loading screen covers this).
- **All data resets** whenever the site sleeps, restarts or redeploys, because free services have no permanent disk. That is fine for a portfolio demo: `DEMO_MODE=true` recreates the demo accounts and services each time.
- Use Razorpay **test mode** only. The sign-in screen shows the demo logins publicly, so don't enter real personal data on this site.
- Render gives each account 750 free instance hours a month, enough for one service.

## 1. Put the code on GitHub
```powershell
cd CampusLoop
git add .
git commit -m "Deploy CampusLoop"
git push
```
Check on github.com that `.env` is **not** in the repo (it is listed in `.gitignore`).

## 2. Create the service
1. Sign in at render.com with your GitHub account.
2. **New → Blueprint**, pick your CampusLoop repo.
3. Render reads `render.yaml` and shows a service called `campusloop-demo` on the **Free** plan. Click **Apply**.
4. It will ask for the secret values (you can leave any blank and add them later under **Environment**):

| Variable | Value |
|---|---|
| `RAZORPAY_KEY_ID` | Test API Key (starts with `rzp_test_`) |
| `RAZORPAY_KEY_SECRET` | Test Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | Any long random text you choose (used in step 4) |
| `BREVO_API_KEY` | From step 3 |
| `MAIL_FROM_EMAIL` | The sender address you verify in step 3 |
| `APP_URL` | Fill in after the first deploy (step 5) |

5. Wait for the first deploy to finish (a few minutes). Your address looks like `https://campusloop-demo.onrender.com`.

## 3. Free email with Brevo (no domain needed)
1. Create a free account at brevo.com (300 emails a day on the free plan).
2. Add a sender: open the **Senders** area (menu names change; look for "Senders, domains & dedicated IPs"), add your own Gmail address, and click the verification link Brevo emails you.
3. Open **SMTP & API → API Keys** and generate a key.
4. Put the key in `BREVO_API_KEY` and the verified address in `MAIL_FROM_EMAIL` on Render.

New accounts at Brevo may go through a short automatic review before sending works. Until email is set up, password-reset and verification links only appear in Render's **Logs** tab.

## 4. Razorpay webhook (test mode)
1. Razorpay dashboard (Test Mode) → Settings → Webhooks → Add.
2. URL: `https://YOUR-SITE.onrender.com/api/razorpay/webhook`
3. Secret: the same text you used for `RAZORPAY_WEBHOOK_SECRET`.
4. Events: `payment.captured` and `order.paid`.

## 5. Set the public address
In Render → your service → **Environment**, set `APP_URL` to your site address (no trailing slash). Render redeploys automatically.

## 6. Check it works
- Open `https://YOUR-SITE.onrender.com/api/health`. You should see `"payments":"razorpay"`.
- Book a service as the demo student and pay with test UPI `success@razorpay`.
- Try **Forgot password?** with an email you own and confirm the email arrives (check spam).

## Updating the site
`git push` again. Render redeploys automatically.

## Troubleshooting
| Problem | Fix |
|---|---|
| Page takes ~1 minute to open | The free site was asleep. Normal. |
| Health shows `"payments":"simulated"` | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are missing or have a typo. Re-save them and wait for the redeploy. |
| Webhook shows errors in Razorpay | The secret differs from `RAZORPAY_WEBHOOK_SECRET`. Make them identical. |
| Emails don't arrive | The sender address isn't verified in Brevo, `MAIL_FROM_EMAIL` has a typo, or check spam. Look for "Email send failed" in Render Logs. |
| Orders and accounts vanished | Expected on the free plan: data resets when the site sleeps. |

## Optional: keeping data (costs money)
`render-persistent.yaml` adds a permanent disk, but that plan is paid. Only use it after checking the price Render shows and deciding you want it.
