# Deploying the hosted demo (Render, Docker): steps for the user

Nothing here has been run. The Blueprint is [`render.yaml`](../render.yaml). **Deploying makes the demo public and the Starter plan costs money, so it needs your approval.**

## Why Docker on Render

The app calls Qloo through the official `@qloo/qloo-harness` CLI, which it spawns as a local process. That needs a long-running container, not serverless functions; the hackathon kit says "VM or container". The [`Dockerfile`](../Dockerfile):

- builds the Next.js standalone server;
- installs the harness pinned at 0.1.26, the version the adapters were verified against;
- runs as the `node` user on port 8080.

Secrets are passed at runtime and never baked into the image.

## What a visitor costs

| Action | Qloo requests | Claude Haiku calls | Notes |
| --- | --- | --- | --- |
| Tap a demo flyer (4 presets) | 0 | 0 | Replays a captured live run from `public/presets/`. Verified with no credentials and a missing harness: all four replay fully |
| Live tour | 21–29 | 1 (≈ $0.01) | Capped per visitor (`TOUR_RUNS_PER_HOUR=3`) and per server (`TOUR_DAILY_CAP=40`) |
| Same tour again within 24 h | 0 | 0 | Reuses the stored plan |
| Ask the scout | 2–10 | 2–4 | Capped per visitor (`FOLLOWUPS_PER_HOUR=10`) |
| "Why not <city>?" | 2–3 | 0 | Templated answer |
| All model calls | | at most 60 per day (`LLM_DAILY_CAP`) | Worst case ≈ $0.60/day; afterwards text is templated and labelled |

When a cap is reached, visitors see a friendly message with an "Open a demo tour" button.

## Which plan

| | Free | Starter ($7/month, prorated) |
| --- | --- | --- |
| Always on | No: sleeps after 15 min idle, so the first visit takes about 1 min | Yes |
| Persistent disk | No: share links and the daily LLM counter reset on every restart or sleep | Optional disk ($0.25/GB-month): uncomment `disk:` in `render.yaml` |
| Cost to 31 Oct + judging | $0 | ≈ $7–10 |

**Recommendation:** try Free first to check the deploy works. Switch to Starter (with the 1 GB disk) before you submit on 29 Oct, so judges never hit a cold start and share links survive. Don't add a keep-alive ping to the free plan; Render's terms don't clearly allow one.

## Steps (you, in a browser; about 15 minutes)

1. **GitHub.** Push the repo to GitHub under `xexpertai`. Render can deploy a *private* repo through its GitHub app. Making the repo public (required for Devpost, with the MIT license shown in the About section) is a separate step you approve.
2. **Render.** Sign in at dashboard.render.com. Add a payment method only if you choose Starter.
3. **New → Blueprint**, then pick the repo. Render reads `render.yaml` and shows one web service, `tour-scout` (Docker, Oregon, Free).
4. **Secret env vars** (prompted; never committed):
   - `QLOO_API_KEY`: the event key, the same value as in `.env.local`. The harness reads it from the environment, so no `qloo setup` is needed in the container.
   - `CLAUDE_API_KEY`: same as `.env.local`. Leave it empty to run with templated text and the templated scout (labelled).
5. **Apply.** The first build takes about 5–8 minutes (Next build plus the global harness install).
6. **Check health:** open `https://<service>.onrender.com/api/health`. Expect `{"ok":true,"qloo":"live","qlooReason":"credential from environment",...,"llm":"claude"}`. If `qloo` says `mock`, the key isn't set. If it says the harness is unavailable, the image build failed to install it; check the deploy log for `qloo --version`.
7. **Smoke test** on a phone and a laptop:
   - each of the four demo flyers (instant, no API calls);
   - one live tour, e.g. Big Thief, United States, 5 stops (about 45–55 s);
   - **Ask the scout** once;
   - Share, CSV and Print / PDF.
8. **Before submitting:** switch to Starter and the disk, and put the URL into:
   - the README ("hosted link: _pending_");
   - `scripts/video/cards.html` (`DEMO_URL`);
   - `docs/SUBMISSION.md`.
9. **After judging:** suspend or downgrade the service to stop billing. Rotate the Qloo and Claude keys if they were ever shared.

## Notes

- **Not yet verified:** `docker build`. No Docker daemon was available locally. The same standalone server the image runs (`node server.js` from `.next/standalone`) was smoke-tested: all four presets replay with no credentials and no harness on PATH. If the Render build fails, the deploy log shows which Dockerfile step broke.
- **Port:** the Dockerfile and `render.yaml` both use `PORT=8080`. Render routes to the port the container listens on.
- **Data:** `/data` holds share-link plans, the daily LLM counter and the OpenStreetMap name cache. On Free it is ephemeral; nothing in it is personal data (aggregate Qloo results and the tour inputs only).
- **OpenStreetMap:** neighbourhood names use Nominatim at no more than 1 request per second, with a cache and the `NOMINATIM_USER_AGENT` above. Map tiles come from OSM's standard tile server, which suits light demo traffic only.
- **Rollback:** Render keeps previous deploys (Events tab → Rollback).
