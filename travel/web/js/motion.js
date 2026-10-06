// Fluid motion helpers: interruptible springs, momentum projection, rubber-banding,
// a draggable sheet with detents, and edge-swipe-to-close screens.
(function () {
  "use strict";

  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Spring described the way Apple does: damping ratio (1 = no overshoot) and response (seconds).
  // Animates from the current value with an initial velocity (units/s); stop() leaves the value where it is.
  function spring({ from, to, velocity = 0, damping = 1, response = 0.35, onUpdate, onDone }) {
    const k = Math.pow((2 * Math.PI) / response, 2);
    const c = (4 * Math.PI * damping) / response;
    let x = from;
    let v = velocity;
    let last = performance.now();
    let raf = 0;
    let stopped = false;
    const handle = {
      get value() {
        return x;
      },
      get velocity() {
        return v;
      },
      stop() {
        stopped = true;
        cancelAnimationFrame(raf);
      },
    };
    if (reduceMotion()) {
      x = to;
      onUpdate(x);
      onDone && onDone();
      return handle;
    }
    const step = (now) => {
      if (stopped) return;
      let dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      // Fixed sub-steps keep stiff springs stable.
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240);
        const a = -k * (x - to) - c * v;
        v += a * h;
        x += v * h;
        dt -= h;
      }
      if (Math.abs(x - to) < 0.3 && Math.abs(v) < 6) {
        x = to;
        v = 0;
        onUpdate(x);
        onDone && onDone();
        return;
      }
      onUpdate(x);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return handle;
  }

  // Where a flick would come to rest (Apple's scroll-deceleration projection). velocity in px/s.
  function project(velocity, rate = 0.998) {
    return ((velocity / 1000) * rate) / (1 - rate);
  }

  // Progressive resistance past a boundary.
  function rubberband(overshoot, dimension, constant = 0.55) {
    if (!dimension) return 0;
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  // Velocity from the last ~100 ms of pointer samples, in px/s.
  function tracker() {
    let samples = [];
    return {
      reset() {
        samples = [];
      },
      add(x, y) {
        const t = performance.now();
        samples.push({ x, y, t });
        while (samples.length > 2 && t - samples[0].t > 100) samples.shift();
      },
      velocity() {
        if (samples.length < 2) return { x: 0, y: 0 };
        const a = samples[0];
        const b = samples[samples.length - 1];
        const dt = (b.t - a.t) / 1000 || 1;
        if (performance.now() - b.t > 80) return { x: 0, y: 0 }; // finger stopped before lifting
        return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
      },
    };
  }

  function haptic(ms = 10) {
    try {
      navigator.vibrate?.(ms);
    } catch (e) {
      /* not supported */
    }
  }

  // ---- Bottom sheet with detents -------------------------------------------------
  // y is the sheet's offset from fully open (0). Detents: full, medium (if the content is tall), closed.
  function Sheet(el, backdrop, handleEl, { onClosed, onClosing, handle }) {
    let y = 0;
    let anim = null;
    let open = false;
    const vt = tracker();
    let drag = null;

    const height = () => el.offsetHeight;
    const closedY = () => height() + 24;
    const detents = () => {
      const h = height();
      const medium = h - window.innerHeight * 0.55;
      return medium > 80 ? [0, medium, closedY()] : [0, closedY()];
    };
    const set = (v) => {
      y = v;
      el.style.transform = `translate3d(0, ${v}px, 0)`;
      const p = Math.max(0, Math.min(1, 1 - v / closedY()));
      backdrop.style.opacity = String(p);
    };
    const settle = (target, velocity, momentum) => {
      anim?.stop();
      if (target >= closedY() - 1 && onClosing) onClosing();
      anim = spring({
        from: y,
        to: target,
        velocity,
        // Bounce only when a flick carried momentum into the release.
        damping: momentum ? 0.8 : 1,
        response: momentum ? 0.3 : 0.35,
        onUpdate: set,
        onDone: () => {
          anim = null;
          if (target >= closedY() - 1) finishClose();
        },
      });
    };
    const finishClose = () => {
      open = false;
      el.hidden = true;
      backdrop.hidden = true;
      onClosed && onClosed();
    };

    handleEl.addEventListener("pointerdown", (e) => {
      if (!open || e.target.closest("button, input, select, textarea, a")) return;
      if (handle && !e.target.closest(handle)) return;
      anim?.stop(); // grab it mid-flight; continue from where it is on screen
      anim = null;
      drag = { startY: e.clientY, startSheet: y, active: false, id: e.pointerId };
      vt.reset();
      vt.add(0, e.clientY);
    });
    handleEl.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.startY;
      if (!drag.active) {
        if (Math.abs(dy) < 8) return;
        drag.active = true;
        handleEl.setPointerCapture(e.pointerId);
      }
      vt.add(0, e.clientY);
      const raw = drag.startSheet + dy;
      set(raw < 0 ? rubberband(raw, height()) : raw);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasActive = drag.active;
      drag = null;
      if (!wasActive) return;
      const v = vt.velocity().y;
      const projected = y + project(v, 0.99);
      const target = detents().reduce((best, d) => (Math.abs(d - projected) < Math.abs(best - projected) ? d : best));
      settle(target, v, Math.abs(v) > 300);
    };
    handleEl.addEventListener("pointerup", end);
    handleEl.addEventListener("pointercancel", end);

    const api = {
      get isOpen() {
        return open;
      },
      open() {
        const wasOpen = open;
        open = true;
        el.hidden = false;
        backdrop.hidden = false;
        backdrop.style.pointerEvents = "auto";
        el.style.pointerEvents = "auto";
        if (!wasOpen) set(closedY());
        const d = detents();
        const resting = d.length === 3 ? d[1] : d[0];
        settle(wasOpen && y <= resting ? y : resting, 0, false);
      },
      // Keep the sheet in place when its content changes height.
      relayout() {
        if (!open || drag || anim) return;
        const d = detents();
        if (y > d[d.length - 2]) set(d[d.length - 2]);
      },
      close() {
        if (!open) return;
        // Let taps through to the app while it slides away.
        backdrop.style.pointerEvents = "none";
        el.style.pointerEvents = "none";
        settle(closedY(), 0, false);
      },
    };
    return api;
  }

  // ---- Full-screen pages: slide in from the right, out the same way, edge-swipe back ----
  function Pager(el, scrim) {
    let x = 0;
    let anim = null;
    let onClosed = null;
    const vt = tracker();
    let drag = null;
    const w = () => window.innerWidth;
    const set = (v) => {
      x = v;
      el.style.transform = `translate3d(${v}px, 0, 0)`;
      scrim.style.opacity = String(Math.max(0, 1 - v / w()) * 0.35);
    };
    const go = (to, velocity, done) => {
      anim?.stop();
      anim = spring({ from: x, to, velocity, damping: 1, response: 0.35, onUpdate: set, onDone: () => ((anim = null), done && done()) });
    };
    const finish = () => {
      el.hidden = true;
      scrim.hidden = true;
      const cb = onClosed;
      onClosed = null;
      cb && cb();
    };

    el.addEventListener("pointerdown", (e) => {
      if (e.clientX > 28 || e.pointerType === "mouse") return;
      anim?.stop();
      drag = { x0: e.clientX, y0: e.clientY, start: x, active: false, id: e.pointerId };
      vt.reset();
      vt.add(e.clientX, 0);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      if (!drag.active) {
        if (Math.abs(e.clientY - drag.y0) > 10) return (drag = null);
        if (dx < 10) return;
        drag.active = true;
        el.setPointerCapture(e.pointerId);
      }
      vt.add(e.clientX, 0);
      set(Math.max(0, drag.start + dx));
      e.preventDefault();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const active = drag.active;
      drag = null;
      if (!active) return;
      const v = vt.velocity().x;
      // Decide from where the flick is heading, not where the finger stopped.
      if (x + project(v, 0.99) > w() / 2) go(w(), v, finish);
      else go(0, v);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);

    return {
      open(closedCb) {
        onClosed = closedCb;
        el.hidden = false;
        scrim.hidden = false;
        set(w());
        go(0, 0);
      },
      close() {
        go(w(), 0, finish);
      },
    };
  }

  // ---- Segmented controls: a thumb that slides to the selected segment ------------------
  function syncSeg(seg) {
    let thumb = seg.querySelector(":scope > .seg-thumb");
    if (!thumb) {
      thumb = document.createElement("span");
      thumb.className = "seg-thumb";
      thumb.setAttribute("aria-hidden", "true");
      seg.prepend(thumb);
    }
    const on = seg.querySelector(":scope > button.on");
    if (!on || !on.offsetWidth) return;
    thumb.style.width = on.offsetWidth + "px";
    thumb.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  }

  function watchSegs(root) {
    const all = () => root.querySelectorAll(".seg").forEach(syncSeg);
    new MutationObserver((list) => {
      for (const m of list) {
        const seg = m.target.closest?.(".seg") || (m.target.querySelectorAll && m.target.querySelector(".seg"));
        if (seg) {
          requestAnimationFrame(all);
          return;
        }
      }
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    new ResizeObserver(all).observe(root);
    all();
  }

  window.Motion = { spring, project, rubberband, tracker, haptic, Sheet, Pager, watchSegs, reduceMotion };
})();
