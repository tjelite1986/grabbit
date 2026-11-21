'use strict';
// Parity for the Phase 2 slice 6 move (expected values captured from the
// pre-move server.js). A behaviour change belongs in its own commit with its
// own test update.
const test = require('node:test');
const assert = require('node:assert');
const {
  cleanRuleStr, RULE_VALUE_MAX, hasNestedQuantifier, rulePatternError, validRulePattern, ruleTextMatch,
} = require('../rule-patterns');

const NESTED = 'a repeated group that itself repeats or alternates (e.g. "(a+)+") can hang the server on a near-miss; rewrite it or use a plain substring';

test('cleanRuleStr trims and caps strings and blanks everything else', () => {
  assert.strictEqual(cleanRuleStr('  hello  ', 3), 'hel');
  assert.strictEqual(cleanRuleStr(42, 10), '');
  assert.strictEqual(cleanRuleStr(null, 10), '');
});

test('hasNestedQuantifier flags backtracking shapes only', () => {
  for (const re of ['(a+)+', '(a|a)*', '(\\d?){3}', '((a)+)+']) assert.strictEqual(hasNestedQuantifier(re), true, re);
  for (const re of ['[(a+)+]', '(?:ab)+', 'a+b', '\\(a+\\)+', '(?<n>a)+']) assert.strictEqual(hasNestedQuantifier(re), false, re);
});

test('rulePatternError explains a refused regex and passes substrings', () => {
  assert.strictEqual(rulePatternError('/(a+)+/'), NESTED);
  assert.match(rulePatternError('/(/'), /^not a valid regular expression: /);
  assert.strictEqual(rulePatternError('/a+b/'), null);
  assert.strictEqual(rulePatternError('foo'), null);
  assert.strictEqual(validRulePattern('/(a|a)*/'), false);
  assert.strictEqual(validRulePattern('/(?:ab)+/'), true);
});

test('ruleTextMatch: case-insensitive substring, guarded regex, capped input', () => {
  assert.strictEqual(RULE_VALUE_MAX, 500);
  assert.strictEqual(ruleTextMatch('YouTube', 'www.youtube.com'), true);
  assert.strictEqual(ruleTextMatch('/^www\\./', 'WWW.example.com'), true);
  assert.strictEqual(ruleTextMatch('/(a+)+$/', 'aaaa'), false);
  assert.strictEqual(ruleTextMatch('/(/', '('), false);
  assert.strictEqual(ruleTextMatch('tail', `${'x'.repeat(RULE_VALUE_MAX)}tail`), false);
  assert.strictEqual(ruleTextMatch('x', null), false);
});
