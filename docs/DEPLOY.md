# Deploying the hosted demo (Google Cloud Run)

The service is live (see the README). **Deploying makes the demo public and can cost money,** so the script refuses to deploy without `CONFIRM_PUBLIC=1`.

## The pieces

- **Container.** The [`Dockerfile`](../Dockerfile) builds the Next.js standalone server and installs the official `@qloo/qloo-harness` CLI (pinned at 0.1.26, the version the adapters were verified against), whose `qloo exec` workflows make every Qloo call. The server runs them in-process through the package's own exported entry points (the ones the `qloo` binary calls), because starting a `qloo` process per call cost about 3 s of the single vCPU each; it falls back to spawning `qloo` if the package is not found (`/api/health` shows `qlooHarness`). The hackathon kit asks for a VM or a container; Cloud Run runs the container.
- **Build.** Cloud Build builds the image from the uploaded source (`gcloud run deploy --source .`). [`.gcloudignore`](../.gcloudignore) keeps `.env*`, caches, tests and the video project out of the upload.
- **Service.** The service is `tour-scout` in `us-central1`, with these settings:
  - gen2, 1 vCPU, 1 GiB, startup CPU boost;
  - **min instances 0** (no idle cost; the first visit after a quiet spell takes a few seconds);
  - **max instances 1** (the rate limits and caches are per process, so one instance keeps them exact and bounds cost);
  - request timeout 300 s, well above a live tour (about 25–40 s of Qloo calls plus 15–20 s of model text).
- **Secrets.** `QLOO_API_KEY` and `CLAUDE_API_KEY` live in Secret Manager as `qloo-api-key` and `claude-api-key`. The script reads them from your environment or `.env.local` and pipes them in without printing them. Only the service's own account can read them.
- **Data.** The Cloud Storage bucket `<project>-tour-scout-data` is mounted at `/data`. It holds:
  - share-link plans;
  - the daily model-call counter, so the cap survives scale-to-zero;
  - the OpenStreetMap place-name cache.

  The bucket is private (public access prevention on). Nothing in it is personal data: it holds aggregate Qloo results and tour inputs only.
- **Settings.** The non-secret settings are in [`deploy/cloudrun.env.yaml`](../deploy/cloudrun.env.yaml), including the public-demo caps. A test checks that the README's limits table matches them.
- **Runtime identity.** The service runs as its own account, `tour-scout-run`. It can read the two secrets and the bucket, and nothing else.

## What a visitor costs

