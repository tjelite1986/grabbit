'use strict';
// Text scan for code that uses the global fetch() directly instead of
// safeFetch() (url-guard.js). Shared by test/guard-url.test.js (pins the D2
// list) and test/known-gaps.test.js (D2 desired end state), so both judge the
// same thing.
//
// This is a TEXT scan, not a parser. It catches the usual call shapes
// (`fetch(u)`, `fetch (u)`, `globalThis.fetch(u)`) and a bare reference that
// could be called later (`const f = fetch;`, `(fetch)(u)`, `{ fetch }`). It
// ignores `safeFetch(`, `obj.fetch(` and names like `prefetch(`. Comments are
// stripped first, so prose that mentions fetch does not count. Code built at
// run time (`globalThis['fe' + 'tch']`) is out of reach; review catches that.
// No module has side effects when loaded on its own (node --test loads it).
const fs = require('fs');
const path = require('path');

const PLAIN_FETCH = /(?<![\w$.])fetch\s*\(|\bglobalThis\s*\.\s*fetch\b|(?<![\w$.])fetch\s*(?:[;,)}\]]|$)/m;

// Drop block comments and `//` line comments. A `//` right after `:` is kept,
// so URLs in strings (`https://...`) are not mistaken for comments.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
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
