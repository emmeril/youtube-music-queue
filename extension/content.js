// ================= KONFIGURASI =================
const CONFIG = {
  SERVER_URL: 'https://music.monse.co.id',
  SERVER_URL_STORAGE_KEY: 'ytmBridgeServerUrl',
  SEARCH_MIN_DURATION_STORAGE_KEY: 'ytmBridgeSearchMinDurationSeconds',
  SEARCH_MAX_DURATION_STORAGE_KEY: 'ytmBridgeSearchMaxDurationSeconds',
  UPDATE_INTERVAL: 500,
  REQUEST_CHECK_INTERVAL: 500,
  SEARCH_TIMEOUT: 15000,
  SEARCH_MIN_DURATION_SECONDS: 90,
  SEARCH_MAX_DURATION_SECONDS: 480,
  DEBUG: true
};

const APP_RUNTIME_KEY = '__ytmBridgeRuntime';

function getServerUrl() {
  try {
    const override = window.localStorage.getItem(CONFIG.SERVER_URL_STORAGE_KEY);
    if (override && /^https?:\/\//i.test(override)) {
      return override.replace(/\/+$/, '');
    }
  } catch (error) {
    // Fallback to the default server URL if localStorage is unavailable.
  }

  return CONFIG.SERVER_URL;
}

function normalizeServerUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed.replace(/\/+$/, '');
}

