# Devpost submission draft: Tour Scout

Draft for qloo.devpost.com (deadline 30 Oct 2026, 11:45 pm EDT; target submit 29 Oct). Fill the `<…>` placeholders after hosting and the public repo are approved. Every number below comes from the demo runs captured live on 7 Oct 2026; re-check after any recapture.

**Devpost requirements checklist** (from the challenge page)

- [ ] Working app integrating the Qloo API as an agentic tool: yes (Phase A pipeline plus the "Ask the scout" agent)
- [x] Hosted externally, end to end: https://tour-scout-196979752200.us-central1.run.app (Google Cloud Run; see `docs/DEPLOY.md`)
- [ ] Public repo with source and instructions: `<REPO_URL>`
- [ ] Open-source license shown in the repo's About section: MIT
- [ ] Text description of features and the Qloo integration (below)
- [ ] Optional video (not required): `<VIDEO_URL>`; built by `scripts/video/make-story.sh`

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

**Why not Spotify for Artists, Chartmetric or Bandsintown?** Those show where an act's existing listeners and followers are. A first-tour act has few of those. Qloo's cross-domain taste graph answers a different question: where the people who would *like* this act are (even planned from "sounds like" artists), which live rooms that audience favours, which acts no bigger than you share its tastes, and which brands it favours. Streaming counts can't name a room, an opener or a sponsor.

### What it does

Type an act, or tap one of three demo posters that open instantly. The signature moment: **the fan map lights up**. Qloo's hotspots bloom as heat across the country, the candidate cities get their scores, then the camera eases in and the route draws itself. Tour Scout then:

1. **Confirms the entity.** A "Did you mean…?" card shows the Qloo match before anything runs, because the entity choice changes every later result.
2. **Finds the fans, in one drivable region.** Qloo's country-wide fan map (`where_popular`) returns the act's hotspots, each snapped to a nearby touring city. Tour Scout works in the region where most hotspots sit and keeps every leg within about 500 km by road; hotspots elsewhere are named as "a second run". For fans of Joanna Sternberg (the Maya demo), that is Boston, Burlington, Albany, New York and Philadelphia, longest drive about 370 km. When most stops are outside the big metros and the fan map skips New York, Los Angeles or Chicago, the plan says it is built on "the secondary markets where they are", and the route check still tests the big cities nearby by their rooms.
3. **Ranks each city by room affinity.** That is how strongly this audience favours the city's best-matching live room (Qloo's music-venue or comedy-club tag). One audience's values sit close together, so tickets lead with the fit rank ("#2 of 7") and the plan says when stops are effectively tied.
4. **Builds each stop:**
   - the neighbourhood where fans cluster (e.g. Old North End, Washington Square West);
   - real rooms (Monkey House, O'Briens Pub, Fuze Box, Ortlieb's); studios, arenas, plain restaurants, ferry-only rooms and places named as record labels or record stores are filtered out (the filter reads names and tags, so a shop that hosts in-store shows, like Square Cat Vinyl in Indianapolis, can still appear);
   - an opener no bigger than the act on Qloo or, for a new act, a support slot on a small-room act (popularity ≤ 0.92: Mikaela Davis, Squirrel Flower, Half Waif, Tomberlin, Frances Quinlan), never one of its members and never the same act twice. When no candidate with local affinity is small enough, the closest is shown with a visible "above your size fit" flag;
   - a pitch email a booker could receive today: addressed to the named room, plain words, a clear ask, and [dates] / [draw] / [ticket price] / [links] to fill in.
