'use strict';
// What a scanned file is, from its folder and name alone: the media kind, and
// whether it is original media or something an app generated from it
// (thumbnail, poster, preview, cache, temp file). Generated files are left out
// of the duplicate lists by default and get their own Cache & Thumbnails view:
// two identical thumbnails are not two copies of anything the owner made.
//
// Pure functions; the scanner's records are not changed.

const path = require('path');

const VIDEO = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'vob', '3gp']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'm4b', 'wma', 'alac', 'aiff']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff']);

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

function kindOf(rel) {
  const e = extOf(path.basename(rel));
  if (VIDEO.has(e)) return 'video';
  if (IMAGE.has(e)) return 'image';
  if (AUDIO.has(e)) return 'audio';
  return 'other';
}

// Folder names apps use for generated files. A segment match, never a
// substring: a creator called "thumbsup" is media.
const CACHE_DIRS = new Set([
  '_thumbs', '.thumbs', 'thumbs', 'thumbnails', '.thumbnails', '_thumbnails',
  '.posters', 'posters', '_posters', '_previews', 'previews', '.previews',
  '_cache', '.cache', 'cache', '_tmp', '.tmp', 'tmp', '_sprites', 'sprites',
]);

// Per-app rules, by the root's `app` field.
// - Elitogram: everything under an underscore folder is the app's own
//   (thumbnails, avatars, banners, stories, temp); only _thumbs and _tmp are
//   regenerable cache. Avatars and banners are owner-chosen pictures.
// - TikShortis is a video app: an image beside the clips is the poster frame
//   it generated.
const EGRAM_LABELS = { _avatars: 'avatar', _banners: 'banner', _stories: 'story', _users: 'user' };

function appRule(root, rel) {
  const segs = rel.split(/[\\/]/);
  const top = segs[0];
  if (root.app === 'egram') {
    if (top === '_thumbs') return { cls: 'derivative', what: 'thumbnail', regenerable: true };
    if (top === '_tmp') return { cls: 'derivative', what: 'temporary file', regenerable: true };
    // Only a folder counts: a file named "_x.jpg" at the root is media.
    if (segs.length > 1 && top.startsWith('_')) return { cls: 'app', what: EGRAM_LABELS[top] || top.slice(1) };
  }
  if (root.app === 'TikShortis' && kindOf(rel) === 'image') return { cls: 'derivative', what: 'poster', regenerable: true };
  return null;
}

// { kind, cls: 'media' | 'derivative' | 'app', what, regenerable, webOptimized }
function classify(root, rel) {
  const kind = kindOf(rel);
  const r = appRule(root || {}, rel);
  if (r) return { kind, webOptimized: false, regenerable: false, ...r };
  const segs = rel.split(/[\\/]/).slice(0, -1);
  const hit = segs.find((s) => CACHE_DIRS.has(s.toLowerCase()));
  if (hit) {
    const what = /post/i.test(hit) ? 'poster' : /prev/i.test(hit) ? 'preview' : /tmp|cache/i.test(hit) ? 'cache file' : /sprite/i.test(hit) ? 'sprite' : 'thumbnail';
    return { kind, cls: 'derivative', what, regenerable: true, webOptimized: false };
  }
  const base = path.basename(rel);
  // A web-optimised rendition the owner (or an app) made on purpose: kept
  // beside its original, related to it, never a removable "copy".
  const webOptimized = /\.(web|web-?opt|optimized|preview|small|mobile)\.[a-z0-9]+$/i.test(base);
  return { kind, cls: 'media', what: kind, regenerable: false, webOptimized };
}

// The stem two renditions of one original share: "clip.web.mp4" and
// "clip.mp4" both give "clip".
function renditionStem(rel) {
  const base = path.basename(rel).toLowerCase();
  return base.replace(/\.[a-z0-9]+$/, '').replace(/\.(web|web-?opt|optimized|preview|small|mobile)$/, '');
}

// Whether two files are an original and an intended derivative of it (same
// folder, same stem, one web-optimised). Such a pair is related, not a
// duplicate to remove.
function relatedRenditions(a, b) {
  if (path.dirname(a.rel) !== path.dirname(b.rel) || a.root !== b.root) return false;
  const ca = classify(a.rootInfo, a.rel);
  const cb = classify(b.rootInfo, b.rel);
  if (ca.webOptimized === cb.webOptimized) return false;
  return renditionStem(a.rel) === renditionStem(b.rel);
}

// The audience a file belongs to, as far as Grabbit can tell without opening
// it: an 18+ folder or an item classified adult makes it adult. Nothing here
// ever makes a file general; unknown stays unknown.
function audienceOf(rootInfo, itemAudience) {
  if (rootInfo && rootInfo.adult) return 'adult';
  if (itemAudience === 'adult') return 'adult';
  if (itemAudience === 'general') return 'general';
  return 'unknown';
}

module.exports = { classify, kindOf, extOf, renditionStem, relatedRenditions, audienceOf, CACHE_DIRS };
