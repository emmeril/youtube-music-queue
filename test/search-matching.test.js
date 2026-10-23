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
const songManagerStart = contentSource.indexOf('class SongManager');
const songManagerEnd = contentSource.indexOf('// ================= SEARCH AUTOPLAY');
const songManagerSource = `${contentSource.slice(songManagerStart, songManagerEnd)}\n` +
  'globalThis.LoadedSongManager = SongManager;';

function loadSearchMatching(overrides = {}) {
  const context = {
    CONFIG: { SEARCH_TIMEOUT: 15000 },
    getSearchDurationSettings: () => ({ minSeconds: 1, maxSeconds: 900 }),
    ...overrides
  };
  vm.runInNewContext(matchingSource, context);
  return context.SearchMatching;
}

function loadSongManager(overrides = {}) {
  const context = { ...overrides };
  vm.runInNewContext(songManagerSource, context);
  return context.LoadedSongManager;
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

test('uses the timeout fallback instead of silently stopping the search', () => {
  let timeoutCallback;
  const { SearchAutoplay } = loadSearchMatching({
    setInterval: () => 1,
    setTimeout: (callback) => {
      timeoutCallback = callback;
      return 2;
    }
  });
  const matcher = new SearchAutoplay();
  let fallbackCalls = 0;
  matcher.tryAlternativeMethods = () => {
    fallbackCalls++;
  };

  matcher.start();
  timeoutCallback();

  assert.equal(fallbackCalls, 1);
});

test('only clicks the YouTube Music song filter chip', () => {
  class FakeHTMLElement {}
  let selectedSelector = '';
  let clickCount = 0;
  const songChip = new FakeHTMLElement();
  songChip.textContent = 'Lagu';
  songChip.getAttribute = () => 'false';
  songChip.hasAttribute = () => false;
  songChip.classList = { contains: () => false };
  songChip.click = () => {
    clickCount++;
  };

  const { SearchAutoplay } = loadSearchMatching({
    HTMLElement: FakeHTMLElement,
    document: {
      querySelectorAll: (selector) => {
        selectedSelector = selector;
        return [songChip];
      }
    }
  });
  const matcher = new SearchAutoplay();

  assert.equal(matcher.ensureSongFilterApplied(), true);
  assert.equal(selectedSelector, 'ytmusic-chip-cloud-chip-renderer [role="tab"]');
  assert.equal(clickCount, 1);
});

test('matches blocked labels as whole terms, not parts of artist names', () => {
  const { SearchAutoplay } = loadSearchMatching();
  const matcher = new SearchAutoplay();

  assert.equal(matcher.hasWholeTerm('Oliver Tree - Miss You', 'live'), false);
  assert.equal(matcher.hasWholeTerm('Numb - Live in Texas', 'live'), true);
});

test('scores the exact song title above an extended title', () => {
  const { SearchAutoplay } = loadSearchMatching();
  const matcher = new SearchAutoplay();
  const target = {
    title: 'numb',
    artist: 'linkin park',
    titleTokens: ['numb'],
    artistTokens: ['linkin', 'park']
  };
  const exact = {
    title: 'numb',
    subtitle: 'linkin park',
    text: 'numb linkin park song official audio 3:07'
  };
  const extended = {
    title: 'numb encore',
    subtitle: 'jay z linkin park',
    text: 'numb encore jay z linkin park song official audio 3:25'
  };

  assert.ok(
    matcher.scoreRow(exact, 187, target) > matcher.scoreRow(extended, 205, target)
  );
});

test('keeps a YouTube-ranked song candidate even when metadata is not exact', () => {
  const row = { innerText: 'Numb Linkin Park Official 3:07' };
  const { SearchAutoplay, RequestProcessor } = loadSearchMatching({
    document: {
      querySelectorAll: () => [row]
    }
  });
  RequestProcessor.getSearchTarget = () => ({
    title: 'numb',
    artist: 'linkin park',
    rawQuery: 'Numb - Linkin Park',
    titleTokens: ['numb'],
    artistTokens: ['linkin', 'park']
  });
  const matcher = new SearchAutoplay();
  matcher.findExactPlaybackTarget = () => ({
    playElement: {},
    videoId: 'youtube-result',
    watchUrl: 'https://music.youtube.com/watch?v=youtube-result'
  });
  matcher.extractDurationSeconds = () => 187;
  matcher.extractRowMeta = () => ({
    title: 'numb official audio',
    subtitle: 'official music channel',
    text: 'numb official audio official music channel 3 07'
  });

  const candidate = matcher.findBestSongCandidate();

  assert.equal(candidate.videoId, 'youtube-result');
  assert.equal(candidate.targetMatch, false);
});

test('keeps playing when YouTube metadata differs from the request', async () => {
  let clearedPendingVideo = false;
  let clearedSearch = false;
  let status = '';
  let wentBack = false;
  const { SearchAutoplay, RequestProcessor } = loadSearchMatching({
    SongManager: {
      extractSongInfo: () => ({ title: 'Numb Official Audio', artist: 'Linkin Park Topic' })
    },
    DebugPanel: {
      setStatus: (value) => {
        status = value;
      }
    },
    setPendingAutoplayVideoId: () => {
      clearedPendingVideo = true;
    },
    setTimeout: (callback) => {
      callback();
      return 1;
    }
  });
  RequestProcessor.clearPendingSearchUrl = () => {
    clearedSearch = true;
  };
  const matcher = new SearchAutoplay();
  matcher.waitForPlaybackState = async () => ({ video: {}, videoId: 'different-video' });
  matcher.hasPlaybackActuallyStarted = () => true;
  matcher.waitForCandidateDuration = async () => 187;
  matcher.shouldRejectDuration = () => false;
  matcher.isActualPlaybackMatchingTarget = () => false;
  matcher.goBackAfterDelay = () => {
    wentBack = true;
  };

  await matcher.verifyPlayback({ videoId: 'expected-video' });

  assert.equal(status, 'YouTube memilih hasil terdekat, lagu tetap diputar');
  assert.equal(clearedPendingVideo, true);
  assert.equal(clearedSearch, true);
  assert.equal(wentBack, true);
});

test('defers metadata verification while a YouTube advertisement is playing', async () => {
  let status = '';
  let retryCallback;
  let clearedPendingVideo = false;
  const { SearchAutoplay } = loadSearchMatching({
    DebugPanel: {
      setStatus: (value) => {
        status = value;
      }
    },
    setPendingAutoplayVideoId: () => {
      clearedPendingVideo = true;
    },
    setTimeout: (callback) => {
      retryCallback = callback;
      return 1;
    }
  });
  const matcher = new SearchAutoplay();
  matcher.waitForPlaybackState = async () => ({ video: {}, videoId: 'expected-video' });
  matcher.hasPlaybackActuallyStarted = () => true;
  matcher.waitForCandidateDuration = async () => 0;
  matcher.shouldRejectDuration = () => false;
  matcher.isAdvertisementPlaying = () => true;

  await matcher.verifyPlayback({ videoId: 'expected-video' });

  assert.equal(status, 'Menunggu iklan selesai, request tetap dipertahankan');
  assert.equal(typeof retryCallback, 'function');
  assert.equal(clearedPendingVideo, false);
});

test('retries the same request instead of skipping when results are not ready', () => {
  let status = '';
  let restartCalls = 0;
  let retryCallback;
  const { SearchAutoplay, RequestProcessor } = loadSearchMatching({
    DebugPanel: {
      setStatus: (value) => {
        status = value;
      }
    },
    setPendingAutoplayVideoId: () => {},
    setTimeout: (callback) => {
      retryCallback = callback;
      return 1;
    },
    window: {
      location: { href: 'https://music.youtube.com/search?q=missing' }
    }
  });
  RequestProcessor.getSearchTarget = () => ({ rawQuery: 'Missing - Artist' });
  RequestProcessor.shouldAutoplayForUrl = () => true;
  RequestProcessor.startSearchAutoplay = () => {
    restartCalls++;
  };
  const matcher = new SearchAutoplay();
  matcher.stop = () => {};

  matcher.tryAlternativeMethods();
  retryCallback();

  assert.equal(status, 'Hasil belum tampil, mencoba lagi tanpa melewati request');
  assert.equal(restartCalls, 1);
});

test('does not reject playback while video duration is still unknown', () => {
  const { SearchAutoplay } = loadSearchMatching({
    getSearchDurationSettings: () => ({ minSeconds: 90, maxSeconds: 480 })
  });
  const matcher = new SearchAutoplay();

  assert.equal(matcher.shouldRejectDuration(0), false);
  assert.equal(matcher.shouldRejectDuration(188), false);
  assert.equal(matcher.shouldRejectDuration(30), true);
});

test('skips an advertisement before verifying the requested song', () => {
  let clickCount = 0;
  const metadata = { title: 'Advertisement one', artist: 'Sponsor' };
  const skipButton = {
    disabled: false,
    click: () => {
      clickCount++;
    }
  };
  const { SearchAutoplay } = loadSearchMatching({
    navigator: { mediaSession: { metadata } },
    document: {
      querySelector: (selector) => {
        if (selector === '.ytp-ad-simple-ad-badge') {
          return { textContent: '1 of 2' };
        }
        assert.match(selector, /ytp-ad-skip-button-modern/);
        return skipButton;
      }
    }
  });
  const matcher = new SearchAutoplay();

  assert.equal(matcher.trySkipActiveAd(), true);
  assert.equal(matcher.trySkipActiveAd(), false);
  metadata.title = 'Advertisement two';
  assert.equal(matcher.trySkipActiveAd(), true);
  assert.equal(clickCount, 2);
});

test('uses Media Session metadata when the player bar has not rendered', () => {
  const SongManager = loadSongManager({
    navigator: {
      mediaSession: {
        metadata: { title: 'Numb', artist: 'Linkin Park' }
      }
    },
    document: {
      title: 'YouTube Music',
      querySelector: () => null
    }
  });

  const songInfo = SongManager.extractSongInfo();
  assert.equal(songInfo.title, 'Numb');
  assert.equal(songInfo.artist, 'Linkin Park');
});
