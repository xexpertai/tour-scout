# Devpost submission draft: Tour Scout

Draft for qloo.devpost.com (deadline 30 Oct 2026, 11:45 pm EDT; target submit 29 Oct). Fill the `<…>` placeholders after hosting and the public repo are approved. Every number below comes from live runs on 6 Oct 2026; re-check after any recapture.

**Devpost requirements checklist** (from the challenge page)

- [ ] Working app integrating the Qloo API as an agentic tool: yes (Phase A pipeline plus the "Ask the scout" agent)
- [ ] Hosted externally, end to end: `<DEMO_URL>` (Render; see `docs/DEPLOY.md`)
- [ ] Public repo with source and instructions: `<REPO_URL>`
- [ ] Open-source license shown in the repo's About section: MIT
- [ ] Text description of features and the Qloo integration (below)
- [ ] Optional video (not required): `<VIDEO_URL>`; draft from `scripts/video/make-draft.sh`

**Kit `SUBMISSION.md` items:**

| Item | Where below |
| --- | --- |
| Problem statement | Inspiration |
| Qloo workflows and why | How we built it |
| Redacted request → result | Request → result |
| Demo / screenshots, no credentials or personal data | Gallery |
| Setup from a clean environment | README, "Setup" |
| Limitations | What it doesn't do |

---

## Project name

Tour Scout

## Elevator pitch (tagline, ≤ 200 characters)

> Find your fans before you book the room. Tour Scout uses Qloo's taste graph to plan a tour for indie musicians and comedians: fan hotspots, rooms, openers and booker pitches, each with its source.

(196 characters)

## About the project

### Inspiration

Independent musicians and comedians usually route tours on guesswork: a city they played before, a friend's venue, a promoter's offer. Big acts have agents and data teams. A small act pays for an empty room directly, in travel, guarantees and a night that doesn't build a following.

The question they need answered is a taste question: *where are the people who like this kind of act, which rooms do those people go to, and who else do they like?* Qloo's graph links artists, comedians, places, brands and films through real-world audience affinity, which makes that question answerable. Without Qloo there's nothing to rank.

### What it does

Type an act, or tap one of four demo posters that open instantly. The signature moment: **the fan map lights up**. Qloo's hotspots bloom as heat across the country, the candidate cities get their scores, then the camera eases in and the route draws itself. Tour Scout then:

1. **Confirms the entity.** A "Did you mean…?" card shows the Qloo match before anything runs, because the entity choice changes every later result.
2. **Finds the fans.** Qloo's country-wide fan map (`where_popular`) returns the act's hotspots, and each one is snapped to a nearby touring city. For Big Thief, the hotspots are the Pioneer Valley, Vermont, Portland ME, Albany, Boston and the Pacific Northwest.
3. **Scores each city by room affinity.** That is how strongly this audience favours the city's best-matching live room (Qloo's music-venue or comedy-club tag). It's one comparable measure, so your own shortlist, "Why not Denver?" and the agent all use it.
4. **Builds each stop:**
   - the neighbourhood where fans cluster (e.g. Allston Village, Old North End);
   - real rooms (Monkey House, The Iron Horse, The Sinclair, SPACE Gallery);
   - an opener with local affinity whose audience shares the act's tastes (Julia Jacklin, Snail Mail, Lucy Dacus), never more popular than the act and never one of its members;
   - a pitch email to the booker.
5. **Profiles the fans in aggregate:** taste tags, over/under-index by age and gender, and the brands and films they also like, used for theme and merch ideas.
6. **Answers follow-up questions as an agent.** "Ask the scout" is a tool-using agent (Claude Haiku 4.5) that picks Qloo tools, chains them, and proposes a change you can apply with one tap. The server accepts a proposal only if every city and opener in it came from that session's tool results and every cited Q-id is real.
7. **Shows every source.** Each value is labelled QLOO, AI, TEMPLATE or GENERAL and links to the exact Qloo request (a "Q-number"). Plans export to a share link, CSV and print/PDF.

It also works for **stand-up comedians**: comedy clubs, with club comics as openers (Mark Normand: Austin, Denver, Providence, Burlington). **Emerging acts** that Qloo doesn't know yet are planned from the fans of 1–3 artists they sound like, and every screen says so. **Arena-scale acts** get a plan of where their fans are, with a plain note that the rooms are clubs and theatres.

### How we built it

