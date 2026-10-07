'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FAIR_RANDOM_WEIGHT_BANDS,
  buildFairRandomSelectionWeights,
  buildGeminiFairRandomProfile,
  getRequestFairRandomProfile,
  pickWeightedIndex
} = require('../fair-random');

test('keeps category bands in the requested order', () => {
  assert.ok(FAIR_RANDOM_WEIGHT_BANDS.dangdut_koplo.min > FAIR_RANDOM_WEIGHT_BANDS.indonesia.max);
  assert.ok(FAIR_RANDOM_WEIGHT_BANDS.indonesia.min > FAIR_RANDOM_WEIGHT_BANDS.western.max);
  assert.ok(FAIR_RANDOM_WEIGHT_BANDS.western.min > FAIR_RANDOM_WEIGHT_BANDS.korean_kpop.max);
});

test('keeps Gemini weights inside the configured category bands', () => {
  assert.deepEqual(buildGeminiFairRandomProfile('dangdut_koplo', 120), {
    category: 'dangdut_koplo',
    weight: 100,
    source: 'gemini'
  });
  assert.deepEqual(buildGeminiFairRandomProfile('indonesia', 40), {
    category: 'indonesia',
    weight: 51,
    source: 'gemini'
  });
  assert.deepEqual(buildGeminiFairRandomProfile('western', 45), {
    category: 'western',
    weight: 45,
    source: 'gemini'
  });
  assert.deepEqual(buildGeminiFairRandomProfile('kpop', 30), {
    category: 'korean_kpop',
    weight: 25,
    source: 'gemini'
  });
});

test('uses a neutral fallback when Gemini does not return a valid profile', () => {
  assert.deepEqual(buildGeminiFairRandomProfile('unknown', null), {
    category: 'unclassified',
    weight: 50,
    source: 'fallback'
  });
  assert.deepEqual(buildGeminiFairRandomProfile('western', null), {
    category: 'unclassified',
    weight: 50,
    source: 'fallback'
  });
  assert.deepEqual(getRequestFairRandomProfile({}), {
    category: 'unclassified',
    weight: 50,
    source: 'fallback'
  });
});

test('combines Gemini weight with queue age', () => {
  const requests = [
    { fairRandomCategory: 'korean_kpop', fairRandomWeight: 20, fairRandomSource: 'gemini' },
    { fairRandomCategory: 'dangdut_koplo', fairRandomWeight: 90, fairRandomSource: 'gemini' },
    { fairRandomCategory: 'western', fairRandomWeight: 40, fairRandomSource: 'gemini' }
  ];

  assert.deepEqual(buildFairRandomSelectionWeights(requests), [60, 180, 40]);
});

test('selects an index from the computed weight distribution', () => {
  assert.equal(pickWeightedIndex([60, 180, 40], () => 0), 0);
  assert.equal(pickWeightedIndex([60, 180, 40], () => 0.5), 1);
  assert.equal(pickWeightedIndex([60, 180, 40], () => 0.99), 2);
});
