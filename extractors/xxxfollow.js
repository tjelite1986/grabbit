// Extractor for xxxfollow.com (www.xxxfollow.com)
//
// Server-rendered React site, not bot-gated. Files are direct mp4s on the same
// host in several qualities:
//   /media/fans/post_public/<a>/<b>/<mediaid>{,_fhd,_sd}.mp4   (prefer _fhd)
// Profile pages (/​<creator>) render each post as
//   <img alt="<title> by <creator>" src=".../<mediaid>_small.webp">
// and paginate with ?page=N, so the whole profile is reachable from SSR.
// Single video pages (/​<creator>/<postid>-slug) carry og:title + the mp4s.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://www.xxxfollow.com';

function fetchT(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function match(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'xxxfollow.com';
  } catch {
    return false;
  }
}

// /<creator> is a profile; /<creator>/<post> is a single video.
function isProfile(url) {
  try {
    return /^\/[A-Za-z0-9_.-]+\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function creatorFromUrl(url) {
  return (new URL(url).pathname.match(/^\/([A-Za-z0-9_.-]+)/) || [])[1] || 'xxxfollow';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Per-post tags live on the individual post page as /tag/<slug> links (the
// profile listing carries none). Slugs are normalised to clean hashtag tokens
// (drop hyphens/punctuation) so buildCaption's `#` prefix yields valid tags.
function scrapeTags(html) {
  const out = [];
  const seen = new Set();
  const re = /href="\/tag\/([^"?#]+)"/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 15) {
    const token = decodeURIComponent(m[1]).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (token.length >= 2 && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function buildJob(userdir, userid, mediaid, title, creator, opts = {}) {
  const dir = `${BASE}/media/fans/post_public/${userdir}/${userid}`;
  return {
    kind: 'direct',
    id: String(mediaid),
    creator,
    title: title || String(mediaid),
    description: title || '',
    tags: opts.tags || [],
    // The individual post page, used to enrich tags lazily at download time.
    pageUrl: opts.pageUrl || null,
    sourceUrl: `${BASE}/${creator}`,
    thumbnail: `${dir}/${mediaid}_small.webp`,
    filename: `${creator}-${mediaid}.mp4`,
    // Not every post has an _fhd variant; the downloader falls back in order.
    downloadUrl: `${dir}/${mediaid}_fhd.mp4`,
    fallbackUrls: [`${dir}/${mediaid}.mp4`, `${dir}/${mediaid}_sd.mp4`],
    headers: { 'User-Agent': UA, Referer: BASE + '/' },
  };
}

async function resolve(url) {
  const creator = creatorFromUrl(url);
  const res = await fetchT(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  // Main clip's media id from og:image (.../<mediaid>_small.jpg|webp).
  // The user-id dir can carry a suffix, e.g. post_public/4179/41791007-1/....
  const og = html.match(/og:image"[^>]*content="[^"]*post_public\/(\d+)\/([\d-]+)\/(\d+)_/i);
  let userdir;
  let userid;
  let mediaid;
  if (og) [, userdir, userid, mediaid] = og;
  else {
    const any = html.match(/post_public\/(\d+)\/([\d-]+)\/(\d+)(?:_fhd|_sd)?\.mp4/);
    if (!any) throw new Error('no video found on page');
    [, userdir, userid, mediaid] = any;
  }

  const ogTitle = decodeEntities((html.match(/og:title"[^>]*content="([^"]*)"/i) || [])[1] || '');
  const title = ogTitle.replace(/\s+(by|Starring)\s+[^|]*$/i, '').trim();
  return buildJob(userdir, userid, mediaid, title, creator, { tags: scrapeTags(html), pageUrl: url });
}

// Fetch a profile item's own post page to pull its per-clip tags. Called by the
// registry's enrichJob() at download time, so a profile preview stays a single
// listing fetch and only the clips actually downloaded pay for the extra page.
async function enrich(job) {
  if (!job || !job.pageUrl) return job;
  try {
    const res = await fetchT(job.pageUrl, { headers: { 'User-Agent': UA } });
    if (!res.ok) return job;
    const tags = scrapeTags(await res.text());
    if (tags.length) job.tags = tags;
  } catch {
    /* best effort — tags stay empty */
  }
  return job;
}

async function resolveProfile(url) {
  const creator = creatorFromUrl(url);
  const items = [];
  const seen = new Set();

  for (let page = 1; page <= 100; page++) {
    const res = await fetchT(`${BASE}/${creator}?page=${page}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) break;
    const html = await res.text();
    // Each post is anchored by a preceding <a href="/<creator>/<postid>...">,
    // then rendered as alt="<title> by <creator>" ... src=".../<mediaid>_small".
    // Collect the post hrefs in document order so each media can be paired with
    // its nearest preceding anchor (postid != mediaid, so they can't be joined
    // by id — proximity is the reliable link). The href gives us the post page
    // that carries the clip's tags, fetched later by enrich().
    const hrefs = [];
    const hrefRe = /href="(\/[A-Za-z0-9_.-]+\/\d+[A-Za-z0-9_.-]*)"/g;
    let hm;
    while ((hm = hrefRe.exec(html))) hrefs.push({ i: hm.index, url: hm[1] });
    const re =
      /alt="([^"]+?)\s+by\s+[^"]*?"[^>]*?post_public\/(\d+)\/([\d-]+)\/(\d+)_small/g;
    let m;
    let added = 0;
    while ((m = re.exec(html))) {
      const [, rawTitle, userdir, userid, mediaid] = m;
      if (seen.has(mediaid)) continue;
      seen.add(mediaid);
      let pageUrl = null;
      for (const hf of hrefs) {
        if (hf.i < m.index) pageUrl = hf.url;
        else break;
      }
      items.push(
        buildJob(userdir, userid, mediaid, decodeEntities(rawTitle).trim(), creator, {
          pageUrl: pageUrl ? BASE + pageUrl : null,
        })
      );
      added++;
    }
    if (!added) break; // no new posts -> reached the end
  }
  if (!items.length) throw new Error('no videos found for this profile');
  return { creator, items };
}

module.exports = { name: 'xxxfollow', domain: 'xxxfollow.com', profiles: true, match, isProfile, resolve, resolveProfile, enrich };
