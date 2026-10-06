# Tour Scout

**Find your fans before you book the room.** Tour Scout plans a small tour for an indie musician or comedian from where their audience's taste actually is. It reads [Qloo](https://www.qloo.com)'s taste graph to rank cities and the neighbourhoods inside them, picks rooms near the fans, suggests a local opener whose audience shares their tastes, and drafts a booker pitch for every stop. You can then ask an AI scout to rework the route, and apply its proposal with one tap.

Every number on screen is labelled **QLOO** (returned by Qloo), **AI** (model text citing Qloo evidence), **TEMPLATE** (text filled in by code), or **GENERAL** (model text with no Qloo support). Each label links to the exact Qloo request behind it.

Built for the Qloo Agentic Hackathon. MIT licensed.

![A five-stop route with stop tickets](docs/screenshots/route.png)

> The screenshots show **sample data** (the app's demo mode, before the event's Qloo key arrived). Live-data screenshots will replace them.

## Try it in 60 seconds

1. Open the app (hosted link: _pending_) and tap a **demo flyer** such as *Big Thief*. A captured run opens instantly: cities glow, the route draws itself, and the stop tickets slide in.
2. Scroll to **Ask the scout** and tap **"Swap the weakest stop for a stronger city"**. Watch the numbered trace as the scout chooses Qloo tools, then read its answer and the proposed change.
3. Tap **Apply to my tour**. The new stop is scouted (fan cluster, rooms, opener) and the route redraws.
4. Type any artist or comedian in the search box, confirm the **"Did you mean…?"** card, and scout a live tour.
5. Use **Share**, **CSV** or **Print / PDF**, or tap any **Q-id** to see the Qloo request it came from.

## The problem

Independent musicians, comedians and their managers usually route tours by guesswork: a city they played before, a friend's venue, a promoter's offer. An empty room costs them money directly. Larger acts have agents and data teams; small acts do not. They need to know:

- Which cities have the most people who like this kind of act?
- Where in each city do those fans concentrate, and which rooms fit that taste?
- Who could open the show and bring overlapping fans?
- How do I pitch the booker without overselling?

## What makes it Qloo-powered

Qloo's taste graph links artists, comedians, places, brands and films through real-world audience affinity across 250M+ entities in music, film, dining, fashion and more (per the [hackathon page](https://qloo.devpost.com)). Tour Scout depends on that graph at every step:

- **Where the fans are.** Cities are ranked by the artist's audience affinity (`recommend` with locality targets, or `rank` for your own shortlist). `where_popular` then finds the neighbourhood where the fans cluster.
- **Who they are, in aggregate.** `entity_tags` gives the fan fingerprint, `audience_demographics` the age and gender affinity, and cross-domain `recommend` covers the brands and films the fans like.
- **Rooms and openers.** Places near the cluster come from `recommend` (places, with a venue-type tag from `find_tags`). Openers come from `recommend` (artists or people), with shared tastes from `compare_audiences`.
- **Emerging acts.** An act Qloo doesn't know yet is planned from the fans of 1–3 artists it sounds like, and every screen says so.

Without Qloo there is nothing to rank.

## How the agent works