function normalizeDurationSetting(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getSearchDurationSettings() {
  try {
    const minSeconds = normalizeDurationSetting(
      window.localStorage.getItem(CONFIG.SEARCH_MIN_DURATION_STORAGE_KEY),
      CONFIG.SEARCH_MIN_DURATION_SECONDS
    );
    const maxSeconds = normalizeDurationSetting(
      window.localStorage.getItem(CONFIG.SEARCH_MAX_DURATION_STORAGE_KEY),
      CONFIG.SEARCH_MAX_DURATION_SECONDS
    );

    return {
      minSeconds: Math.min(minSeconds, maxSeconds),
      maxSeconds: Math.max(minSeconds, maxSeconds)
    };
  } catch (error) {
    return {
      minSeconds: CONFIG.SEARCH_MIN_DURATION_SECONDS,
      maxSeconds: CONFIG.SEARCH_MAX_DURATION_SECONDS
    };
  }
}

function saveSearchDurationSettings(minSeconds, maxSeconds) {
  const normalizedMin = normalizeDurationSetting(minSeconds, CONFIG.SEARCH_MIN_DURATION_SECONDS);
  const normalizedMax = normalizeDurationSetting(maxSeconds, CONFIG.SEARCH_MAX_DURATION_SECONDS);
  const nextMin = Math.min(normalizedMin, normalizedMax);
  const nextMax = Math.max(normalizedMin, normalizedMax);

  window.localStorage.setItem(CONFIG.SEARCH_MIN_DURATION_STORAGE_KEY, String(nextMin));
  window.localStorage.setItem(CONFIG.SEARCH_MAX_DURATION_STORAGE_KEY, String(nextMax));

  return { minSeconds: nextMin, maxSeconds: nextMax };
}

function resetSearchDurationSettings() {
  window.localStorage.removeItem(CONFIG.SEARCH_MIN_DURATION_STORAGE_KEY);
  window.localStorage.removeItem(CONFIG.SEARCH_MAX_DURATION_STORAGE_KEY);
  return getSearchDurationSettings();
}

async function probeServerUrl(url, timeoutMs = 1500) {
  const normalizedUrl = normalizeServerUrl(url);
  if (!normalizedUrl) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizedUrl}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function detectServerUrl() {
  const candidateUrls = [
    'http://localhost:4786',
    'http://127.0.0.1:4786',
    normalizeServerUrl(getServerUrl()),
    'https://music.monse.co.id'
  ].filter((value, index, array) => value && array.indexOf(value) === index);

  for (const candidate of candidateUrls) {
    if (await probeServerUrl(candidate)) {
      localStorage.setItem(CONFIG.SERVER_URL_STORAGE_KEY, candidate);
      return candidate;
    }
  }

  return null;
}

// ================= STATE MANAGEMENT =================
const state = {
  currentSong: {
    title: '',
    artist: '',
    duration: 0,
    timestamp: 0
  },
  lastProcessedRequest: null,
  isProcessingRequest: false,
  pendingRequestSignature: null,
  handledRequestSignature: null,
  debugMode: CONFIG.DEBUG,
  retryCount: 0,
  maxRetries: 3,
  searchTarget: null
};

function getRuntime() {
  if (!window[APP_RUNTIME_KEY]) {
    window[APP_RUNTIME_KEY] = {
      initialized: false,
      songUpdateIntervalId: null,
      requestCheckIntervalId: null,
      videoMonitor: null,
      searchAutoplay: null
    };
  }

  return window[APP_RUNTIME_KEY];
}

// ================= VIDEO MONITORING =================
class VideoMonitor {
  constructor() {
    this.video = null;
    this.lastTime = 0;
    this.lastUpdate = 0;
    this.isEnded = false;
    this.observer = null;
    this.reinitTimeoutId = null;
    this.boundOnEnded = this.onEnded.bind(this);
    this.boundOnPlaying = this.onPlaying.bind(this);
    this.boundOnTimeUpdate = this.onTimeUpdate.bind(this);
    this.init();
  }

  init() {
    this.dispose();
    this.findVideoElement();
    if (!this.video) {
      this.reinitTimeoutId = setTimeout(() => {
        this.reinitTimeoutId = null;
        this.init();
      }, 1000);
      return;
    }
    this.setupEventListeners();
    this.log('Video monitoring initialized');
  }

  findVideoElement() {
    this.video = document.querySelector('video');
    if (!this.video) {
      const videoSelectors = [
        'video',
        'ytd-player video',
        '#movie_player video',
        '.html5-main-video'
      ];

      for (const selector of videoSelectors) {
        this.video = document.querySelector(selector);
        if (this.video) break;
      }
    }
  }

  setupEventListeners() {
    if (!this.video) return;
    if (this.video.dataset.ytmBridgeBound === 'true') {
      this.setupMutationObserver();
      return;
    }

    this.video.dataset.ytmBridgeBound = 'true';

    this.video.addEventListener('ended', this.boundOnEnded);
    this.video.addEventListener('playing', this.boundOnPlaying);
    this.video.addEventListener('timeupdate', this.boundOnTimeUpdate);

    this.setupMutationObserver();
  }

  onEnded() {
    this.isEnded = true;
    this.log('Video ended - triggering next song');
    this.handleSongEnd();
  }

  onPlaying() {
    if (this.isEnded) {
      this.isEnded = false;
      this.log('New song started playing');
      setTimeout(() => SongManager.update(), 1000);
    }
  }

  onTimeUpdate() {
    if (!this.video) return;

    const now = Date.now();
    if (now - this.lastUpdate <= 1000) {
      return;
    }

    this.lastUpdate = now;

    if (this.video.currentTime < 2 && this.lastTime > 30) {
      this.log('Video reset detected - new song');
      setTimeout(() => SongManager.update(), 1500);
    }

    this.lastTime = this.video.currentTime;
  }

  setupMutationObserver() {
    if (!document.body) return;
    if (this.observer) {
      this.observer.disconnect();
    }

    this.observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && this.video && !document.contains(this.video)) {
          this.log('Video element removed, reinitializing...');
          if (!this.reinitTimeoutId) {
            this.reinitTimeoutId = setTimeout(() => {
              this.reinitTimeoutId = null;
              this.init();
            }, 500);
          }
        }
      });
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  dispose() {
    if (this.reinitTimeoutId) {
      clearTimeout(this.reinitTimeoutId);
      this.reinitTimeoutId = null;
    }

    if (this.video) {
      this.video.removeEventListener('ended', this.boundOnEnded);
      this.video.removeEventListener('playing', this.boundOnPlaying);
      this.video.removeEventListener('timeupdate', this.boundOnTimeUpdate);
      delete this.video.dataset.ytmBridgeBound;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  handleSongEnd() {
    ServerAPI.notifySongEnded()
      .then(() => {
        this.log('Server notified of song end');
        setTimeout(() => RequestProcessor.checkRequests(), 1000);
      })
      .catch((err) => this.error('Failed to notify server:', err));
  }

  log(...args) {
    if (CONFIG.DEBUG) console.log('[VideoMonitor]', ...args);
  }

  error(...args) {
    console.error('[VideoMonitor]', ...args);
  }
}

// ================= SONG MANAGER =================
class SongManager {
  static lastTitle = '';
  static lastArtist = '';
  static lastDuration = 0;
  static updateCount = 0;
  static updateInFlight = false;
  static pendingUpdate = false;

  static update() {
    try {
      if (this.updateInFlight) {
        this.pendingUpdate = true;
        return;
      }

      const songInfo = this.extractSongInfo();
      const duration = this.getDuration();

      const isNewSong = this.isNewSong(songInfo, duration);

      if (isNewSong || this.shouldForceUpdate()) {
        this.sendToServer(songInfo, duration, isNewSong);
      }
    } catch (error) {
      console.error('SongManager error:', error);
    }
  }

  static extractSongInfo() {
    const titleSelectors = [
      'ytmusic-player-bar .title',
      'ytmusic-player-bar yt-formatted-string.title',
      'ytmusic-player-bar [title]',
      'ytmusic-player-bar [aria-label]',
      '.title.ytmusic-player-bar',
      'yt-formatted-string.title',
      '[data-title]',
      'h1.title',
      '.song-title',
      'ytmusic-player-bar .yt-formatted-string[has-link-only_]'
    ];

    const artistSelectors = [
      'ytmusic-player-bar .byline',
      'ytmusic-player-bar yt-formatted-string.byline',
      'ytmusic-player-bar .subtitle',
      'ytmusic-player-bar [subtitle]',
      '.byline.ytmusic-player-bar',
      'yt-formatted-string.byline',
      '.artist-name',
      '.ytmusic-player-bar .yt-formatted-string.complex-string'
    ];

    const title = this.extractSongField(titleSelectors, 'title');
    const artist = this.extractSongField(artistSelectors, 'artist', title);

    if (title !== 'Tidak diketahui' || artist !== 'Tidak diketahui') {
      return { title, artist };
    }

    return this.extractSongInfoFromPageTitle();
  }

  static extractSongField(selectors, fieldType, title = '') {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      const candidates = [
        element.textContent,
        element.getAttribute?.('title'),
        element.getAttribute?.('aria-label'),
        element.dataset?.title,
        element.dataset?.name
      ];

      for (const candidate of candidates) {
        const cleaned = this.cleanSongText(candidate, fieldType, title);
        if (cleaned) return cleaned;
      }
    }

    return 'Tidak diketahui';
  }

  static cleanSongText(text, fieldType = 'title', title = '') {
    if (!text) return '';

    let normalized = text.trim().replace(/\s+/g, ' ');
    normalized = normalized.replace(/\u00a0/g, ' ');
    normalized = normalized.replace(/[|\u2022\u00b7\u2013\u2014]+/g, ' - ');

    if (fieldType === 'artist') {
      normalized = this.cleanArtistText(normalized);
      if (title && normalized.toLowerCase() === title.toLowerCase()) {
        return '';
      }
    }

    normalized = normalized.replace(/\b(Official|Audio|Video|Topic)\b/gi, ' ');
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized || '';
  }

  static extractSongInfoFromPageTitle() {
    const rawTitle = (document.title || '').trim();
    if (!rawTitle) {
      return { title: 'Tidak diketahui', artist: 'Tidak diketahui' };
    }

    const cleanedTitle = rawTitle.replace(/\s*[|•·–—-]\s*YouTube Music\s*$/i, '').trim();
    const parts = cleanedTitle
      .split(/\s*[-–—|•·]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        title: parts[0] || 'Tidak diketahui',
        artist: this.cleanArtistText(parts.slice(1).join(' - ')) || 'Tidak diketahui'
      };
    }

    return {
      title: cleanedTitle || 'Tidak diketahui',
      artist: 'Tidak diketahui'
    };
  }

  static cleanArtistText(text) {
    if (!text) return text;

    const separators = ['•', '·', '|', '-', '–', '—'];
    for (const separator of separators) {
      if (text.includes(separator)) {
        text = text.split(separator)[0].trim();
      }
    }

    const commonWords = ['Topic', 'VEVO', 'Official', 'Video', 'Audio'];
    commonWords.forEach((word) => {
      const regex = new RegExp(`\\s*${word}\\s*`, 'gi');
      text = text.replace(regex, ' ');
    });

    return text.trim();
  }

  static getDuration() {
    const video = document.querySelector('video');
    if (video?.duration && video.duration > 0) {
      return Math.round(video.duration * 1000);
    }

    const progressBar = document.querySelector(
      'tp-yt-paper-progress, .ytp-progress-bar'
    );
    if (progressBar) {
      const max =
        progressBar.getAttribute('aria-valuemax') ||
        progressBar.getAttribute('max') ||
        progressBar.style.getPropertyValue('--max-value');
      if (max && parseFloat(max) > 0) {
        return parseFloat(max) * 1000;
      }
    }

    const durationElements = document.querySelectorAll(
      '.ytp-time-duration, .time-info, [aria-label*="duration"], [class*="duration"]'
    );
    for (const element of durationElements) {
      const text = element.textContent || '';
      if (text.includes(':')) {
        const seconds = this.parseTimeText(text);
        if (seconds > 0) return seconds * 1000;
      }
    }

    return 180000;
  }

  static parseTimeText(text) {
    const timeMatch = text.match(/\b(?:\d{1,2}:){1,2}\d{1,2}\b/g);
    if (!timeMatch) return 0;

    const lastTime = timeMatch[timeMatch.length - 1];
    const parts = lastTime.split(':').map(Number);

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
  }

  static isNewSong(songInfo, duration) {
    const titleChanged = songInfo.title !== this.lastTitle;
    const artistChanged = songInfo.artist !== this.lastArtist;
    const durationChanged = Math.abs(duration - this.lastDuration) > 10000;

    return titleChanged || (artistChanged && songInfo.artist !== 'Tidak diketahui') || durationChanged;
  }

  static shouldForceUpdate() {
    this.updateCount++;
    if (this.updateCount >= 10) {
      this.updateCount = 0;
      return true;
    }
    return Date.now() - state.currentSong.timestamp > 30000;
  }

  static async sendToServer(songInfo, duration, isNewSong) {
    this.updateInFlight = true;
    try {
      const songData = {
        ...songInfo,
        duration,
        timestamp: Date.now(),
        isNewSong,
        url: window.location.href
      };

      const response = await fetch(`${getServerUrl()}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(songData)
      });

      if (response.ok) {
        this.lastTitle = songInfo.title;
        this.lastArtist = songInfo.artist;
        this.lastDuration = duration;
        state.currentSong = songData;

        if (isNewSong) {
          this.log(`New song detected: ${songInfo.title} - ${songInfo.artist}`);
          setTimeout(() => this.verifyRequestMatch(songInfo), 2000);
        }

        DebugPanel.update(songInfo, duration);
      }
    } catch (error) {
      console.error('Failed to send song data:', error);
    } finally {
      this.updateInFlight = false;
      if (this.pendingUpdate) {
        this.pendingUpdate = false;
        setTimeout(() => this.update(), 0);
      }
    }
  }

  static async verifyRequestMatch(songInfo) {
    try {
      const response = await fetch(`${getServerUrl()}/verify-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(songInfo)
      });

      const result = await response.json();
      if (result.isMatch && result.requestId) {
        this.log(`Song matches request: ${result.requestQuery}`);
      }
    } catch (error) {
      console.error('Error verifying match:', error);
    }
  }

  static log(...args) {
    if (CONFIG.DEBUG) console.log('[SongManager]', ...args);
  }
}

