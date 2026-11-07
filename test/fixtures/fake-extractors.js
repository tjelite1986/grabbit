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
  const job = {
    extractor: 'fake',
    kind: 'direct',
    downloadUrl: `${BASE}/media/${image ? 'pic.jpg' : 'clip.mp4'}`,
    url: `${BASE}/media/${image ? 'pic.jpg' : 'clip.mp4'}`,
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
  return job;
};
extractors.isProfile = () => false;