![The scout's numbered trace while it works](docs/screenshots/scout-working.png)

```
Search ──► describe (Qloo) ──► "Did you mean…?"  (the user confirms the entity)
                                     │
Phase A — data gathering (code-planned, parallel, streamed)
  fingerprint · cross-domain · cities ──► per stop: cluster ─► venues, opener ─► overlap
  every Qloo call is recorded as evidence Q1, Q2, …
                                     │
Phase B — one model call (Claude Haiku 4.5, streamed per stop)
  writes "why", the pitch email, theme, merch and risks, citing Q-ids
                                     │
Ask the scout — tool-using agent (Claude Haiku 4.5, up to 4 rounds)
  tools: rank_cities · find_cities · fan_cluster · find_venues · find_openers · audience_overlap
  ends with propose_change ──► server validates ──► "Apply" rebuilds the plan
```

- **Phase A is planned in code, not by a model.** The data each tour needs is the same every time, so a model planning those calls would only add latency and cost. Independent calls run concurrently, and each stop streams to the screen as soon as its data lands.
- **Phase B is one model call.** It sees only the evidence ledger (values and Q-ids), never raw responses. Each stop's text appears as soon as the model has written it.
- **The scout is the agent.** For free-form requests ("Swap the weakest stop for somewhere in the South", "Who's a good opener in Chicago with crossover fans?"), Claude chooses and chains Qloo tools and then proposes a change. The server accepts a proposal only if:
  - every added city appeared in one of this session's tool results;
  - every removed stop exists, and the tour keeps 2–6 stops;
  - an opener is set only on a stop that stays;
  - every cited Q-id is real.
- **Quick questions skip the model.** "Why not Denver?" runs a fast path with no model call: `rank` plus `where_popular`, answered from a template.
- **Applying a proposal** scouts each new stop the same way a full run does, re-optimises the route, and saves a new plan linked to the original.

![The scout's answer with a proposed change](docs/screenshots/scout-answer.png)

### Route order

The route is the shortest open path through the stops: exact for up to 8 stops, 2-opt beyond. It therefore never crosses itself, and it starts at whichever end has the stronger fan affinity. Tests check this on 50 random sets of cities.

## Qloo requests, redacted

All Qloo calls go through the public [`@qloo/qloo-harness`](https://github.com/qloo/qloo-hackathon-kit) CLI (0.1.26), the event's supported surface, against `https://hackathon.api.qloo.com`. The Sources panel ("Credits") shows every request; requests never contain credentials. A typical tour for "Big Thief, 5 stops, United States":

```text
Q1   qloo exec entity_tags            GET /v2/insights  filter.type=urn:tag, signal.interests.entities=<artist id>
Q2   qloo exec audience_demographics  GET /v2/insights  filter.type=urn:demographics, signal.interests.entities=<artist id>
Q3   qloo exec recommend (brand)      GET /v2/insights  filter.type=urn:entity:brand, signal.interests.entities=<artist id>, signal.location.query=United States
Q5   qloo exec recommend (locality)   GET /v2/insights  filter.type=urn:entity:locality, signal.interests.entities=<artist id>, filter.location.query=United States, take=10
Q6   qloo exec find_tags              GET /v2/tags      filter.query=live music venue, feature.semantic_search=true
Q7…  qloo exec where_popular          GET /v2/insights  filter.type=urn:heatmap, signal.interests.entities=<artist id>, filter.location.query=<city>
     qloo exec recommend (place)      GET /v2/insights  filter.type=urn:entity:place, signal.interests.entities=<artist id>, filter.tags=<venue tag>, filter.location.query=<neighbourhood, city>
     qloo exec recommend (artist)     GET /v2/insights  filter.type=urn:entity:artist, signal.interests.entities=<artist id>, signal.location.query=<city>
     qloo exec compare_audiences      GET /v2/analysis/compare  a.signal.interests.entities=<artist id>, b.signal.interests.entities=<opener id>
```

A 5-stop tour makes roughly 25 Qloo requests. Emerging-act heatmaps with several proxy artists use `qloo api insights` with the documented heatmap parameters, because `where_popular` takes a single entity.

> **TODO (once the event key arrives):** add a short excerpt of a live result (top cities with scores, one stop's cluster, rooms and opener) next to these requests. `npm run qloo:verify-tour` saves raw responses for this.

## Responsible data handling

Built to the kit's [safe-use rules](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SAFE_USE.md):

- **Aggregate only.** No personal data is sent to Qloo. Inputs are an act's name, a region or cities, a stop count and an optional room size. Demographics are shown as relative over- or under-indexing for the audience as a whole, labelled "not a headcount, and not about any one fan".
- **Affinity is not a forecast.** Scores (0–100) rank places against each other; a tap-to-open explainer and the CSV header say so. Pitches never promise turnout.
- **A deterministic guard** (`src/lib/guard.ts`) withholds any model text that mentions income, wealth or class, sensitive traits, certainty or causation, attendance or ticket forecasts, or individual fans. The plan says how many statements were withheld and why.
- **Provenance is never overstated.** Text from code is labelled TEMPLATE, never AI. Citations to Q-ids that don't exist are dropped, and the text is then labelled GENERAL.
- **Server-owned plans.** Share links serve only plans this server generated; a client cannot upload a plan.
- **Credentials stay server-side.** Keys are read from the server environment and never reach the browser, the model or the logs. `npm run qloo:key` stores the Qloo key with hidden input.

## Reliability and quota protection

| Situation | What happens |
| --- | --- |
| No Qloo credential | Demo mode with sample data, labelled "SAMPLE" everywhere and with a banner |
| Credential set but harness missing or broken | Clear "Qloo connection isn't set up" error, never silent sample data |
| Qloo rejects the key, or rate-limits | The run stops with a named error; demo tours stay available |
| One Qloo call fails or times out (45 s) | That step is marked failed; the rest of the plan continues |
| Model unavailable, over quota or over the daily cap | Text falls back to templates (labelled), and the scout falls back to a templated scout (labelled) |
| Same tour requested again within 24 h | The stored plan replays instantly at no quota cost |
| Too many requests from one client | 429 with a friendly message and an "Open a demo tour" button (per hour: 4 tours, 40 searches, 15 scout questions or applies; all configurable) |
| Server-wide daily cap on live tours (150) | Same message; demo tours keep working |
| OpenStreetMap naming unavailable | Neighbourhoods show as "one part of the city"; nothing else breaks |
| Unknown share link | Branded 404 page |

Model spend is bounded by `LLM_DAILY_CAP` (default 40 calls a day), and every call logs its token counts (counts only). Measured on Claude Haiku 4.5 with sample data:

| Operation | Model calls | Tokens (input + output) | Cost |
| --- | --- | --- | --- |
| One tour's text | 1 | ≈ 2.1k + 1.7k | ≈ $0.01 |
| One scout question | 3–4 | ≈ 5.5–8.3k + 0.5k | ≈ $0.01 |

## Setup from a clean environment

Requirements: Node.js 22.19 or newer, an event-issued Qloo credential, and a Claude API key (optional: without it, text is templated).

```sh
# 1. Qloo harness (the supported way to call Qloo for this event)
npm install --global @qloo/qloo-harness@0.1.26

# 2. App
git clone <repo-url> tour-scout && cd tour-scout
npm ci
cp .env.example .env.local            # set CLAUDE_API_KEY (and LLM_PROVIDER=claude)

# 3. Qloo credential (input is hidden; never pass the key as an argument)
npm run qloo:key                      # or: qloo setup --qloo

# 4. One small live check of the workflows Tour Scout uses (~16 requests)
npm run qloo:verify-tour

# 5. Run
npm run dev                           # http://localhost:3898
```

**Without any keys:** run `QLOO_MOCK=1 npm run dev`. The whole flow works on sample data, with templated text and the templated scout.

**Docker** (the harness is a local process, so deploy to a VM or container, not serverless):

```sh
docker build -t tour-scout .
docker run -p 8080:8080 -v tour-scout-data:/data -e QLOO_API_KEY -e CLAUDE_API_KEY tour-scout
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `QLOO_API_KEY` | — | Event credential (or use the harness's own config) |
| `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL` | `https://hackathon.api.qloo.com` | Where the harness sends requests |
| `LLM_PROVIDER` | `scripted` | `claude` (primary), `gemini`, or `scripted` (no model) |
| `CLAUDE_API_KEY`, `CLAUDE_MODEL` | — / `claude-haiku-4-5-20251001` | Deliberately not `ANTHROPIC_API_KEY`, so no other tool picks it up |
| `LLM_DAILY_CAP` | `40` | Model calls per UTC day |
| `TOUR_RUNS_PER_HOUR`, `RESOLVES_PER_HOUR`, `FOLLOWUPS_PER_HOUR`, `TOUR_DAILY_CAP` | `4`, `40`, `15`, `150` | Quota protection |
| `DATA_DIR` | `.cache` (`/data` in Docker) | Share links, LLM budget counter, geocoding cache |
| `QLOO_CONCURRENCY` | `4` | Parallel harness processes |

**Demo presets** are captured runs in `public/presets/`. Recapture them with `npm run presets:capture`; a live capture costs about 25 Qloo requests and one model call per preset.

**Checks:** `npm test` (25 tests: guard, pipeline, routing, scout agent, apply, store, CSV, limits), `npm run lint`, `npx tsc --noEmit`.

## Screens

| Mobile route | Mobile stop ticket | Landing |
| --- | --- | --- |
| ![](docs/screenshots/mobile-route.png) | ![](docs/screenshots/mobile-ticket.png) | ![](docs/screenshots/landing.png) |

## Project layout

| Path | What it does |
| --- | --- |
| `src/lib/qloo.ts`, `qloo-mock.ts` | Qloo client over the harness CLI: adapters, cache, concurrency, errors; labelled sample data |
| `src/lib/tour/pipeline.ts` | Phase A: the per-stop scouting pipeline and evidence recording |
| `src/lib/tour/plan.ts` | Full run, route ordering, plan assembly with the guard |
| `src/lib/tour/scout.ts`, `apply.ts` | The tool-using scout agent and applying its proposals |
| `src/lib/llm.ts` | Phase B synthesis: Claude (primary), Gemini (fallback), scripted; daily cap and usage logging |
| `src/lib/guard.ts` | Provenance labels and the safe-use guard |
| `src/lib/limits.ts`, `store.ts` | Quota protection, run reuse, share-link storage |
| `src/app/api/tour/*` | Streaming endpoints: resolve, tour, ask, apply, health |
| `src/components/tour/*` | UI: landing, resolve card, map, tickets, scout panel, credits |
| `scripts/` | Hidden-input key setup, live verification, preset capture |

## Known limitations

What a plan does **not** establish:

- **Fan affinity is not ticket demand.** It ignores dates, routing costs, competing shows, venue availability, capacity and price. Confirm all of these with bookers.
- **Scores rank places against each other.** They are not percentages of people and not predictions about any individual.
- **Qloo has no venue capacity.** Your room size is used only as text in the pitch, labelled as your target.
- **Neighbourhood names are approximate.** They come from reverse-geocoding the centre of the strongest Qloo map cell, so a cell can straddle areas.
- **Coverage varies by country and by act.** Small or very new acts may need emerging-act mode. Arena-scale acts still get a plan, but venue suggestions may skew large.
- **New stops get templated text.** Stops added through "Apply" have no model-written text, to keep model spend bounded.
- **The guard is keyword-based.** It catches the known failure modes but is not exhaustive; provenance labels remain the main safeguard.
- **Map tiles come from OpenStreetMap's standard tile server**, which suits light demo traffic only. Heavy use would need a tile provider.
- **Single instance.** Limits, caches and the scout's state are in-memory per server process; plans persist under `DATA_DIR`.

## License and credits

[MIT](LICENSE) © 2026 Harsha Shinde. Taste data by [Qloo](https://www.qloo.com). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, rendered with [Leaflet](https://leafletjs.com). Fonts: Anton, Inter and JetBrains Mono (Google Fonts). Plan text and the scout agent use [Claude](https://www.anthropic.com/claude).
