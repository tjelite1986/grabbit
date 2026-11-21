'use strict';
// Smart Video Routing and Source Classification (Settings spec, approved
// 2026-11-21). Pure functions: the server feeds them what a resolve returned
// and the audience gate's read-only verdict, and gets back where a video goes
// and why.
//
// The rules, each one a promise to the owner:
// - Orientation decides between Shorts and Long Videos. Portrait goes to
//   Shorts whatever its length, landscape to Long Videos (the server library),
//   square and unknown orientation to Review.
// - TikTok, Facebook, Instagram and YouTube are General SOURCES. A source is a
//   suggestion, never a classification: a creator still needs the owner's hand
//   before a general app takes their items. RedGIFs, FikFap and every source
//   not in the table are Review.
// - 18+ always wins over General. An adult site or an adult creator routes to
//   the 18+ destinations, whatever the source table or the orientation says.
// - Review never reaches a general app. Review is a server-library folder that
//   no app imports from.
// - Nothing here reclassifies anything. Routing picks a destination for the
//   video being downloaded now; the audience gate still decides at write time.

const { isAdultSite, platformOfSite } = require('./audience');

// The approved source table. Anything not named here is Review.
const SOURCE_CLASSES = Object.freeze({
  tiktok: 'general',
  facebook: 'general',
  instagram: 'general',
  youtube: 'general',
  redgifs: 'review',
  fikfap: 'review',
});
const SOURCE_LABELS = Object.freeze({
  tiktok: 'TikTok',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  redgifs: 'RedGIFs',
  fikfap: 'FikFap',
});
const GENERAL_SOURCES = Object.freeze(Object.keys(SOURCE_CLASSES).filter((k) => SOURCE_CLASSES[k] === 'general'));

// The server-library folder Review material is filed into. No app imports from
// it, so nothing in it is exposed in a general app.
const REVIEW_FOLDER = 'review';

// Width / height within this ratio of 1 counts as square. Encoders round odd
// sizes (1080x1078), so an exact comparison would call those portrait.
const SQUARE_TOLERANCE = 0.03;

const ORIENTATIONS = ['portrait', 'landscape', 'square', 'unknown'];

// Orientation from the pixel size. Rotation metadata is already applied by
// the sites that report it; anything missing or nonsensical is unknown.
function orientationOf(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'unknown';
  const ratio = w / h;
  if (Math.abs(ratio - 1) <= SQUARE_TOLERANCE) return 'square';
  return ratio < 1 ? 'portrait' : 'landscape';
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  } catch {
    return '';
  }
}

// A source id for one site value (a slug like `tiktok`, a hostname, or a
// yt-dlp extractor key like `TikTok`). Known platforms map to their platform
// id; everything else keeps a cleaned name so a new source can be listed.
function sourceIdOf(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  const platform = platformOfSite(s);
  if (platform) return platform;
  const slug = s.replace(/^(www|m|mobile)\./, '').replace(/\.(com|net|org|tv|io|co)$/, '').replace(/[^a-z0-9]+/g, '');
  if (slug === 'fikfap' || slug === 'redgifs') return slug;
  return slug.slice(0, 40);
}

// The source of a job and its class: { id, label, class: general|review|adult, known }.
// `adult` means an adult-only site, which outranks the table (18+ wins).
function classifySource({ site, extractor, sourceUrl } = {}) {
  if (isAdultSite(site, extractor, sourceUrl)) {
    const id = sourceIdOf(site) || sourceIdOf(hostOf(sourceUrl)) || 'unknown';
    return { id, label: SOURCE_LABELS[id] || id, class: 'adult', known: true };
  }
  const candidates = [site, hostOf(sourceUrl), extractor].map(sourceIdOf).filter(Boolean);
  const known = candidates.find((id) => Object.prototype.hasOwnProperty.call(SOURCE_CLASSES, id));
  if (known) return { id: known, label: SOURCE_LABELS[known], class: SOURCE_CLASSES[known], known: true };
  const id = candidates[0] || 'unknown';
  return { id, label: id, class: 'review', known: false };
}

// The class of one site as the registry stores it (hub.siteOf output).
function sourceClassOfSite(site) {
  return classifySource({ site }).class;
}

// A General suggestion for a set of sites (a review group or a profile): only
// when there is at least one site and every one of them is a General source.
// Returns { audience: 'general', reason } or null. A suggestion is shown to the
// owner, who confirms it; it never classifies anything by itself.
function suggestionForSites(sites) {
  const list = (Array.isArray(sites) ? sites : []).filter((s) => s && s !== 'unknown');
  if (!list.length) return null;
  const classes = list.map((s) => classifySource({ site: s }));
  if (!classes.every((c) => c.class === 'general')) return null;
  const labels = [...new Set(classes.map((c) => c.label))];
  return { audience: 'general', reason: `General source${labels.length > 1 ? 's' : ''}: ${labels.join(', ')}` };
}