// ================= SEARCH AUTOPLAY =================
class SearchAutoplay {
  constructor() {
    this.attempts = 0;
    this.maxAttempts = 20;
    this.timeout = CONFIG.SEARCH_TIMEOUT;
    this.interval = null;
    this.timeoutId = null;
    this.songFilterApplied = false;
    this.rejectedCandidateKeys = new Set();
    this.pendingCandidate = null;
  }

  start() {
    if (this.interval) {
      return;
    }

    this.log('Starting search autoplay...');

    this.interval = setInterval(() => {
      this.attempts++;
      this.findAndPlay();
    }, 1000);

    this.timeoutId = setTimeout(() => {
      if (this.interval) {
        this.stop();
        this.log('Search autoplay timeout');
      }
    }, this.timeout);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    const runtime = getRuntime();
    if (runtime.searchAutoplay === this) {
      runtime.searchAutoplay = null;
    }
  }

  findAndPlay() {
    const video = document.querySelector('video');
    if (video && (video.currentTime > 0 || !video.paused)) {
      this.log('Video already playing, stopping search');
      this.stop();
      this.goBackAfterDelay();
      return;
    }

    this.ensureSongFilterApplied();

    const bestCandidate = this.findBestSongCandidate();
    if (bestCandidate && bestCandidate.playElement) {
      this.log(`Found candidate score=${bestCandidate.score}`);
      bestCandidate.playElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        this.pendingCandidate = bestCandidate;
        bestCandidate.playElement.click();
        this.log('Clicked best candidate play element');
        this.verifyPlayback(bestCandidate);
      }, 500);
      this.stop();
      return;
    }

    if (this.attempts >= 4) {
      const fallbackCandidate = this.findFallbackPlayElement();
      if (fallbackCandidate?.playElement) {
        this.log('No strong candidate yet, using fallback play element');
        fallbackCandidate.playElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          this.pendingCandidate = fallbackCandidate;
          fallbackCandidate.playElement.click();
          this.log('Clicked fallback play element');
          this.verifyPlayback(fallbackCandidate);
        }, 500);
        this.stop();
        return;
      }
    }

    if (this.attempts >= this.maxAttempts) {
      this.tryAlternativeMethods();
    }
  }

  ensureSongFilterApplied() {
    if (this.songFilterApplied) return;

    const filterElements = Array.from(
      document.querySelectorAll('tp-yt-paper-tab, button, yt-chip-cloud-chip-renderer')
    );

    const songFilter = filterElements.find((element) => {
      const text = (element.textContent || '').trim();
      return /\b(song|songs|lagu)\b/i.test(text);
    });

    if (songFilter && songFilter instanceof HTMLElement) {
      this.songFilterApplied = true;
      songFilter.click();
      this.log('Applied song filter from search chips');
    }
  }

  findBestSongCandidate() {
    const rows = Array.from(document.querySelectorAll('ytmusic-responsive-list-item-renderer')).slice(0, 15);
    if (!rows.length) return undefined;
    const target = RequestProcessor.getSearchTarget();

    const candidates = [];
    for (const row of rows) {
      const playElement = this.findPlayButton(row);
      if (!playElement) continue;

      const rowText = RequestProcessor.normalizeText(row.innerText || '');
      const durationSeconds = this.extractDurationSeconds(rowText);
      const rowMeta = this.extractRowMeta(row, rowText);
      const candidateKey = this.getCandidateKey(rowMeta, durationSeconds);
      if (!this.isCandidateAllowedForSearch(rowText, durationSeconds) || this.rejectedCandidateKeys.has(candidateKey)) {
        continue;
      }

      const score = this.scoreRow(rowMeta, durationSeconds, target);
      candidates.push({ playElement, score, durationSeconds, rowMeta, candidateKey });
    }

    if (!candidates.length) return undefined;
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    this.log(
      `Best candidate score=${best.score}, duration=${best.durationSeconds || 0}s, title="${best.rowMeta.title}"`
    );
    return best.score >= 4 ? best : undefined;
  }

  findPlayButton(row) {
    const selectors = [
      'ytmusic-play-button-renderer button',
      'ytmusic-play-button-renderer yt-icon-button button',
      'button[aria-label*="Play"]',
      'button[aria-label*="Putar"]',
      'button[title*="Play"]',
      'button[title*="Putar"]',
      '[aria-label*="Play"]',
      '[aria-label*="Putar"]',
      '#play-button'
    ];

    for (const selector of selectors) {
      const candidate = row.querySelector(selector);
      if (candidate) return candidate;
    }

    const link = row.querySelector('a.yt-simple-endpoint[href]');
    if (link && !/\/watch\?/.test(link.getAttribute('href') || '')) {
      return link;
    }

    return null;
  }

  findFallbackPlayElement() {
    const rowSelectors = [
      'ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer',
      'ytmusic-section-list-renderer ytmusic-responsive-list-item-renderer',
      'ytmusic-responsive-list-item-renderer'
    ];

    for (const rowSelector of rowSelectors) {
      const rows = Array.from(document.querySelectorAll(rowSelector)).slice(0, 10);
      for (const row of rows) {
        const rowText = RequestProcessor.normalizeText(row.innerText || '');
        const durationSeconds = this.extractDurationSeconds(rowText);
        const rowMeta = this.extractRowMeta(row, rowText);
        const candidateKey = this.getCandidateKey(rowMeta, durationSeconds);
        if (!this.isCandidateAllowedForSearch(rowText, durationSeconds) || this.rejectedCandidateKeys.has(candidateKey)) {
          continue;
        }

        const playElement = this.findPlayButton(row);
        if (playElement) {
          return { playElement, durationSeconds, rowMeta, candidateKey, score: 0 };
        }
      }
    }
    return null;
  }

  isCandidateAllowedForSearch(text, durationSeconds) {
    if (!text) return false;

    const blockedTerms = [
      'playlist',
      'album',
      'full album',
      'podcast',
      'episode',
      'mix',
      'live',
      'karaoke',
      'dj set',
      'radio',
      'compilation',
      'nonstop',
      'slowed',
      'reverb'
    ];

    if (blockedTerms.some((term) => text.includes(term))) {
      return false;
    }

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return true;
    }

    return this.isDurationAllowed(durationSeconds);
  }

  isDurationAllowed(durationSeconds) {
    const settings = getSearchDurationSettings();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return false;
    }

    return (
      durationSeconds >= settings.minSeconds &&
      durationSeconds <= settings.maxSeconds
    );
  }

  extractRowMeta(row, rowText) {
    const titleElement = row.querySelector(
      '#title, .title, yt-formatted-string.title, a.yt-simple-endpoint[title], a.yt-simple-endpoint[href]'
    );
    const subtitleElement = row.querySelector(
      '.secondary-flex-columns, .subtitle, .byline, yt-formatted-string.byline, yt-formatted-string.secondary-flex-column, .secondary-text'
    );

    const title = RequestProcessor.normalizeText(
      titleElement?.getAttribute?.('title') || titleElement?.textContent || ''
    );
    const subtitle = RequestProcessor.normalizeText(
      subtitleElement?.getAttribute?.('title') || subtitleElement?.textContent || ''
    );

    return { title, subtitle, text: rowText };
  }

  getCandidateKey(meta, durationSeconds) {
    return [meta?.title || '', meta?.subtitle || '', durationSeconds || 0].join('|');
  }

  scoreRow(meta, durationSeconds, target) {
    if (!this.isCandidateAllowedForSearch(meta.text, durationSeconds)) {
      return -100;
    }

    let score = 0;
    const text = meta.text;

    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      score += 4;
    } else {
      score -= 1;
    }

    const positiveTerms = ['song', 'official', 'audio', 'video', 'single'];
    const negativeTerms = [
      'album',
      'playlist',
      'mix',
      'live',
      'podcast',
      'episode',
      'full album',
      'karaoke',
      'compilation',
      'nonstop',
      'slowed',
      'reverb'
    ];

    for (const term of positiveTerms) {
      if (text.includes(term)) score += 1;
    }
    for (const term of negativeTerms) {
      if (text.includes(term)) score -= 3;
    }

    if (target && target.titleTokens.length) {
      const titleScore = this.countTokenMatches(meta.title || text, target.titleTokens);
      const artistScore = this.countTokenMatches(meta.subtitle || text, target.artistTokens);
      const titleCoverage = titleScore / target.titleTokens.length;
      const artistCoverage = target.artistTokens.length > 0
        ? (artistScore / target.artistTokens.length)
        : 0;

      score += Math.round(titleCoverage * 10);
      if (target.artistTokens.length > 0) score += Math.round(artistCoverage * 8);

      if (titleCoverage < 0.5) score -= 10;
      if (target.artistTokens.length > 0 && artistCoverage === 0) score -= 4;
    }

    return score;
  }

  countTokenMatches(text, tokens = []) {
    if (!tokens.length) return 0;
    let matches = 0;
    for (const token of tokens) {
      if (token && text.includes(token)) matches++;
    }
    return matches;
  }

  extractDurationSeconds(text) {
    if (!text) return 0;
    const matches = text.match(/\b(?:\d{1,2}:){1,2}\d{2}\b/g);
    if (!matches || !matches.length) return 0;

    for (const value of matches) {
      const parts = value.split(':').map(Number);
      if (parts.some(Number.isNaN)) continue;

      if (parts.length === 2) {
        return (parts[0] * 60) + parts[1];
      }
      if (parts.length === 3) {
        return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
      }
    }
    return 0;
  }

  async verifyPlayback(candidate = null) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const video = document.querySelector('video');
    if (video && (video.currentTime > 0 || !video.paused)) {
      const actualDurationSeconds = Math.round(Number(video.duration || 0));
      if (!this.isDurationAllowed(actualDurationSeconds)) {
        const candidateKey = candidate?.candidateKey || this.pendingCandidate?.candidateKey;
        if (candidateKey) {
          this.rejectedCandidateKeys.add(candidateKey);
        }

        this.log(`Rejected playing candidate due to real duration=${actualDurationSeconds}s`);
        this.pendingCandidate = null;
        await this.rejectCurrentPlayback(video);
        this.attempts = 0;
        return;
      }

      this.log('Playback verified successfully');
      this.pendingCandidate = null;
      this.goBackAfterDelay();
    } else {
      this.log('Playback not detected, retrying...');
      const candidateKey = candidate?.candidateKey || this.pendingCandidate?.candidateKey;
      if (candidateKey) {
        this.rejectedCandidateKeys.add(candidateKey);
      }
      this.pendingCandidate = null;
      this.attempts = 0;
      this.start();
    }
  }

  async rejectCurrentPlayback(video) {
    this.stop();

    try {
      if (video) {
        video.pause();
        video.currentTime = 0;
      }
    } catch (error) {
      this.error('Failed to reset rejected playback', error);
    }

    DebugPanel.setStatus('Lagu terlalu panjang, lanjut request berikutnya');

    try {
      await ServerAPI.skipCurrent();
      this.log('Skipped current server request after rejected playback');
    } catch (error) {
      this.error('Failed to skip current server request', error);
    }

    setTimeout(() => RequestProcessor.checkRequests(), 500);
  }

  tryAlternativeMethods() {
    this.log('Trying alternative search methods...');
    this.stop();

    const links = document.querySelectorAll('a[href*="/watch"]');
    for (const link of links) {
      if (!link.href.includes('list=')) {
        link.click();
        this.log('Clicked watch link:', link.href);
        this.goBackAfterDelay();
        return;
      }
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    this.log('Sent space key for playback');

    setTimeout(() => {
      const video = document.querySelector('video');
      if (!video || video.paused) {
        this.log('Alternative methods failed');
      } else {
        this.goBackAfterDelay();
      }
    }, 2000);
  }

  goBackAfterDelay() {
    setTimeout(() => {
      if (window.location.href.includes('/search?q=') && window.history.length > 1) {
        this.log('Returning to previous page...');
        window.history.back();
      }
    }, 3000);
  }

  log(...args) {
    if (CONFIG.DEBUG) console.log('[SearchAutoplay]', ...args);
  }

  error(...args) {
    console.error('[SearchAutoplay]', ...args);
  }
}

