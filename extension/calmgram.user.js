// ==UserScript==
// @name         Calmgram — Instagram without the brainrot
// @namespace    https://github.com/kskerbergs/instagram
// @version      1.0.0
// @description  Friends' posts, stories and DMs only. No Reels tab, no Explore, no endless feed.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---- Settings -----------------------------------------------------------
  const MAX_POSTS = 20;      // feed stops after this many posts
  const MAX_AGE_DAYS = 3;    // hide feed posts older than this
  const WHERE_BLOCKED_GOES = "/direct/inbox/";

  // Feed posts containing any of these labels are ads or suggestions.
  const JUNK_LABELS = [
    "Suggested for you", "Suggested posts", "Sponsored", "Paid partnership",
    "Ieteikts jums", "Ieteiktās ziņas", "Sponsorēts", "Apmaksāta sadarbība",
  ];

  // ---- Routing ------------------------------------------------------------
  // Swipeable feeds are blocked outright. A single /reel/<id> a friend sends
  // in DMs still opens.
  const BLOCKED_PATHS = [/^\/reels\/?$/, /^\/reels\/audio\//, /^\/explore\/(?!search)/, /^\/explore\/?$/];

  function route() {
    const { pathname, search } = location;
    if (BLOCKED_PATHS.some((re) => re.test(pathname))) {
      location.replace(WHERE_BLOCKED_GOES);
      return;
    }
    // Home: force the "Following" feed — people you follow, newest first, no suggestions.
    if (pathname === "/" && !/variant=following/.test(search)) {
      location.replace("/?variant=following");
    }
  }

  // ---- Styling ------------------------------------------------------------
  const CSS = `
    a[href="/reels/"], a[href^="/reels/"],
    a[href="/explore/"], a[href^="/explore/"]:not([href^="/explore/search"]),
    a[href^="https://www.threads.net"], a[href^="https://www.threads.com"],
    a[href*="/explore/people"] { display: none !important; }
    body.calmgram-explore main a[href^="/p/"],
    body.calmgram-explore main a[href^="/reel/"] { display: none !important; }
    .calmgram-hidden { display: none !important; }
    #calmgram-end {
      margin: 32px auto 96px; max-width: 470px; padding: 24px; text-align: center;
      border-radius: 12px; font: 15px/1.5 system-ui, sans-serif;
      background: rgba(127,127,127,.12); color: inherit;
    }
    #calmgram-end strong { display: block; font-size: 18px; margin-bottom: 6px; }
    #calmgram-end a { color: #0095f6; font-weight: 600; text-decoration: none; }
  `;

  function injectCss() {
    if (!document.documentElement || document.getElementById("calmgram-css")) return;
    const style = document.createElement("style");
    style.id = "calmgram-css";
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- Feed ---------------------------------------------------------------
  function isJunk(article) {
    const text = article.innerText || "";
    return JUNK_LABELS.some((label) => text.includes(label));
  }

  function isOld(article) {
    const time = article.querySelector("time[datetime]");
    if (!time) return false;
    const age = Date.now() - Date.parse(time.getAttribute("datetime"));
    return age > MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  }

  function endBanner(afterNode) {
    let banner = document.getElementById("calmgram-end");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "calmgram-end";
      banner.innerHTML =
        "<strong>You're all caught up ✨</strong>" +
        "That's everything from your friends lately.<br>" +
        '<a href="/direct/inbox/">Check messages</a> or go do something fun.';
    }
    if (banner.previousElementSibling !== afterNode) afterNode.after(banner);
  }

  function trimFeed() {
    if (location.pathname !== "/") return;
    const articles = document.querySelectorAll("main article");
    let shown = 0;
    let lastShown = null;
    let reachedEnd = false;
    for (const article of articles) {
      const keep = !reachedEnd && !isJunk(article) && !isOld(article);
      if (keep && ++shown >= MAX_POSTS) reachedEnd = true;
      // Once an old post appears everything after it is older too.
      if (!keep && isOld(article)) reachedEnd = true;
      article.classList.toggle("calmgram-hidden", !keep);
      if (keep) lastShown = article;
    }
    if (reachedEnd && lastShown) endBanner(lastShown);
  }

  // ---- Main loop ----------------------------------------------------------
  let lastUrl = "";
  function tick() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      route();
    }
    injectCss();
    if (document.body) {
      document.body.classList.toggle("calmgram-explore", location.pathname.startsWith("/explore"));
    }
    trimFeed();
  }

  route();
  injectCss();
  // Instagram is a single-page app: re-check on navigation and DOM changes.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; tick(); });
  }).observe(document, { childList: true, subtree: true });
  window.addEventListener("popstate", tick);
})();
