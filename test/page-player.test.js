'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pagePlayerSource = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'page-player.js'),
  'utf8'
);

function createPageContext({ currentVideoId, expectedVideoId }) {
  const storage = new Map([['ytmBridgePendingAutoplayVideoId', expectedVideoId]]);
  const listeners = new Map();
  const video = {
    paused: true,
    playCalls: 0,
    async play() {
      this.playCalls++;
      this.paused = false;
    }
  };
  const player = {
    playCalls: 0,
    playVideo() {
      this.playCalls++;
    }
  };
  const documentElement = { dataset: {} };
  const document = {
    documentElement,
    querySelector(selector) {
      if (selector === '#movie_player') return player;
      if (selector === 'video') return video;
      return null;
    }
  };
  const window = {
    location: {
      href: `https://music.youtube.com/watch?v=${currentVideoId}`,
      origin: 'https://music.youtube.com'
    },
    sessionStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      }
    },
    addEventListener(name, listener) {
      listeners.set(name, listener);
    }
  };
  window.window = window;

  let intervalSequence = 0;
  const context = {
    URL,
    window,
    document,
    setInterval() {
      intervalSequence++;
      return intervalSequence;
    },
    clearInterval() {}
  };

  vm.runInNewContext(pagePlayerSource, context);
  return { storage, video, player };
}

test('starts playback only when the loaded video ID matches the queued candidate', async () => {
  const matching = createPageContext({
    currentVideoId: 'requested123',
    expectedVideoId: 'requested123'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(matching.player.playCalls, 1);
  assert.equal(matching.video.playCalls, 1);
  assert.equal(matching.storage.has('ytmBridgePendingAutoplayVideoId'), false);

  const mismatched = createPageContext({
    currentVideoId: 'different456',
    expectedVideoId: 'requested123'
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(mismatched.player.playCalls, 0);
  assert.equal(mismatched.video.playCalls, 0);
  assert.equal(mismatched.storage.get('ytmBridgePendingAutoplayVideoId'), 'requested123');
});
