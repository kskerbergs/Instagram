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
      this.stopMotion();
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
      if (this.pressed) {
        for (const f of this.flatPaths) {
          if (f.id !== this.pressed || !f.path) continue;
          ctx.globalAlpha = 0.22;
          ctx.fillStyle = theme.text;
          ctx.fill(f.path);
          ctx.globalAlpha = 1;
        }
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
      if (this.pressed) {
        ctx.beginPath();
        for (const f of globeFeatures) if (f.id === this.pressed) path(f);
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = theme.text;
        ctx.fill();
        ctx.globalAlpha = 1;
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
        ctx.lineWidth = d.id === this.pressed ? 3 : 1;
        ctx.strokeStyle = d.id === this.pressed ? theme.text : theme.dotStroke;
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
    // Where tx/ty must be for the map to stay on screen: centre an axis that fits, else no gap at the edges.
    bounds(tx, ty, k = this.k) {
      const [[x0, y0], [x1, y1]] = this.content;
      const fit = (t, a0, a1, size) => {
        const lo = a0 * k + t;
        const hi = a1 * k + t;
        if (hi - lo <= size) return (size - (a1 - a0) * k) / 2 - a0 * k;
        if (lo > 0) return t - lo;
        if (hi < size) return t + (size - hi);
        return t;
      };
      return [fit(tx, x0, x1, this.w), fit(ty, y0, y1, this.h)];
    }

    clampFlat() {
      this.k = Math.max(1, Math.min(this.k, 40));
      [this.tx, this.ty] = this.bounds(this.tx, this.ty);
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

    isGlobe() {
      return this.mode === "globe" && this.region === "world";
    }

    stopMotion() {
      for (const a of this.anims || []) a.stop();
      this.anims = [];
      this.inertiaOn = false;
    }

    zoomAt(factor, x, y) {
      if (this.isGlobe()) {
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

    // Raw pan: the globe rotates 1:1; the flat map follows the finger and rubber-bands past its edges.
    panBy(dx, dy) {
      if (this.isGlobe()) {
        const deg = (90 / (this.globeProjection().scale() || 1)) * 1.08;
        this.rotate = [this.rotate[0] + dx * deg, Math.max(-85, Math.min(85, this.rotate[1] - dy * deg))];
      } else {
        this.raw[0] += dx;
        this.raw[1] += dy;
        const [cx, cy] = this.bounds(this.raw[0], this.raw[1]);
        this.tx = cx + Motion.rubberband(this.raw[0] - cx, this.w);
        this.ty = cy + Motion.rubberband(this.raw[1] - cy, this.h);
      }
      this.render();
    }

    // Flat-map release: project where the flick is heading, then spring there carrying the finger's
    // velocity. X and Y are independent springs. A flick into an edge lands with a little bounce.
    settleFlat(vx, vy) {
      const [px, py] = this.bounds(this.tx + Motion.project(vx), this.ty + Motion.project(vy));
      const hitEdge = Math.abs(px - (this.tx + Motion.project(vx))) > 1 || Math.abs(py - (this.ty + Motion.project(vy))) > 1;
      const opts = (v) => ({ velocity: v, damping: hitEdge ? 0.85 : 1, response: hitEdge ? 0.45 : 0.7 });
      this.anims = [
        Motion.spring({ from: this.tx, to: px, ...opts(vx), onUpdate: (x) => ((this.tx = x), this.draw()) }),
        Motion.spring({ from: this.ty, to: py, ...opts(vy), onUpdate: (y) => ((this.ty = y), this.draw()) }),
      ];
    }

    // Globe release: keep spinning at the finger's speed and decelerate like a scroll view.
    inertia(vx, vy) {
      this.inertiaOn = true;
      let v = [vx, vy];
      let last = performance.now();
      const step = (now) => {
        if (!this.inertiaOn) return;
        const dt = now - last;
        last = now;
        this.panBy((v[0] * dt) / 1000, (v[1] * dt) / 1000);
        const decay = Math.pow(0.998, dt);
        v = v.map((x) => x * decay);
        if (Math.hypot(v[0], v[1]) > 8) requestAnimationFrame(step);
        else this.inertiaOn = false;
      };
      requestAnimationFrame(step);
    }

    // Entering 3D: the globe settles into place with a short turn instead of popping in.
    spinIn() {
      this.stopMotion();
      const r0 = this.rotate[0];
      this.anims = [
        Motion.spring({ from: 0.86, to: this.globeScale || 1, damping: 1, response: 0.5, onUpdate: (v) => ((this.globeScale = v), this.draw()) }),
        Motion.spring({ from: r0 + 30, to: r0, damping: 1, response: 0.6, onUpdate: (v) => ((this.rotate = [v, this.rotate[1]]), this.draw()) }),
      ];
    }

    flyTo(id) {
      const c = this.opts.countries.find((x) => x.id === id);
      const f = worldFeatures.find((x) => x.id === id);
      const target = f ? d3.geoCentroid(f) : c ? [c.lon, c.lat] : null;
      if (!target) return;
      this.stopMotion();
      const to = [-target[0], -target[1]];
      if (to[0] - this.rotate[0] > 180) this.rotate[0] += 360;
      if (this.rotate[0] - to[0] > 180) this.rotate[0] -= 360;
      const spring = (from, toV, set) => Motion.spring({ from, to: toV, damping: 1, response: 0.5, onUpdate: (v) => (set(v), this.draw()) });
      this.anims = [
        spring(this.rotate[0], to[0], (v) => (this.rotate = [v, this.rotate[1]])),
        spring(this.rotate[1], to[1], (v) => (this.rotate = [this.rotate[0], v])),
        spring(this.globeScale, Math.max(2.5, this.globeScale), (v) => (this.globeScale = v)),
      ];
    }

    bindGestures() {
      const el = this.canvas;
      const vt = Motion.tracker();
      let start = null;
      let moved = false;
      let lastTap = 0;
      let tapTimer = null;
      let pressTimer = null;
      let pinch = null;
      this.raw = [0, 0];

      const local = (e) => {
        const r = el.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      const setPressed = (id) => {
        if (this.pressed === id) return;
        this.pressed = id;
        this.draw();
      };

      el.addEventListener("pointerdown", (e) => {
        el.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, local(e));
        this.stopMotion(); // grab the map mid-flight
        if (this.pointers.size === 1) {
          start = { p: local(e), t: performance.now() };
          this.raw = [this.tx, this.ty];
          vt.reset();
          vt.add(...start.p);
          moved = false;
          // Feedback on touch-down: highlight what's under the finger right away.
          setPressed(this.hit(...start.p));
          clearTimeout(pressTimer);
          pressTimer = setTimeout(() => {
            if (!moved && this.pointers.size === 1) {
              const id = this.hit(...start.p);
              if (id && this.opts.onLongPress) {
                moved = true; // swallow the tap
                setPressed(null);
                this.opts.onLongPress(id);
              }
            }
          }, 450);
        } else if (this.pointers.size === 2) {
          clearTimeout(pressTimer);
          moved = true;
          setPressed(null);
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
          this.raw = [this.tx, this.ty];
          return;
        }
        if (this.pointers.size !== 1) return;
        vt.add(...p);
        if (!moved && Math.hypot(p[0] - start.p[0], p[1] - start.p[1]) > 8) {
          moved = true;
          clearTimeout(pressTimer);
          setPressed(null);
        }
        if (moved) this.panBy(p[0] - prev[0], p[1] - prev[1]);
      });

      const end = (e) => {
        if (!this.pointers.has(e.pointerId)) return;
        this.pointers.delete(e.pointerId);
        clearTimeout(pressTimer);
        if (this.pointers.size < 2) pinch = null;
        if (this.pointers.size === 1) {
          // Pinch ended with one finger still down: keep panning from here, without a jump.
          this.raw = [this.tx, this.ty];
          vt.reset();
          return;
        }
        if (this.pointers.size > 0) return;
        if (!moved && start && e.type === "pointerup") {
          const p = start.p;
          const now = performance.now();
          if (this.isGlobe() && now - lastTap < 300) {
            clearTimeout(tapTimer);
            lastTap = 0;
            setPressed(null);
            const id = this.hit(...p);
            if (id) this.flyTo(id);
            return;
          }
          lastTap = now;
          const fire = () => {
            setPressed(null);
            const id = this.hit(...p);
            if (id && this.opts.onTap) this.opts.onTap(id);
          };
          // Only the globe has a double-tap, so only the globe pays the disambiguation delay.
          if (this.isGlobe()) tapTimer = setTimeout(fire, 260);
          else fire();
          return;
        }
        setPressed(null);
        const v = vt.velocity();
        if (this.isGlobe()) {
          if (Math.hypot(v.x, v.y) > 30) this.inertia(v.x, v.y);
        } else {
          this.settleFlat(v.x, v.y);
        }
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);

      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.stopMotion();
        const [x, y] = local(e);
        this.zoomAt(Math.exp(-e.deltaY * 0.002), x, y);
      }, { passive: false });
    }

    resetView() {
      this.stopMotion();
      const fromK = this.k;
      const fromT = [this.tx, this.ty];
      this.initialView(this.opts.center && this.opts.center());
      const to = { k: this.k, tx: this.tx, ty: this.ty };
      [this.k, this.tx, this.ty] = [fromK, fromT[0], fromT[1]];
      const go = (from, target, set) => Motion.spring({ from, to: target, damping: 1, response: 0.45, onUpdate: (v) => (set(v), this.draw()) });
      this.anims = [
        go(this.k, to.k, (v) => (this.k = v)),
        go(this.tx, to.tx, (v) => (this.tx = v)),
        go(this.ty, to.ty, (v) => (this.ty = v)),
        go(this.globeScale, 1, (v) => (this.globeScale = v)),
      ];
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
