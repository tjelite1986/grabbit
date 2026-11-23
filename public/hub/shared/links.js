'use strict';
// Grabbit 3.0 Adshortis phase 2: helpers shared by the hub's native modules
// (TikShortis now, Adshortis later). Loaded before the modules.
(() => {
  const shared = (window.GrabbitShared = window.GrabbitShared || {});

  // Only http(s) links from captions and profile rows become hrefs.
  shared.safeHref = function safeHref(u) {
    try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
  };
})();
