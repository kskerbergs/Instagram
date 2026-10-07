// Builds web/data/*.js (bundled, read-only reference data) and copies vendor libraries into web/vendor.
// Run: npm install && npm run build
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const d3 = require("d3-geo");
const topojson = require("topojson-client");
const out = new URL("../web/", import.meta.url);
const json = (p) => JSON.parse(readFileSync(require.resolve(p), "utf8"));

// ---- Countries -----------------------------------------------------------
const wc = json("world-countries/countries.json");
const world = json("world-atlas/countries-50m.json");
// Lighter geometry for the 3D globe, which re-projects every frame.
const world110 = json("world-atlas/countries-110m.json");

// Natural Earth features without an ISO numeric code.
const NAME_TO_ISO2 = { Kosovo: "XK" };
const byNum = new Map(wc.map((c) => [c.ccn3, c]));
const byIso2 = new Map(wc.map((c) => [c.cca2, c]));
// Natural Earth draws some overseas territories as part of the governing country, so they lit up
// with it (tap France, and French Guiana and Réunion highlight too). The app lists them as places of
// their own, so their polygons are split out here. Only each country's own territories are
// candidates; a polygon moves when it is near the territory, far from the mainland (> 8°) and about
// the territory's size.
const OVERSEAS = {
  FR: ["GF", "GP", "MQ", "RE", "YT"], // French Guiana, Guadeloupe, Martinique, Réunion, Mayotte
  NO: ["SJ"], // Svalbard and Jan Mayen
  NL: ["BQ"], // Bonaire, Sint Eustatius, Saba (spread out: 8° reach)
  NZ: ["TK"], // Tokelau
};
const REACH = { SJ: 4, BQ: 8 };
// world-countries gives -1 (unknown) for some areas; Svalbard and Jan Mayen is 61,022 km².
const AREA_FALLBACK = { SJ: 61022 };

const geomIds = new Set();
const log = [];
for (const topo of [world, world110]) {
  for (const g of topo.objects.countries.geometries) {
    const c = byNum.get(g.id) || byIso2.get(NAME_TO_ISO2[g.properties.name]);
    // Unassigned features (e.g. Siachen Glacier) stay as plain grey land.
    g.id = c ? c.cca2 : null;
    g.properties = {};
  }
  splitOverseasTerritories(topo);
  for (const g of topo.objects.countries.geometries) if (g.id) geomIds.add(g.id);
}

function splitOverseasTerritories(topo) {
  const geoms = topo.objects.countries.geometries;
  const drawn = new Set(geoms.map((g) => g.id));
  const KM2 = 6371 * 6371;
  const moved = new Map();
  for (const g of geoms) {
    const candidates = (OVERSEAS[g.id] || []).filter((id) => !drawn.has(id)).map((id) => byIso2.get(id));
    if (!candidates.length || g.type !== "MultiPolygon") continue;
    const polys = g.arcs.map((arcs) => topojson.feature(topo, { type: "Polygon", arcs }));
    const areas = polys.map((p) => d3.geoArea(p));
    const main = d3.geoCentroid(polys[areas.indexOf(Math.max(...areas))]);
    const keep = [];
    g.arcs.forEach((arcs, i) => {
      const centre = d3.geoCentroid(polys[i]);
      const farFromMainland = (d3.geoDistance(centre, main) * 180) / Math.PI > 8;
      let best = null;
      for (const t of candidates) {
        const d = (d3.geoDistance(centre, [t.latlng[1], t.latlng[0]]) * 180) / Math.PI;
        const area = t.area > 0 ? t.area : AREA_FALLBACK[t.cca2] || 0;
        const sizeOk = areas[i] * KM2 <= Math.max(3 * area, 2000);
        if (farFromMainland && sizeOk && d <= (REACH[t.cca2] || 2.5) && (!best || d < best.d)) best = { t, d };
      }
      if (best) {
        if (!moved.has(best.t.cca2)) moved.set(best.t.cca2, []);
        moved.get(best.t.cca2).push(arcs);
        log.push(`${best.t.cca2} from ${g.id}`);
      } else keep.push(arcs);
    });
    g.arcs = keep;
  }
  for (const [id, arcs] of moved) geoms.push({ type: "MultiPolygon", id, arcs, properties: {} });
}

