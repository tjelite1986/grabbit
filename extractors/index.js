// Extractor registry.
//
// Each extractor is a module that exports:
//   name:   string label
//   match(url): boolean  -> does this extractor handle the URL?
//   async resolve(url):   -> a "job" describing how to fetch the media.
//
// A resolved job has the shape:
//   {
//     kind: 'direct' | 'ytdlp',
//     filename: 'creator-id.mp4',   // suggested download filename (sanitized later)
//     title?: string,
//     thumbnail?: string,
//     // for kind 'direct':
//     downloadUrl?: string,
//     headers?: { [k]: string },    // request headers (e.g. Referer) for the upstream fetch
//     // for kind 'ytdlp': nothing extra, the server runs yt-dlp on the original url
//     url?: string,
//   }
//
// To add a new site, drop a file in this folder that exports the interface above.
// The generic yt-dlp fallback is always tried last.

const fs = require('fs');
const path = require('path');

const generic = require('./generic');

// Load every *.js file in this directory except the registry and the fallback.
const siteExtractors = fs
  .readdirSync(__dirname)
  .filter(
    (f) => f.endsWith('.js') && !['index.js', 'generic.js', 'util.js'].includes(f)
  )
  .map((f) => require(path.join(__dirname, f)));

function pick(url) {
  for (const ex of siteExtractors) {
    try {
      if (ex.match(url)) return ex;
    } catch {
      // ignore a broken matcher and keep looking
    }
  }
  return generic;
}

// The site a clip came from, as a stable slug. The yt-dlp path names itself
// (`facebook`, `tiktok`); a site extractor is identified by its hostname.
function siteOf(job, url) {
  if (job && job.site) return job.site;
  try {
    return new URL(String(job && job.sourceUrl) || String(url)).hostname.replace(/^(www|m)\./i, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// Every extractor already carries the site's own id for a clip — as `id` in the
// site extractors, as `mediaId` from yt-dlp. Normalising both into `site` +
// `mediaId` here is what lets the downloaded-registry recognise a repeat that
// arrives under a different URL, without touching each extractor.
function withMediaId(job, url) {
  if (!job || typeof job !== 'object') return job;
  return { ...job, site: siteOf(job, url), mediaId: job.mediaId || (job.id != null ? String(job.id) : null) };
}

async function resolve(url) {
  const extractor = pick(url);
  const job = await extractor.resolve(url);
  return { extractor: extractor.name, ...withMediaId(job, url) };
}

// Does the matching extractor recognise this URL as a multi-video profile?
function isProfile(url) {
  const extractor = pick(url);
  return typeof extractor.isProfile === 'function' && extractor.isProfile(url);
}

// Resolve every clip on a profile. Throws if the site has no profile support.
async function resolveProfile(url) {
  const extractor = pick(url);
  if (typeof extractor.resolveProfile !== 'function') {
    throw new Error('This site does not support whole-profile downloads');
  }
  const result = await extractor.resolveProfile(url);
  const items = Array.isArray(result.items) ? result.items.map((it) => withMediaId(it, it.sourceUrl || url)) : result.items;
  return { extractor: extractor.name, ...result, items };
}

// Some extractors can lazily enrich a resolved job (e.g. fetch a profile clip's
// own post page for its tags) at download time. A no-op for jobs whose owning
// extractor has no enrich() or that carry no pageUrl.
async function enrichJob(job) {
  try {
    if (!job || !job.pageUrl) return job;
    const ex = pick(job.pageUrl);
    if (ex && typeof ex.enrich === 'function') return await ex.enrich(job);
  } catch {
    /* best effort — leave the job unchanged */
  }
  return job;
}

module.exports = { resolve, isProfile, resolveProfile, enrichJob, pick, siteExtractors, generic };
