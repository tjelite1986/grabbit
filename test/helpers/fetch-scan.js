'use strict';
// Text scan for code that uses the global fetch() directly instead of
// safeFetch() (url-guard.js). Shared by test/guard-url.test.js (pins the D2
// list) and test/known-gaps.test.js (D2 desired end state), so both judge the
// same thing.
//
// This is a TEXT scan, not a parser. It catches the usual call shapes
// (`fetch(u)`, `fetch (u)`, `fetch?.(u)`, `fetch.call(...)`,
// `globalThis.fetch(u)`, `window.fetch`, `globalThis['fetch']`) and a bare
// reference that could be called later (`const f = fetch;`, `(fetch)(u)`,
// `{ fetch }`). It ignores `safeFetch(`, `obj.fetch(` and names like
// `prefetch(`. Comments are stripped first (string text is kept), so prose
// that mentions fetch does not count. Code built at run time
// (`globalThis['fe' + 'tch']`) is out of reach; review catches that.
// No module has side effects when loaded on its own (node --test loads it).
const fs = require('fs');
const path = require('path');

const PLAIN_FETCH = new RegExp(
  [
    // fetch(u), fetch (u), fetch?.(u), fetch.call/apply/bind(...)
    String.raw`(?<![\w$.])fetch\s*(?:\(|\?\.|\.\s*(?:call|apply|bind)\b)`,
    // globalThis.fetch, window.fetch, self.fetch, globalThis['fetch']
    String.raw`(?<![\w$.])(?:globalThis|window|self)\s*(?:\.\s*fetch\b|\[\s*['"${'`'}]fetch['"${'`'}]\s*\])`,
    // a bare reference that can be called later: const f = fetch; (fetch)(u); { fetch }
    String.raw`(?<![\w$.])fetch\s*(?:[;,)}\]]|$)`,
  ].join('|'),
  'm'
);

// Drop `//` and `/* */` comments, keeping string and template literal text
// as it is (a `//` or `/*` inside a string is not a comment). A small
// scanner, not a parser: a regex literal that contains `//` may end a line
// early, which can only hide code on the same line after it.
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < src.length) out += src[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      out += c + src[++i];
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

function usesPlainFetch(src) {
  return stripComments(src).split('\n').some((line) => PLAIN_FETCH.test(line));
}

// Sorted .js file names in dir whose code uses plain fetch.
function plainFetchFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => usesPlainFetch(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort();
}

module.exports = { PLAIN_FETCH, stripComments, usesPlainFetch, plainFetchFiles };
