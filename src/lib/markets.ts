/**
 * Touring markets: cities with a live-music and comedy circuit, used to turn Qloo's fan heatmap
 * (anonymous map cells) into bookable stops. This is reference geography, not taste data: every
 * score shown for a market still comes from Qloo.
 *
 * Why this exists: on the hackathon API the harness cannot target `urn:entity:locality`, so cities
 * are found from a country-wide `where_popular` heatmap and each hotspot cell is snapped to the
 * nearest market within SNAP_KM. Cells far from any market (national parks, resort areas) are
 * reported as remote hotspots instead of becoming stops.
 */
export type Market = { name: string; query: string; lat: number; lng: number; country: string };

const m = (country: string, rows: [string, string, number, number][]): Market[] =>
  rows.map(([name, query, lat, lng]) => ({ name, query, lat, lng, country }));

// Queries name the state or country where a bare name is ambiguous ("Glasgow" also matches a town
// in Kentucky, "London" one in Ontario), because Qloo resolves `filter.location.query` as free text.
export const MARKETS: Market[] = [
  ...m("United States", [
    ["New York", "New York City", 40.7128, -74.006], ["Boston", "Boston, Massachusetts", 42.3601, -71.0589],
    ["Northampton", "Northampton, Massachusetts", 42.3251, -72.6412], ["Providence", "Providence, Rhode Island", 41.824, -71.4128],
    ["Burlington", "Burlington, Vermont", 44.4759, -73.2121], ["Portland, ME", "Portland, Maine", 43.6591, -70.2568],
    ["Albany", "Albany, New York", 42.6526, -73.7562], ["Hudson Valley", "Kingston, New York", 41.927, -73.9974],
    ["Philadelphia", "Philadelphia", 39.9526, -75.1652], ["Washington, DC", "Washington, DC", 38.9072, -77.0369],
    ["Baltimore", "Baltimore", 39.2904, -76.6122], ["Pittsburgh", "Pittsburgh", 40.4406, -79.9959],
    ["Richmond", "Richmond, Virginia", 37.5407, -77.436], ["Raleigh-Durham", "Durham, North Carolina", 35.994, -78.8986],
    ["Asheville", "Asheville, North Carolina", 35.5951, -82.5515], ["Charlotte", "Charlotte, North Carolina", 35.2271, -80.8431],
    ["Charleston", "Charleston, South Carolina", 32.7765, -79.9311], ["Atlanta", "Atlanta", 33.749, -84.388],
    ["Savannah", "Savannah, Georgia", 32.0809, -81.0912], ["Jacksonville", "Jacksonville, Florida", 30.3322, -81.6557],
    ["Orlando", "Orlando", 28.5384, -81.3789], ["Tampa", "Tampa", 27.9506, -82.4572], ["Miami", "Miami", 25.7617, -80.1918],
    ["Nashville", "Nashville, Tennessee", 36.1627, -86.7816], ["Memphis", "Memphis, Tennessee", 35.1495, -90.049],
    ["Louisville", "Louisville, Kentucky", 38.2527, -85.7585], ["Birmingham", "Birmingham, Alabama", 33.5186, -86.8104],
    ["Jackson", "Jackson, Mississippi", 32.2988, -90.1848], ["New Orleans", "New Orleans", 29.9511, -90.0715],
    ["Shreveport", "Shreveport, Louisiana", 32.5252, -93.7502], ["Houston", "Houston", 29.7604, -95.3698],
    ["Dallas", "Dallas", 32.7767, -96.797], ["Austin", "Austin, Texas", 30.2672, -97.7431],
    ["San Antonio", "San Antonio", 29.4241, -98.4936], ["Oklahoma City", "Oklahoma City", 35.4676, -97.5164],
    ["Kansas City", "Kansas City, Missouri", 39.0997, -94.5786], ["St. Louis", "St. Louis", 38.627, -90.1994],
    ["Chicago", "Chicago", 41.8781, -87.6298], ["Milwaukee", "Milwaukee", 43.0389, -87.9065],
    ["Madison", "Madison, Wisconsin", 43.0731, -89.4012], ["Minneapolis", "Minneapolis", 44.9778, -93.265],
    ["Detroit", "Detroit", 42.3314, -83.0458], ["Cleveland", "Cleveland", 41.4993, -81.6944],
    ["Columbus", "Columbus, Ohio", 39.9612, -82.9988], ["Cincinnati", "Cincinnati", 39.1031, -84.512],
    ["Indianapolis", "Indianapolis", 39.7684, -86.1581], ["Denver", "Denver", 39.7392, -104.9903],
    ["Salt Lake City", "Salt Lake City", 40.7608, -111.891], ["Boise", "Boise, Idaho", 43.615, -116.2023],
    ["Phoenix", "Phoenix", 33.4484, -112.074], ["Tucson", "Tucson", 32.2226, -110.9747],
    ["Albuquerque", "Albuquerque", 35.0844, -106.6504], ["Santa Fe", "Santa Fe, New Mexico", 35.687, -105.9378],
    ["Las Vegas", "Las Vegas", 36.1699, -115.1398], ["Los Angeles", "Los Angeles", 34.0522, -118.2437],
    ["San Diego", "San Diego", 32.7157, -117.1611], ["San Francisco", "San Francisco", 37.7749, -122.4194],
    ["Santa Cruz", "Santa Cruz, California", 36.9741, -122.0308], ["Sacramento", "Sacramento", 38.5816, -121.4944],
    ["Portland, OR", "Portland, Oregon", 45.5152, -122.6784], ["Seattle", "Seattle", 47.6062, -122.3321],
  ]),
  ...m("India", [
    ["Mumbai", "Mumbai", 19.076, 72.8777], ["Delhi", "New Delhi", 28.6139, 77.209], ["Bengaluru", "Bengaluru", 12.9716, 77.5946],
    ["Pune", "Pune", 18.5204, 73.8567], ["Hyderabad", "Hyderabad, Telangana", 17.385, 78.4867], ["Chennai", "Chennai", 13.0827, 80.2707],
    ["Kolkata", "Kolkata", 22.5726, 88.3639], ["Goa", "Panaji, Goa", 15.4909, 73.8278], ["Ahmedabad", "Ahmedabad", 23.0225, 72.5714],
    ["Jaipur", "Jaipur", 26.9124, 75.7873], ["Chandigarh", "Chandigarh", 30.7333, 76.7794], ["Kochi", "Kochi", 9.9312, 76.2673],
    ["Guwahati", "Guwahati", 26.1445, 91.7362], ["Shillong", "Shillong", 25.5788, 91.8933], ["Indore", "Indore", 22.7196, 75.8577],
  ]),
  ...m("United Kingdom", [
    ["London", "London, England", 51.5072, -0.1276], ["Manchester", "Manchester, England", 53.4808, -2.2426], ["Glasgow", "Glasgow, Scotland", 55.8642, -4.2518],
    ["Edinburgh", "Edinburgh, Scotland", 55.9533, -3.1883], ["Bristol", "Bristol, England", 51.4545, -2.5879], ["Leeds", "Leeds, England", 53.8008, -1.5491],
    ["Birmingham", "Birmingham, England", 52.4862, -1.8904], ["Brighton", "Brighton, England", 50.8225, -0.1372],
    ["Liverpool", "Liverpool, England", 53.4084, -2.9916], ["Nottingham", "Nottingham, England", 52.9548, -1.1581],
    ["Newcastle", "Newcastle upon Tyne", 54.9783, -1.6178], ["Cardiff", "Cardiff, Wales", 51.4816, -3.1791],
    ["Sheffield", "Sheffield, England", 53.3811, -1.4701], ["Oxford", "Oxford, England", 51.752, -1.2577], ["Belfast", "Belfast, Northern Ireland", 54.5973, -5.9301],
  ]),
  ...m("Canada", [
    ["Toronto", "Toronto, Ontario", 43.6532, -79.3832], ["Montreal", "Montreal", 45.5019, -73.5674], ["Vancouver", "Vancouver, British Columbia", 49.2827, -123.1207],
    ["Ottawa", "Ottawa, Ontario", 45.4215, -75.6972], ["Calgary", "Calgary", 51.0447, -114.0719], ["Edmonton", "Edmonton", 53.5461, -113.4938],
    ["Winnipeg", "Winnipeg", 49.8951, -97.1384], ["Halifax", "Halifax, Nova Scotia", 44.6488, -63.5752],
  ]),
  ...m("Australia", [
    ["Sydney", "Sydney, Australia", -33.8688, 151.2093], ["Melbourne", "Melbourne, Australia", -37.8136, 144.9631], ["Brisbane", "Brisbane", -27.4698, 153.0251],
    ["Perth", "Perth, Western Australia", -31.9523, 115.8613], ["Adelaide", "Adelaide", -34.9285, 138.6007],
  ]),
];

