'use strict';
// Grabbit 2.0 audience gate: which audience an item belongs to, and whether a
// destination may receive it. Pure functions; the server feeds them the
// profile store, the item's earlier record and the job, and calls refusal()
// before every write into an app's folder.
//
// Rules, each one a promise to the owner:
// - Three audiences: general, adult, unknown. Unknown is never treated as
//   general. A general app receives an item only when it is positively
//   classified general.
// - Adult wins. Any adult signal (the job, the item's earlier record, the
//   source site, a matching adult profile) makes the item adult, whatever the
//   general signals say.
// - A job may tighten the audience to adult, never lower it. An item once
//   recorded adult stays adult.
// - General evidence is the owner's hand and nothing else: a profile created
//   by hand or classified general in the review queue, or the item itself
//   classified general by hand. A delivery is not a classification: that an alias reached a general
//   app before (or was saved to the plain server library) says nothing about
//   its audience. Profiles the registry sync created stay unknown until the
//   owner classifies them.
// - Adshortis (the 18+ destination) takes videos only. Every other
//   destination is general.

const { effectiveAudience } = require('./profiles');

const AUDIENCES = ['general', 'adult', 'unknown'];

// Every app destination Grabbit writes into, and the audience it serves.
const DESTINATIONS = {
  main: { id: 'main', app: 'Tikshortis', audience: 'general' },
  platform: { id: 'platform', app: 'Platform', audience: 'general' },
  posts: { id: 'posts', app: 'the posts library', audience: 'general' },
  egram: { id: 'egram', app: 'egram', audience: 'general' },
  '18plus': { id: '18plus', app: 'Adshortis', audience: 'adult' },
};

// Sites that only host adult content. A clip from one of these is adult no
// matter which profile its creator name matches.
const ADULT_SITE_DOMAINS = [
  'erome.com',
  'imagefap.com',
  'nuditok.com',
  'onlytik.com',
  'redgifs.com',
  'tik.porn',
  'xfree.com',
  'xxxfollow.com',
];
const ADULT_SITE_SLUGS = new Set(['erome', 'imagefap', 'nuditok', 'onlytik', 'redgifs', 'tikporn', 'xfree', 'xxxfollow']);

// The site of a job is a hostname (`redgifs.com`), a slug yt-dlp gave itself
// (`RedGifs`) or an extractor name. Any of them may name an adult site.
function isAdultSite(...values) {
  for (const v of values) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) continue;
    let host = s;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) host = new URL(s).hostname;
    } catch { /* not a URL */ }
    host = host.replace(/^(www|m)\./, '');
    if (ADULT_SITE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
    if (ADULT_SITE_SLUGS.has(s.replace(/[^a-z0-9]+/g, ''))) return true;
  }
  return false;
}

// The site of a job, as a profile account platform. Exact matches only: a
// hostname equal to (or a subdomain of) the platform's domain, or yt-dlp's
// extractor key for it. Anything else matches no account.
const PLATFORM_DOMAINS = [
  ['tiktok.com', 'tiktok'],
  ['instagram.com', 'instagram'],
  ['facebook.com', 'facebook'],
  ['fb.watch', 'facebook'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['twitter.com', 'x'],
  ['x.com', 'x'],
  ['reddit.com', 'reddit'],
  ['snapchat.com', 'snapchat'],
  ['twitch.tv', 'twitch'],
];
const PLATFORM_KEYS = {
  tiktok: 'tiktok',
  instagram: 'instagram',
  facebook: 'facebook',
  youtube: 'youtube',
  twitter: 'x',
  x: 'x',
  reddit: 'reddit',
  snapchat: 'snapchat',
  twitch: 'twitch',
};
function platformOfSite(site) {
  const s = String(site || '').trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(PLATFORM_KEYS, s)) return PLATFORM_KEYS[s];
  const host = s.replace(/^(www|m|mobile)\./, '');
  for (const [domain, platform] of PLATFORM_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return platform;
  }
  return null;
}

// Creator names are compared the way they appear in file names: the server's
// safeCreator() output, case-insensitive. The caller passes that function so
// this module and the file names can never disagree.
const norm = (v) => String(v || '').trim().toLowerCase();

// The profiles a job's creator matches: by alias, by profile name, or by a
// linked account on the job's own platform.
function matchProfiles(store, { creatorKey, handle, platform }, keyOf = norm) {
  const out = [];
  if (!store || !Array.isArray(store.profiles)) return out;
  for (const p of store.profiles) {
    const byAlias = creatorKey && (p.aliases || []).some((a) => norm(keyOf(a.name)) === creatorKey);
    const byName = creatorKey && p.origin === 'manual' && norm(keyOf(p.name)) === creatorKey;
    // A general account must match on its own platform. An adult account
    // matches its handle on any platform: an unrecognised site (a yt-dlp key
    // such as "tiktokuser") must never drop an adult signal.
    const byAccount =
      handle &&
      (p.accounts || []).some(
        (a) => norm(a.handle) === handle && (effectiveAudience(p) === 'adult' || (platform && a.platform === platform))
      );
    if (byAlias || byName || byAccount) out.push({ profile: p, byAlias, byName, byAccount });
  }
  return out;
}