| Action | Qloo requests | Claude Haiku calls | Notes |
| --- | --- | --- | --- |
| Tap a demo poster (3 presets), or its "instant" scout suggestion | 0 | 0 | Replays a captured live run from `public/presets/` |
| Live tour | 25–38 | 1 (≈ $0.01) | 3 per visitor per hour, 40 per day for the whole service |
| Same tour again within 24 h | 0 | 0 | Reuses the stored plan |
| Ask the scout | 2–15 | 2–4 | 10 per visitor per hour |
| Apply a proposal (demos included) | about 4 per added city | 0 | Live calls when a Qloo key works (venue tag, the city's fan map, a support act, an audience comparison); with no key, none |
| All model calls | | at most 30 per day (hosted), 45 in the judging window | Bounded by the persisted spend ceiling too ($4 for judging); after either cap, text is templated and labelled |

**Cloud costs.**
- Request-based Cloud Run with min instances 0 bills only while requests run. A live tour is about a minute of one vCPU, so demo traffic should stay inside Cloud Run's monthly free tier.
- The other charges are cents: Artifact Registry image storage (each deploy adds an image; delete old ones after judging), Cloud Storage for a few MB, Secret Manager for two secrets, and Cloud Build for a few builds.
- Check current prices on the [Cloud Run pricing page](https://cloud.google.com/run/pricing).
- **Budget:** an alert-only budget (about $10/month) emails the billing admins at 50%, 90% and 100%. A budget must be in the billing account's currency: the script reads it (`gcloud billing accounts describe --format='value(currencyCode)'`), or set `BUDGET_AMOUNT=850 BUDGET_CURRENCY=INR`. It never stops the service. What bounds spend is the caps above plus `max instances 1`.

## Before the first deploy (about 10 minutes, in a browser and a terminal)

1. **Billing and project.** In the Cloud console, create a project (note its **project ID**, e.g. `tour-scout-12345`) and link it to your billing account. Note the **billing account ID** too (Billing → Account management; it looks like `XXXXXX-XXXXXX-XXXXXX`).
2. **gcloud.** On a Mac: `brew install --cask google-cloud-sdk`. On Linux or WSL2: see "Deploy from a fresh machine" below.
3. **Sign in.** These open a browser:
   ```
   gcloud auth login
   gcloud config set project <PROJECT_ID>
   ```
4. **Decide to go public.** `deploy` needs the project ID (from `gcloud config`), the billing account ID for `budget`, and `CONFIRM_PUBLIC=1`, which you set only when the demo may be public.

## Deploy from a fresh machine (Linux or Windows 11 + WSL2 Ubuntu)

Everything runs in the Ubuntu shell. Work inside the Linux file system (`~/…`), not `/mnt/c/…`: it is faster, and it keeps Unix line endings and the script's executable bit.

1. **Install gcloud** (Google's apt repository):
   ```
   sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates gnupg curl git
   curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
   echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
   sudo apt-get update && sudo apt-get install -y google-cloud-cli
   ```
2. **Sign in and pick the project.** In WSL, `gcloud auth login` prints a link; open it in the Windows browser and paste the code back.
   ```
   gcloud auth login
   gcloud config set project <PROJECT_ID>
   ```
3. **Get the code:** `git clone <repo URL> tour-scout && cd tour-scout`. The repo can be private for this step.
4. **Put the keys in place.** Create `.env.local` in the repo root with two lines, `QLOO_API_KEY=…` and `CLAUDE_API_KEY=…`. Copy it over privately; it is git-ignored and never uploaded (`.gcloudignore`). Windows line endings are fine.
5. **Run the script in this order:**
   ```
   scripts/deploy-cloudrun.sh plan
   scripts/deploy-cloudrun.sh setup
   BILLING_ACCOUNT=<BILLING_ACCOUNT_ID> scripts/deploy-cloudrun.sh budget
   CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh deploy
   ```
   `deploy` ends with `verify`, a health check plus a preset smoke test. Then do the browser smoke test below.

No Docker, Node or local build is needed: Cloud Build builds the image from the uploaded source. On a new project the build runs as the default compute service account, so `setup` grants it `roles/cloudbuild.builds.builder` and `roles/run.builder`; without them the source deploy fails. A free-trial billing account must be activated before `setup` can enable the APIs.

## What the script does

```
scripts/deploy-cloudrun.sh plan                                  # prints the plan, changes nothing
scripts/deploy-cloudrun.sh setup                                 # APIs, service account, bucket, secrets
BILLING_ACCOUNT=<ID> scripts/deploy-cloudrun.sh budget           # alert-only budget (BUDGET_AMOUNT in the account's currency)
CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh deploy               # Cloud Build + deploy, then verify
scripts/deploy-cloudrun.sh verify                                # health + preset smoke test
```

Every step can be re-run safely: existing resources are reused, and `ROTATE=1 … setup` adds new secret versions.

After the deploy:

1. **Health.** `/api/health` should read `"qloo":"live"`, `"qlooReason":"credential from environment"` and `"llm":"claude"`.
2. **Smoke test** on a phone and a laptop:
   - the three demo posters and their instant scout answers (no API calls);
   - one live tour (Big Thief, United States, 5 stops);
   - one scout question and one Apply;
   - Share, CSV and Print / PDF;
   - reopening a share link after the service has scaled to zero (checks the bucket mount).
3. **Links.** Put the service URL into the README, `docs/SUBMISSION.md` and `scripts/video/config.json`. Once the repo is public, render the final video with `FINAL=1 scripts/video/make-story.sh`.

## Before submitting (eligibility is pass/fail)

1. **Hosted app** answers on its public URL: the health check, a demo poster, and one live tour.
2. **Public repo** (submit day only, with the entrant's OK). The public repo is a fresh-history snapshot, never this working repository's history:
   1. **Publish the snapshot (still private):**
      `~/workspace/ai-demo/scripts/publish-repo.sh taste-advisor tour-scout "<description>" docs/DESIGN_REVIEW.md docs/VIDEO_STORYBOARD.md`
      (the maintainer's script, not part of this repo). It stages `git archive HEAD`, drops the internal files (`BRIEF.md`, `AGENTS.md`, `CLAUDE.md`, `docs/HANDOFF.md`, `docs/PLAN.md`, `docs/M0-FINDINGS.md`, `graphify-out`, plus the two paths given), refuses to publish if a personal, work or secret marker is found, and commits under the entrant's GitHub noreply identity in its own history.
   2. **Verify a clean clone of what was published** (not the working tree): `gh repo clone xexpertai/tour-scout "$(mktemp -d)/ts"`, then in it `npm ci && npm test && npm run typecheck && npm run build`. All must pass, and `git ls-files` must not list any of the internal files above.
   3. **Only then flip visibility:** `gh repo edit xexpertai/tour-scout --visibility public --accept-visibility-change-consequences`. Check that GitHub shows the MIT license in the About sidebar (`gh repo view xexpertai/tour-scout --json licenseInfo` should return `MIT`; it is detected from `LICENSE`).
3. **Links** in the README, `docs/SUBMISSION.md` and `scripts/video/config.json`; then the `FINAL=1` video render.
   Placeholders to fill on submit day: README "Video (1:27): _link pending_" (top) and `git clone <repo-url>` (Setup); every `<REPO_URL>` and `<VIDEO_URL>` in `docs/SUBMISSION.md`; `repoUrl` in `scripts/video/config.json`. Check with `grep -rn "link pending\|<repo-url>\|<REPO_URL>\|<VIDEO_URL>" README.md docs/` (must print nothing).
   Once the repo is public, add `FEEDBACK_URL: "https://github.com/xexpertai/tour-scout/issues"` to `deploy/cloudrun.env.yaml` (and the judging file) and redeploy: it turns on the app's feedback links. Unset, the app shows none, so nobody hits the private repo's 404.
4. **Judging window:** run `judging-on` before 2 Nov (it also starts the separate $4 Claude budget). After the 31 Oct deadline, confirm the event's Qloo key still answers (`/api/health`, then one live tour). If it was rotated, `ROTATE=1 scripts/deploy-cloudrun.sh setup` with the new key, then redeploy.

## If the Qloo key stops working (after 31 Oct)

The judges may test in November, after the event key could be rotated or switched off. Nothing breaks:
- The three demo tours, their recorded scout answers, Apply and share links keep working with no Qloo calls. (With a working key, Apply scouts each added city live: about 4 Qloo requests, see the cost table.)
- A live search or tour is refused at once (HTTP 503, under a second) with "Live Qloo data isn't available on this server right now. The demo tours still work.", plus an "Open a demo tour" button.
- A rejected key (`QLOO_AUTH`) gives the same message in about 2 s; no run hangs.

To check this locally, run `npm run build && scripts/smoke-nokey.sh`. It starts the production server with no key and no harness and checks all of the above. Set `QLOO_ALLOW_SAMPLE=1` only if you want labelled sample data instead (local development without a key uses it automatically).

## Judge-ready checklist (do these on the hosted URL, in order)

1. **Build:** each `deploy` is the container build check (Cloud Build; no local Docker needed). Deploy well before the deadline, not on submit day.
2. **Warm instance:** `judging-on` before 2 Nov (min instances 1, judging caps).
3. **No-key path:** run `scripts/smoke-nokey.sh` locally, and on the hosted URL confirm demo posters, their route checks, Apply and share links work.
4. **Shared office IPs:** judging caps allow 20 live tours per IP per hour; the daily cap (120) and the Claude caps protect the budget.
5. **Claude budget:** 45 calls/day within $4 for 14 days (see `deploy/cloudrun.judging.env.yaml`); past it, labelled template text.
6. **Share links after scale-to-zero:** open a share link, wait for the instance to stop (or redeploy), open it again (checks the /data bucket mount and write access).
7. **After 31 Oct:** `/api/health`, then one live tour; if the Qloo key is gone, the "Live Qloo data isn't available… demo tours still work" path.
8. **Assets:** OpenFreeMap tiles and the Nominatim user agent from the hosted origin; no `.env.local` in the upload (`.gcloudignore`).
9. **Phone and desktop pass:** 1440×900 and 390×844 from a network other than the dev machine.

## Notes

- **Verified on the live service:**
  - **The container build.** Cloud Build builds the image on every `deploy` (no local Docker needed); its log shows `qloo --version` from the image build.
  - **The Cloud Storage volume.** It mounts with `uid=1000;gid=1000` so the container's `node` user can write. Share links created by Apply reopened from a fresh browser after the service had scaled to zero. If writes ever fail, share links and the counters won't persist and the error shows in the service log; the fix is the volume's `mount-options`.
- **What survives scale to zero:** the daily caps (live tours and model calls, both saved under `/data`) and share links. The per-visitor hourly limits are in memory and reset on a restart.
- **Judging window (2 Nov until 17 Nov, 10:15 IST; judging ends 16 Nov, 11:45 pm ET):** `scripts/deploy-cloudrun.sh judging-on` sets min instances 1 (no cold starts; idle time is billed, a few dollars for the fortnight) and applies the higher caps in [`deploy/cloudrun.judging.env.yaml`](../deploy/cloudrun.judging.env.yaml): 20 live tours per IP per hour (judges may share an office address), 120 per day, and 45 model calls per day under a separate $4 Claude spend ceiling (the math is in the file). `judging-off` restores scale-to-zero and the normal caps; run it only after 17 Nov, 10:15 IST.
- **OpenStreetMap:** neighbourhood names use Nominatim at no more than 1 request per second, with a cache and the `NOMINATIM_USER_AGENT` above. Map tiles come from OpenFreeMap (free, no key).
- **Rollback:** `gcloud run services update-traffic tour-scout --to-revisions <REVISION>=100 --region us-central1`. Revisions are listed in the console.
- **After judging:** delete the service, the bucket and the Artifact Registry images (or the whole project) to stop all charges. Rotate the Qloo and Claude keys if they were ever shared.
