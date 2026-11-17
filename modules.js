'use strict';
// Grabbit 3.0 module registry.
//
// Grabbit grows from a downloader with a hub into one media platform. Each
// section of that platform is a module: it has an id, a place in the shared
// navigation, an audience, and a switch of its own. The registry is the one
// list both the server and the hub read, so a module that is off is off
// everywhere: no menu entry, no API, no config entry.
//
// Phase 1 builds one module (TikShortis, native). The later phases are listed
// with `planned: true` so the navigation, the audience rules and the flags are
// designed for them now, but nothing of theirs is served: a planned module is
// never shown and has no routes.
//
// Audience is part of the module, not of its pages: an `adult` module is never
// shown, searched, recommended or cached together with a `general` one. The hub
// groups adult modules apart and the server refuses to mix them (see
// `modulesFor()`), so a future 18+ module cannot appear in the general feed by
// accident.

const AUDIENCES = ['general', 'adult'];

// Phase order is the roadmap's. `phase` is informational; `planned` is what
// keeps a module dark.
const MODULES = [
  { id: 'tikshortis', label: 'TikShortis', phase: 1, audience: 'general', group: 'watch' },
  { id: 'videos', label: 'Videos', phase: 2, audience: 'general', group: 'watch', planned: true },
  { id: 'social', label: 'eGram', phase: 3, audience: 'general', group: 'social', planned: true },
  // Adshortis keeps its existing library page (hub #/adshortis) unchanged in
  // phase 1; phase 4 turns it into a module. It is listed for the audience
  // rules only.
  { id: 'adshortis', label: 'Adshortis', phase: 4, audience: 'adult', group: 'adult', planned: true },
  { id: 'adult-media', label: 'Adult videos & photos', phase: 5, audience: 'adult', group: 'adult', planned: true },
  { id: 'movies-music', label: 'Movies & music', phase: 6, audience: 'general', group: 'watch', planned: true },
  { id: 'home', label: 'Home', phase: 7, audience: 'general', group: 'home', planned: true },
];

// TikShortis has three modes, chosen by TIKSHORTIS_MODE:
//   native  the hub's own TikShortis pages over the TikShortis API, through
//           Grabbit's gateway (/api/tik/*). Needs TIKSHORTIS_API_URL.
//   embed   the Grabbit 2.2 page: the TikShortis app in an iframe. Needs
//           TIKSHORTIS_EMBED_URL.
//   off     no TikShortis page at all.
// Unset keeps Grabbit 2.2's behaviour (embed when TIKSHORTIS_EMBED_URL is set,
// else off), so a 3.0 image deployed without new settings changes nothing.
// A mode whose setting is missing or malformed falls back to the next safer one
// (native -> embed -> off) and says so in the log: it never half-works.
const TIK_MODES = ['native', 'embed', 'off'];

function tikshortisMode(env, { apiOrigin, embed }) {
  const raw = String(env.TIKSHORTIS_MODE || '').trim().toLowerCase();
  const warnings = [];
  let wanted = raw;
  if (!raw) wanted = embed ? 'embed' : 'off';
  else if (!TIK_MODES.includes(raw)) {
    warnings.push(`TIKSHORTIS_MODE=${raw} is not one of ${TIK_MODES.join(', ')}; using ${embed ? 'embed' : 'off'}.`);
    wanted = embed ? 'embed' : 'off';
  }
  if (wanted === 'native' && !apiOrigin) {
    warnings.push(`TIKSHORTIS_MODE=native needs a valid TIKSHORTIS_API_URL; using ${embed ? 'embed' : 'off'}.`);
    wanted = embed ? 'embed' : 'off';
  }
  if (wanted === 'embed' && !embed) {
    warnings.push('TIKSHORTIS_MODE=embed needs a valid TIKSHORTIS_EMBED_URL; the TikShortis page is off.');
    wanted = 'off';
  }
  return { mode: wanted, warnings };
}

// What the hub receives in /api/config.modules: only what it needs to draw the
// navigation. Planned modules are listed as planned (no routes, never shown as
// a link) so the client can be written against the final shape.
function modulesFor({ tikMode }) {
  return MODULES.map((m) => {
    const out = { id: m.id, label: m.label, phase: m.phase, audience: m.audience, group: m.group };
    if (m.planned) return { ...out, enabled: false, planned: true };
    if (m.id === 'tikshortis') return { ...out, enabled: tikMode !== 'off', mode: tikMode };
    return { ...out, enabled: false };
  });
}

module.exports = { MODULES, AUDIENCES, TIK_MODES, tikshortisMode, modulesFor };
