'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contentSource = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'content.js'),
  'utf8'
);
const classStart = contentSource.indexOf('class SearchAutoplay');
const classEnd = contentSource.indexOf('// ================= SERVER API');
const matchingSource = `${contentSource.slice(classStart, classEnd)}\n` +
  'globalThis.SearchMatching = { SearchAutoplay, RequestProcessor };';

function loadSearchMatching() {
  const context = { CONFIG: { SEARCH_TIMEOUT: 15000 } };
  vm.runInNewContext(matchingSource, context);
  return context.SearchMatching;
}

test('requires an exact artist token match', () => {
  const { SearchAutoplay } = loadSearchMatching();
  const matcher = new SearchAutoplay();

  assert.equal(matcher.countTokenMatches('niken salindry', ['nikem']), 0);
  assert.equal(matcher.countTokenMatches('nikem salindry', ['nikem']), 1);
  assert.equal(matcher.countTokenMatches('northsle topic', ['nikem']), 0);
});

test('builds a focused search query without generic suffixes', () => {
  const { RequestProcessor } = loadSearchMatching();

  assert.equal(
    RequestProcessor.buildSearchQuery({ title: 'bubrah 2', artist: 'nikem', rawQuery: 'Bubrah 2 - Nikem' }),
    'bubrah 2 nikem'
  );
});
