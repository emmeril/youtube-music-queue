(() => {
  'use strict';

  const RUNTIME_KEY = '__ytmBridgePagePlayer';
  const STORAGE_KEY = 'ytmBridgePendingAutoplayVideoId';
  const SEARCH_STORAGE_KEY = 'ytmBridgePendingSearchUrl';
  if (window[RUNTIME_KEY]) return;

  const runtime = {
    expectedVideoId: '',
    intervalId: null,
    monitorId: null,
    attempts: 0
  };
  window[RUNTIME_KEY] = runtime;

  function getVideoId(url) {
    try {
      return new URL(url, window.location.origin).searchParams.get('v') || '';
    } catch (error) {
      return '';
    }
  }

  function readExpectedVideoId() {
    const datasetValue = document.documentElement?.dataset?.ytmBridgeAutoplayVideoId || '';
    if (datasetValue) return datasetValue;
    try {
      return window.sessionStorage.getItem(STORAGE_KEY) || '';
    } catch (error) {
      return runtime.expectedVideoId;
    }
  }

  function getCurrentVideoId() {
    const urlVideoId = getVideoId(window.location.href);
    if (urlVideoId) return urlVideoId;

    const playerLink = document.querySelector(
      'ytmusic-player-bar .title a[href*="watch?v="], ytmusic-player-bar a[href*="watch?v="]'
    );
    return getVideoId(playerLink?.getAttribute('href') || playerLink?.href || '');
  }

  function clearPendingPlayback() {
    runtime.expectedVideoId = '';
    runtime.attempts = 0;
    if (runtime.intervalId) {
      clearInterval(runtime.intervalId);
      runtime.intervalId = null;
    }
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
      delete document.documentElement.dataset.ytmBridgeAutoplayVideoId;
    } catch (error) {
      // Ignore storage failures; the runtime state is already cleared.
    }
  }

  async function attemptPlayback() {
    runtime.expectedVideoId = readExpectedVideoId();
    if (!runtime.expectedVideoId) {
      clearPendingPlayback();
      return;
    }

    runtime.attempts++;
    const currentVideoId = getCurrentVideoId();
    if (!currentVideoId || currentVideoId !== runtime.expectedVideoId) {
      return;
    }

    const player = document.querySelector('#movie_player');
    try {
      if (typeof player?.playVideo === 'function') {
        player.playVideo();
      }
    } catch (error) {
      // Fall through to the native video and visible player controls.
    }

    const video = document.querySelector('video');
    if (video?.paused) {
      try {
        await video.play();
      } catch (error) {
        const playerButton = document.querySelector(
          'ytmusic-player-bar #play-pause-button, ytmusic-player-bar button[aria-label*="Play"], ' +
          'ytmusic-player-bar button[aria-label*="Putar"], #movie_player .ytp-play-button'
        );
        playerButton?.click();
      }
    }

    if (video && !video.paused && currentVideoId === runtime.expectedVideoId) {
      try {
        window.sessionStorage.removeItem(SEARCH_STORAGE_KEY);
      } catch (error) {
        // Playback has already started; storage cleanup can be skipped.
      }
      clearPendingPlayback();
    } else if (runtime.attempts >= 30) {
      clearPendingPlayback();
    }
  }

  function startPlaybackAttempts() {
    runtime.expectedVideoId = readExpectedVideoId();
    runtime.attempts = 0;
    if (!runtime.expectedVideoId) return;

    if (runtime.intervalId) clearInterval(runtime.intervalId);
    attemptPlayback();
    runtime.intervalId = setInterval(attemptPlayback, 500);
  }

  window.addEventListener('ytm-bridge-request-playback', startPlaybackAttempts);
  window.addEventListener('ytm-bridge-cancel-playback', clearPendingPlayback);
  runtime.monitorId = setInterval(() => {
    if (!runtime.intervalId && readExpectedVideoId()) {
      startPlaybackAttempts();
    }
  }, 500);
  if (readExpectedVideoId()) {
    startPlaybackAttempts();
  }
})();
