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

async function resolve(url) {
  const extractor = pick(url);
  const job = await extractor.resolve(url);
  return { extractor: extractor.name, ...job };
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
  return { extractor: extractor.name, ...result };
}

module.exports = { resolve, isProfile, resolveProfile, pick, siteExtractors, generic };
