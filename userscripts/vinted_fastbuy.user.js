// ==UserScript==
// @name         Vinted FastBuy (Auto-Buy Click)
// @namespace    fastbuy.vinted
// @match        https://www.vinted.*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  const qs = new URLSearchParams(location.search);
  if (!qs.has('fastbuy')) return;

  const clickWhenVisible = (predicate) => {
    const tryClick = () => {
      const nodes = Array.from(document.querySelectorAll('button,[role="button"]'));
      const el = nodes.find(predicate);
      if (el) { el.click(); return true; }
      return false;
    };
    if (tryClick()) return;
    const obs = new MutationObserver(() => { if (tryClick()) obs.disconnect(); });
    obs.observe(document, { childList: true, subtree: true });
  };

  // Item-Seite → "Kaufen" auto-klicken
  if (/\/items\/\d+/.test(location.pathname)) {
    clickWhenVisible(b => /kaufen|buy/i.test(b.textContent || ''));
  }

  // Checkout → "Zahlen/Pay" sichtbar machen (kein Auto-Pay!)
  if (/^\/checkout/.test(location.pathname)) {
    const focusPay = () => {
      const btn = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find(b => /zahlen|pay/i.test(b.textContent || ''));
      if (btn) { btn.scrollIntoView({ behavior: 'smooth', block: 'end' }); btn.focus(); }
    };
    focusPay();
    new MutationObserver(focusPay).observe(document, { childList: true, subtree: true });
  }
})();