/** A hotspot cell further than this from every market is "remote" and never becomes a stop. */
export const SNAP_KM = 75;

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "United States", "united states of america": "United States", usa: "United States", us: "United States", america: "United States",
  "united kingdom": "United Kingdom", uk: "United Kingdom", britain: "United Kingdom", "great britain": "United Kingdom", england: "United Kingdom", scotland: "United Kingdom", wales: "United Kingdom",
  india: "India", canada: "Canada", australia: "Australia",
};
/** The country a region names, when it is one with a market list ("USA" → "United States"). */
export const countryOf = (region?: string) => (region ? COUNTRY_ALIASES[region.trim().toLowerCase().replace(/\.$/, "")] : undefined);

/** The nearest market within `maxKm` (optionally only in `country`), or undefined for a remote point. */
export function nearestMarket(point: { lat: number; lng: number }, maxKm = SNAP_KM, country?: string): Market | undefined {
  let best: Market | undefined, bestKm = maxKm;
  for (const market of MARKETS) {
    if (country && market.country !== country) continue;
    const km = distanceKm(point, market);
    if (km <= bestKm) { best = market; bestKm = km; }
  }
  return best;
}

/** A market by display name or query ("Portland, OR", "portland, oregon", "Chicago"). */
export function findMarket(name: string): Market | undefined {
  const key = name.trim().toLowerCase();
  return MARKETS.find((x) => x.name.toLowerCase() === key || x.query.toLowerCase() === key);
}

export const marketSlug = (name: string) => `market:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