// ================= REQUEST PROCESSOR =================
class RequestProcessor {
  static isProcessing = false;
  static lastRequestTime = 0;
  static cooldown = 5000;

  static getRequestSignature(request) {
    if (!request) return '';
    return [request.id || '', request.time || '', request.query || ''].join('|');
  }

  static async checkRequests() {
    if (this.isProcessing || Date.now() - this.lastRequestTime < this.cooldown) {
      return;
    }

    this.isProcessing = true;
    state.isProcessingRequest = true;

    try {
      const response = await fetch(`${getServerUrl()}/get-request`);

      if (response.status === 423) {
        const data = await response.json();
        const remainingFormatted =
          data?.error?.meta?.remainingFormatted ||
          data?.remainingFormatted ||
          'unknown';
        const lockMessage =
          data?.error?.message ||
          data?.error ||
          'Request terkunci';
        this.log(`${lockMessage}: ${remainingFormatted} remaining`);
        return;
      }

      if (response.status === 204) {
        return;
      }

      const request = await response.json();
      if (request?.query) {
        const signature = this.getRequestSignature(request);
        if (!signature) {
          return;
        }

        if (
          signature === state.pendingRequestSignature ||
          signature === state.handledRequestSignature
        ) {
          this.log(`Skipping duplicate request: ${request.query}`);
          return;
        }

        await this.processRequest(request, signature);
      }
    } catch (error) {
      console.error('Error checking requests:', error);
    } finally {
      this.isProcessing = false;
      state.isProcessingRequest = false;
      this.lastRequestTime = Date.now();
    }
  }