- **Qloo, through the official `@qloo/qloo-harness` CLI (0.1.26)**, the event's supported surface, against `hackathon.api.qloo.com`. Every call is a validated `qloo exec` workflow:

  | Workflow | Why it fits |
  | --- | --- |
  | `describe` | Resolve and confirm the act (artist or person) |
  | `where_popular` (country) | Fan hotspots across a country: the core "where are the fans" signal |
  | `find_tags` | Pick the room type: `live_music_venue` or `comedy_club` |
  | `recommend` (place + venue tag, filtered to a city) | Rooms the audience favours; the best one scores the city |
  | `where_popular` (city) | The neighbourhood where fans cluster |
  | `recommend` (artist, or person with Qloo's comedian tags) | Opener candidates with local affinity |
  | `compare_audiences` | The shared tastes that make the opener's case |
  | `entity_tags`, `audience_demographics` | Aggregate fan profile |
  | `recommend` (brand, movie) | Cross-domain taste for show theme and merch |

- **Two-phase agent.**
  - *Phase A:* about 25–29 Qloo calls per tour, planned in code (no model needed to decide them), run concurrently and streamed; each stop appears as soon as its data lands.
  - *Phase B:* one Claude Haiku 4.5 call that sees only the evidence ledger (values plus Q-ids) and writes the "why", the pitches, theme, merch and risks, streamed per stop.
  - *Ask the scout:* a tool-using agent (up to 4 rounds) over six Qloo-backed tools, ending in a validated `propose_change`.
- **A deterministic guard** withholds model text that:
  - forecasts turnout;
  - claims a room fits a capacity (Qloo has no capacity data) or invents a room size;
  - targets or characterises an age or gender group;
  - mentions income or sensitive traits;
  - calls taste affinity "confirmed";
  - names a city that isn't on the route.

  Withheld items are counted on screen. Citations to non-existent Q-ids are dropped.
- **Stack:** Next.js 16, React 19, TypeScript, Tailwind 4, MapLibre GL with OpenFreeMap vector tiles (free, no key) and OpenStreetMap's Nominatim for neighbourhood names, the Anthropic SDK, Node 22, and Docker for a container host. 35 tests, including adapter tests against recorded live Qloo responses.

### Request → result (redacted; live Big Thief tour, US, 5 stops)

```text
Q6   where_popular  GET /v2/insights filter.type=urn:heatmap, signal.interests.entities=<Big Thief>,
                    filter.location.query=United States, take=20
     → 20 hotspot cells → touring cities: Northampton, Burlington, Portland ME, Albany, Boston, Portland OR, …
       (3 remote cells counted, not scheduled)
Q8   recommend      GET /v2/insights filter.type=urn:entity:place, filter.location.query=Burlington, Vermont,
                    filter.tags=urn:tag:category:place:live_music_venue, take=4
     → Monkey House 88 · Radio Bean 87 · ArtsRiot 86 · Nectar's 86  ⇒ Burlington room affinity 88
Q17  where_popular  filter.location.query=Burlington, Vermont, take=10 → strongest cell: Old North End (OSM name)
Q19  recommend      filter.type=urn:entity:artist, signal.location.query=Burlington, Vermont → Julia Jacklin
Q26  compare_audiences  a=<Big Thief>, b=<Julia Jacklin>
     → shared: Straightforward, Melodic, Folk, Simple Chord Progressions, Post Punk, Alternative Rock
Route: Burlington → Albany → Northampton → Boston → Portland ME (shortest non-crossing path)
```

### Challenges we ran into

- **No locality ranking on the event API.** `recommend` and `rank` reject a `locality` target. Raw locality insights come back popularity-ordered with no affinity, and `output.heatmap.boundary=city` returns HTTP 400. We rebuilt city discovery around what does work: country-wide fan hotspots snapped to touring cities, then room affinity per city. It turned out to be the better product signal anyway: it says where fans are *and* which rooms they go to.
- **Noisy tags.** `entity_tags` mixes taste tags with payment-card, hotel-star, dish and identity tags (ethnicity, sexuality). We keep only taste families and never show identity terms.
- **Comedians resolve to actors.** Unfiltered `person` recommendations for a comedian are mostly actors; Qloo's comedian tags fix it.
- **Model drift on real data.** Early drafts tied the capacity to venues, attributed national demographics to single cities, and called hotspots "confirmed". Each became a prompt rule plus a deterministic guard rule with a test.
- **Ambiguous place names.** "Glasgow" matched a US town and "National Capital Region" geocoded to Manila, so queries are disambiguated and scoped to the country.
- **Quota.** The event key rate-limits bursts. We use concurrency 3, one bounded retry, a 24-hour reuse of identical runs, and demo flyers that replay captured live runs at zero cost.

### Accomplishments we're proud of

- Plans that look right to people who know the scene: a compact New England run for Big Thief through Monkey House, The Iron Horse and The Sinclair; Austin's Creek & The Cave and Denver's Comedy Works for Mark Normand. All from Qloo data, with every claim linked to its request.
- An agent that proposes, not just chats, and a server that refuses any proposal the agent didn't earn from its own tool results.
- Honesty built into the product:
  - affinity is never presented as ticket demand;
  - room sizes are only ever the user's own;
  - "Limited data" appears when coverage is thin;
  - suggested openers are clearly suggestions.

### What we learned

- Taste graphs answer "where" questions well when you ask at the right granularity: country-wide for hotspots, city-level for rooms, neighbourhood-level for clusters.
- Planning data calls in code and keeping the model for writing and judgement gave us speed (one model call per tour), lower cost (about $0.01 per tour) and auditability.
- Guards need tests built from real model output, not imagined failures.

### What's next

- Dates and routing costs: combine affinity with drive times and a calendar.
- Support-slot discovery for emerging acts: which touring acts with overlapping fans pass through your city.
- More countries' touring-city lists, and a booker-facing share view.
- Pilots with a few independent acts and comedy managers.

### What it doesn't do (limitations)

- **Fan affinity is not ticket demand.** It ignores dates, prices, competing shows and venue availability.
- **Scores rank places against each other.** A city's score is its best room's affinity, so one excellent room can lift a city.
- **Qloo has no venue capacity.** The user's room size is used only as their own target in the pitch.
- **Fixed touring-city list.** Hotspots are snapped to about 100 touring cities (US, UK, Canada, Australia, India); far-off hotspots are counted, not scheduled.
- **Broad venue tag.** It includes some galleries and bars. Every room is a suggestion to check.
- **Taste tags vary by act.** Some acts get few tags, and the plan says "Limited data".
- **Aggregate only.** No personal data is sent to Qloo, and nothing is said about any individual fan.

## Built with

`qloo` · `qloo-harness` · `claude` · `anthropic` · `next.js` · `react` · `typescript` · `tailwindcss` · `node.js` · `maplibre` · `openfreemap` · `openstreetmap` · `docker` · `render`

## Try it out

- Demo: `<DEMO_URL>`. Tap a demo poster for an instant captured run (its scout suggestion marked "instant" also replays at no cost), or type any artist or comedian for a live run (rate-limited).
- Code: `<REPO_URL>` (MIT)
- Video (optional): `<VIDEO_URL>`

## Gallery (from `docs/screenshots/`, live data, no credentials or personal data)

1. `route.png`: Big Thief's New England route with stop tickets
2. `route-comedian.png`: Mark Normand, stand-up
3. `scout-answer.png`: the scout's recorded answer and proposed change
8. `fan-map.png`: the fan map lighting up (hotspots while cities are scored)
9. `receipts.png`: "Show receipts" on, every value with its Q-id
4. `route-emerging.png`: an emerging act planned from "sounds like" artists
5. `route-arena.png`: the arena-scale test with its caveat
6. `mobile-ticket.png`: a stop ticket on a phone
7. `landing.png`: the landing page with demo flyers

## Judging criteria: where each is answered

| Criterion | What judges see |
| --- | --- |
| Technological implementation | Official Qloo harness workflows; two-phase agent with streaming; tool-using scout with server-validated proposals; deterministic guard; 35 tests against recorded live responses |
| Design | The fan map lighting up, then the route drawing itself; gig-poster UI; compact stop tickets; mobile-first layout with a scout bottom sheet; provenance as quiet dots with a "Show receipts" switch; instant demo flyers |
| Potential impact | A real, underserved user (indie acts and comedians without data teams); useful from the first tap; extends to promoters and bookers |
| Quality of the idea | A taste question ("where are the people who like this act?") that only Qloo's cross-domain graph answers, turned into an action (a route, rooms, openers and a pitch) |

## Notes for whoever submits

- Use public names and aggregate data only. Presets carry "Demo … not affiliated with or endorsed by …".
- Don't name or tag any judge in the submission or the demo presets.
- Before submitting, make sure the README's hosted link, the video end card (`scripts/video/cards.html`) and this file all carry the real URLs.
