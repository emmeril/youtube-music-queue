'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSongWithGemini, parseGeminiJson } = require('../gemini-song-normalizer');

test('returns the original metadata when no API key is configured', async () => {
  const result = await normalizeSongWithGemini({
    title: '  Anti-Hero ',
    artist: ' Taylor Swift  '
  });

  assert.equal(result.title, 'Anti-Hero');
  assert.equal(result.artist, 'Taylor Swift');
  assert.equal(result.usedGemini, false);
  assert.equal(result.changed, false);
});

test('uses valid structured metadata returned by Gemini', async () => {
  let requestBody = null;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{ text: '{"title":"Blinding Lights","artist":"The Weeknd","confidence":0.98}' }]
          }
        }]
      })
    };
  };

  const result = await normalizeSongWithGemini({
    title: 'blinding light',
    artist: 'weekend',
    apiKey: 'test-key',
    fetchImpl
  });

  assert.equal(result.title, 'Blinding Lights');
  assert.equal(result.artist, 'The Weeknd');
  assert.equal(result.usedGemini, true);
  assert.equal(result.changed, true);
  assert.equal(requestBody.generationConfig.responseMimeType, 'application/json');
});

test('falls back when Gemini returns low-confidence metadata', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        content: {
          parts: [{ text: '{"title":"Unknown Song","artist":"Unknown Artist","confidence":0.2}' }]
        }
      }]
    })
  });

  const result = await normalizeSongWithGemini({
    title: 'Original Title',
    artist: 'Original Artist',
    apiKey: 'test-key',
    fetchImpl
  });

  assert.equal(result.title, 'Original Title');
  assert.equal(result.artist, 'Original Artist');
  assert.equal(result.usedGemini, false);
});

test('reports a timeout when the Gemini request is aborted', async () => {
  const abortError = new Error('request aborted');
  abortError.name = 'AbortError';

  const result = await normalizeSongWithGemini({
    title: 'Numb',
    artist: 'Linkin Park',
    apiKey: 'test-key',
    fetchImpl: async () => {
      throw abortError;
    }
  });

  assert.equal(result.usedGemini, false);
  assert.equal(result.reason, 'Gemini timeout');
});

test('parses JSON wrapped in a markdown code fence', () => {
  assert.deepEqual(
    parseGeminiJson('```json\n{"title":"Numb","artist":"Linkin Park"}\n```'),
    { title: 'Numb', artist: 'Linkin Park' }
  );
});
