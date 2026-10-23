'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateMatchConfidence,
  generateSessionToken,
  isBlankPassword,
  normalizePassword,
  timingSafeStringEqual
} = require('../server-utils');

test('preserves password characters and spacing exactly', () => {
  const password = '  <admin>{ secret }  ';

  assert.equal(normalizePassword(password), password);
  assert.equal(isBlankPassword(password), false);
  assert.equal(isBlankPassword('   '), true);
});

test('creates cryptographically random session tokens', () => {
  const first = generateSessionToken();
  const second = generateSessionToken();

  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('compares secrets safely without coercing invalid values', () => {
  assert.equal(timingSafeStringEqual('same', 'same'), true);
  assert.equal(timingSafeStringEqual('same', 'different'), false);
  assert.equal(timingSafeStringEqual(undefined, 'undefined'), false);
});

test('handles missing song metadata without throwing', () => {
  assert.equal(calculateMatchConfidence('Numb - Linkin Park', undefined, undefined), 0);
  assert.equal(calculateMatchConfidence('Numb', 'Numb', 'Linkin Park'), 100);
});
