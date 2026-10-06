// Pure logic: counting rules, statistics, share codes. No DOM, so it runs under Node for tests.
(function (root) {
  "use strict";

  const CONTINENTS_7 = [
    { id: "AF", name: "Africa" },
    { id: "AN", name: "Antarctica" },
    { id: "AS", name: "Asia" },
    { id: "EU", name: "Europe" },
    { id: "NA", name: "North America" },
    { id: "SA", name: "South America" },
    { id: "OC", name: "Oceania" },
  ];
  const CONTINENTS_6 = CONTINENTS_7.filter((c) => c.id !== "NA" && c.id !== "SA")
    .concat({ id: "AM", name: "Americas" })
    .sort((a, b) => a.name.localeCompare(b.name));

  const COUNTING = new Set(["visited", "lived"]);
  const RANK = { wishlist: 1, visited: 2, lived: 3 };

  function continentOf(country, model) {
    if (model === 6 && (country.cont === "NA" || country.cont === "SA")) return "AM";
    return country.cont;
  }

  function continentList(model) {
    return model === 6 ? CONTINENTS_6 : CONTINENTS_7;
  }

  // The countries that make up the denominator under the current counting rules.
  function activeCountries(countries, settings) {
    return settings.countTerritories ? countries : countries.filter((c) => c.un);
  }

  function activeRegions(regions, country, settings) {
    return regions.filter((r) => r.country === country && (settings.regionTerritories || r.main));
  }

  // Strongest status per place: lived > visited > wishlist.
  function statusMap(visits, profileId, type) {
    const m = new Map();
    for (const v of visits) {
      if (v.profile !== profileId || v.type !== type) continue;
      const cur = m.get(v.place);
      if (!cur || RANK[v.status] > RANK[cur]) m.set(v.place, v.status);
    }
    return m;
  }

  // Country statuses, including countries implied by a visited region
  // (marking a region marks its country; not the other way round).
  function countryStatusMap(visits, profileId, regions) {
    const m = statusMap(visits, profileId, "country");
    const regionCountry = new Map(regions.map((r) => [r.id, r.country]));
    for (const [rid, st] of statusMap(visits, profileId, "region")) {
      if (!COUNTING.has(st)) continue;
      const cid = regionCountry.get(rid);
      const cur = m.get(cid);
      if (!cur || cur === "wishlist") m.set(cid, "visited");
    }
    return m;
  }

  function counts(status) {
    return COUNTING.has(status);
  }

  // Dates are "YYYY", "YYYY-MM" or "YYYY-MM-DD"; string order is chronological.
  function earliestDates(visits, profileId, regions) {
    const regionCountry = new Map(regions.map((r) => [r.id, r.country]));
    const first = new Map();
    for (const v of visits) {
      if (v.profile !== profileId || !counts(v.status) || !v.first) continue;
      const cid = v.type === "country" ? v.place : regionCountry.get(v.place);
      if (!cid) continue;
      if (!first.has(cid) || v.first < first.get(cid)) first.set(cid, v.first);
    }
    return first;
  }

  function computeStats(data, visits, profileId, settings) {
    const { countries, regions } = data;
    const model = settings.continentModel;
    const active = activeCountries(countries, settings);
    const status = countryStatusMap(visits, profileId, regions);
    const visited = active.filter((c) => counts(status.get(c.id)));
    const wishlist = active.filter((c) => status.get(c.id) === "wishlist");

    const totalArea = active.reduce((s, c) => s + (c.area || 0), 0);
    const visitedArea = visited.reduce((s, c) => s + (c.area || 0), 0);

    const byContinent = continentList(model)
      .map((ct) => {
        const all = active.filter((c) => continentOf(c, model) === ct.id);
        return { id: ct.id, name: ct.name, total: all.length, visited: all.filter((c) => counts(status.get(c.id))).length };
      })
      .filter((c) => c.total > 0);

    const regionStatus = statusMap(visits, profileId, "region");
    const byCountryRegions = {};
    for (const cid of new Set(regions.map((r) => r.country))) {
      const list = activeRegions(regions, cid, settings);
      byCountryRegions[cid] = { total: list.length, visited: list.filter((r) => counts(regionStatus.get(r.id))).length };
    }

    // Countries per year: by earliest dated visit.
    const first = earliestDates(visits, profileId, regions);
    const activeIds = new Set(active.map((c) => c.id));
    const years = new Map();
    for (const [cid, d] of first) {
      if (!activeIds.has(cid) || !counts(status.get(cid))) continue;
      const y = d.slice(0, 4);
      if (!years.has(y)) years.set(y, []);
      years.get(y).push(cid);
    }
    const perYear = [...years.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, ids]) => ({ year: +year, countries: ids.sort((a, b) => first.get(a).localeCompare(first.get(b))) }));

    // Repeat trips: the country with the most dated visits.
    const visitCount = new Map();
    const regionCountry = new Map(regions.map((r) => [r.id, r.country]));
    let firstTrip = null;
    let lastTrip = null;
    for (const v of visits) {
      if (v.profile !== profileId || !counts(v.status)) continue;
      const cid = v.type === "country" ? v.place : regionCountry.get(v.place);
      if (v.first) {
        visitCount.set(cid, (visitCount.get(cid) || 0) + 1);
        if (!firstTrip || v.first < firstTrip.date) firstTrip = { date: v.first, country: cid };
        const end = v.last || v.first;
        if (!lastTrip || end > lastTrip.date) lastTrip = { date: end, country: cid };
      }
    }
    let mostVisited = null;
    for (const [cid, n] of visitCount) if (n > 1 && (!mostVisited || n > mostVisited.count)) mostVisited = { country: cid, count: n };

    return {
      visited: visited.length,
      total: active.length,
      pct: active.length ? visited.length / active.length : 0,
      areaPct: totalArea ? visitedArea / totalArea : 0,
      wishlist: wishlist.length,
      lived: active.filter((c) => status.get(c.id) === "lived").length,
      regionsVisited: [...regionStatus.values()].filter(counts).length,
      byContinent,
      regions: byCountryRegions,
      perYear,
      firstTrip,
      lastTrip,
      mostVisited,
      status,
    };
  }

  // ---- Share code ----------------------------------------------------------
  // Layout (v1): version byte, country count (2 bytes), visited bitset, wishlist bitset,
  // region count (1 byte), visited-region bitset, then the display name as UTF-8. Base64url.
  const VERSION = 1;

  function bitsFor(order, set) {
    const bytes = new Uint8Array(Math.ceil(order.length / 8));
    order.forEach((id, i) => {
      if (set.has(id)) bytes[i >> 3] |= 1 << (i & 7);
    });
    return bytes;
  }

  function readBits(order, bytes, offset, n) {
    const out = new Set();
    for (let i = 0; i < n && i < order.length; i++) if (bytes[offset + (i >> 3)] & (1 << (i & 7))) out.add(order[i]);
    return out;
  }

  function toBase64Url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    const b64 = typeof btoa === "function" ? btoa(s) : Buffer.from(bytes).toString("base64");
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(str) {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    if (typeof atob === "function") {
      const s = atob(b64);
      return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }

  function regionOrder(regions) {
    return regions.map((r) => r.id).sort();
  }

  function encodeShare(data, { visited, wishlist, regions, name }) {
    const order = data.codeOrder;
    const rOrder = regionOrder(data.regions);
    const nameBytes = new TextEncoder().encode((name || "").slice(0, 40));
    const parts = [
      Uint8Array.of(VERSION, order.length >> 8, order.length & 255),
      bitsFor(order, visited),
      bitsFor(order, wishlist),
      Uint8Array.of(rOrder.length),
      bitsFor(rOrder, regions || new Set()),
      nameBytes,
    ];
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    return toBase64Url(all);
  }

  function decodeShare(data, code) {
    const clean = String(code).trim().replace(/^.*\/c\//, "").replace(/^.*[#?&]c=/, "").replace(/[^A-Za-z0-9_-].*$/, "");
    const b = fromBase64Url(clean);
    if (b.length < 3 || b[0] !== VERSION) throw new Error("Not a valid share code");
    const n = (b[1] << 8) | b[2];
    const len = Math.ceil(n / 8);
    if (b.length < 3 + 2 * len + 1) throw new Error("Share code is cut off");
    const visited = readBits(data.codeOrder, b, 3, n);
    const wishlist = readBits(data.codeOrder, b, 3 + len, n);
    let o = 3 + 2 * len;
    const m = b[o++];
    const rLen = Math.ceil(m / 8);
    const regions = readBits(regionOrder(data.regions), b, o, m);
    o += rLen;
    const name = new TextDecoder().decode(b.slice(o));
    return { visited, wishlist, regions, name };
  }

  function compare(mine, theirs) {
    const only = (a, b) => [...a].filter((x) => !b.has(x));
    return {
      onlyMe: only(mine.visited, theirs.visited),
      onlyThem: only(theirs.visited, mine.visited),
      both: [...mine.visited].filter((x) => theirs.visited.has(x)),
      together: [...mine.wishlist].filter((x) => theirs.wishlist.has(x)),
    };
  }

  // ---- Achievements (data, evaluated on every change) -----------------------
  const BALTICS = ["EE", "LV", "LT"];
  const EU27 = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
  const NORDICS = ["DK", "FI", "IS", "NO", "SE"];
  const ACHIEVEMENTS = [
    { id: "abroad", icon: "✈️", title: "First country abroad", rule: { type: "abroad" } },
    { id: "c10", icon: "🧭", title: "10 countries", rule: { type: "count", n: 10 } },
    { id: "c25", icon: "🗺️", title: "25 countries", rule: { type: "count", n: 25 } },
    { id: "c50", icon: "🌍", title: "50 countries", rule: { type: "count", n: 50 } },
    { id: "c100", icon: "🏆", title: "100 countries", rule: { type: "count", n: 100 } },
    { id: "baltics", icon: "🌲", title: "All Baltic states", rule: { type: "all", ids: BALTICS } },
    { id: "nordics", icon: "❄️", title: "All Nordic countries", rule: { type: "all", ids: NORDICS } },
    { id: "eu", icon: "🇪🇺", title: "All EU members", rule: { type: "all", ids: EU27 } },
    { id: "continents", icon: "🌐", title: "Every inhabited continent", rule: { type: "continents" } },
    { id: "us50", icon: "🇺🇸", title: "All 50 US states", rule: { type: "regions", country: "US", n: 50, kind: "state" } },
  ];

  function evaluateAchievements(data, stats, visits, profileId, home) {
    const visitedIds = new Set([...stats.status].filter(([, s]) => counts(s)).map(([id]) => id));
    const regionStatus = statusMap(visits, profileId, "region");
    return ACHIEVEMENTS.map((a) => {
      const r = a.rule;
      let done = false;
      let progress = "";
      if (r.type === "abroad") done = [...visitedIds].some((id) => id !== home);
      if (r.type === "count") {
        done = stats.visited >= r.n;
        progress = `${Math.min(stats.visited, r.n)} / ${r.n}`;
      }
      if (r.type === "all") {
        const n = r.ids.filter((id) => visitedIds.has(id)).length;
        done = n === r.ids.length;
        progress = `${n} / ${r.ids.length}`;
      }
      if (r.type === "continents") {
        const inhabited = new Set(data.countries.filter((c) => visitedIds.has(c.id) && c.cont !== "AN").map((c) => c.cont));
        done = inhabited.size >= 6;
        progress = `${inhabited.size} / 6`;
      }
      if (r.type === "regions") {
        const n = data.regions.filter((x) => x.country === r.country && x.type === r.kind && counts(regionStatus.get(x.id))).length;
        done = n >= r.n;
        progress = `${n} / ${r.n}`;
      }
      return { ...a, done, progress };
    });
  }

  root.Core = {
    CONTINENTS_7,
    continentOf,
    continentList,
    activeCountries,
    activeRegions,
    statusMap,
    countryStatusMap,
    counts,
    computeStats,
    encodeShare,
    decodeShare,
    compare,
    evaluateAchievements,
  };
})(typeof window !== "undefined" ? window : globalThis);
