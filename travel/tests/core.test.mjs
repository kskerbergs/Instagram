// Unit tests for counting rules, statistics and share codes. Run: node --test tests/core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = { console, TextEncoder, TextDecoder, Buffer, btoa, atob };
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["../web/data/places.js", "../web/js/core.js"]) {
  vm.runInContext(readFileSync(new URL(f, import.meta.url), "utf8"), ctx);
}
const { Core, COUNTRIES, REGIONS, CODE_ORDER } = ctx;
const DATA = { countries: COUNTRIES, regions: REGIONS, codeOrder: CODE_ORDER };
const v = (place, status = "visited", extra = {}) => ({ id: place + status, profile: "p", type: "country", place, status, first: null, last: null, ...extra });
const r = (place, status = "visited", extra = {}) => ({ ...v(place, status, extra), type: "region" });

// Values from the VM context have other-realm prototypes, so compare as JSON.
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const UN = COUNTRIES.filter((c) => c.un).length;
const ALL = COUNTRIES.length;

test("reference data", () => {
  assert.equal(UN, 195); // 193 members + 2 observers
  assert.equal(REGIONS.filter((x) => x.main).length, 51);
  assert.equal(REGIONS.length, 56);
  assert.equal(new Set(CODE_ORDER).size, CODE_ORDER.length);
});

const visits = [v("LV"), v("EE", "lived"), v("FR", "wishlist"), v("GL"), v("BR"), v("US", "visited", { first: "2019-05" }), v("US", "visited", { first: "2023-01" }), r("US-CA"), r("PR")];

for (const countTerritories of [false, true]) {
  for (const continentModel of [6, 7]) {
    for (const regionTerritories of [false, true]) {
      test(`percentages: territories=${countTerritories} continents=${continentModel} usTerritories=${regionTerritories}`, () => {
        const settings = { countTerritories, continentModel, regionTerritories };
        const s = Core.computeStats(DATA, visits, "p", settings);
        const total = countTerritories ? ALL : UN;
        // LV, EE (lived), BR, US count; GL only as a territory; FR is wishlist and never counts.
        const visited = countTerritories ? 5 : 4;
        assert.equal(s.total, total);
        assert.equal(s.visited, visited);
        assert.equal(s.pct, visited / total);
        assert.equal(s.wishlist, 1);
        const conts = s.byContinent.map((c) => c.id).sort();
        if (continentModel === 6) assert.ok(conts.includes("AM") && !conts.includes("NA"));
        else assert.ok(conts.includes("NA") && conts.includes("SA"));
        assert.equal(s.byContinent.reduce((a, c) => a + c.total, 0), total);
        assert.equal(s.byContinent.reduce((a, c) => a + c.visited, 0), visited);
        const eu = s.byContinent.find((c) => c.id === "EU");
        assert.equal(eu.visited, 2);
        assert.equal(s.regions.US.total, regionTerritories ? 56 : 51);
        assert.equal(s.regions.US.visited, 1);
        const area = Core.activeCountries(COUNTRIES, settings);
        const sum = (l) => l.reduce((a, c) => a + c.area, 0);
        const vis = area.filter((c) => Core.counts(s.status.get(c.id)));
        assert.equal(s.areaPct, sum(vis) / sum(area));
      });
    }
  }
}

test("a visited region marks its country, not the other way round", () => {
  const s = Core.computeStats(DATA, [r("US-TX")], "p", { continentModel: 7 });
  assert.equal(s.status.get("US"), "visited");
  assert.equal(s.visited, 1);
  const s2 = Core.computeStats(DATA, [v("US")], "p", { continentModel: 7 });
  assert.equal(s2.regions.US.visited, 0);
});

test("wishlist region does not mark its country", () => {
  const s = Core.computeStats(DATA, [r("US-TX", "wishlist")], "p", { continentModel: 7 });
  assert.equal(s.status.get("US"), undefined);
});

test("repeat visits count once; per-year uses earliest dated visit", () => {
  const s = Core.computeStats(DATA, visits, "p", { continentModel: 7 });
  assert.equal(s.visited, 4);
  same(s.perYear.map((y) => [y.year, y.countries]), [[2019, ["US"]]]);
  same(s.mostVisited, { country: "US", count: 2 });
  assert.equal(s.firstTrip.date, "2019-05");
  assert.equal(s.lastTrip.date, "2023-01");
});

test("other profiles are ignored", () => {
  const s = Core.computeStats(DATA, [{ ...v("DE"), profile: "q" }], "p", { continentModel: 7 });
  assert.equal(s.visited, 0);
});

test("share code round trip", () => {
  const sets = { visited: new Set(["LV", "EE", "GL", "VA"]), wishlist: new Set(["JP"]), regions: new Set(["US-CA", "US-PR"]), name: "Klāvs 🌍" };
  const code = Core.encodeShare(DATA, sets);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.ok(code.length < 140, "short enough for a URL");
  for (const input of [code, `wandermap://c/${code}`, `https://x.example/c#c=${code}`]) {
    const d = Core.decodeShare(DATA, input);
    same([...d.visited].sort(), [...sets.visited].sort());
    same([...d.wishlist], ["JP"]);
    same([...d.regions].sort(), ["US-CA", "US-PR"]);
    assert.equal(d.name, "Klāvs 🌍");
  }
  assert.throws(() => Core.decodeShare(DATA, "hello"));
});

test("compare sets", () => {
  const a = { visited: new Set(["LV", "EE", "FR"]), wishlist: new Set(["JP", "PE"]) };
  const b = { visited: new Set(["FR", "DE"]), wishlist: new Set(["JP"]) };
  const c = Core.compare(a, b);
  same(c.onlyMe.sort(), ["EE", "LV"]);
  same(c.onlyThem, ["DE"]);
  same(c.both, ["FR"]);
  same(c.together, ["JP"]);
});

test("achievements", () => {
  const vs = [v("LV"), v("EE"), v("LT")];
  const s = Core.computeStats(DATA, vs, "p", { continentModel: 7 });
  const a = Object.fromEntries(Core.evaluateAchievements(DATA, s, vs, "p", "LV").map((x) => [x.id, x]));
  assert.ok(a.baltics.done);
  assert.ok(a.abroad.done);
  assert.ok(!a.c10.done);
  assert.equal(a.c10.progress, "3 / 10");
});