5. **Profiles the fans in aggregate:** taste tags, over/under-index by age and gender, the films they also like, and a **sponsor match** from Qloo's brand graph (Onnit, Vuori, Chubbies for Joe List; Stetson, Tecovas for S.G. Goodman).
6. **Checks the plan with an agent.** The plan itself is deterministic and auditable: code decides every Qloo call. When it is drawn, an **agent route check** (Claude Haiku 4.5 with Qloo tools) runs by itself: it tests the weakest stop against the cities within a day's drive, can suggest a better opener or support slot, shows a numbered tool trace, and proposes at most one change, or says the route holds and why. You apply a proposal with one tap, and can keep asking. The server accepts a proposal only if every city and opener came from that session's tool results, no added city breaks the drivable route, no opener breaks the size rule (not bigger than the act; for a new act, Qloo popularity ≤ 0.92), and every cited Q-id is real.
7. **Shows every source.** Each value is labelled QLOO, AI, TEMPLATE or GENERAL and links to the exact Qloo request (a "Q-number"). Plans export to a share link, CSV and print/PDF.

It also works for **stand-up comedians**: comedy clubs, with club comics as openers (Joe List: Washington DC, Philadelphia, New York, Providence, Boston; a rooms-led plan, as none of his hotspots is near a touring city). **Emerging acts** that Qloo doesn't know yet are planned from the fans of 1–3 artists they sound like, and every screen says so (the lead demo, Maya, is a fictional first-tour act). **Arena-scale acts** get a plan of where their fans cluster, with no room or pitch suggestions (Qloo's room data is club and theatre scale).

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
- **Stack:** Next.js 16, React 19, TypeScript, Tailwind 4, MapLibre GL with OpenFreeMap vector tiles (free, no key) and OpenStreetMap's Nominatim for neighbourhood names, the Anthropic SDK, Node 22, and Docker for a container host. 63 tests, including adapter tests against recorded live Qloo responses.

### Request → result (redacted; live Maya tour from fans of Joanna Sternberg, US, 5 stops)

<!-- request-excerpt:start (generated by `npm run docs:excerpt` from public/presets/us-emerging.json) -->
```text
Q6   where_popular   GET /v2/insights  filter.type=urn:heatmap, signal.interests.entities=<Joanna Sternberg>,
                                       filter.location.query=United States, take=20
     → 20 hotspot cells (~30 km each), near touring cities: New York, Boston, Burlington, Philadelphia, Albany, Portland ME, Northampton, Hudson Valley.
       1 cell far from any touring city is counted, not scheduled.

Q14  recommend       GET /v2/insights  filter.type=urn:entity:place, signal.interests.entities=<Joanna Sternberg>,
                                       filter.location.query=Boston, Massachusetts,
                                       filter.tags=urn:tag:category:place:live_music_venue, take=6
     → O'Briens Pub 94.4 · Midway Café 91.5 · Club Passim 90.1 · The Jungle Community Music Club 89.8   ⇒ Boston room affinity 94.4
       (rooms that are not venues, or more than 18 km out of town, are dropped first; 4 were in this run)

Q7–Q14 (the same request for each candidate city)
     → New York 95.9 · Boston 94.4 · Burlington 94.1 · Philadelphia 93.5 · Albany 88.7 · Portland ME 88.5 · Northampton 87.6
       ⇒ stops: the 5 best within a day's drive of each other, routed Boston → Burlington → Albany → New York → Philadelphia

Q21  where_popular   GET /v2/insights  filter.type=urn:heatmap, filter.location.query=Boston, Massachusetts, take=10
     → strongest cell named via OpenStreetMap: Church Green

Q16  recommend       GET /v2/insights  filter.type=urn:entity:artist, signal.location.query=Boston, Massachusetts, take=8
     → Squirrel Flower (first candidate that is not the act, not a member of it, and within the support-slot size rule: Qloo popularity ≤ 0.92)

Q26  compare_audiences GET /v2/analysis/compare  a=<Joanna Sternberg>, b=<Squirrel Flower>
     → shared taste tags: Indie - Folk, Loyal, Intimate, Introspective, Expressive, Raw
```
<!-- request-excerpt:end -->

### Challenges we ran into

