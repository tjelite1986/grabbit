'use strict';
// Grabbit 3.0 Adshortis phase 2: the bottom-sheet stack shared by the hub's
// native modules (moved from public/hub/tik/tik.js without a change in look or
// behaviour). There is one stack for the whole hub, so a module's player can
// tell whether any sheet is open, whichever module opened it.
//
// GrabbitShared.sheets(deps) returns that one stack; the first caller's deps
// (the hub's h(), the close icon, the error reporter) are the ones used.
(() => {
  const shared = (window.GrabbitShared = window.GrabbitShared || {});
  let instance = null;

  shared.sheets = function sheets(deps) {
    if (!instance) instance = createSheets(deps);
    return instance;
  };

  function createSheets({ h, closeIcon, onError }) {
    // One stack. The device Back button closes the open sheets: while any is
    // open, ONE history entry with the same address sits on top (no
    // hashchange, no redraw). One entry, not one per sheet, because a sheet
    // often closes and the next opens in the same click (More -> Edit), and a
    // history.back() per sheet would land late and close the new one.
    const stack = [];
    // The on-screen keyboard. Android Chrome only shrinks the visual
    // viewport, so a sheet pinned to bottom: 0 ends up behind the keyboard
    // (the comment field could not be seen while typing). --tik-kb is the
    // height the keyboard takes off the bottom of the layout viewport and
    // --tik-vvh the height still visible; the sheets ride on top of it.
    const vvp = window.visualViewport;
    function syncKeyboard() {
      const root = document.documentElement.style;
      if (!vvp) return;
      const kb = Math.max(0, Math.round(window.innerHeight - vvp.height - vvp.offsetTop));
      root.setProperty('--tik-kb', `${kb}px`);
      root.setProperty('--tik-vvh', `${Math.round(vvp.height)}px`);
    }
    if (vvp) {
      vvp.addEventListener('resize', syncKeyboard);
      vvp.addEventListener('scroll', syncKeyboard);
      syncKeyboard();
    }
    let guard = false; // our history entry is on top
    let ignorePop = 0; // pops we caused ourselves
    //
    // The look is TikShortis' bottom sheet: full width with a title row and
    // an X (comments, playlists, share, the menu). opts.size 'narrow' is the
    // player menu and its confirmations (at most 448 px wide), 'form' a sheet
    // with inputs. opts.bare drops the title row, as TikShortis' player menu
    // has none; opts.clear leaves the page behind undimmed.
    function openSheet(title, body, opts = {}) {
      const close = () => closeSheet(entry, true);
      const cls = ['tik-sheet', opts.size || (opts.wide ? 'wide' : 'form'), opts.bare ? 'bare' : null, opts.cls || null].filter(Boolean).join(' ');
      const panel = h('div', { class: cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        opts.bare ? null : h('div', { class: 'tik-sheet-head' }, h('h3', null, title), h('button', { type: 'button', class: 'tik-x', 'aria-label': 'Close', onclick: close }, closeIcon())),
        h('div', { class: 'tik-sheet-body' }, body));
      const scrim = h('div', { class: `tik-scrim${opts.clear ? ' clear' : ''}`, onclick: close });
      const entry = { panel, scrim, onClose: opts.onClose, back: document.activeElement };
      document.body.append(scrim, panel);
      stack.push(entry);
      if (!guard) {
        try { history.pushState({ ...(history.state || {}), tikSheet: 1 }, '', location.href); guard = true; } catch { /* ignore */ }
      }
      const first = panel.querySelector('input, textarea, select, button:not(.tik-x), a[href]');
      const target = first || panel.querySelector('.tik-x');
      if (target) target.focus({ preventScroll: true });
      return { close, panel, body: panel.querySelector('.tik-sheet-body') };
    }
    // Called once the last sheet is gone (the feed resumes auto-scroll).
    const whenClosed = new Set();
    // viaUi: closed on screen (X, scrim, Escape, a button). refocus: closed by
    // the device Back; the opener gets its focus back as on screen (phase-2
    // E7 MINOR). Leaving the page (closeAll) does neither.
    function closeSheet(entry, viaUi, refocus) {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      entry.panel.remove();
      entry.scrim.remove();
      if (entry.onClose) entry.onClose();
      if (!stack.length) for (const fn of whenClosed) { try { fn(); } catch (e) { console.warn('sheets: sheet-close hook failed', e); } }
      if ((viaUi || refocus) && entry.back && entry.back.isConnected && !stack.length) entry.back.focus({ preventScroll: true });
      if (!viaUi) return;
      // Closed on screen: take the history entry back off, unless another
      // sheet opens right away (it reuses the entry).
      setTimeout(() => {
        if (stack.length || !guard) return;
        guard = false;
        if (history.state && history.state.tikSheet) { ignorePop++; history.back(); }
      }, 0);
    }
    function closeAll() {
      while (stack.length) closeSheet(stack[stack.length - 1], false);
      // Leaving the page: the entry stays below the new address and is a
      // harmless duplicate of the old one.
      guard = false;
    }
    window.addEventListener('popstate', () => {
      if (ignorePop) { ignorePop--; return; }
      if (!guard) return;
      guard = false;
      while (stack.length) closeSheet(stack[stack.length - 1], false, true);
    });
    document.addEventListener('keydown', (e) => {
      // Escape closes the top sheet and nothing else: no other handler on the
      // document (a player, the hub's viewer) may act on the same key press.
      if (e.key === 'Escape' && stack.length) { e.preventDefault(); e.stopImmediatePropagation(); closeSheet(stack[stack.length - 1], true); return; }
      // aria-modal: Tab and Shift+Tab cycle inside the top sheet and never
      // reach the page behind the scrim.
      if (e.key === 'Tab' && stack.length) {
        const panel = stack[stack.length - 1].panel;
        const items = [...panel.querySelectorAll('a[href], button, input, textarea, select, video[controls], [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
        if (!items.length) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        const inside = panel.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === firstEl)) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && (!inside || document.activeElement === lastEl)) { e.preventDefault(); firstEl.focus(); }
      }
    });
    // TikShortis' confirmation sheet (the clip's "Delete this clip?"): a title,
    // one line, then the action in red and Cancel side by side.
    function confirmSheet(title, text, label, run) {
      const s = openSheet(title, [
        h('p', { class: 'tf-sheet-title' }, title),
        h('p', { class: 'tf-sheet-sub' }, text),
        h('div', { class: 'tf-sheet-btns' },
          h('button', { type: 'button', class: 'tf-sbtn danger', onclick: async (e) => {
            // currentTarget is gone after the await: keep the button.
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await run(); s.close(); } catch (err) { onError(err); btn.disabled = false; }
          } }, label),
          h('button', { type: 'button', class: 'tf-sbtn', onclick: () => s.close() }, 'Cancel')),
      ], { size: 'narrow', bare: true });
      // The destructive button comes first, as in TikShortis, but the focus
      // starts on Cancel: Enter (or a held key) must never confirm by itself.
      const cancel = s.panel.querySelector('.tf-sheet-btns .tf-sbtn:not(.danger)');
      if (cancel) cancel.focus({ preventScroll: true });
    }

    return {
      open: openSheet,
      close: closeSheet,
      closeAll,
      confirm: confirmSheet,
      // How many sheets are open (any module's).
      count: () => stack.length,
      // Hooks run once the last sheet is gone.
      whenClosed,
    };
  }
})();
