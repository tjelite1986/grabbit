'use strict';
// Rule field cleaning and pattern matching for the rules engine, moved verbatim
// out of server.js (Phase 2, slice 6). Pure and stateless: no I/O, no requires,
// no module state. Callers in server.js: sanitizeRules (cleanRuleStr,
// rulePatternError) and matchRule (ruleTextMatch, which calls validRulePattern).

function cleanRuleStr(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// A rule's regex runs on the main thread on every resolve, and a RegExp cannot
// be timed out in-process. One catastrophically backtracking pattern therefore
// hangs the whole server until it is restarted. Two guards, because neither is
// complete on its own: refuse the shapes that backtrack exponentially, and cap
// the input so a shape that slips through has nothing long to chew on.
const RULE_VALUE_MAX = 500;

// True when a quantified group's body itself quantifies or alternates — (a+)+,
// (a|a)*, (\d?){3}. That nesting is what turns a failed match into 2^n work.
// Walked rather than pattern-matched so escapes, character classes and the
// (?:  (?=  (?<name>  prefixes are not mistaken for the real thing.
function hasNestedQuantifier(re) {
  const bodyRepeats = []; // one flag per open group
  let inClass = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') { i++; continue; } // escaped: never syntax
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') {
      bodyRepeats.push(false);
      // Skip the group prefix so its '?' is not read as a quantifier.
      if (re[i + 1] === '?') {
        const k = re[i + 2];
        if (k === ':' || k === '=' || k === '!') i += 2;
        else if (k === '<' && (re[i + 3] === '=' || re[i + 3] === '!')) i += 3;
        else if (k === '<') { const end = re.indexOf('>', i + 3); i = end === -1 ? re.length : end; }
      }
      continue;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{' || c === '|') {
      if (bodyRepeats.length) bodyRepeats[bodyRepeats.length - 1] = true;
      continue;
    }
    if (c === ')') {
      const repeats = bodyRepeats.pop();
      const next = re[i + 1];
      const quantified = next === '*' || next === '+' || next === '{';
      if (repeats && quantified) return true;
      // To its parent, a quantified group is itself a repetition.
      if (bodyRepeats.length && (quantified || next === '?')) {
        bodyRepeats[bodyRepeats.length - 1] = true;
      }
    }
  }
  return false;
}

// A pattern is a case-insensitive substring, or /…/ for a regex. Returns the
// reason it cannot be used, or null when it is fine — the save path shows that
// reason instead of dropping the field, because a dropped condition silently
// turns the rule into a catch-all.
function rulePatternError(p) {
  if (!(p.length > 2 && p.startsWith('/') && p.endsWith('/'))) return null; // substring
  const body = p.slice(1, -1);
  try {
    new RegExp(body, 'i');
  } catch (e) {
    return `not a valid regular expression: ${e.message}`;
  }
  if (hasNestedQuantifier(body)) {
    return 'a repeated group that itself repeats or alternates (e.g. "(a+)+") can hang the server on a near-miss; rewrite it or use a plain substring';
  }
  return null;
}

function validRulePattern(p) {
  return !rulePatternError(p);
}

function ruleTextMatch(pattern, value) {
  // Titles are the long field here, and only their first few hundred
  // characters can plausibly carry a rule's condition.
  const v = String(value || '').slice(0, RULE_VALUE_MAX);
  const p = String(pattern);
  if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
    // Checked again at match time, not just at save time: rules.json is a file
    // on disk, and one written before this check (or by hand) still runs here.
    if (!validRulePattern(p)) return false;
    try {
      return new RegExp(p.slice(1, -1), 'i').test(v);
    } catch {
      return false;
    }
  }
  return v.toLowerCase().includes(p.toLowerCase());
}

module.exports = { cleanRuleStr, RULE_VALUE_MAX, hasNestedQuantifier, rulePatternError, validRulePattern, ruleTextMatch };