  static async processRequest(request, signature = '') {
    this.log(`Processing request: "${request.query}"`);

    state.lastProcessedRequest = request;
    state.isProcessingRequest = true;
    const nextSignature = signature || this.getRequestSignature(request);
    state.pendingRequestSignature = nextSignature;

    try {
      DebugPanel.setStatus(`Processing: ${request.query}`);

      const searchTarget = this.extractSearchTarget(request);
      state.searchTarget = searchTarget;
      const searchQuery = this.buildSearchQuery(searchTarget);
      const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(searchQuery)}`;

      if (window.location.href === searchUrl) {
        this.log('Already on search page, starting autoplay');
        this.startSearchAutoplay();
        state.handledRequestSignature = nextSignature;
      } else {
        this.log(`Redirecting to: ${searchUrl}`);
        state.handledRequestSignature = nextSignature;
        window.location.href = searchUrl;
      }
    } catch (error) {
      state.handledRequestSignature = null;
      throw error;
    } finally {
      state.isProcessingRequest = false;
      state.pendingRequestSignature = null;
    }
  }

  static startSearchAutoplay() {
    const runtime = getRuntime();
    if (runtime.searchAutoplay) {
      runtime.searchAutoplay.stop();
    }

    runtime.searchAutoplay = new SearchAutoplay();
    runtime.searchAutoplay.start();
  }

  static extractSearchTarget(request) {
    const fallbackQuery = (request?.query || '').trim();
    const parsedTitle = (request?.parsedTitle || '').trim();
    const parsedArtist = (request?.parsedArtist || '').trim();

    let title = this.normalizeText(parsedTitle);
    let artist = this.normalizeText(parsedArtist);

    if (!title || title === 'tidak diketahui') {
      const [titlePart, ...artistParts] = fallbackQuery.split('-').map(part => part.trim()).filter(Boolean);
      title = this.normalizeText(titlePart || fallbackQuery);
      if (!artist && artistParts.length) artist = this.normalizeText(artistParts.join(' '));
    }

    return {
      title,
      artist,
      rawQuery: fallbackQuery,
      titleTokens: this.tokenize(title),
      artistTokens: this.tokenize(artist)
    };
  }

  static buildSearchQuery(target) {
    if (!target) return '';
    const title = target.title || '';
    const artist = target.artist || '';
    const base = `${title} ${artist}`.trim() || target.rawQuery;
    return `${base} official audio song`;
  }

  static getSearchTarget() {
    return state.searchTarget;
  }

  static normalizeText(value) {
    return (value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[()[\]{}"'`]/g, ' ')
      .replace(/[^a-z0-9\s&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  static tokenize(value) {
    if (!value) return [];
    const stopWords = new Set(['official', 'audio', 'video', 'lyrics', 'lirik', 'feat', 'ft', 'the', 'a']);
    return value
      .split(/\s+/)
      .map(part => part.trim())
      .filter(part => part.length > 1 && !stopWords.has(part));
  }

  static log(...args) {
    if (CONFIG.DEBUG) console.log('[RequestProcessor]', ...args);
  }
}

// ================= SERVER API =================
class ServerAPI {
  static async notifySongEnded() {
    try {
      const response = await fetch(`${getServerUrl()}/song-ended`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: Date.now(),
          url: window.location.href
        })
      });

      if (!response.ok) {
        throw new Error(`notifySongEnded failed with status ${response.status}`);
      }

      return response.json();
    } catch (error) {
      console.error('Failed to notify server:', error);
      throw error;
    }
  }

  static async skipCurrent() {
    try {
      const response = await fetch(`${getServerUrl()}/skip-current`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`skipCurrent failed with status ${response.status}`);
      }

      return response.json();
    } catch (error) {
      console.error('Failed to skip:', error);
      throw error;
    }
  }
}