// Every source the registry has seen, with its class, for the Settings view.
// The approved table always shows; a site outside it is listed as a newly
// detected source in Review.
function sourceOverview(seenSites) {
  const seen = new Map();
  for (const s of seenSites || []) {
    const c = classifySource({ site: s });
    const prev = seen.get(c.id);
    seen.set(c.id, { ...c, sites: [...new Set([...(prev ? prev.sites : []), s])] });
  }
  // `class` is what routing applies; `specClass` is the table's word. They
  // differ only where 18+ wins (RedGIFs is an 18+ site).
  const out = Object.keys(SOURCE_CLASSES).map((id) => ({
    id, label: SOURCE_LABELS[id], class: classifySource({ site: id }).class, specClass: SOURCE_CLASSES[id], known: true, seen: seen.has(id),
  }));
  for (const [id, c] of seen) {
    if (Object.prototype.hasOwnProperty.call(SOURCE_CLASSES, id) || id === 'unknown') continue;
    out.push({ id, label: c.label, class: c.class, specClass: c.class === 'adult' ? null : 'review', known: c.class === 'adult', seen: true, detected: c.class !== 'adult' });
  }
  return out;
}

// Where a video goes under smart routing.
//
// input: { width, height, site, extractor, sourceUrl }
// facts: {
//   audience: 'general' | 'adult' | 'unknown'  (the gate's read-only verdict
//             for the main shorts app: general only when classified by hand),
//   mainRefusal: string | null   (why the main shorts app would refuse it),
//   shortsMain: boolean          (a main shorts library exists),
//   shorts18: boolean            (an 18+ shorts library exists and takes it),
// }
// Returns { dest: 'elite' | 'server', channel, folder, route, orientation,
//           source, reasons: [string] }.
// `route` is the spec name of the outcome: shorts, shorts-18, long-videos,
// adults or review.
function decideRoute(input = {}, facts = {}) {
  const orientation = orientationOf(input.width, input.height);
  const source = classifySource(input);
  const reasons = [];
  const out = (dest, channel, folder, route) => ({ dest, channel, folder, route, orientation, source, reasons });

  // 18+ first, before the source table and the orientation (principle 1).
  if (source.class === 'adult' || facts.audience === 'adult') {
    reasons.push(source.class === 'adult' ? `${source.label} is an 18+ site` : 'the creator or item is 18+');
    if (orientation === 'portrait' && facts.shorts18) {
      reasons.push('portrait goes to Shorts (18+)');
      return out('elite', '18plus', null, 'shorts-18');
    }
    reasons.push(orientation === 'portrait' ? 'no 18+ shorts library, so the 18+ library' : `${orientation} 18+ video goes to the 18+ library`);
    return out('server', 'main', 'adults', 'adults');
  }

  if (source.class !== 'general') {
    reasons.push(source.known ? `${source.label} is a Review source` : `${source.label} is a new or unknown source, so Review`);
    return out('server', 'main', REVIEW_FOLDER, 'review');
  }
  reasons.push(`${source.label} is a General source`);

  if (orientation === 'landscape') {
    reasons.push('landscape goes to Long Videos');
    return out('server', 'main', 'videos', 'long-videos');
  }
  if (orientation !== 'portrait') {
    reasons.push(orientation === 'square' ? 'square video goes to Review' : 'the orientation is unknown, so Review');
    return out('server', 'main', REVIEW_FOLDER, 'review');
  }
  if (!facts.shortsMain) {
    reasons.push('portrait, but this server has no Shorts library, so Review');
    return out('server', 'main', REVIEW_FOLDER, 'review');
  }
  if (facts.audience !== 'general' || facts.mainRefusal) {
    // A General source is a suggestion only: the creator waits in Review until
    // the owner classifies them.
    reasons.push('portrait, but the creator is not classified General yet, so Review');
    return out('server', 'main', REVIEW_FOLDER, 'review');
  }
  reasons.push('portrait goes to Shorts, whatever its length');
  return out('elite', 'main', null, 'shorts');
}

module.exports = {
  SOURCE_CLASSES,
  SOURCE_LABELS,
  GENERAL_SOURCES,
  REVIEW_FOLDER,
  ORIENTATIONS,
  SQUARE_TOLERANCE,
  orientationOf,
  sourceIdOf,
  classifySource,
  sourceClassOfSite,
  suggestionForSites,
  sourceOverview,
  decideRoute,
};
