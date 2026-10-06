// Map and globe rendering on <canvas>: vector polygons from bundled TopoJSON, no tile server.
(function () {
  "use strict";

  const worldFeatures = topojson.feature(WORLD_TOPO, WORLD_TOPO.objects.countries).features;
  const globeFeatures = topojson.feature(GLOBE_TOPO, GLOBE_TOPO.objects.countries).features;
  const usFeatures = topojson.feature(US_TOPO, US_TOPO.objects.states).features;

  // Countries too small to tap as a polygon get a dot (also those with no polygon at all).
  const DOT_AREA_KM2 = 4000;
  function dotPlaces(countries) {
    return countries.filter((c) => (!c.geo || c.area < DOT_AREA_KM2) && c.lat != null && c.id !== "AQ");
  }

  function hatch(color, scale) {
    const s = 8;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const x = c.getContext("2d");
    x.strokeStyle = color;
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(0, s);
    x.lineTo(s, 0);
    x.moveTo(-s / 2, s / 2);
    x.lineTo(s / 2, -s / 2);
    x.moveTo(s / 2, s * 1.5);
    x.lineTo(s * 1.5, s / 2);
    x.stroke();
    return { canvas: c, scale };
  }

  function applyStyle(ctx, style, k) {
    if (style.hatch) {
      const p = ctx.createPattern(hatch(style.hatch, 1).canvas, "repeat");
      if (p.setTransform && k !== 1) p.setTransform(new DOMMatrix().scale(1 / k));
      ctx.fillStyle = p;
    } else {
      ctx.fillStyle = style.fill;
    }
  }

  function sameStyle(a, b) {
    return a.fill === b.fill && a.hatch === b.hatch;
  }

  class MapView {
    // opts: { region: "world" | "US", style(id) -> {fill, hatch?}, onTap(id), onLongPress(id), theme() }
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.opts = opts;
      this.region = opts.region || "world";
      this.mode = "flat";
      this.k = 1;
      this.tx = 0;
      this.ty = 0;
      this.rotate = [-20, -30];
      this.globeScale = 1;
      this.velocity = null;
      this.pointers = new Map();
      this.dots = this.region === "world" ? dotPlaces(opts.countries) : [];
      this.hitCtx = document.createElement("canvas").getContext("2d");
      this.bindGestures();
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }

    features() {
      if (this.region === "US") return usFeatures;
      return this.mode === "globe" ? globeFeatures : worldFeatures;
    }

    setMode(mode) {
      this.mode = mode;
      this.velocity = null;
      this.render();
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      this.w = r.width;
      this.h = r.height;
      this.dpr = dpr;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.buildFlat();
      this.render();
    }

    // Flat maps are projected once into Path2D objects; pan/zoom is a canvas transform (cheap, smooth).
    buildFlat() {
      const pad = 8;
      this.flatProj = this.region === "US" ? d3.geoAlbersUsa() : d3.geoRobinson();
      const fc = { type: "FeatureCollection", features: this.region === "US" ? usFeatures.filter((f) => d3.geoAlbersUsa()(d3.geoCentroid(f))) : worldFeatures.filter((f) => f.id !== "AQ") };
      this.flatProj.fitExtent([[pad, pad], [this.w - pad, this.h - pad]], fc);
      const path = d3.geoPath(this.flatProj);
      this.flatPaths = (this.region === "US" ? usFeatures : worldFeatures).map((f) => {
        const d = path(f);
        return { id: f.id, path: d ? new Path2D(d) : null, bounds: d ? path.bounds(f) : null };
      });
      this.flatDots = this.dots.map((c) => ({ id: c.id, p: this.flatProj([c.lon, c.lat]) })).filter((d) => d.p);
      this.sphere = this.region === "world" ? new Path2D(path({ type: "Sphere" })) : null;
      this.content = path.bounds(this.region === "world" ? { type: "Sphere" } : fc);
      const first = !this.viewInit;
      this.viewInit = true;
      if (first) this.initialView(this.opts.center && this.opts.center());
      else this.clampFlat();
    }

    globeProjection() {
      const r = Math.min(this.w, this.h) / 2 - 12;
      return d3.geoOrthographic().rotate(this.rotate).scale(r * this.globeScale).translate([this.w / 2, this.h / 2]).clipAngle(90);
    }

    render() {
      if (!this.w) return;
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.draw());
    }

    draw() {
      const { ctx, dpr } = this;
      const theme = this.opts.theme();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      if (this.mode === "globe" && this.region === "world") this.drawGlobe(theme);
      else this.drawFlat(theme);
    }

    drawFlat(theme) {
      const { ctx, k } = this;
      ctx.save();
      ctx.translate(this.tx, this.ty);
      ctx.scale(k, k);
      if (this.sphere) {
        ctx.fillStyle = theme.ocean;
        ctx.fill(this.sphere);
      }
      ctx.lineWidth = 0.6 / k;
      ctx.strokeStyle = theme.border;
      for (const f of this.flatPaths) {
        if (!f.path) continue;
        applyStyle(ctx, f.id ? this.opts.style(f.id) : { fill: theme.land }, k);
        ctx.fill(f.path);
        ctx.stroke(f.path);
      }
      ctx.restore();
      this.drawDots(this.flatDots.map((d) => ({ id: d.id, x: d.p[0] * k + this.tx, y: d.p[1] * k + this.ty })), theme);
    }

    drawGlobe(theme) {
      const { ctx } = this;
      const proj = this.globeProjection();
      const path = d3.geoPath(proj, ctx);
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.fillStyle = theme.ocean;
      ctx.fill();
      ctx.beginPath();
      path(d3.geoGraticule10());
      ctx.strokeStyle = theme.graticule;
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = theme.border;
      // Batch by style so the globe stays smooth while rotating.
      const groups = [];
      for (const f of globeFeatures) {
        const st = f.id ? this.opts.style(f.id) : { fill: theme.land };
        let g = groups.find((x) => sameStyle(x.style, st));
        if (!g) groups.push((g = { style: st, list: [] }));
        g.list.push(f);
      }
      for (const g of groups) {
        ctx.beginPath();
        for (const f of g.list) path(f);
        applyStyle(ctx, g.style, 1);
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.strokeStyle = theme.border;
      ctx.stroke();
      const center = [-this.rotate[0], -this.rotate[1]];
      // 110m geometry drops some small countries; show every one of them as a dot on the globe.
      const globeIds = new Set(globeFeatures.map((f) => f.id));
      const dots = this.opts.countries
        .filter((c) => c.lat != null && c.id !== "AQ" && (!globeIds.has(c.id) || c.area < DOT_AREA_KM2))
        .filter((c) => d3.geoDistance([c.lon, c.lat], center) < Math.PI / 2 - 0.05)
        .map((c) => {
          const p = proj([c.lon, c.lat]);
          return { id: c.id, x: p[0], y: p[1] };
        });
      this.drawDots(dots, theme);
    }

    drawDots(dots, theme) {
      const { ctx } = this;
      this.screenDots = dots;
      for (const d of dots) {
        const st = this.opts.style(d.id);
        const plain = st.fill === theme.unvisited;
        ctx.beginPath();
        ctx.arc(d.x, d.y, plain ? 2.5 : 4.5, 0, Math.PI * 2);
        applyStyle(ctx, plain ? { fill: theme.dot } : st, 1);
        ctx.globalAlpha = plain ? 0.7 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = theme.dotStroke;
        ctx.stroke();
      }
    }

    // ---- Hit testing --------------------------------------------------------
    hit(x, y) {
      let best = null;
      let bestD = 16;
      for (const d of this.screenDots || []) {
        const dist = Math.hypot(d.x - x, d.y - y);
        if (dist < bestD) {
          bestD = dist;
          best = d.id;
        }
      }
      if (best) return best;
      if (this.mode === "globe" && this.region === "world") {
        const ll = this.globeProjection().invert([x, y]);
        if (!ll || d3.geoDistance(ll, [-this.rotate[0], -this.rotate[1]]) > Math.PI / 2) return null;
        const f = worldFeatures.find((f) => f.id && f.id !== "AQ" && d3.geoContains(f, ll)) || globeFeatures.find((f) => f.id && d3.geoContains(f, ll));
        return f ? f.id : null;
      }
      const bx = (x - this.tx) / this.k;
      const by = (y - this.ty) / this.k;
      for (const f of this.flatPaths) {
        if (!f.path || !f.id) continue;
        const [[x0, y0], [x1, y1]] = f.bounds;
        if (bx < x0 || bx > x1 || by < y0 || by > y1) continue;
        if (this.hitCtx.isPointInPath(f.path, bx, by)) return f.id;
      }
      return null;
    }

    // ---- Gestures -----------------------------------------------------------
    // Keep the map on screen: centre an axis that fits, otherwise don't pan past its edges.
    clampFlat() {
      this.k = Math.max(1, Math.min(this.k, 40));
      const [[x0, y0], [x1, y1]] = this.content;
      const fit = (t, a0, a1, size) => {
        const lo = a0 * this.k + t;
        const hi = a1 * this.k + t;
        if (hi - lo <= size) return (size - (a1 - a0) * this.k) / 2 - a0 * this.k;
        if (lo > 0) return t - lo;
        if (hi < size) return t + (size - hi);
        return t;
      };
      this.tx = fit(this.tx, x0, x1, this.w);
      this.ty = fit(this.ty, y0, y1, this.h);
    }

    // Portrait phones: open zoomed in so the map fills most of the height, centred on a place.
    initialView(lonlat) {
      const [[x0, y0], [x1, y1]] = this.content;
      const k = this.opts.fillHeight ? Math.max(1, Math.min(4, (this.h * 0.72) / (y1 - y0))) : 1;
      const p = (lonlat && this.flatProj(lonlat)) || [(x0 + x1) / 2, (y0 + y1) / 2];
      this.k = k;
      this.tx = this.w / 2 - p[0] * k;
      this.ty = this.h / 2 - ((y0 + y1) / 2) * k;
      this.clampFlat();
    }

    zoomAt(factor, x, y) {
      if (this.mode === "globe" && this.region === "world") {
        this.globeScale = Math.max(0.6, Math.min(this.globeScale * factor, 12));
      } else {
        const k = Math.max(1, Math.min(this.k * factor, 40));
        this.tx = x - ((x - this.tx) * k) / this.k;
        this.ty = y - ((y - this.ty) * k) / this.k;
        this.k = k;
        this.clampFlat();
      }
      this.render();
    }

    panBy(dx, dy) {
      if (this.mode === "globe" && this.region === "world") {
        const deg = 90 / (this.globeProjection().scale() || 1) * 1.2;
        this.rotate = [this.rotate[0] + dx * deg * 0.9, Math.max(-85, Math.min(85, this.rotate[1] - dy * deg * 0.9))];
      } else {
        this.tx += dx;
        this.ty += dy;
        this.clampFlat();
      }
      this.render();
    }

    flyTo(id) {
      const c = this.opts.countries.find((x) => x.id === id);
      const f = worldFeatures.find((x) => x.id === id);
      const target = f ? d3.geoCentroid(f) : c ? [c.lon, c.lat] : null;
      if (!target) return;
      const from = this.rotate.slice();
      const fromS = this.globeScale;
      const to = [-target[0], -target[1]];
      if (to[0] - from[0] > 180) from[0] += 360;
      if (from[0] - to[0] > 180) from[0] -= 360;
      const toS = Math.max(2.5, fromS);
      const t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / 600);
        const e = t * (2 - t);
        this.rotate = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
        this.globeScale = fromS + (toS - fromS) * e;
        this.draw();
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    bindGestures() {
      const el = this.canvas;
      let start = null;
      let moved = false;
      let lastTap = 0;
      let tapTimer = null;
      let pressTimer = null;
      let pinch = null;
      let last = null;

      const local = (e) => {
        const r = el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };

      el.addEventListener("pointerdown", (e) => {
        el.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, local(e));
        this.velocity = null;
        if (this.pointers.size === 1) {
          start = { p: local(e), t: performance.now() };
          last = { p: local(e), t: performance.now() };
          moved = false;
          clearTimeout(pressTimer);
          pressTimer = setTimeout(() => {
            if (!moved && this.pointers.size === 1) {
              const id = this.hit(...start.p);
              if (id && this.opts.onLongPress) {
                moved = true; // swallow the tap
                navigator.vibrate?.(15);
                this.opts.onLongPress(id);
              }
            }
          }, 500);
        } else if (this.pointers.size === 2) {
          clearTimeout(pressTimer);
          moved = true;
          const [a, b] = [...this.pointers.values()];
          pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
        }
      });

      el.addEventListener("pointermove", (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        const p = local(e);
        const prev = this.pointers.get(e.pointerId);
        this.pointers.set(e.pointerId, p);
        if (this.pointers.size === 2 && pinch) {
          const [a, b] = [...this.pointers.values()];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (pinch.d > 0) this.zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          pinch.d = d;
          return;
        }
        if (this.pointers.size !== 1) return;
        if (!moved && Math.hypot(p[0] - start.p[0], p[1] - start.p[1]) > 8) {
          moved = true;
          clearTimeout(pressTimer);
        }
        if (moved) {
          this.panBy(p[0] - prev[0], p[1] - prev[1]);
          const now = performance.now();
          const dt = Math.max(1, now - last.t);
          this.velocity = [(p[0] - last.p[0]) / dt, (p[1] - last.p[1]) / dt];
          last = { p, t: now };
        }
      });

      const end = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        clearTimeout(pressTimer);
        if (this.pointers.size < 2) pinch = null;
        if (this.pointers.size > 0) return;
        if (!moved && start && e.type === "pointerup") {
          const p = start.p;
          const now = performance.now();
          const isGlobe = this.mode === "globe" && this.region === "world";
          if (isGlobe && now - lastTap < 300) {
            clearTimeout(tapTimer);
            lastTap = 0;
            const id = this.hit(...p);
            if (id) this.flyTo(id);
            return;
          }
          lastTap = now;
          const fire = () => {
            const id = this.hit(...p);
            if (id && this.opts.onTap) this.opts.onTap(id);
          };
          if (isGlobe) tapTimer = setTimeout(fire, 280);
          else fire();
        } else if (moved && this.velocity && this.mode === "globe" && performance.now() - last.t < 80) {
          this.inertia();
        }
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);

      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        const [x, y] = local(e);
        this.zoomAt(Math.exp(-e.deltaY * 0.002), x, y);
      }, { passive: false });
    }

    inertia() {
      let v = this.velocity.map((x) => x * 16);
      const step = () => {
        if (!this.velocity) return;
        this.panBy(v[0], v[1]);
        v = v.map((x) => x * 0.93);
        if (Math.hypot(v[0], v[1]) > 0.3) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    resetView() {
      this.initialView(this.opts.center && this.opts.center());
      this.globeScale = 1;
      this.render();
    }
  }

  // Draws a whole map into an arbitrary context/rectangle (used for share images).
  function drawStaticMap(ctx, rect, { region = "world", countries, style, theme }) {
    const [[x0, y0], [x1, y1]] = rect;
    const proj = region === "US" ? d3.geoAlbersUsa() : d3.geoRobinson();
    const feats = region === "US" ? usFeatures : worldFeatures;
    proj.fitExtent(rect, { type: "FeatureCollection", features: region === "US" ? feats.filter((f) => d3.geoAlbersUsa()(d3.geoCentroid(f))) : feats.filter((f) => f.id !== "AQ") });
    const path = d3.geoPath(proj, ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    if (region === "world") {
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.fillStyle = theme.ocean;
      ctx.fill();
    }
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = theme.border;
    for (const f of feats) {
      ctx.beginPath();
      path(f);
      applyStyle(ctx, f.id ? style(f.id) : { fill: theme.land }, 1);
      ctx.fill();
      ctx.stroke();
    }
    if (region === "world") {
      for (const c of dotPlaces(countries)) {
        const p = proj([c.lon, c.lat]);
        if (!p) continue;
        const st = style(c.id);
        if (st.fill === theme.unvisited) continue;
        ctx.beginPath();
        ctx.arc(p[0], p[1], 7, 0, Math.PI * 2);
        applyStyle(ctx, st, 1);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  window.MapView = MapView;
  window.drawStaticMap = drawStaticMap;
})();