// ================= DEBUG PANEL =================
class DebugPanel {
  static panel = null;
  static content = null;
  static isCollapsed = false;

  static create() {
    if (this.panel) return;
    const searchDurationSettings = getSearchDurationSettings();

    this.panel = document.createElement('div');
    this.panel.id = 'ytm-debug-panel';
    this.panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(15, 15, 15, 0.95);
      color: white;
      padding: 15px;
      border-radius: 12px;
      font-family: 'Segoe UI', system-ui, sans-serif;
      font-size: 12px;
      z-index: 999999;
      border: 2px solid #ff4757;
      max-width: 380px;
      min-width: 320px;
      box-shadow: 0 8px 32px rgba(255, 71, 87, 0.2);
      backdrop-filter: blur(12px);
      transition: all 0.3s ease;
    `;

    this.panel.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid #333; padding-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 12px; height: 12px; background: #ff4757; border-radius: 50%; animation: pulse 1.5s infinite;"></div>
          <div style="font-weight: 800; color: #ff4757; font-size: 14px; letter-spacing: 0.5px;">YT MUSIC BRIDGE</div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="debug-toggle" style="background: #333; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; transition: background 0.2s;">Hide</button>
          <button id="debug-refresh" style="background: #333; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; transition: background 0.2s;">Refresh</button>
        </div>
      </div>

      <div id="debug-content">
      <div style="margin-bottom: 8px;">
        <div style="font-weight: 600; color: #aaa; margin-bottom: 4px;">LAGU SAAT INI</div>
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div><strong>Judul:</strong> <span id="debug-title" style="color: #fff; font-weight: 500;">-</span></div>
          <div><strong>Artis:</strong> <span id="debug-artist" style="color: #1e90ff;">-</span></div>
          <div><strong>Durasi:</strong> <span id="debug-duration" style="color: #2ed573;">-</span></div>
        </div>
      </div>

      <div style="margin-bottom: 8px;">
        <div style="font-weight: 600; color: #aaa; margin-bottom: 4px;">STATUS</div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div><strong>Status:</strong> <span id="debug-status" style="color: #2ed573;">Aktif</span></div>
          <div><strong>Update:</strong> <span id="debug-time" style="color: #aaa;">${new Date().toLocaleTimeString()}</span></div>
        </div>
      </div>

      <div style="margin-bottom: 8px;">
        <div style="font-weight: 600; color: #aaa; margin-bottom: 4px;">SERVER</div>
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <input id="debug-server-url" type="text" spellcheck="false" value="${getServerUrl()}" placeholder="https://localhost:4786"
            style="width: 100%; background: #111; color: #fff; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; font-size: 11px; outline: none;">
          <div style="display: flex; gap: 6px;">
            <button id="debug-server-save" style="flex: 1; background: #16a34a; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Simpan</button>
            <button id="debug-server-reset" style="flex: 1; background: #6b7280; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Reset</button>
          </div>
          <button id="debug-server-detect" style="width: 100%; background: #7c3aed; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Auto Detect</button>
        </div>
      </div>

      <div style="margin-bottom: 8px;">
        <div style="font-weight: 600; color: #aaa; margin-bottom: 4px;">FILTER DURASI</div>
        <div style="display: flex; gap: 6px; margin-bottom: 6px;">
          <input id="debug-search-min-duration" type="number" min="1" step="1" value="${searchDurationSettings.minSeconds}" placeholder="Min detik"
            style="flex: 1; background: #111; color: #fff; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; font-size: 11px; outline: none;">
          <input id="debug-search-max-duration" type="number" min="1" step="1" value="${searchDurationSettings.maxSeconds}" placeholder="Max detik"
            style="flex: 1; background: #111; color: #fff; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; font-size: 11px; outline: none;">
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="debug-duration-save" style="flex: 1; background: #0f766e; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Simpan Filter</button>
          <button id="debug-duration-reset" style="flex: 1; background: #92400e; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Reset Filter</button>
        </div>
      </div>

      <div>
        <div style="font-weight: 600; color: #aaa; margin-bottom: 4px;">AKSI CEPAT</div>
        <div style="display: flex; gap: 6px;">
          <button id="debug-skip" style="flex: 1; background: #ffa502; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Skip Lagu</button>
          <button id="debug-check" style="flex: 1; background: #3742fa; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Cek Request</button>
        </div>
      </div>
      </div>

      <style>
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        #debug-toggle:hover { background: #444 !important; }
        #debug-refresh:hover { background: #444 !important; }
        #debug-server-save:hover { background: #15803d !important; }
        #debug-server-reset:hover { background: #4b5563 !important; }
        #debug-server-detect:hover { background: #6d28d9 !important; }
        #debug-duration-save:hover { background: #115e59 !important; }
        #debug-duration-reset:hover { background: #b45309 !important; }
        #debug-skip:hover { background: #ffb142 !important; }
        #debug-check:hover { background: #5352ed !important; }
      </style>
    `;

    document.body.appendChild(this.panel);
    this.content = document.getElementById('debug-content');
    this.setupEventListeners();
  }