- **No locality ranking on the event API.** `recommend` and `rank` reject a `locality` target. Raw locality insights come back popularity-ordered with no affinity, and `output.heatmap.boundary=city` returns HTTP 400. We rebuilt city discovery around what does work: country-wide fan hotspots snapped to touring cities, then room affinity per city. It turned out to be the better product signal anyway: it says where fans are *and* which rooms they go to.
- **Noisy tags.** `entity_tags` mixes taste tags with payment-card, hotel-star, dish and identity tags (ethnicity, sexuality). We keep only taste families and never show identity terms.
- **Comedians resolve to actors.** Unfiltered `person` recommendations for a comedian are mostly actors; Qloo's comedian tags fix it.
- **Model drift on real data.** Early drafts tied the capacity to venues, attributed national demographics to single cities, and called hotspots "confirmed". Each became a prompt rule plus a deterministic guard rule with a test.
- **Ambiguous place names.** "Glasgow" matched a US town and "National Capital Region" geocoded to Manila, so queries are disambiguated and scoped to the country.
- **Quota.** The event key rate-limits bursts. We use concurrency 3, one bounded retry, a 24-hour reuse of identical runs, and demo flyers that replay captured live runs at zero cost.

### Accomplishments we're proud of

- Routes you can actually drive, in rooms that fit a small act: Maya's Boston → Burlington → Albany → New York → Philadelphia run through O'Briens Pub, Monkey House, Fuze Box, The Broadway and Ortlieb's, where the agent route check proposes Washington, DC over Albany (stronger, still drivable); Joe List's Washington DC → Boston club run through DC Comedy Loft, Helium, EastVille Comedy Club, Comedy Connection and Laugh Boston. All from Qloo data, with every claim linked to its request.
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

`qloo` · `qloo-harness` · `claude` · `anthropic` · `next.js` · `react` · `typescript` · `tailwindcss` · `node.js` · `maplibre` · `openfreemap` · `openstreetmap` · `docker` · `google-cloud-run`

**Transparency:** built with AI coding assistance; the demo video's voiceover is synthetic (Kokoro TTS).

## Try it out

- Demo: https://tour-scout-196979752200.us-central1.run.app. Tap a demo poster for an instant captured run (its scout suggestion marked "instant" also replays at no cost), or type any artist or comedian for a live run (rate-limited).
- Code: `<REPO_URL>` (MIT)
- Video (optional): `<VIDEO_URL>`

## Gallery (from `docs/screenshots/`, live data, no credentials or personal data)

1. `route.png`: Maya's Northeast route (fans of Joanna Sternberg) with stop tickets
2. `fan-map.png`: the fan map lighting up (hotspots while cities are scored)
3. `scout-answer.png`: the agent route check's verdict (Maya: swap Albany for Washington, DC, stronger and still drivable)
4. `route-comedian.png`: Joe List, stand-up (a rooms-led plan; the route check says it holds)
   `route-americana.png`: S.G. Goodman, a Southern club run
5. `receipts.png`: "Show receipts" on, every value with its Q-id
6. `pitch.png`: a sendable pitch email
7. `mobile-ticket.png`: a stop ticket on a phone
8. `landing.png`: the landing page with demo posters

## Judging criteria: where each is answered

| Criterion | What judges see |
| --- | --- |
| Technological implementation | Official Qloo harness workflows; two-phase agent with streaming; tool-using scout with server-validated proposals; deterministic guard; 63 tests, including adapter tests against recorded live responses |
| Design | The fan map lighting up, then the route drawing itself; gig-poster UI; compact stop tickets; mobile-first layout with a scout bottom sheet; provenance as quiet dots with a "Show receipts" switch; instant demo flyers |
| Potential impact | A real, underserved user (indie acts and comedians without data teams); useful from the first tap; extends to promoters and bookers |
| Quality of the idea | A taste question ("where are the people who like this act?") that only Qloo's cross-domain graph answers, turned into an action (a route, rooms, openers and a pitch) |

## Notes for whoever submits

- Use public names and aggregate data only. Presets carry "Demo … not affiliated with or endorsed by …".
- Don't name or tag any judge in the submission or the demo presets.
- Before submitting, set the real links in the README, `scripts/video/config.json` (the video end card; `FINAL=1` refuses to render without them) and this file.
- Transparency line for the Devpost text: "Built with AI coding assistance; the demo video's voiceover is synthetic (Kokoro TTS)."