delete world110.objects.land;

const NORTH_AMERICA = new Set(["North America", "Central America", "Caribbean"]);
function continent(c) {
  if (c.region === "Americas") return NORTH_AMERICA.has(c.subregion) ? "NA" : "SA";
  return { Europe: "EU", Asia: "AS", Africa: "AF", Oceania: "OC", Antarctic: "AN" }[c.region];
}
// UN members plus the two observer states.
const OBSERVERS = new Set(["VA", "PS"]);

const countries = wc
  .filter((c) => c.cca2 !== "UM") // tiny uninhabited US islands
  .map((c) => ({
    id: c.cca2,
    iso3: c.cca3,
    name: c.name.common,
    names: { de: c.translations.deu?.common, ru: c.translations.rus?.common },
    cont: continent(c),
    un: c.unMember || OBSERVERS.has(c.cca2),
    flag: c.flag,
    area: c.area,
    lat: +c.latlng[0].toFixed(2),
    lon: +c.latlng[1].toFixed(2),
    geo: geomIds.has(c.cca2),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Fixed order for share-code bitsets, kept in code-order.json. Append-only: reordering breaks old codes.
const orderFile = new URL("code-order.json", import.meta.url);
const CODE_ORDER = existsSync(orderFile) ? JSON.parse(readFileSync(orderFile, "utf8")) : [];
for (const c of countries) if (!CODE_ORDER.includes(c.id)) CODE_ORDER.push(c.id);
writeFileSync(orderFile, JSON.stringify(CODE_ORDER) + "\n");

// ---- US states (first region set) -----------------------------------------
const us = json("us-atlas/states-10m.json");
const FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
  "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};
const TERRITORY = new Set(["60", "66", "69", "72", "78"]);
const regions = [];
for (const g of us.objects.states.geometries) {
  const id = "US-" + FIPS[g.id];
  regions.push({
    id,
    country: "US",
    name: g.properties.name.replace("Commonwealth of the ", "").replace("United States ", ""),
    type: TERRITORY.has(g.id) ? "territory" : g.id === "11" ? "district" : "state",
    main: !TERRITORY.has(g.id),
  });
  g.id = id;
  g.properties = {};
}
delete us.objects.nation;
delete us.objects.counties;
regions.sort((a, b) => a.name.localeCompare(b.name));

const header = "// Generated by tools/build-data.mjs. Do not edit by hand.\n";
writeFileSync(new URL("data/places.js", out), header +
  `window.COUNTRIES=${JSON.stringify(countries)};\n` +
  `window.CODE_ORDER=${JSON.stringify(CODE_ORDER)};\n` +
  `window.REGIONS=${JSON.stringify(regions)};\n`);
writeFileSync(new URL("data/world.js", out), header + `window.WORLD_TOPO=${JSON.stringify(world)};\n`);
writeFileSync(new URL("data/globe.js", out), header + `window.GLOBE_TOPO=${JSON.stringify(world110)};\n`);
writeFileSync(new URL("data/us.js", out), header + `window.US_TOPO=${JSON.stringify(us)};\n`);

for (const f of ["d3-array/dist/d3-array.min.js", "d3-geo/dist/d3-geo.min.js",
  "d3-geo-projection/dist/d3-geo-projection.min.js", "topojson-client/dist/topojson-client.min.js",
  "qrcode-generator/dist/qrcode.js"]) {
  copyFileSync(new URL("node_modules/" + f, import.meta.url), new URL("vendor/" + f.split("/").pop(), out));
}
console.log("Split out overseas territories:", [...new Set(log)].join(", "));
console.log(`${countries.length} countries (${countries.filter((c) => c.un).length} UN), ${regions.length} US regions`);
