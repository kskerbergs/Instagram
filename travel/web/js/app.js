// Wandermap UI: tabs, shared Place sheet, stats, sharing, comparison. All data stays on the device.
(function () {
  "use strict";

  const DATA = { countries: COUNTRIES, regions: REGIONS, codeOrder: CODE_ORDER };
  const COUNTRY = new Map(COUNTRIES.map((c) => [c.id, c]));
  const REGION = new Map(REGIONS.map((r) => [r.id, r]));
  // Okabe–Ito based, colour-blind safe.
  const PALETTE = ["#0072B2", "#009E73", "#D55E00", "#CC79A7", "#E69F00", "#56B4E9", "#7B61FF", "#8C6D46"];
  const STORE_KEY = "wandermap.v1";
  const Native = window.WandermapNative || null;

  // ---- State -----------------------------------------------------------------
  const DEFAULT_STATE = {
    version: 1,
    profiles: [{ id: "p1", name: "Me", color: PALETTE[0], created: today() }],
    active: "p1",
    visits: [],
    friends: [],
    home: null,
    onboarded: false,
    settings: {
      continentModel: 7,
      countTerritories: false,
      regionTerritories: false,
      theme: "auto",
      colorMode: "status",
      undated: "first",
    },
  };

  let state = load();
  const ui = {
    tab: "map",
    placesKind: "country",
    search: "",
    filter: "all",
    sort: "az",
    sheet: null,
    screen: null,
    mapFilter: { status: "all", cont: "all", from: "", to: "" },
    anim: null,
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { ...DEFAULT_STATE, ...s, settings: { ...DEFAULT_STATE.settings, ...s.settings } };
      }
    } catch (e) {
      console.warn("Could not read saved data", e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("Could not save: " + e.message);
    }
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  const profile = () => state.profiles.find((p) => p.id === state.active) || state.profiles[0];
  const myVisits = () => state.visits.filter((v) => v.profile === state.active);
  const stats = () => Core.computeStats(DATA, state.visits, state.active, state.settings);

  // ---- Small helpers -----------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pct = (x) => (x * 100 < 10 && x > 0 ? (x * 100).toFixed(1) : Math.round(x * 100)) + "%";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function fmtDate(d) {
    if (!d) return "";
    const [y, m, day] = d.split("-");
    if (!m) return y;
    return (day ? +day + " " : "") + MONTHS[+m - 1] + " " + y;
  }

  function fmtRange(v) {
    if (!v.first) return "No date";
    return v.last && v.last !== v.first ? fmtDate(v.first) + " – " + fmtDate(v.last) : fmtDate(v.first);
  }

  function placeName(type, id) {
    if (type === "region") return REGION.get(id)?.name || id;
    return COUNTRY.get(id)?.name || id;
  }

  function placeFlag(type, id) {
    return type === "region" ? "🇺🇸" : COUNTRY.get(id)?.flag || "🏳️";
  }

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }

  let toastTimer;
  // A transient status; with `undo`, it offers a way back instead of asking "are you sure?" first.
  function toast(msg, ms = 2600, undo = null) {
    const el = $("#toast");
    el.classList.add("material");
    el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="btn small">Undo</button>` : ""}`;
    el.hidden = true;
    void el.offsetWidth; // restart the entrance animation
    el.hidden = false;
    if (undo) {
      $("button", el).addEventListener("click", () => {
        el.hidden = true;
        undo();
      });
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), undo ? Math.max(ms, 5000) : ms);
  }

  function snapshot() {
    const saved = JSON.stringify(state.visits);
    return () => {
      state.visits = JSON.parse(saved);
      changed();
      Motion.haptic(8);
    };
  }

  function applyTheme() {
    const t = state.settings.theme;
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    document.documentElement.style.setProperty("--pc", profile().color);
  }

  function cssTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      ocean: v("--ocean"),
      land: v("--land"),
      unvisited: v("--land"),
      border: v("--border"),
      graticule: v("--graticule"),
      dot: v("--dot"),
      dotStroke: v("--dot-stroke"),
      text: v("--text"),
      muted: v("--muted"),
      bg: v("--bg"),
      surface: v("--surface"),
    };
  }
  let theme = null;

  // ---- Visit operations (used from every screen through the one Place sheet) -------
  function visitsFor(type, id) {
    return myVisits().filter((v) => v.type === type && v.place === id);
  }

  function statusOf(type, id) {
    if (type === "country") return currentStats.status.get(id) || null;
    return Core.statusMap(state.visits, state.active, "region").get(id) || null;
  }

  function setStatus(type, id, status) {
    const list = visitsFor(type, id);
    Motion.haptic(10);
    ui.justChanged = type + ":" + id;
    if (!status) {
      if (!list.length) return;
      const undo = snapshot();
      state.visits = state.visits.filter((v) => !(v.profile === state.active && v.type === type && v.place === id));
      changed();
      toast(`${placeName(type, id)} cleared${list.some((v) => v.first) ? ` (${list.length} visit${list.length > 1 ? "s" : ""})` : ""}`, 5000, undo);
      return;
    } else if (!list.length) {
      state.visits.push({ id: uid(), profile: state.active, type, place: id, status, first: null, last: null, note: "" });
    } else {
      list.forEach((v) => (v.status = status));
    }
    changed();
  }

  function quickToggle(type, id) {
    const st = statusOf(type, id);
    const dated = visitsFor(type, id).some((v) => v.first || v.note);
    if (Core.counts(st)) {
      if (dated) {
        openSheet(type, id);
        toast("This place has dated visits. Clear it here if you want to.");
        return;
      }
      setStatus(type, id, null);
    } else {
      const undo = snapshot();
      setStatus(type, id, "visited");
      toast("✓ " + placeName(type, id) + " visited", 3000, undo);
    }
  }

  let currentStats = stats();
  let currentAchievements = null;

  function changed() {
    save();
    const before = currentAchievements;
    const prevStyles = new Map();
    for (const c of COUNTRIES) prevStyles.set("country:" + c.id, theme ? countryStyle(c.id) : null);
    for (const r of REGIONS) prevStyles.set("region:" + r.id, theme ? regionStyle(r.id) : null);
    currentStats = stats();
    startFade(prevStyles);
    currentAchievements = Core.evaluateAchievements(DATA, currentStats, state.visits, state.active, state.home);
    if (before) {
      const newly = currentAchievements.filter((a, i) => a.done && !before[i].done);
      if (newly.length) toast(newly[0].icon + " Achievement: " + newly[0].title, 3500);
    }
    refresh();
  }

  function refresh() {
    applyTheme();
    theme = cssTheme();
    worldMap?.render();
    regionMap?.render();
    renderCounter();
    if (ui.tab === "places") renderPlaces();
    if (ui.tab === "stats") renderStats();
    if (ui.tab === "profile") renderProfile();
    if (ui.sheet) renderSheet();
    if (ui.screen?.refresh) ui.screen.refresh();
    ui.justChanged = null;
  }

  // ---- Colour transitions -------------------------------------------------------------
  // Places that change colour blend from their old fill to the new one instead of snapping.
  const FADE_MS = 420;
  function startFade(prevStyles) {
    if (Motion.reduceMotion() || !theme) return;
    const from = new Map();
    for (const [key, st] of prevStyles) {
      const [kind, id] = key.split(":");
      const now = kind === "country" ? countryStyle(id) : regionStyle(id);
      if (st && (st.fill !== now.fill || st.hatch !== now.hatch)) from.set(key, st);
    }
    if (!from.size) return;
    ui.fade = { from, t0: performance.now() };
    const tick = (t) => {
      if (!ui.fade) return;
      const done = t - ui.fade.t0 >= FADE_MS;
      if (done) ui.fade = null;
      worldMap?.draw();
      regionMap?.draw();
      ui.screen?.redraw?.();
      if (!done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function faded(key, target) {
    const f = ui.fade;
    const prev = f && f.from.get(key);
    if (!prev) return target;
    const t = Math.min(1, (performance.now() - f.t0) / FADE_MS);
    const e = 1 - Math.pow(1 - t, 3); // ease-out: quick start, gentle landing
    const a = prev.fill || theme.unvisited;
    const b = target.fill || theme.unvisited;
    if (target.hatch) return t > 0.5 ? target : { fill: mix(a, theme.unvisited, e * 2) };
    return { fill: mix(a, b, e) };
  }

  // ---- Map colouring ------------------------------------------------------------
  function yearColor(year, years) {
    const pc = profile().color;
    if (!year || years.length < 2) return pc;
    const t = (year - years[0]) / (years[years.length - 1] - years[0]);
    return mix(mix(pc, "#ffffff", 0.55), mix(pc, "#000000", 0.35), t);
  }

  function firstYears() {
    const m = new Map();
    for (const y of currentStats.perYear) for (const id of y.countries) m.set(id, y.year);
    return m;
  }

  function countryStyle(id) {
    const pc = profile().color;
    const st = currentStats.status.get(id);
    const c = COUNTRY.get(id);
    const active = state.settings.countTerritories || c?.un;
    const f = ui.mapFilter;
    const years = ui.styleYears;
    const y = years.map.get(id);

    if (ui.anim) {
      if (!Core.counts(st)) return { fill: theme.unvisited };
      if (!y) return state.settings.undated === "first" ? { fill: pc } : { fill: theme.unvisited };
      if (y > ui.anim.year) return { fill: theme.unvisited };
      return y === ui.anim.year ? { fill: mix(pc, "#ffffff", 0.35 * (1 - ui.anim.t)) } : { fill: pc };
    }
    if (!st) return { fill: theme.unvisited };
    if (f.status !== "all" && st !== f.status && !(f.status === "visited" && st === "lived")) return { fill: theme.unvisited };
    if (f.cont !== "all" && c && Core.continentOf(c, state.settings.continentModel) !== f.cont) return { fill: theme.unvisited };
    if ((f.from || f.to) && Core.counts(st)) {
      if (!y || (f.from && y < +f.from) || (f.to && y > +f.to)) return { fill: theme.unvisited };
    }
    const tone = active ? pc : mix(pc, theme.unvisited, 0.35);
    if (st === "wishlist") return { hatch: tone };
    if (state.settings.colorMode === "year" && Core.counts(st)) return { fill: yearColor(y, years.list) };
    return { fill: st === "lived" ? mix(tone, "#000000", 0.3) : tone };
  }

  function regionStyle(id) {
    const pc = profile().color;
    const st = Core.statusMap(state.visits, state.active, "region").get(id);
    if (!st) return { fill: theme.unvisited };
    if (st === "wishlist") return { hatch: pc };
    return { fill: st === "lived" ? mix(pc, "#000000", 0.3) : pc };
  }

  // ---- Tabs ---------------------------------------------------------------------
  function showTab(tab) {
    ui.tab = tab;
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $$(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + tab));
    if (tab !== "map") stopAnimation();
    if (tab === "map") worldMap.resize();
    if (tab === "places") renderPlaces();
    if (tab === "stats") renderStats();
    if (tab === "profile") renderProfile();
    // Stagger the cards in on arrival, not on every refresh.
    const sec = $("#tab-" + tab);
    sec.classList.remove("enter");
    void sec.offsetWidth;
    sec.classList.add("enter");
    clearTimeout(ui.enterTimer);
    ui.enterTimer = setTimeout(() => sec.classList.remove("enter"), 900);
  }

  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---- Map tab -------------------------------------------------------------------
  let worldMap = null;
  let regionMap = null;

  function initMap() {
    ui.styleYears = { map: new Map(), list: [] };
    worldMap = new MapView($("#map"), {
      region: "world",
      countries: COUNTRIES,
      theme: () => theme,
      style: (id) => faded("country:" + id, countryStyle(id)),
      onTap: (id) => {
        if (ui.anim) return stopAnimation();
        openSheet("country", id);
      },
      onLongPress: (id) => quickToggle("country", id),
      fillHeight: true,
      center: () => {
        const c = COUNTRY.get(state.home) || COUNTRY.get("DE");
        return [c.lon, c.lat];
      },
    });
    const origDraw = worldMap.draw.bind(worldMap);
    worldMap.draw = () => {
      const m = firstYears();
      ui.styleYears = { map: m, list: [...new Set(m.values())].sort((a, b) => a - b) };
      origDraw();
    };
    $$(".map-top .seg button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.classList.contains("on")) return;
        $$(".map-top .seg button").forEach((x) => x.classList.toggle("on", x === b));
        const canvas = $("#map");
        canvas.classList.remove("morph");
        void canvas.offsetWidth;
        canvas.classList.add("morph");
        worldMap.setMode(b.dataset.mode);
        if (b.dataset.mode === "globe") worldMap.spinIn();
      }),
    );
    $("#map-reset").addEventListener("click", () => worldMap.resetView());
    $("#map-filter").addEventListener("click", toggleFilterBar);
    $("#counter").addEventListener("click", () => showTab("stats"));
  }

  // The counter rolls to its new value rather than jumping.
  let counterAnim = null;
  let counterShown = null;
  function renderCounter() {
    const s = currentStats;
    const el = $("#counter");
    const write = (n) => {
      const v = Math.round(n);
      el.textContent = `${v} ${v === 1 ? "country" : "countries"} · ${pct(s.total ? n / s.total : 0)} of the world`;
    };
    counterAnim?.stop();
    if (counterShown === null || counterShown === s.visited) {
      counterShown = s.visited;
      write(s.visited);
      return;
    }
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
    counterAnim = Motion.spring({ from: counterShown, to: s.visited, damping: 1, response: 0.45, onUpdate: (v) => ((counterShown = v), write(v)) });
  }

  function toggleFilterBar() {
    const bar = $("#filter-bar");
    if (!bar.hidden) {
      bar.hidden = true;
      return;
    }
    const f = ui.mapFilter;
    const conts = Core.continentList(state.settings.continentModel);
    bar.innerHTML = `
      <label>Status <select data-k="status">
        ${["all", "visited", "lived", "wishlist"].map((s) => `<option value="${s}" ${f.status === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}
      </select></label>
      <label>Continent <select data-k="cont">
        <option value="all">All</option>
        ${conts.map((c) => `<option value="${c.id}" ${f.cont === c.id ? "selected" : ""}>${c.name}</option>`).join("")}
      </select></label>
      <label>First visit between
        <span class="inline"><input data-k="from" type="number" inputmode="numeric" placeholder="from" value="${esc(f.from)}" style="width:80px">
        <input data-k="to" type="number" inputmode="numeric" placeholder="to" value="${esc(f.to)}" style="width:80px"></span></label>
      <button class="btn link" data-clear>Clear filters</button>`;
    bar.hidden = false;
    $$("[data-k]", bar).forEach((el) =>
      el.addEventListener("input", () => {
        f[el.dataset.k] = el.value;
        $("#map-filter").classList.toggle("on", f.status !== "all" || f.cont !== "all" || !!f.from || !!f.to);
        worldMap.render();
      }),
    );
    $("[data-clear]", bar).addEventListener("click", () => {
      ui.mapFilter = { status: "all", cont: "all", from: "", to: "" };
      $("#map-filter").classList.remove("on");
      bar.hidden = true;
      worldMap.render();
    });
  }

  // Chronological map: step through the years, each year's new countries fade in.
  function playAnimation() {
    const years = [...currentStats.perYear].map((y) => y.year).sort((a, b) => a - b);
    if (!years.length) {
      toast("Add dates to your visits to play the timeline.");
      return;
    }
    showTab("map");
    const label = $("#anim-label");
    label.hidden = false;
    let i = 0;
    const stepMs = 1100;
    ui.anim = { year: years[0], t: 0 };
    let start = performance.now();
    const tick = (now) => {
      if (!ui.anim) return;
      const t = (now - start) / stepMs;
      if (t >= 1) {
        i++;
        if (i >= years.length) {
          setTimeout(stopAnimation, 1500);
          ui.anim.t = 1;
          worldMap.render();
          return;
        }
        start = now;
      }
      const year = years[i];
      ui.anim = { year, t: Math.min(1, t) };
      const n = currentStats.perYear.find((y) => y.year === year).countries.length;
      const total = currentStats.perYear.filter((y) => y.year <= year).reduce((s, y) => s + y.countries.length, 0);
      if (label.dataset.year !== String(year)) {
        label.dataset.year = year;
        label.innerHTML = `<span class="roll">${year}</span><small>+${n} new · ${total} total</small>`;
      }
      worldMap.draw();
      ui.animRaf = requestAnimationFrame(tick);
    };
    ui.animRaf = requestAnimationFrame(tick);
  }

  function stopAnimation() {
    if (!ui.anim) return;
    ui.anim = null;
    cancelAnimationFrame(ui.animRaf);
    $("#anim-label").hidden = true;
    worldMap.render();
  }

  // ---- Places tab ----------------------------------------------------------------
  function initPlaces() {
    $$("#places-kind button").forEach((b) =>
      b.addEventListener("click", () => {
        ui.placesKind = b.dataset.kind;
        $$("#places-kind button").forEach((x) => x.classList.toggle("on", x === b));
        renderPlaces();
      }),
    );
    $("#search").addEventListener("input", (e) => {
      ui.search = e.target.value;
      renderPlaces();
    });
    $("#places-filter").addEventListener("change", (e) => {
      ui.filter = e.target.value;
      renderPlaces();
    });
    $("#places-sort").addEventListener("change", (e) => {
      ui.sort = e.target.value;
      renderPlaces();
    });
    $("#places-list").addEventListener("click", (e) => {
      const check = e.target.closest(".check");
      const row = e.target.closest(".place-row");
      if (!row) return;
      if (check) quickToggle(row.dataset.type, row.dataset.id);
      else openSheet(row.dataset.type, row.dataset.id);
    });
  }

  function latestDate(type, id) {
    const ds = visitsFor(type, id).map((v) => v.last || v.first).filter(Boolean).sort();
    return ds[ds.length - 1] || null;
  }

  function placeRow(type, item, st, extra = "") {
    const d = latestDate(type, item.id);
    const mark = st === "wishlist" ? "★" : Core.counts(st) ? "✓" : "";
    return `<button class="place-row" data-type="${type}" data-id="${item.id}">
      <span class="flag" aria-hidden="true">${type === "region" ? `<span class="code">${item.id.slice(3)}</span>` : item.flag}</span>
      <span class="name">${esc(item.name)}${d || extra ? `<small>${[d ? fmtDate(d) : "", extra].filter(Boolean).join(" · ")}</small>` : ""}</span>
      <span class="check ${st || ""}${ui.justChanged === type + ":" + item.id ? " pop" : ""}" role="checkbox" aria-checked="${Core.counts(st)}" aria-label="${esc(item.name)}: ${st || "not visited"}">${mark}</span>
    </button>`;
  }

  function matchesFilter(st) {
    if (ui.filter === "visited") return Core.counts(st);
    if (ui.filter === "wishlist") return st === "wishlist";
    if (ui.filter === "none") return !st;
    return true;
  }

  function searchMatch(item) {
    const q = ui.search.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.id, item.iso3, ...Object.values(item.names || {})].some((s) => s && s.toLowerCase().includes(q));
  }

  function sortItems(type, items) {
    if (ui.sort === "date") {
      return items.sort((a, b) => (latestDate(type, b.id) || "").localeCompare(latestDate(type, a.id) || "") || a.name.localeCompare(b.name));
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderPlaces() {
    const el = $("#places-list");
    let html = "";
    if (ui.placesKind === "country") {
      const model = state.settings.continentModel;
      const active = Core.activeCountries(COUNTRIES, state.settings);
      for (const ct of Core.continentList(model)) {
        const all = active.filter((c) => Core.continentOf(c, model) === ct.id);
        if (!all.length) continue;
        const done = all.filter((c) => Core.counts(currentStats.status.get(c.id))).length;
        const shown = sortItems("country", all.filter((c) => searchMatch(c) && matchesFilter(currentStats.status.get(c.id))));
        if (!shown.length) continue;
        html += `<div class="group-h">${ct.name}<span>${done} / ${all.length}</span></div>`;
        html += `<div class="group">${shown.map((c) => placeRow("country", c, currentStats.status.get(c.id))).join("")}</div>`;
      }
      if (!state.settings.countTerritories) {
        const terr = sortItems("country", COUNTRIES.filter((c) => !c.un && searchMatch(c) && matchesFilter(currentStats.status.get(c.id))));
        if (terr.length && (ui.search || ui.filter !== "all")) {
          html += `<div class="group-h">Territories<span>not counted</span></div>`;
          html += `<div class="group">${terr.map((c) => placeRow("country", c, currentStats.status.get(c.id))).join("")}</div>`;
        }
      }
    } else {
      const rs = Core.statusMap(state.visits, state.active, "region");
      const counted = Core.activeRegions(REGIONS, "US", state.settings);
      const done = counted.filter((r) => Core.counts(rs.get(r.id))).length;
      const shown = sortItems("region", counted.filter((r) => searchMatch(r) && matchesFilter(rs.get(r.id))));
      html += `<div class="list" style="margin-top:0.75rem"><div class="list-row"><div><b>United States</b><small>${done} / ${counted.length} visited</small></div><button class="btn small primary" data-open-us>Open map</button></div></div>`;
      html += `<div class="group-h">States<span>${done} / ${counted.length}</span></div>`;
      html += `<div class="group">${shown.map((r) => placeRow("region", r, rs.get(r.id), r.type !== "state" ? r.type : "")).join("")}</div>`;
      if (!state.settings.regionTerritories) {
        const terr = REGIONS.filter((r) => !r.main && searchMatch(r) && matchesFilter(rs.get(r.id)));
        if (terr.length) {
          html += `<div class="group-h">US territories<span>not counted</span></div>`;
          html += `<div class="group">${terr.map((r) => placeRow("region", r, rs.get(r.id))).join("")}</div>`;
        }
      }
    }
    el.innerHTML = html || `<div class="empty">Nothing matches.</div>`;
    $("[data-open-us]", el)?.addEventListener("click", () => openRegionMap("US"));
  }

  // ---- Place sheet ---------------------------------------------------------------
  const sheetCtl = Motion.Sheet($("#sheet"), $("#sheet-backdrop"), $("#sheet"), {
    handle: ".sheet-top",
    onClosed: () => {
      if (!ui.sheet) $("#sheet-body").innerHTML = "";
    },
  });

  function openSheet(type, id) {
    ui.sheet = { type, id, editing: null };
    renderSheet();
    sheetCtl.open();
  }

  function closeSheet() {
    ui.sheet = null; // content stays on screen while it slides away
    sheetCtl.close();
  }
  $("#sheet-backdrop").addEventListener("click", closeSheet);

  function renderSheet() {
    const { type, id, editing } = ui.sheet;
    const st = statusOf(type, id);
    const visits = visitsFor(type, id).sort((a, b) => (b.first || "").localeCompare(a.first || ""));
    let sub = "";
    let extra = "";
    if (type === "country") {
      const c = COUNTRY.get(id);
      const cont = Core.continentList(state.settings.continentModel).find((x) => x.id === Core.continentOf(c, state.settings.continentModel));
      sub = `${cont ? cont.name : ""}${c.un ? "" : " · territory"}`;
      const regs = REGIONS.filter((r) => r.country === id);
      if (regs.length) {
        const r = currentStats.regions[id];
        extra = `<div class="list" style="margin-top:0.75rem"><div class="list-row"><div><b>States</b><small>${r.visited} / ${r.total} visited</small></div><button class="btn small primary" data-open-regions="${id}">Open map</button></div></div>`;
      }
    } else {
      const r = REGION.get(id);
      sub = `${r.type[0].toUpperCase() + r.type.slice(1)} · <button class="btn link" data-parent="${r.country}">${esc(COUNTRY.get(r.country).name)}</button>`;
    }
    const statusBtns = [
      ["visited", "Visited", "✓"],
      ["lived", "Lived", "⌂"],
      ["wishlist", "Wishlist", "★"],
      [null, "Clear", "✕"],
    ]
      .map(([s, label, icon]) => `<button data-status="${s || ""}" class="${s && st === s ? "on " + s + (ui.justChanged === type + ":" + id ? " pop" : "") : ""}" aria-pressed="${s && st === s}"><i aria-hidden="true">${icon}</i>${label}</button>`)
      .join("");

    const visitRows = visits.length
      ? visits
          .map(
            (v) => `<div class="visit"><div><b>${esc(fmtRange(v))}</b><small>${esc(v.status)}${v.note ? " · " + esc(v.note) : ""}</small></div>
            <button class="btn link" data-edit="${v.id}">Edit</button></div>`,
          )
          .join("")
      : `<div class="visit"><div class="note">No visits recorded yet.</div></div>`;

    const keepScroll = $(".sheet-scroll")?.scrollTop || 0;
    $("#sheet-body").innerHTML = `
      <div class="sheet-top">
        <div class="grab" aria-hidden="true"></div>
        <div class="sheet-head">
          <span class="flag" aria-hidden="true">${type === "region" ? "🗺️" : placeFlag(type, id)}</span>
          <div style="flex:1;min-width:0"><h2>${esc(placeName(type, id))}</h2><small>${sub}</small></div>
          <button class="icon-btn" data-close-sheet aria-label="Close">✕</button>
        </div>
        <div class="status-row">${statusBtns}</div>
      </div>
      <div class="sheet-scroll">
        ${extra}
        <h3>Visits</h3>
        <div class="list">${visitRows}${editing ? visitForm(visits.find((v) => v.id === editing)) : ""}</div>
        ${editing ? "" : `<div class="section" style="margin-top:0.75rem"><button class="btn block" data-add>Add a visit with dates</button></div>`}
      </div>
    `;
    $(".sheet-scroll").scrollTop = keepScroll;
    sheetCtl.relayout();
    const body = $("#sheet-body");
    $("[data-close-sheet]", body).addEventListener("click", closeSheet);
    $$("[data-status]", body).forEach((b) => b.addEventListener("click", () => setStatus(type, id, b.dataset.status || null)));
    $("[data-add]", body)?.addEventListener("click", () => {
      ui.sheet.editing = "new";
      renderSheet();
    });
    $$("[data-edit]", body).forEach((b) =>
      b.addEventListener("click", () => {
        ui.sheet.editing = b.dataset.edit;
        renderSheet();
      }),
    );
    $("[data-open-regions]", body)?.addEventListener("click", (e) => {
      closeSheet();
      openRegionMap(e.target.dataset.openRegions);
    });
    $("[data-parent]", body)?.addEventListener("click", (e) => openSheet("country", e.target.dataset.parent));
    if (editing) bindVisitForm(body, type, id, visits.find((v) => v.id === editing));
  }

  function visitForm(v) {
    const exact = !!(v?.first && v.first.length > 7);
    const kind = exact ? "date" : "month";
    return `<div class="form" id="visit-form">
      <label class="inline"><input type="checkbox" class="toggle" id="exact" ${exact ? "checked" : ""}> Exact days</label>
      <div class="two">
        <label>From <input id="v-first" type="${kind}" value="${esc(v?.first || "")}"></label>
        <label>To (optional) <input id="v-last" type="${kind}" value="${esc(v?.last || "")}"></label>
      </div>
      <label>Status <select id="v-status">
        ${["visited", "lived", "wishlist"].map((s) => `<option ${(v?.status || statusOf(ui.sheet.type, ui.sheet.id) || "visited") === s ? "selected" : ""}>${s}</option>`).join("")}
      </select></label>
      <label>Note <input id="v-note" type="text" maxlength="200" value="${esc(v?.note || "")}" placeholder="Trip name, who you went with…"></label>
      <div class="btns">
        <button class="btn primary" id="v-save">Save</button>
        <button class="btn" id="v-cancel">Cancel</button>
        ${v ? `<button class="btn danger" id="v-delete">Delete</button>` : ""}
      </div>
    </div>`;
  }

  function bindVisitForm(body, type, id, v) {
    const first = $("#v-first", body);
    const last = $("#v-last", body);
    $("#exact", body).addEventListener("change", (e) => {
      const kind = e.target.checked ? "date" : "month";
      for (const inp of [first, last]) {
        const val = inp.value;
        inp.type = kind;
        inp.value = kind === "month" ? val.slice(0, 7) : val && val.length === 7 ? val + "-01" : val;
      }
    });
    $("#v-cancel", body).addEventListener("click", () => {
      ui.sheet.editing = null;
      renderSheet();
    });
    $("#v-delete", body)?.addEventListener("click", () => {
      const undo = snapshot();
      state.visits = state.visits.filter((x) => x.id !== v.id);
      ui.sheet.editing = null;
      changed();
      toast("Visit deleted", 5000, undo);
    });
    $("#v-save", body).addEventListener("click", () => {
      let f = first.value || null;
      let l = last.value || null;
      if (f && l && l < f) [f, l] = [l, f];
      const rec = { first: f, last: l, status: $("#v-status", body).value, note: $("#v-note", body).value.trim() };
      if (v) Object.assign(v, rec);
      else {
        // An undated placeholder visit is replaced by the first dated one.
        const blank = visitsFor(type, id).find((x) => !x.first && !x.note);
        if (blank) Object.assign(blank, rec);
        else state.visits.push({ id: uid(), profile: state.active, type, place: id, ...rec });
      }
      ui.sheet.editing = null;
      Motion.haptic(10);
      changed();
    });
  }

  // ---- Regional map (one tap from the world map's Place sheet) ----------------------
  function openRegionMap(countryId) {
    const c = COUNTRY.get(countryId);
    openScreen({
      html: `<div class="screen-h"><button class="icon-btn" data-close aria-label="Back">‹ Back</button><h2>${esc(c.name)}</h2><span id="region-count" class="note"></span></div>
        <div style="flex:1;display:flex;position:relative"><canvas id="region-canvas" aria-label="Map of ${esc(c.name)} states"></canvas></div>
        <p class="map-hint" style="position:static;padding:8px">Tap a state for details · long-press to mark visited</p>`,
      mount(root) {
        regionMap = new MapView($("#region-canvas", root), {
          region: countryId,
          countries: COUNTRIES,
          theme: () => theme,
          style: (id) => faded("region:" + id, regionStyle(id)),
          onTap: (id) => openSheet("region", id),
          onLongPress: (id) => quickToggle("region", id),
        });
        this.refresh();
      },
      refresh() {
        const r = currentStats.regions[countryId];
        $("#region-count").textContent = `${r.visited} / ${r.total} visited`;
      },
      unmount() {
        regionMap.resizeObserver.disconnect();
        regionMap = null;
      },
    });
  }

  // ---- Full-screen overlays ---------------------------------------------------------
  // Pages enter from the right and leave the same way; swipe from the left edge to go back.
  const pager = Motion.Pager($("#screen"), $("#screen-scrim"));

  function openScreen(screen) {
    const el = $("#screen");
    if (ui.screen) ui.screen.unmount?.();
    el.innerHTML = screen.html;
    ui.screen = screen;
    $$("[data-close]", el).forEach((b) => b.addEventListener("click", closeScreen));
    pager.open(() => {
      if (ui.screen === screen) ui.screen = null;
      screen.unmount?.();
      if (!ui.screen) el.innerHTML = "";
    });
    screen.mount?.(el);
  }

  function closeScreen() {
    if (!ui.screen) return;
    ui.screen = null;
    pager.close();
  }

  // ---- Stats tab ----------------------------------------------------------------------
  function ring(p) {
    const r = 52;
    const c = 2 * Math.PI * r;
    return `<svg class="ring" viewBox="0 0 124 124" role="img" aria-label="${pct(p)} of the world">
      <circle cx="62" cy="62" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
      <circle class="arc" cx="62" cy="62" r="${r}" fill="none" stroke="var(--pc)" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${c * p} ${c}" transform="rotate(-90 62 62)"/>
      <text x="62" y="70" text-anchor="middle" font-size="24" font-weight="800">${pct(p)}</text></svg>`;
  }

  function renderStats() {
    const s = currentStats;
    const ach = currentAchievements;
    const rules = `${state.settings.countTerritories ? "all countries and territories" : "UN members and observers"}, ${state.settings.continentModel} continents`;
    const name = (id) => (COUNTRY.get(id) ? COUNTRY.get(id).flag + " " + esc(COUNTRY.get(id).name) : id);
    $("#stats").innerHTML = `
      <div class="hero">
        ${ring(s.pct)}
        <div>
          <div class="big">${s.visited}<small style="font-size:1.1rem;font-weight:600;letter-spacing:-0.01em;color:var(--muted)"> / ${s.total}</small></div>
          <p>countries visited</p>
          <p>${pct(s.areaPct)} of the world's land area</p>
        </div>
      </div>
      <p class="note">Counting ${rules}. Change this in Profile → Counting rules.</p>
      <div class="cards">
        <div class="card"><b>${s.byContinent.filter((c) => c.visited).length}</b><span>continents</span></div>
        <div class="card"><b>${s.regions.US.visited} / ${s.regions.US.total}</b><span>US states</span></div>
        <div class="card"><b>${s.lived}</b><span>lived in</span></div>
        <div class="card"><b>${s.wishlist}</b><span>on wishlist</span></div>
        <div class="card"><b>${s.firstTrip ? esc(fmtDate(s.firstTrip.date)) : "–"}</b><span>first trip${s.firstTrip ? " · " + name(s.firstTrip.country) : ""}</span></div>
        <div class="card"><b>${s.lastTrip ? esc(fmtDate(s.lastTrip.date)) : "–"}</b><span>latest trip${s.lastTrip ? " · " + name(s.lastTrip.country) : ""}</span></div>
        ${s.mostVisited ? `<div class="card" style="grid-column:1/-1"><b>${name(s.mostVisited.country)}</b><span>most visited · ${s.mostVisited.count} trips</span></div>` : ""}
      </div>
      <div class="section" style="margin-top:1rem"><button class="btn primary block" data-share>Share my map</button></div>

      <h3>Continents</h3>
      <div class="bars">${s.byContinent
        .map((c) => `<div class="bar-row"><span>${c.name}</span><div class="track"><div class="fill" style="width:${(c.visited / c.total) * 100}%"></div></div><em>${c.visited} / ${c.total}</em></div>`)
        .join("")}</div>

      <div class="h3-row"><h3>Timeline</h3><button class="btn small" data-play style="margin-top:1.2rem">▶ Play</button></div>
      ${
        s.perYear.length
          ? s.perYear
              .map(
                (y) => `<div class="year"><div class="year-h"><span>${y.year}</span><span class="note">${y.countries.length} new</span></div>
                <div class="chips">${y.countries.map((id) => `<button class="chip" data-country="${id}">${name(id)}</button>`).join("")}</div></div>`,
              )
              .join("")
          : `<p class="note">Add dates to your visits (tap a country → Add a visit) to build your timeline.</p>`
      }

      <h3>Achievements</h3>
      <div class="badges">${ach
        .map((a) => `<div class="badge ${a.done ? "" : "locked"}"><i>${a.icon}</i><div>${esc(a.title)}<small>${a.done ? "Unlocked" : a.progress}</small></div></div>`)
        .join("")}</div>`;
    $("[data-share]").addEventListener("click", openShare);
    $("[data-play]").addEventListener("click", playAnimation);
    $$("#stats [data-country]").forEach((b) => b.addEventListener("click", () => openSheet("country", b.dataset.country)));
  }

  // ---- Share image ------------------------------------------------------------------
  const IMG_THEMES = {
    light: { bg: "#f2f2f7", card: "#ffffff", text: "#000000", muted: "#8a8a8e", ocean: "#dfe8f1", land: "#d1d5db", unvisited: "#d1d5db", border: "#f7f8fa", track: "#e5e5ea" },
    dark: { bg: "#000000", card: "#1c1c1e", text: "#ffffff", muted: "#98989f", ocean: "#0c1420", land: "#3a3a3c", unvisited: "#3a3a3c", border: "#0c1420", track: "#2c2c2e" },
  };

  function renderShareImage({ template, format, look }) {
    const W = 1080;
    const H = format === "story" ? 1920 : 1350;
    const t = IMG_THEMES[look];
    const pc = profile().color;
    const s = currentStats;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    const font = (w, px) => `${w} ${px}px system-ui, -apple-system, Roboto, sans-serif`;
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, H);

    let year = null;
    if (template === "year") year = s.perYear[0] || null;
    const yearSet = new Set(year ? year.countries : []);
    const style = (id) => {
      const st = s.status.get(id);
      if (template === "year") return yearSet.has(id) ? { fill: pc } : Core.counts(st) ? { fill: mix(pc, t.unvisited, 0.7) } : { fill: t.unvisited };
      if (!st) return { fill: t.unvisited };
      if (st === "wishlist") return { hatch: pc };
      return { fill: st === "lived" ? mix(pc, "#000000", 0.3) : pc };
    };
    const mapTheme = { ...t, ocean: t.ocean };

    // Header
    ctx.fillStyle = t.text;
    ctx.font = font(800, 64);
    const title = template === "year" ? (year ? `${year.year} in travel` : "My year in travel") : "My travel map";
    ctx.fillText(title, 64, 130);
    ctx.fillStyle = t.muted;
    ctx.font = font(600, 34);
    ctx.fillText(
      template === "year" ? (year ? `${year.countries.length} new ${year.countries.length === 1 ? "country" : "countries"}` : "Add dates to your visits") : `${s.visited} countries · ${pct(s.pct)} of the world`,
      64,
      186,
    );

    const mapTop = 230;
    const mapH = template === "bars" ? 420 : format === "story" ? 760 : 620;
    drawStaticMap(ctx, [[40, mapTop], [W - 40, mapTop + mapH]], { region: "world", countries: COUNTRIES, style, theme: mapTheme });

    let y = mapTop + mapH + 50;
    const card = (x, yy, w, h) => {
      ctx.fillStyle = t.card;
      ctx.beginPath();
      ctx.roundRect(x, yy, w, h, 28);
      ctx.fill();
    };

    if (template === "stats") {
      const items = [
        [String(s.visited), "countries"],
        [pct(s.pct), "of the world"],
        [String(s.byContinent.filter((c) => c.visited).length), "continents"],
        [`${s.regions.US.visited}`, "US states"],
      ];
      const w = (W - 64 * 2 - 24) / 2;
      items.forEach(([big, small], i) => {
        const x = 64 + (i % 2) * (w + 24);
        const yy = y + Math.floor(i / 2) * 170;
        card(x, yy, w, 146);
        ctx.fillStyle = pc;
        ctx.font = font(800, 60);
        ctx.fillText(big, x + 32, yy + 78);
        ctx.fillStyle = t.muted;
        ctx.font = font(600, 28);
        ctx.fillText(small, x + 32, yy + 118);
      });
    }
    if (template === "bars" || (template === "stats" && format === "story")) {
      if (template === "stats") y += 360;
      const rows = s.byContinent;
      for (const c of rows) {
        ctx.fillStyle = t.text;
        ctx.font = font(600, 32);
        ctx.fillText(c.name, 64, y + 28);
        ctx.fillStyle = t.muted;
        ctx.textAlign = "right";
        ctx.fillText(`${c.visited} / ${c.total}`, W - 64, y + 28);
        ctx.textAlign = "left";
        ctx.fillStyle = t.track;
        ctx.beginPath();
        ctx.roundRect(64, y + 46, W - 128, 18, 9);
        ctx.fill();
        if (c.visited) {
          ctx.fillStyle = pc;
          ctx.beginPath();
          ctx.roundRect(64, y + 46, Math.max(18, (W - 128) * (c.visited / c.total)), 18, 9);
          ctx.fill();
        }
        y += 100;
      }
    }
    if (template === "year" && year) {
      ctx.font = font(600, 34);
      let x = 64;
      for (const id of year.countries) {
        const c = COUNTRY.get(id);
        const label = `${c.flag} ${c.name}`;
        const w = ctx.measureText(label).width + 40;
        if (x + w > W - 64) {
          x = 64;
          y += 70;
        }
        if (y > H - 160) break;
        card(x, y, w, 56);
        ctx.fillStyle = t.text;
        ctx.fillText(label, x + 20, y + 40);
        x += w + 14;
      }
    }

    // Watermark
    ctx.fillStyle = t.muted;
    ctx.font = font(700, 30);
    ctx.textAlign = "right";
    ctx.fillText("Wandermap", W - 64, H - 56);
    ctx.textAlign = "left";
    ctx.fillStyle = pc;
    ctx.beginPath();
    ctx.arc(W - 64 - ctx.measureText("Wandermap").width - 26, H - 66, 11, 0, Math.PI * 2);
    ctx.fill();
    return cv.toDataURL("image/png");
  }

  function openShare() {
    const opts = { template: "stats", format: "portrait", look: document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") };
    const seg = (key, items) =>
      `<div class="seg" data-opt="${key}">${items.map(([v, l]) => `<button data-v="${v}" class="${opts[key] === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    openScreen({
      html: `<div class="screen-h"><button class="icon-btn" data-close>Cancel</button><h2>Share image</h2><span class="icon-btn" aria-hidden="true"></span></div>
        <div class="screen-body">
          <div class="share-preview"><img id="share-img" alt="Preview of the share image"></div>
          <div class="share-opts">
            ${seg("template", [["map", "Map"], ["stats", "Map + stats"], ["bars", "Continents"], ["year", "Year"]])}
            ${seg("format", [["portrait", "Post 4:5"], ["story", "Story 9:16"]])}
            ${seg("look", [["light", "Light"], ["dark", "Dark"]])}
          </div>
        </div>
        <div class="footer"><button class="btn primary" id="share-go">Share</button><button class="btn" id="share-save">Save</button></div>`,
      mount(root) {
        const draw = () => ($("#share-img", root).src = renderShareImage(opts));
        $$("[data-opt]", root).forEach((g) =>
          $$("button", g).forEach((b) =>
            b.addEventListener("click", () => {
              opts[g.dataset.opt] = b.dataset.v;
              $$("button", g).forEach((x) => x.classList.toggle("on", x === b));
              draw();
            }),
          ),
        );
        draw();
        $("#share-go", root).addEventListener("click", () => shareImage($("#share-img", root).src, false));
        $("#share-save", root).addEventListener("click", () => shareImage($("#share-img", root).src, true));
      },
    });
  }

  async function shareImage(dataUrl, saveOnly) {
    const name = `wandermap-${today()}.png`;
    const b64 = dataUrl.split(",")[1];
    if (Native) {
      if (saveOnly) Native.saveImage(b64, name);
      else Native.shareImage(b64, name, "My travel map");
      return;
    }
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], name, { type: "image/png" });
    if (!saveOnly && navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file], title: "My travel map" }).catch(() => {});
    } else {
      downloadBlob(blob, name);
    }
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---- Share codes and comparison -------------------------------------------------------
  function mySets() {
    const visited = new Set();
    const wishlist = new Set();
    for (const [id, st] of currentStats.status) {
      if (Core.counts(st)) visited.add(id);
      else if (st === "wishlist") wishlist.add(id);
    }
    const regions = new Set([...Core.statusMap(state.visits, state.active, "region")].filter(([, s]) => Core.counts(s)).map(([id]) => id));
    return { visited, wishlist, regions, name: profile().name };
  }

  function myCode() {
    return Core.encodeShare(DATA, mySets());
  }

  const linkFor = (code) => `wandermap://c/${code}`;

  function addFriend(code, fallbackName) {
    let decoded;
    try {
      decoded = Core.decodeShare(DATA, code);
    } catch (e) {
      toast(e.message);
      return null;
    }
    const clean = code.trim().replace(/^.*\/c\//, "").replace(/^.*[#?&]c=/, "");
    const name = decoded.name || fallbackName || "Friend";
    let f = state.friends.find((x) => x.name === name);
    if (f) {
      f.code = clean;
      f.updated = today();
    } else {
      f = { id: uid(), name, code: clean, updated: today() };
      state.friends.push(f);
    }
    save();
    return f;
  }

  function openCompare(friend) {
    const theirs = Core.decodeShare(DATA, friend.code);
    const mine = mySets();
    const cmp = Core.compare(mine, theirs);
    const pc = profile().color;
    const FRIEND = "#E69F00";
    const BOTH = "#7B61FF";
    const sets = { me: new Set(cmp.onlyMe), them: new Set(cmp.onlyThem), both: new Set(cmp.both) };
    const list = (ids) =>
      ids.length
        ? `<div class="chips section">${ids
            .map((id) => COUNTRY.get(id))
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => `<span class="chip">${c.flag} ${esc(c.name)}</span>`)
            .join("")}</div>`
        : `<p class="note">None</p>`;
    let compareMap = null;
    openScreen({
      html: `<div class="screen-h"><button class="icon-btn" data-close aria-label="Back">‹ Back</button><h2>You and ${esc(friend.name)}</h2>
          <button class="icon-btn" data-remove aria-label="Remove friend">🗑</button></div>
        <div class="screen-body">
          <div class="map-box"><canvas id="compare-canvas" aria-label="Comparison map"></canvas></div>
          <div class="legend"><span><i style="background:${pc}"></i>Only you (${cmp.onlyMe.length})</span>
            <span><i style="background:${FRIEND}"></i>Only ${esc(friend.name)} (${cmp.onlyThem.length})</span>
            <span><i style="background:${BOTH}"></i>Both (${cmp.both.length})</span></div>
          <div style="padding-bottom:2rem">
            <div class="cards" style="margin-top:0">
              <div class="card"><b>${mine.visited.size}</b><span>your countries</span></div>
              <div class="card"><b>${theirs.visited.size}</b><span>${esc(friend.name)}'s countries</span></div>
            </div>
            <h3>Both visited</h3>${list(cmp.both)}
            <h3>Only you</h3>${list(cmp.onlyMe)}
            <h3>Only ${esc(friend.name)}</h3>${list(cmp.onlyThem)}
            <h3>You could visit together</h3>
            <p class="note">On both your wishlists.</p>${list(cmp.together)}
            <p class="note" style="margin-top:1.2rem">Code imported ${esc(fmtDate(friend.updated))}. Ask ${esc(friend.name)} for a new code to refresh.</p>
          </div>
        </div>`,
      mount(root) {
        compareMap = new MapView($("#compare-canvas", root), {
          region: "world",
          countries: COUNTRIES,
          theme: () => theme,
          style: (id) => (sets.both.has(id) ? { fill: BOTH } : sets.me.has(id) ? { fill: pc } : sets.them.has(id) ? { fill: FRIEND } : { fill: theme.unvisited }),
        });
        $("[data-remove]", root).addEventListener("click", () => {
          if (!confirm(`Remove ${friend.name}?`)) return;
          state.friends = state.friends.filter((f) => f.id !== friend.id);
          save();
          closeScreen();
          refresh();
        });
      },
      unmount() {
        compareMap.resizeObserver.disconnect();
      },
    });
  }

  function qrImage(text) {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createDataURL(4, 2);
  }

  // ---- Profile tab --------------------------------------------------------------------
  function renderProfile() {
    const p = profile();
    const s = state.settings;
    const code = myCode();
    const unCount = COUNTRIES.filter((c) => c.un).length;
    const opt = (v, cur, label) => `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${label}</option>`;
    $("#profile").innerHTML = `
      <h3 style="margin-top:0.5rem">Profiles</h3>
      <div class="list">
        ${state.profiles
          .map((x) => {
            const n = Core.computeStats(DATA, state.visits, x.id, s).visited;
            return `<div class="list-row"><span class="swatch" style="background:${x.color}"></span>
              <div><b>${esc(x.name)}</b><small>${n} countries${x.id === p.id ? " · active" : ""}</small></div>
              ${x.id === p.id ? `<span style="color:var(--accent);font-weight:700">✓</span>` : `<button class="btn small" data-switch="${x.id}">Switch</button>`}</div>`;
          })
          .join("")}
        <div class="list-row"><button class="btn link" data-add-profile>Add profile</button></div>
      </div>

      <h3>This profile</h3>
      <div class="list">
        <div class="setting"><span>Name</span><input type="text" id="p-name" value="${esc(p.name)}" maxlength="30" style="max-width:60%"></div>
        <div class="setting" style="color:var(--text)"><span>Colour</span><div class="swatches">${PALETTE.map((c) => `<button data-color="${c}" class="${c === p.color ? "on" : ""}" style="background:${c}" aria-label="Colour ${c}"></button>`).join("")}</div></div>
        <div class="setting"><span>Home country</span><select id="home">${opt("", state.home || "", "Not set")}${COUNTRIES.map((c) => opt(c.id, state.home || "", c.flag + " " + esc(c.name))).join("")}</select></div>
        ${state.profiles.length > 1 ? `<div class="list-row"><button class="btn link danger" data-del-profile style="color:var(--danger)">Delete this profile…</button></div>` : ""}
      </div>

      <h3>Compare with friends</h3>
      <div class="list">
        <div class="list-row" style="display:block">
          <b>Your share code</b>
          <p class="note" style="margin:4px 0 8px">Only the countries and states you marked, plus your profile name. No account, no server.</p>
          <div class="qr"><img alt="QR code with your share link" src="${qrImage(linkFor(code))}"></div>
          <div class="code-box" id="my-code">${esc(code)}</div>
          <div class="btns" style="margin-top:0.75rem"><button class="btn primary" style="flex:1" data-share-code>Share code</button><button class="btn" style="flex:1" data-copy-code>Copy</button></div>
        </div>
        ${state.friends
          .map((f) => {
            let n = "?";
            try {
              n = Core.decodeShare(DATA, f.code).visited.size;
            } catch (e) {}
            return `<div class="list-row"><span class="swatch" style="background:#E69F00"></span><div><b>${esc(f.name)}</b><small>${n} countries</small></div><button class="btn small" data-compare="${f.id}">Compare</button></div>`;
          })
          .join("")}
        <div class="list-row"><div><input type="text" id="friend-code" placeholder="Paste a friend's code or link" aria-label="Friend's share code"></div><button class="btn small primary" data-add-friend>Add</button></div>
      </div>

      <h3>Counting rules</h3>
      <div class="list">
        <div class="setting"><div>Countries<small>UN members + 2 observers, or every territory too</small></div>
          <select id="s-terr">${opt("false", s.countTerritories, `UN (${unCount})`)}${opt("true", s.countTerritories, `With territories (${COUNTRIES.length})`)}</select></div>
        <div class="setting"><span>Continents</span><select id="s-cont">${opt(7, s.continentModel, "7")}${opt(6, s.continentModel, "6 (one America)")}</select></div>
        <div class="setting"><div>US regions<small>50 states + DC, or with territories</small></div>
          <select id="s-rterr">${opt("false", s.regionTerritories, "51")}${opt("true", s.regionTerritories, "56")}</select></div>
      </div>
      <p class="note">These change the denominator of every percentage. Visited and lived count; wishlist never does.</p>

      <h3>Map</h3>
      <div class="list">
        <div class="setting"><span>Colour countries by</span><select id="s-color">${opt("status", s.colorMode, "Status")}${opt("year", s.colorMode, "Year of first visit")}</select></div>
        <div class="setting"><span>Undated visits in timeline</span><select id="s-undated">${opt("first", s.undated, "Show from the start")}${opt("hide", s.undated, "Leave out")}</select></div>
        <div class="setting"><span>Theme</span><select id="s-theme">${opt("auto", s.theme, "System")}${opt("light", s.theme, "Light")}${opt("dark", s.theme, "Dark")}</select></div>
      </div>

      <h3>Backup</h3>
      <div class="list">
        <div class="list-row"><button class="btn link" data-export="json">Export backup (JSON)</button></div>
        <div class="list-row"><button class="btn link" data-export="csv">Export visits (CSV)</button></div>
        <div class="list-row"><button class="btn link" data-import>Restore from backup…</button></div>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <p class="note">Your data lives only on this phone. Android also backs it up to your Google account if device backup is on.</p>

      <h3>About</h3>
      <p class="note">Wandermap works offline and collects no data. Map data: Natural Earth (public domain), US Census Bureau via us-atlas.
      Country data: mledoze/countries (ODbL). Includes d3-geo, topojson-client (ISC) and qrcode-generator (MIT).</p>
      <div class="list" style="margin-top:0.75rem"><div class="list-row"><button class="btn link" data-onboard>Run first-time setup again</button></div></div>`;

    const root = $("#profile");
    $$("[data-switch]", root).forEach((b) =>
      b.addEventListener("click", () => {
        state.active = b.dataset.switch;
        changed();
        toast("Switched to " + profile().name);
      }),
    );
    $("[data-add-profile]", root).addEventListener("click", () => {
      const name = prompt("Profile name", "Profile " + (state.profiles.length + 1));
      if (!name) return;
      const color = PALETTE[state.profiles.length % PALETTE.length];
      state.profiles.push({ id: uid(), name: name.slice(0, 30), color, created: today() });
      state.active = state.profiles[state.profiles.length - 1].id;
      changed();
    });
    $("[data-del-profile]", root)?.addEventListener("click", () => {
      if (!confirm(`Delete ${p.name} and all its visits?`)) return;
      state.visits = state.visits.filter((v) => v.profile !== p.id);
      state.profiles = state.profiles.filter((x) => x.id !== p.id);
      state.active = state.profiles[0].id;
      changed();
    });
    $("#p-name", root).addEventListener("change", (e) => {
      p.name = e.target.value.trim() || "Me";
      changed();
    });
    $$("[data-color]", root).forEach((b) =>
      b.addEventListener("click", () => {
        p.color = b.dataset.color;
        changed();
      }),
    );
    $("#home", root).addEventListener("change", (e) => {
      state.home = e.target.value || null;
      changed();
    });
    $("[data-share-code]", root).addEventListener("click", () => {
      const text = `Compare travel maps with me in Wandermap!\n\nOpen this link on your phone: ${linkFor(code)}\n\nOr paste this code in Profile → Compare with friends:\n${code}`;
      if (Native) Native.shareText(text);
      else if (navigator.share) navigator.share({ text }).catch(() => {});
      else copy(code);
    });
    $("[data-copy-code]", root).addEventListener("click", () => copy(code));
    $("[data-add-friend]", root).addEventListener("click", () => {
      const v = $("#friend-code", root).value.trim();
      if (!v) return;
      const f = addFriend(v);
      if (f) {
        renderProfile();
        openCompare(f);
      }
    });
    $$("[data-compare]", root).forEach((b) => b.addEventListener("click", () => openCompare(state.friends.find((f) => f.id === b.dataset.compare))));

    const rule = (sel, key, parse) =>
      $(sel, root).addEventListener("change", (e) => {
        const before = currentStats.total;
        const beforeUS = currentStats.regions.US.total;
        s[key] = parse(e.target.value);
        changed();
        if (currentStats.total !== before) toast(`Now counting out of ${currentStats.total} countries (was ${before}).`, 4000);
        if (currentStats.regions.US.total !== beforeUS) toast(`Now counting out of ${currentStats.regions.US.total} US regions (was ${beforeUS}).`, 4000);
      });
    rule("#s-terr", "countTerritories", (v) => v === "true");
    rule("#s-cont", "continentModel", (v) => +v);
    rule("#s-rterr", "regionTerritories", (v) => v === "true");
    rule("#s-color", "colorMode", (v) => v);
    rule("#s-undated", "undated", (v) => v);
    rule("#s-theme", "theme", (v) => v);

    $$("[data-export]", root).forEach((b) => b.addEventListener("click", () => exportData(b.dataset.export)));
    $("[data-import]", root).addEventListener("click", () => $("#import-file", root).click());
    $("#import-file", root).addEventListener("change", (e) => importData(e.target.files[0]));
    $("[data-onboard]", root).addEventListener("click", openOnboarding);
  }

  function copy(text) {
    if (Native) {
      Native.copyText(text);
      toast("Copied");
      return;
    }
    navigator.clipboard?.writeText(text).then(() => toast("Copied"), () => toast("Could not copy"));
  }

  function exportData(kind) {
    let name;
    let mime;
    let text;
    if (kind === "json") {
      name = `wandermap-backup-${today()}.json`;
      mime = "application/json";
      text = JSON.stringify({ app: "wandermap", exported: new Date().toISOString(), ...state }, null, 2);
    } else {
      name = `wandermap-visits-${today()}.csv`;
      mime = "text/csv";
      const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const rows = [["profile", "type", "code", "name", "status", "first_date", "last_date", "note"]];
      for (const v of state.visits) {
        const pr = state.profiles.find((p) => p.id === v.profile);
        rows.push([pr?.name, v.type, v.place, placeName(v.type, v.place), v.status, v.first, v.last, v.note]);
      }
      text = rows.map((r) => r.map(q).join(",")).join("\n");
    }
    if (Native) Native.shareFile(name, mime, text);
    else downloadBlob(new Blob([text], { type: mime }), name);
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.app !== "wandermap" || !Array.isArray(data.visits) || !Array.isArray(data.profiles)) throw new Error("Not a Wandermap backup");
        if (!confirm(`Replace current data with this backup (${data.visits.length} visits, ${data.profiles.length} profiles)?`)) return;
        const { app, exported, ...rest } = data;
        state = { ...DEFAULT_STATE, ...rest, settings: { ...DEFAULT_STATE.settings, ...rest.settings } };
        changed();
        toast("Backup restored");
      } catch (e) {
        toast("Import failed: " + e.message);
      }
    };
    reader.readAsText(file);
  }

  // ---- Onboarding --------------------------------------------------------------------
  function openOnboarding() {
    const picked = new Set([...currentStats.status].filter(([, s]) => Core.counts(s)).map(([id]) => id));
    let home = state.home;
    let step = home ? 2 : 1;
    let q = "";
    const model = state.settings.continentModel;
    const grid = (onlyOne) => {
      let html = "";
      for (const ct of Core.continentList(model)) {
        const list = COUNTRIES.filter((c) => Core.continentOf(c, model) === ct.id && (c.un || state.settings.countTerritories) && (!q || c.name.toLowerCase().includes(q)));
        if (!list.length) continue;
        html += `<div class="group-h">${ct.name}</div><div class="onboard-grid">${list
          .map((c) => `<button data-id="${c.id}" class="${(onlyOne ? home === c.id : picked.has(c.id)) ? "on" : ""}"><span>${c.flag}</span>${esc(c.name)}</button>`)
          .join("")}</div>`;
      }
      return html || `<div class="empty">No matches</div>`;
    };
    openScreen({
      html: `<div class="screen-h"><span style="flex:1"></span><button class="btn link" data-skip style="padding:0 0.75rem">Skip</button></div>
        <h1 class="large-title padded-x" id="ob-title" style="padding-top:0"></h1>
        <p class="onboard-intro" id="ob-intro"></p>
        <div style="padding:0 1rem 0.5rem"><input type="search" id="ob-search" placeholder="Search countries" aria-label="Search countries"></div>
        <div class="screen-body" id="ob-grid"></div>
        <div class="footer"><button class="btn primary" id="ob-next"></button></div>`,
      mount(root) {
        const draw = () => {
          $("#ob-title", root).textContent = step === 1 ? "Where is home?" : "Where have you been?";
          $("#ob-intro", root).textContent =
            step === 1 ? "Pick your home country. You can change it later in Profile." : `${picked.size} selected. Tap every country you have visited; add dates later.`;
          $("#ob-next", root).textContent = step === 1 ? (home ? "Next" : "Skip this step") : "Done";
          $("#ob-grid", root).innerHTML = grid(step === 1);
        };
        $("#ob-search", root).addEventListener("input", (e) => {
          q = e.target.value.trim().toLowerCase();
          draw();
        });
        $("#ob-grid", root).addEventListener("click", (e) => {
          const b = e.target.closest("[data-id]");
          if (!b) return;
          if (step === 1) home = home === b.dataset.id ? null : b.dataset.id;
          else if (picked.has(b.dataset.id)) picked.delete(b.dataset.id);
          else picked.add(b.dataset.id);
          draw();
        });
        const finish = () => {
          state.onboarded = true;
          if (home) state.home = home;
          for (const id of picked) if (!Core.counts(currentStats.status.get(id))) state.visits.push({ id: uid(), profile: state.active, type: "country", place: id, status: "visited", first: null, last: null, note: "" });
          closeScreen();
          changed();
        };
        $("#ob-next", root).addEventListener("click", () => {
          if (step === 1) {
            step = 2;
            q = "";
            $("#ob-search", root).value = "";
            if (home) picked.add(home);
            draw();
          } else finish();
        });
        $("[data-skip]", root).addEventListener("click", () => {
          state.onboarded = true;
          save();
          closeScreen();
        });
        draw();
      },
    });
  }

  // ---- Native bridge hooks -------------------------------------------------------------
  window.wandermap = {
    // Returns true when the back press was handled in the page.
    onBack() {
      if ($("#filter-bar") && !$("#filter-bar").hidden) {
        $("#filter-bar").hidden = true;
        return true;
      }
      if (ui.sheet) {
        if (ui.sheet.editing) {
          ui.sheet.editing = null;
          renderSheet();
        } else closeSheet();
        return true;
      }
      if (ui.screen) {
        closeScreen();
        return true;
      }
      if (ui.anim) {
        stopAnimation();
        return true;
      }
      if (ui.tab !== "map") {
        showTab("map");
        return true;
      }
      return false;
    },
    openLink(url) {
      const m = String(url).match(/\/c\/([A-Za-z0-9_-]+)/) || String(url).match(/[#?&]c=([A-Za-z0-9_-]+)/);
      if (!m) return;
      const f = addFriend(m[1]);
      if (f) {
        closeSheet();
        openCompare(f);
        toast(`Added ${f.name}`);
      }
    },
    toast,
  };

  // ---- Boot --------------------------------------------------------------------------------
  applyTheme();
  theme = cssTheme();
  currentAchievements = Core.evaluateAchievements(DATA, currentStats, state.visits, state.active, state.home);
  initMap();
  initPlaces();
  Motion.watchSegs(document.body);
  renderCounter();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
  if (!state.onboarded) openOnboarding();
  const hashCode = location.hash.match(/c=([A-Za-z0-9_-]+)/);
  if (hashCode) window.wandermap.openLink(location.hash);
  Native?.ready?.();
})();