  static setupEventListeners() {
    document.getElementById('debug-toggle').addEventListener('click', () => {
      this.isCollapsed = !this.isCollapsed;
      if (this.content) {
        this.content.style.display = this.isCollapsed ? 'none' : 'block';
      }
      document.getElementById('debug-toggle').textContent = this.isCollapsed ? 'Show' : 'Hide';
    });

    document.getElementById('debug-refresh').addEventListener('click', () => {
      location.reload();
    });

    document.getElementById('debug-server-save').addEventListener('click', () => {
      const input = document.getElementById('debug-server-url');
      const rawValue = (input?.value || '').trim();
      if (!/^https?:\/\//i.test(rawValue)) {
        this.setStatus('URL harus diawali http:// atau https://', true);
        return;
      }

      const normalizedUrl = rawValue.replace(/\/+$/, '');
      localStorage.setItem(CONFIG.SERVER_URL_STORAGE_KEY, normalizedUrl);
      input.value = normalizedUrl;
      this.setStatus(`Server URL disimpan: ${normalizedUrl}`);
    });

    document.getElementById('debug-server-reset').addEventListener('click', () => {
      localStorage.removeItem(CONFIG.SERVER_URL_STORAGE_KEY);
      const input = document.getElementById('debug-server-url');
      if (input) input.value = CONFIG.SERVER_URL;
      this.setStatus(`Server URL kembali ke default: ${CONFIG.SERVER_URL}`);
    });

    document.getElementById('debug-server-detect').addEventListener('click', async () => {
      const button = document.getElementById('debug-server-detect');
      const input = document.getElementById('debug-server-url');
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = 'Mencari...';

      try {
        const detectedUrl = await detectServerUrl();
        if (detectedUrl) {
          if (input) input.value = detectedUrl;
          this.setStatus(`Server terdeteksi: ${detectedUrl}`);
        } else {
          this.setStatus('Server tidak ditemukan', true);
        }
      } catch (error) {
        this.setStatus('Auto detect gagal', true);
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    });

    document.getElementById('debug-duration-save').addEventListener('click', () => {
      const minInput = document.getElementById('debug-search-min-duration');
      const maxInput = document.getElementById('debug-search-max-duration');
      const rawMin = minInput?.value || '';
      const rawMax = maxInput?.value || '';

      const parsedMin = Number.parseInt(rawMin, 10);
      const parsedMax = Number.parseInt(rawMax, 10);
      if (!Number.isFinite(parsedMin) || !Number.isFinite(parsedMax) || parsedMin <= 0 || parsedMax <= 0) {
        this.setStatus('Durasi min/max harus angka lebih dari 0', true);
        return;
      }

      const settings = saveSearchDurationSettings(parsedMin, parsedMax);
      if (minInput) minInput.value = String(settings.minSeconds);
      if (maxInput) maxInput.value = String(settings.maxSeconds);
      this.setStatus(`Filter durasi disimpan: ${settings.minSeconds}s - ${settings.maxSeconds}s`);
    });

    document.getElementById('debug-duration-reset').addEventListener('click', () => {
      const settings = resetSearchDurationSettings();
      const minInput = document.getElementById('debug-search-min-duration');
      const maxInput = document.getElementById('debug-search-max-duration');
      if (minInput) minInput.value = String(settings.minSeconds);
      if (maxInput) maxInput.value = String(settings.maxSeconds);
      this.setStatus(`Filter durasi reset: ${settings.minSeconds}s - ${settings.maxSeconds}s`);
    });

    document.getElementById('debug-skip').addEventListener('click', async () => {
      try {
        await ServerAPI.skipCurrent();
        this.setStatus('Skipping current song...');
        setTimeout(() => RequestProcessor.checkRequests(), 1000);
      } catch (error) {
        this.setStatus('Skip failed', true);
      }
    });

    document.getElementById('debug-check').addEventListener('click', () => {
      RequestProcessor.checkRequests();
      this.setStatus('Checking requests...');
    });
  }

  static update(songInfo, duration) {
    if (!this.panel) this.create();

    const durationSec = Math.round(duration / 1000);
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;

    document.getElementById('debug-title').textContent = songInfo.title || '-';
    document.getElementById('debug-artist').textContent = songInfo.artist || '-';
    document.getElementById('debug-duration').textContent = `${minutes}:${seconds
      .toString()
      .padStart(2, '0')}`;
    document.getElementById('debug-time').textContent = new Date().toLocaleTimeString();
  }

  static setStatus(message, isError = false) {
    if (!this.panel) this.create();

    const statusElement = document.getElementById('debug-status');
    statusElement.textContent = message;
    statusElement.style.color = isError ? '#ff4757' : '#2ed573';

    setTimeout(() => {
      statusElement.textContent = 'Aktif';
      statusElement.style.color = '#2ed573';
    }, 3000);
  }
}

// ================= URL MONITOR =================
class URLMonitor {
  static lastURL = '';
  static intervalId = null;
  static popstateAttached = false;

