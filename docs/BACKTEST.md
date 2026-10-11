# Back-test: do the demo routes match where these acts actually played?

**Short answer: inconclusive. At this size the test cannot separate a good route from a random one.**
Each route hits 1 of its 5 stops. That is also the most any route built from the plan's own scored
candidates could have hit (see Power below), and random picks do about as well. The show lists are small
(10 and 16 shows), so this is a sanity check and not validation, in either direction. A fan map is also a
different thing from a past booking history.

## Method

- `scripts/backtest.mts` makes **no Qloo or model calls**. It reads a recorded demo plan
  (`public/presets/<slug>.json`) and a cited show list (`docs/backtest/<slug>.json`).
- Each show is matched to one of the app's touring cities: by name, or else to the nearest one within 75 km
  (so Cambridge, MA counts as Boston and Brooklyn as New York). Shows near no touring city count as "elsewhere".
- It reports how many of the plan's stops are cities the act played. It compares that count with two random
  baselines (10,000 seeded draws each): 5 of the plan's own scored candidate cities, and 5 of the touring
  cities within 800 km of the route's centre.
- Run it with: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/backtest.mts us-americana docs/backtest/us-americana.json`

## Sources

Every show cites one of these sources. Nothing is typed in from memory. Shows were retrieved on 11 Oct 2026.

| Demo | Act checked | Sources | Shows used |
|---|---|---|---|
| S.G. Goodman (`us-americana`) | S.G. Goodman | [setlist.fm, page 1, archived 20 Apr 2024](https://web.archive.org/web/20240420051312/https://www.setlist.fm/setlists/sg-goodman-2bf57846.html); [Seated feed behind sggoodman.net/tour](https://cdn.seated.com/api/tour/0d0aa498-2b05-42f8-a28f-b8ceab9231a0?include=tour-events) (upcoming dates) | 10 (Oct 2023 – Feb 2027) |
| Maya (`us-emerging`, a fictional act planned from Joanna Sternberg's fans) | Joanna Sternberg | [setlist.fm, page 1, archived 25 Apr 2024](https://web.archive.org/web/20240425025830/https://www.setlist.fm/setlists/joanna-sternberg-bf73542.html); [the same page, archived 9 Nov 2025](https://web.archive.org/web/20251109231425/https://www.setlist.fm/setlists/joanna-sternberg-bf73542.html) | 16 (Feb 2024 – Apr 2025) |
| Joe List (`us-comedian`) | Not run | No cited show list could be retrieved: setlist.fm does not cover stand-up, the official site did not answer from this machine, and its only recent archive is a redirect. | 0 |

Some entries were left out because the page gives no city: festival entries (Mission Creek 2024, Big Ears 2024,
End of the Road 2024, Woodsist 2025) and Sternberg's Holiday Spectacular 2024. S.G. Goodman's WFPK radio
session was also left out, because it was not a show. Each list's `sources[].note` records these exclusions.

## Results

| Demo | Route | Cities the act played | Stops hit | Random 5 of the plan's candidates hit ≥ that | Random 5 regional touring cities hit ≥ that |
|---|---|---|---|---|---|
| S.G. Goodman | Asheville, Nashville, Louisville, Cincinnati, Indianapolis | Washington DC, Baltimore, Philadelphia, Boston, Toronto, Pittsburgh, Cleveland, **Louisville**, Miami (a cruise) | **1 of 5** (Louisville) | 0.63 | 0.73 |
| Maya / Joanna Sternberg | Boston, Burlington, Albany, New York, Philadelphia | Seattle, Portland OR, San Francisco, Los Angeles, Santa Cruz, **New York** (6 shows), London, Glasgow, Manchester | **1 of 5** (New York) | 0.72 | 0.34 |

**How to read it:**
- For both acts, a random choice of 5 cities would match at least as many played cities most of the time.
  This does not show the routes are better than chance, and (because of the ceiling below) it does not show
  they are no better either.

## Power: the most any route could have scored

The script also prints the ceiling: the most played cities any 5-stop route could include from each pool.

| Demo | Played cities among the plan's scored candidates | Ceiling from candidates | Played cities among regional touring cities (800 km) | Ceiling from regional cities |
|---|---|---|---|---|
| S.G. Goodman | Louisville (1 of 8 candidates) | **1 of 5** | Washington DC, Baltimore, Pittsburgh, Louisville, Cleveland (5 of 24) | 5 of 5 |
| Maya / Joanna Sternberg | New York (1 of 7 candidates) | **1 of 5** | New York (1 of 15) | **1 of 5** |

- **Maya:** New York is the only city Joanna Sternberg played inside the Northeast region this demo plans,
  and the route includes it. So 1 of 5 is the most any route in that region could score. The candidate
  baseline (0.72) and the regional baseline (0.34) only measure how often a random pick also lands on
  New York.
- **S.G. Goodman:** among the plan's 8 scored candidates only Louisville appears in the show list, so 1 of 5
  is the most any route from those candidates could score, and "random candidates do as well" is close to
  certain by construction. The wider regional pool is different: it holds 5 played cities (his archived
  East Coast and Midwest run), none of which the plan scored as a candidate except Louisville. That
  comparison is the one place the test had room to separate routes, and there the route did not beat
  random regional picks (0.73). It reflects a choice of region (Southeast and Ohio Valley) more than the
  ranking within it, and rests on 10 shows.
- So the result is **inconclusive**. A test with real power would need many acts and longer show
  histories, or outcome data (tickets sold), which this project does not have.
- The Maya route does include New York, the city where Sternberg played most often (6 of 16 shows), and her
  top-scored candidate. Her other listed US shows were a West Coast run, outside the Northeast region this
  demo plans.
- S.G. Goodman's archived run went up the East Coast and through the Midwest (DC to Louisville). The demo
  route covers the Southeast and Ohio Valley instead, so only Louisville overlaps.

## Limitations

- **Very small samples.** Only page 1 of each setlist.fm list is archived (about 10 recent shows each). Older
  pages are not archived, so most of each act's history is missing.
- **Different questions.** A fan map shows where an act's fans are now. A show list shows where the act and
  its agent chose to play, which also depends on support slots, festivals, label and routing deals, and
  which tours fell inside the archived window. A good route may well add cities the act has not played yet.
- **Maya is fictional.** Checking a plan built from Joanna Sternberg's fans against her own shows is a proxy.
- **setlist.fm is user-contributed**, so some shows may be missing.
- The two demo routes were not tuned to these lists; the lists were gathered after the plans were recorded.
