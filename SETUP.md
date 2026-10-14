# Set up your free Kyara tracker

You will deploy the dashboard to Cloudflare and run the price collector in a public GitHub repository. Your computer only needs to be on during setup. The website and later updates run in the cloud.

The package has not been deployed or connected to your accounts. Follow these steps in order. Commands below are for Windows PowerShell; the same `npm`, `npx`, `python`, and `git` commands also work in a terminal on macOS/Linux.

## 1. Prepare your accounts and project folder

You need:

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) on the **Workers Free plan**.
- A [GitHub account](https://github.com/signup) and a **public** repository for the updater.
- The current [Node.js LTS](https://nodejs.org/en/download) installer, including npm.
- [Python 3.11 or newer](https://www.python.org/downloads/) if you want to run checks or the collector locally. GitHub installs its own Python automatically.
- [Git](https://git-scm.com/downloads) to upload this project to GitHub.

Extract the supplied ZIP. Open PowerShell in the folder containing `package.json` and `wrangler.jsonc`. Do not upload just the `public` folder: the Worker and updater files are also required.

If you are using the unzipped project already provided in this chat's output folder:

```powershell
cd 'C:\Users\enzod\Documents\Codex\2026-10-14\d\outputs\kyara-live'
npm ci
npx wrangler login
```

If you extracted it elsewhere, use that path in the `cd` command. Wrangler opens a Cloudflare login page. Sign in and authorize it to deploy to your own account. If PowerShell blocks `npm.ps1` or `npx.ps1`, use `npm.cmd` and `npx.cmd` instead; no execution-policy change is needed.

There is no frontend build step. You do not need to buy a domain or enable a paid Cloudflare plan.

## 2. Create the Cloudflare data store

In the same PowerShell window:

```powershell
npx wrangler kv namespace create PRICES
```

The command prints an ID for the new KV namespace. Open `wrangler.jsonc` and replace the placeholder `id` in its `kv_namespaces` section with that ID. Keep the binding name exactly `PRICES`:

```json
"kv_namespaces": [
  {
    "binding": "PRICES",
    "id": "PASTE_YOUR_NAMESPACE_ID_HERE"
  }
]
```

Edit the existing section; do not add a duplicate. Save the namespace ID for step 5. It identifies the store and is not an API token. [Cloudflare's KV setup guide](https://developers.cloudflare.com/kv/get-started/)

## 3. Publish the dashboard

Upload the included historical snapshot so the initial deployment has data:

```powershell
npx wrangler kv key put latest --binding PRICES --path public/seed.json --remote
npm run deploy
```

The first command is only for initial setup: running it later would overwrite fresh prices with the old seed. The second command publishes your website. If prompted, choose your account and create a free `workers.dev` subdomain.

Wrangler prints a URL like `https://kyara-mythical-tracker.YOUR-SUBDOMAIN.workers.dev`. Open your actual URL. The page initially labels its data as the historical preview. If a Worker with this name already exists in your account and is unrelated, change `name` in `wrangler.jsonc` to a distinct name before deploying.

You can also open your site's `/api/prices` path to see the JSON being served. KV changes may take a short time to propagate. A deployment does not start the collector; connect GitHub next. [Workers deployment](https://developers.cloudflare.com/workers/get-started/guide/), [free workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

## 4. Put the project in a public GitHub repository

On GitHub, create a new **public** repository called `kyara-mythical-tracker`. Leave the options to create a README, `.gitignore`, or license unchecked because this package already contains project files. Copy the new repository's HTTPS URL.

In your project folder, run these commands one at a time. Replace `YOUR-USERNAME` with your GitHub username:

```powershell
git init
git add .
git commit -m "Add Kyara mythical tracker"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/kyara-mythical-tracker.git
git push -u origin main
```

Complete GitHub's browser sign-in if asked. If Git says your name/email is missing, configure your Git identity and repeat the commit; GitHub's [set up Git guide](https://docs.github.com/en/get-started/git-basics/set-up-git) explains the prompts.

Verify the repository contains `.github/workflows/update-prices.yml` and that `package.json` is at the repository root. The included `.gitignore` excludes dependencies, local runtime files, and generated data. Do not put Cloudflare tokens or Kyara credentials in any tracked file.

The **Check project** workflow runs on the push. Scheduled collection is initially skipped until you add `ENABLE_SCHEDULE` in step 7; manual collection is available immediately after credentials are configured.

## 5. Create a Cloudflare upload token

The collector needs permission to write its snapshot to KV. This token is separate from the browser login used by Wrangler.

1. In Cloudflare, open your profile menu, then **My Profile → API Tokens → Create Token → Create Custom Token**.
2. Give it a name such as `Kyara KV updater`.
3. Add the permission **Account → Workers KV Storage → Edit** (the write permission).
4. Under account resources, choose **Include → Specific account → your account**. It needs KV access only, not DNS or Worker deployment permissions. This permission can edit KV namespaces in the selected account; use a dedicated account if you need stronger isolation from other projects.
5. Create the token and copy it directly into the GitHub secret in step 6. Cloudflare displays the secret once.

Cloudflare's dashboard wording may vary slightly; its [token creation guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) describes the controls.

Find your **Account ID** in Cloudflare's **Workers & Pages → Account Details**, or use dashboard search for **Copy account ID**. The Account ID and KV Namespace ID are different. [Find your Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)

## 6. Add the three GitHub secrets and test an update

In your GitHub repository, open **Settings → Secrets and variables → Actions → Secrets → New repository secret**. Add these exact names:

| Secret name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The KV edit token you just created |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID |
| `CLOUDFLARE_KV_NAMESPACE_ID` | The namespace ID from step 2 |

Paste the values without quotes or extra spaces. Keep the token in GitHub's secret field, not in source files, screenshots, or this chat. [GitHub repository secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

Now open **Actions → Update prices → Run workflow**, choose the default branch (`main`), and run it. If GitHub asks you to enable Actions for this repository, enable them first. The workflow runs tests, collects all current Mythical prices, then uploads one complete snapshot. Allow several minutes; it intentionally spaces source requests.

After a green check, reopen the dashboard or press its refresh button. Its collection timestamp should be recent and its historical-preview indicator should clear. If it fails, open the failed step's log; the previously published snapshot stays available. This first run also verifies that Kyara accepts requests from GitHub's runner, which cannot be confirmed by local tests alone.

## 7. Turn on half-hour updates

In **Settings → Secrets and variables → Actions**, switch to the **Variables** tab and create a **New repository variable**:

| Name | Value |
| --- | --- |
| `ENABLE_SCHEDULE` | `true` |

The workflow is scheduled for minute 13 and 43 of every hour, UTC. Runs are approximate; GitHub can delay or skip them. The page fetches the saved snapshot every five minutes while open, so the visible prices can lag the last collection by a few minutes. The refresh button only reloads the snapshot; use **Actions → Update prices → Run workflow** to start a new collection.

Set `ENABLE_SCHEDULE` to `false` or remove it to stop automatic collection. Manual runs still work. To use a slower schedule, edit the cron line in `.github/workflows/update-prices.yml`; for example, `13 */2 * * *` requests one update every two hours.

Kyara's public endpoints are undocumented. Its [rules](https://kyara.games/regles) broadly prohibit bots/scripts and do not explicitly address read-only market trackers; that remains a service-policy uncertainty. At the original 200-card pool size, the half-hour schedule makes about 9,744 source requests/day before retries. Use a frequency that Kyara permits.

## Keeping it free and running

Stay on **Workers Free**, keep the GitHub repository public, use the supplied standard Ubuntu runner, and use the free `workers.dev` hostname. The collector uses no browser automation and creates no Actions artifacts or caches. At 48 successful runs/day, it writes one KV value each time: 48 writes/day against the free 1,000/day allowance. Worker API requests and KV reads have separate free 100,000/day quotas shared with other account use. Heavy public traffic can exhaust those quotas; free-plan operations can then fail until the quota resets. [Cloudflare KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

GitHub may disable public-repository schedules after 60 days without repository activity. Check **Actions** if the dashboard becomes stale, and re-enable a disabled workflow there. Routine scheduled runs alone are not a guarantee that this inactivity rule will be avoided. [Scheduling limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## Troubleshooting and later changes

| Symptom | What to check |
| --- | --- |
| `npm` / `npx` is not recognized | Install Node LTS and reopen PowerShell. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd` and `npx.cmd`. |
| Wrangler reports multiple accounts | Add your intended `account_id` to `wrangler.jsonc`, then retry. |
| Invalid namespace or Cloudflare upload 403 | Check all three GitHub secrets, token KV edit permission, and that both IDs belong to the same account. |
| Dashboard keeps showing historical data | Confirm the workflow succeeded and its namespace ID matches `wrangler.jsonc`; allow propagation and refresh. |
| Dashboard is stale | Check the most recent **Update prices** run and `ENABLE_SCHEDULE`; check whether GitHub disabled the workflow. |
| Kyara returns 401, 403, 429, or changed JSON | Read the workflow error. Pause the schedule if persistent; the collector does not bypass access restrictions. |
| No **Run workflow** button | The workflow must be on the default branch, Actions must be enabled, and you need repository write access. |

To publish later page or Worker edits, run `npm run deploy` again from the project folder. Push changes to GitHub too so the repository stays in sync. **GitHub's included workflows update data and run checks; they do not deploy page/code edits.** To change the collector, edit and push its code to the default branch; the next run uses that version.

For an optional local preview after `npm ci`:

```powershell
npm run dev
```

Open the local URL printed by Wrangler. To test collection without uploading, run:

```powershell
python scripts/update_prices.py --output data/latest.json
```

This makes live read requests to Kyara but does not change Cloudflare. It does not refresh the deployed website until the resulting snapshot is uploaded through the configured workflow or a deliberate KV upload.
