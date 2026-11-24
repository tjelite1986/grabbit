'use strict';
// Preloaded with `node -r` by the audience gate tests: replaces the extractor
// registry's resolve() so the server never reaches a real site. A URL
// http://fake.test/<kind>/<site>/<creator>/<id> resolves to a direct download
// served by the test's own loopback server (FAKE_MEDIA_BASE).
const extractors = require('../../extractors');

const BASE = process.env.FAKE_MEDIA_BASE;

extractors.resolve = async (url) => {
  const u = new URL(url);
  const [kind, site, creator, id] = u.pathname.split('/').slice(1).map(decodeURIComponent);
  const image = kind === 'image';
  // The item id is part of the media path, so the loopback server can tell
  // which job a request belongs to (the guard-jobs FIFO test needs that).
  const file = `${BASE}/media/${encodeURIComponent(id)}/${image ? 'pic.jpg' : 'clip.mp4'}`;
  const job = {
    extractor: 'fake',
    kind: 'direct',
    downloadUrl: file,
    url: file,
    mediaType: image ? 'image' : 'video',
    ext: image ? 'jpg' : 'mp4',
    creator: creator === '-' ? null : creator,
    title: `clip ${id}`,
    tags: [],
    duration: 5,
    site,
    mediaId: id,
    sourceUrl: url,
  };
  job.sourceCreator = job.creator;
  // ?adult=1 stands in for a site's own 18+ flag on the item (yt-dlp age_limit).
  if (u.searchParams.get('adult') === '1') job.audience = 'adult';
  // ?title= gives two sources the same title (and so the same file name).
  if (u.searchParams.get('title')) job.title = u.searchParams.get('title');
  // ?w=&h= give the pixel size smart routing reads; ?dur= the length.
  if (u.searchParams.get('w')) job.width = Number(u.searchParams.get('w'));
  if (u.searchParams.get('h')) job.height = Number(u.searchParams.get('h'));
  if (u.searchParams.get('dur')) job.duration = Number(u.searchParams.get('dur'));
  // ?probe=fatal|transient stands in for a failed yt-dlp metadata probe: the
  // real generic extractor then leaves the creator 'unknown' and no title.
  const probe = u.searchParams.get('probe');
  if (probe) {
    Object.assign(job, { creator: 'unknown', sourceCreator: 'unknown', title: undefined });
    job.probeError =
      probe === 'fatal'
        ? `ERROR: [TikTok] ${id}: No video formats found!; please report this issue on  https://github.com/yt-dlp/yt-dlp/issues?q= , filling out the appropriate issue template.`
        : 'Timed out reading metadata';
    job.probeFatal = probe === 'fatal';
  }
  // ?thumb=1 gives the item a site picture on the loopback server.
  if (u.searchParams.get('thumb') === '1') job.thumbnail = `${BASE}/thumbs/${encodeURIComponent(id)}.jpg`;
  return job;
};
extractors.isProfile = () => false;

// A profile URL http://fake.test/profile/<site>/<creator>/<count> lists
// <count> fake videos (ids <creator>-p1 ... -pN), each resolved as above.
// Used by the /api/download-all guard test.
extractors.resolveProfile = async (url) => {
  const u = new URL(url);
  const [kind, site, creator, count] = u.pathname.split('/').slice(1).map(decodeURIComponent);
  if (kind !== 'profile') throw new Error(`fake extractors: not a profile URL: ${url}`);
  const items = [];
  for (let i = 1; i <= Number(count); i++) {
    const id = `${creator}-p${i}`;
    const itemUrl = `http://fake.test/video/${encodeURIComponent(site)}/${encodeURIComponent(creator)}/${encodeURIComponent(id)}`;
    items.push({ ...(await extractors.resolve(itemUrl)), id });
  }
  return { creator, items };
};