// keyOf turns a name into its file-name spelling (the server passes
// safeCreator), so "Jane Doe" and the alias "Jane_Doe" compare equal.
// classify({ creatorKey, handle, site, extractor, sourceUrl, requested, prior }, store)
//   creatorKey: the job's creator; '' or 'unknown' for none
//   handle:     the creator as the site spells it, lowercased (for accounts)
//   requested:  'adult' when the job tightens the audience, else anything
//   prior:      the audience this item was recorded with before, or null
//   priorByHand: true when the owner set that audience by hand
// -> { audience, reasons: [string], profileId: number|null }
function classify(input, store, { keyOf = norm } = {}) {
  const i = input || {};
  const ck = norm(i.creatorKey ? keyOf(i.creatorKey) : '');
  const creatorKey = ck === 'unknown' ? '' : ck;
  const handle = norm(i.handle);
  const platform = platformOfSite(i.site);
  const reasons = [];

  if (i.requested === 'adult') reasons.push('the job saves it as 18+');
  if (i.prior === 'adult') reasons.push('this item was recorded as 18+ before');
  if (isAdultSite(i.site, i.extractor, i.sourceUrl)) reasons.push('the source site is an 18+ site');
  const matches = matchProfiles(store, { creatorKey, handle, platform }, keyOf);
  const adultProfile = matches.find((m) => effectiveAudience(m.profile) === 'adult');
  if (adultProfile) reasons.push(`the creator matches the 18+ profile #${adultProfile.profile.id}`);
  if (reasons.length) {
    return { audience: 'adult', reasons, profileId: adultProfile ? adultProfile.profile.id : null };
  }

  if (i.prior === 'general' && i.priorByHand === true) {
    return { audience: 'general', reasons: ['this item was classified general by hand'], profileId: null };
  }
  const general = matches.find((m) => effectiveAudience(m.profile) === 'general');
  if (general) {
    return {
      audience: 'general',
      reasons: [`the creator matches the general profile #${general.profile.id} (classified by hand)`],
      profileId: general.profile.id,
    };
  }

  if (!creatorKey && !handle) reasons.push('the item has no creator');
  else if (matches.length) reasons.push('the matching profile was not classified by hand');
  else reasons.push('no profile matches the creator');
  return { audience: 'unknown', reasons, profileId: null };
}

// Why this destination may not receive an item of this classification, or
// null when it may. Fails closed on anything it does not recognise.
function refusal(classification, destinationId, { mediaType, creator } = {}) {
  const dest = DESTINATIONS[destinationId];
  if (!dest) return `Unknown destination "${destinationId}"; nothing is written.`;
  const audience = classification && AUDIENCES.includes(classification.audience) ? classification.audience : 'unknown';
  if (dest.audience === 'adult') {
    if (mediaType === 'image') {
      return 'Adshortis takes videos only, and 18+ images are never filed into the general posts library. Save them to the server library instead.';
    }
    return null;
  }
  if (audience === 'general') return null;
  const why = (classification && classification.reasons && classification.reasons.join('; ')) || 'no classification';
  if (audience === 'adult') {
    return `${dest.app} is a general app and this item is 18+ (${why}). 18+ material only goes to Adshortis or the server library.`;
  }
  const who = creator ? `"${creator}"` : 'this creator';
  return (
    `${dest.app} is a general app and the audience of ${who} is not classified (${why}). ` +
    'Classify the creator or the item on the hub\'s Review page, or save to the server library instead.'
  );
}

// The Navidrome kids library: a child-safety rule of its own, stricter than
// a general app. Only an item positively classified general may go there;
// unknown and 18+ are refused, and so is anything this function does not
// recognise. NOT WIRED YET: the kids library keeps its current behaviour until
// the owner decides to switch this on (see the save path for lib=kids).
function kidsRefusal(classification) {
  const audience = classification && AUDIENCES.includes(classification.audience) ? classification.audience : 'unknown';
  if (audience === 'general') return null;
  const why = (classification && classification.reasons && classification.reasons.join('; ')) || 'no classification';
  if (audience === 'adult') return `The kids library never takes 18+ material (${why}).`;
  return `The kids library only takes items classified general by hand, and this one is not (${why}).`;
}

// Two looks at one item (say the creator as the site named it and as the job
// renamed it): adult if either is adult, general only if both are general.
function stricter(a, b) {
  if (!b) return a;
  if (!a) return b;
  if (a.audience === 'adult' || b.audience === 'adult') {
    const adult = [a, b].filter((c) => c.audience === 'adult');
    return { audience: 'adult', reasons: adult.flatMap((c) => c.reasons), profileId: adult[0].profileId };
  }
  if (a.audience === 'general' && b.audience === 'general') return a;
  const unknown = [a, b].filter((c) => c.audience !== 'general');
  return { audience: 'unknown', reasons: unknown.flatMap((c) => c.reasons), profileId: null };
}

// The audience an item is stored with: never lower than what it had.
function storedAudience(prior, next) {
  if (prior === 'adult' || next === 'adult') return 'adult';
  if (next === 'general') return 'general';
  if (prior === 'general') return 'general';
  return 'unknown';
}

module.exports = {
  AUDIENCES,
  DESTINATIONS,
  ADULT_SITE_DOMAINS,
  isAdultSite,
  platformOfSite,
  matchProfiles,
  classify,
  refusal,
  kidsRefusal,
  stricter,
  storedAudience,
};
