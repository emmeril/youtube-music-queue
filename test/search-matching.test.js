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

test('matches song titles that differ only by spaces', () => {
  const { SearchAutoplay } = loadSearchMatching();
  const matcher = new SearchAutoplay();
  const target = {
    titleTokens: ['kusumawijaya'],
    artistTokens: ['ajeng', 'febria']
  };

  assert.equal(matcher.isCandidateTargetMatch({
    title: 'kusuma wijaya',
    subtitle: 'ajeng febria',
    text: 'kusuma wijaya ajeng febria'
  }, target), true);
  assert.equal(matcher.isCandidateTargetMatch({
    title: 'kusuma wijaya',
    subtitle: 'artis lain',
    text: 'kusuma wijaya artis lain'
  }, target), false);
});

test('plays a search result when title and artist each have a meaningful partial match', () => {
  const { SearchAutoplay } = loadSearchMatching();
  const matcher = new SearchAutoplay();
  const target = {
    titleTokens: ['tamu', 'undangan'],
    artistTokens: ['dede', 'resti']
  };

  assert.equal(matcher.isCandidateTargetMatch({
    title: 'tamu kondangan',
    subtitle: 'dede risty',
    text: 'tamu kondangan live dede risty'
  }, target), true);
  assert.equal(matcher.isCandidateTargetMatch({
    title: 'tamu kondangan',
    subtitle: 'penyanyi lain',
    text: 'tamu kondangan penyanyi lain'
  }, target), false);
  assert.equal(matcher.isCandidateAllowedForSearch('tamu kondangan live dede risty', 0), true);
});

test('builds a focused search query without generic suffixes', () => {
  const { RequestProcessor } = loadSearchMatching();

  assert.equal(
    RequestProcessor.buildSearchQuery({ title: 'bubrah 2', artist: 'nikem', rawQuery: 'Bubrah 2 - Nikem' }),
    'bubrah 2 nikem'
  );
});
