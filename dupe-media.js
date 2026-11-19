'use strict';
// Reads what the photo and video engines need from a media file, with ffprobe
// and ffmpeg (both already in the image), at low CPU and I/O priority.
//
// Read only: ffmpeg gets the file as an input and writes raw frames to pipes;
// nothing is written next to the media. Every call has a timeout and a cap on
// how much output it accepts.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

// nice/ionice when the system has them (Debian images do).
let prefix = null;
function lowPriority() {
  if (prefix) return prefix;
  prefix = [];
  const has = (bin) => {
    try { return spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 2000 }).status === 0; } catch { return false; }
  };
  if (has('ionice')) prefix.push('ionice', '-c3');
  if (has('nice')) prefix.push('nice', '-n', '15');
  return prefix;
}

function run(bin, args, { timeoutMs = 120000, maxBytes = 64 * 1024 * 1024, extraFd = false, stderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const pre = lowPriority();
    const cmd = pre.length ? pre[0] : bin;
    const argv = pre.length ? [...pre.slice(1), bin, ...args] : args;
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe', ...(extraFd ? ['pipe'] : [])] });
    const out = [];
    const out3 = [];
    let size = 0;
    let err = '';
    let killed = null;
    const timer = setTimeout(() => { killed = 'timed out'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { killed = 'output too large'; child.kill('SIGKILL'); return; }
      out.push(c);
    });
    if (extraFd) child.stdio[3].on('data', (c) => out3.push(c));
    child.stderr.on('data', (c) => { if (err.length < (stderr ? 4 * 1024 * 1024 : 4000)) err += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${bin} ${killed}`));
      if (code !== 0) return reject(new Error(`${bin} failed: ${err.split('\n').filter(Boolean).slice(-1)[0] || `exit ${code}`}`));
      resolve({ stdout: Buffer.concat(out), fd3: Buffer.concat(out3), stderr: err });
    });
  });
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const rate = (r) => {
  if (!r || typeof r !== 'string') return null;
  const [a, b] = r.split('/').map(Number);
  return b ? Math.round((a / b) * 100) / 100 : num(a);
};

// Container, duration, bitrate and the first video and audio stream.
async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,bit_rate:stream_side_data=rotation',
    '-of', 'json', '--', file], { timeoutMs: 30000, maxBytes: 1024 * 1024 });
  const j = JSON.parse(stdout.toString('utf8'));
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const a = streams.find((s) => s.codec_type === 'audio') || {};
  const f = j.format || {};
  let w = num(v.width);
  let h = num(v.height);
  const rot = ((v.side_data_list || []).find((d) => d.rotation != null) || {}).rotation;
  if (rot && Math.abs(Number(rot)) % 180 === 90) [w, h] = [h, w];
  return {
    width: w,
    height: h,
    duration: num(f.duration),
    fps: rate(v.avg_frame_rate),
    vcodec: v.codec_name || null,
    acodec: a.codec_name || null,
    bitrate: num(f.bit_rate) || num(v.bit_rate),
    container: f.format_name ? String(f.format_name).split(',')[0] : null,
  };
}

// One picture: a 64x64 greyscale frame (whole picture, squashed) and, when
// asked, the 224x224 RGB centre crop DINOv2 expects (short side to 256 with
// bicubic, then the centre 224 square; the same preprocessing as
// photo-duplicate-finder-ai's preprocess()).
async function readImage(file, { rgb = false } = {}) {
  const gray = '[g]scale=64:64:flags=area,format=gray[go]';
  const args = ['-nostdin', '-v', 'error', '-i', file];
  if (rgb) {
    args.push('-filter_complex', `[0:v]split=2[g][c];${gray};[c]scale=256:256:force_original_aspect_ratio=increase:flags=bicubic,crop=224:224,format=rgb24[co]`,
      '-map', '[go]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
      '-map', '[co]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:3');
  } else {
    args.push('-filter_complex', `[0:v]null[g];${gray}`, '-map', '[go]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1');
  }
  // `--` is not understood by ffmpeg; the path is passed as an -i value, and
  // the caller only hands over paths inside a scan root.
  const r = await run(FFMPEG, args, { timeoutMs: 60000, maxBytes: 1024 * 1024, extraFd: rgb });
  if (r.stdout.length !== 4096) throw new Error('could not decode the picture');
  if (rgb && r.fd3.length !== 224 * 224 * 3) throw new Error('could not decode the picture');
  return { gray: r.stdout, rgb: rgb ? r.fd3 : null };
}

// Keyframes of a video as 64x64 greyscale frames with their times. Decoding
// only keyframes is several times faster than seeking; a re-encode puts its
// keyframes elsewhere, so the matcher compares by time with a tolerance.
async function readVideoFrames(file, { maxFrames = 240, timeoutMs = 15 * 60 * 1000 } = {}) {
  const r = await run(FFMPEG, ['-nostdin', '-v', 'info', '-skip_frame', 'nokey', '-i', file, '-an', '-sn', '-dn',
    '-vf', 'showinfo,scale=64:64:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'],
  { timeoutMs, maxBytes: 4096 * 20000, stderr: true });
  const times = [];
  for (const m of r.stderr.matchAll(/pts_time:\s*(-?[0-9.]+)/g)) times.push(Number(m[1]));
  const n = Math.floor(r.stdout.length / 4096);
  const frames = [];
  for (let i = 0; i < n; i++) frames.push({ t: times[i] != null ? times[i] : i, gray: r.stdout.subarray(i * 4096, (i + 1) * 4096) });
  if (frames.length <= maxFrames) return frames;
  const step = frames.length / maxFrames;
  const out = [];
  for (let i = 0; i < maxFrames; i++) out.push(frames[Math.floor(i * step)]);
  return out;
}

// Frames at exact relative positions (fractions of the duration), one fast
// input seek each. Two encodes of one video give the same picture at the same
// time, wherever their keyframes are.
async function readFramesAt(file, duration, fractions) {
  const out = [];
  for (const f of fractions) {
    const t = Math.max(0, duration * f);
    try {
      const r = await run(FFMPEG, ['-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', file, '-an', '-sn', '-dn', '-frames:v', '1',
        '-vf', 'scale=64:64:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1'], { timeoutMs: 60000, maxBytes: 8192 });
      out.push(r.stdout.length === 4096 ? { t, gray: r.stdout } : { t, gray: null });
    } catch {
      out.push({ t, gray: null });
    }
  }
  return out;
}

const exists = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

module.exports = { probe, readImage, readVideoFrames, readFramesAt, run, exists };