  static init() {
    this.lastURL = window.location.href;

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(() => {
      const currentURL = window.location.href;
      if (currentURL !== this.lastURL) {
        this.handleURLChange(this.lastURL, currentURL);
        this.lastURL = currentURL;
      }
    }, 1000);

    if (!this.popstateAttached) {
      window.addEventListener('popstate', () => {
        setTimeout(() => {
          this.handleURLChange(this.lastURL, window.location.href);
          this.lastURL = window.location.href;
        }, 100);
      });
      this.popstateAttached = true;
    }
  }

  static handleURLChange(oldURL, newURL) {
    console.log(`URL changed: ${oldURL} -> ${newURL}`);

    if (newURL.includes('/search?q=')) {
      console.log('Search page detected, starting autoplay in 1.5s');
      setTimeout(() => RequestProcessor.startSearchAutoplay(), 1500);
    }

    if (!oldURL.includes('music.youtube.com') || !newURL.includes('music.youtube.com')) {
      SongManager.lastTitle = '';
      SongManager.lastArtist = '';
    }
  }
}

// ================= INISIALISASI UTAMA =================
function initialize() {
  const runtime = getRuntime();
  if (runtime.initialized) {
    console.log('YouTube Music Bridge is already initialized');
    return;
  }

  runtime.initialized = true;
  console.log('Initializing YouTube Music Bridge...');

  runtime.videoMonitor = new VideoMonitor();
  URLMonitor.init();
  DebugPanel.create();

  runtime.songUpdateIntervalId = setInterval(() => SongManager.update(), CONFIG.UPDATE_INTERVAL);
  runtime.requestCheckIntervalId = setInterval(
    () => RequestProcessor.checkRequests(),
    CONFIG.REQUEST_CHECK_INTERVAL
  );

  setTimeout(() => SongManager.update(), 1000);
  setTimeout(() => RequestProcessor.checkRequests(), 2000);

  if (window.location.href.includes('/search?q=')) {
    setTimeout(() => RequestProcessor.startSearchAutoplay(), 2000);
  }

  console.log('YouTube Music Bridge initialized successfully');
  DebugPanel.setStatus('Sistem aktif dan berjalan');
}

// ================= START APPLICATION =================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
