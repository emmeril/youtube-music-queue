// ================= KONFIGURASI =================
const CONFIG = {
  SERVER_URL: 'http://localhost:3000',
  UPDATE_INTERVAL: 2000, // 2 detik
  REQUEST_CHECK_INTERVAL: 3000, // 3 detik
  SEARCH_TIMEOUT: 15000, // 15 detik
  DEBUG: true
};

// ================= STATE MANAGEMENT =================
let state = {
  currentSong: {
    title: '',
    artist: '',
    duration: 0,
    timestamp: 0
  },
  lastProcessedRequest: null,
  isProcessingRequest: false,
  debugMode: CONFIG.DEBUG,
  retryCount: 0,
  maxRetries: 3
};

// ================= VIDEO MONITORING =================
class VideoMonitor {
  constructor() {
    this.video = null;
    this.lastTime = 0;
    this.lastUpdate = 0;
    this.isEnded = false;
    this.init();
  }

  init() {
    this.findVideoElement();
    if (!this.video) {
      setTimeout(() => this.init(), 1000);
      return;
    }
    this.setupEventListeners();
    this.log('Video monitoring initialized');
  }

  findVideoElement() {
    this.video = document.querySelector('video');
    if (!this.video) {
      // Coba alternatif selector
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

    // Event untuk deteksi lagu selesai
    this.video.addEventListener('ended', () => {
      this.isEnded = true;
      this.log('🎬 Video ended - triggering next song');
      this.handleSongEnd();
    });

    // Event untuk deteksi lagu mulai
    this.video.addEventListener('playing', () => {
      if (this.isEnded) {
        this.isEnded = false;
        this.log('▶️ New song started playing');
        setTimeout(() => SongManager.update(), 1000);
      }
    });

    // Event untuk deteksi waktu video
    this.video.addEventListener('timeupdate', () => {
      const now = Date.now();
      if (now - this.lastUpdate > 1000) {
        this.lastUpdate = now;
        
        // Deteksi jika video kembali ke awal (lagu baru)
        if (this.video.currentTime < 2 && this.lastTime > 30) {
          this.log('🔄 Video reset detected - new song');
          setTimeout(() => SongManager.update(), 1500);
        }
        this.lastTime = this.video.currentTime;
      }
    });

    // Tambahkan observer untuk perubahan DOM
    this.setupMutationObserver();
  }

  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' || mutation.type === 'subtree') {
          // Cek jika video element berubah
          if (!document.contains(this.video)) {
            this.log('Video element removed, reinitializing...');
            setTimeout(() => this.init(), 500);
          }
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  handleSongEnd() {
    // Kirim notifikasi ke server bahwa lagu selesai
    ServerAPI.notifySongEnded()
      .then(() => {
        this.log('✅ Server notified of song end');
        // Langsung cek request berikutnya
        setTimeout(() => RequestProcessor.checkRequests(), 1000);
      })
      .catch(err => this.error('Failed to notify server:', err));
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

  static update() {
    try {
      const songInfo = this.extractSongInfo();
      const duration = this.getDuration();
      
      // Deteksi perubahan lagu
      const isNewSong = this.isNewSong(songInfo, duration);
      
      if (isNewSong || this.shouldForceUpdate()) {
        this.sendToServer(songInfo, duration, isNewSong);
      }
    } catch (error) {
      console.error('❌ SongManager error:', error);
    }
  }

  static extractSongInfo() {
    // Cari elemen title dengan berbagai selector
    const titleSelectors = [
      'ytmusic-player-bar .title',
      '.title.ytmusic-player-bar',
      'yt-formatted-string.title',
      '[data-title]',
      'h1.title',
      '.song-title',
      'ytmusic-player-bar .yt-formatted-string[has-link-only_]'
    ];

    // Cari elemen artist dengan berbagai selector
    const artistSelectors = [
      'ytmusic-player-bar .byline',
      '.byline.ytmusic-player-bar',
      'yt-formatted-string.byline',
      '.artist-name',
      '.ytmusic-player-bar .yt-formatted-string.complex-string'
    ];

    let title = 'Tidak diketahui';
    let artist = 'Tidak diketahui';

    // Extract title
    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent && element.textContent.trim()) {
        title = element.textContent.trim();
        break;
      }
    }

    // Extract artist
    for (const selector of artistSelectors) {
      const element = document.querySelector(selector);
      if (element && element.textContent && element.textContent.trim()) {
        let artistText = element.textContent.trim();
        
        // Bersihkan text artist
        artistText = this.cleanArtistText(artistText);
        
        if (artistText) {
          artist = artistText;
          break;
        }
      }
    }

    return { title, artist };
  }

  static cleanArtistText(text) {
    if (!text) return text;
    
    // Hapus separator dan text setelahnya
    const separators = ['•', '·', '|', '-', '–', '—'];
    
    for (const separator of separators) {
      if (text.includes(separator)) {
        text = text.split(separator)[0].trim();
      }
    }
    
    // Hapus kata-kata umum yang tidak perlu
    const commonWords = ['Topic', 'VEVO', 'Official', 'Video', 'Audio'];
    commonWords.forEach(word => {
      const regex = new RegExp(`\\s*${word}\\s*`, 'gi');
      text = text.replace(regex, ' ');
    });
    
    return text.trim();
  }

  static getDuration() {
    // Method 1: Dari video element
    const video = document.querySelector('video');
    if (video && video.duration && video.duration > 0) {
      return Math.round(video.duration * 1000);
    }

    // Method 2: Dari progress bar
    const progressBar = document.querySelector('tp-yt-paper-progress, .ytp-progress-bar');
    if (progressBar) {
      const max = progressBar.getAttribute('aria-valuemax') || 
                  progressBar.getAttribute('max') ||
                  progressBar.style.getPropertyValue('--max-value');
      if (max && parseFloat(max) > 0) {
        return parseFloat(max) * 1000;
      }
    }

    // Method 3: Dari text duration
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

    // Default: 3 menit
    return 180000;
  }

  static parseTimeText(text) {
    // Format: "3:45" atau "1:23 / 3:45"
    const timeMatch = text.match(/(\d+):(\d+)/g);
    if (!timeMatch) return 0;
    
    // Ambil bagian terakhir (total duration)
    const lastTime = timeMatch[timeMatch.length - 1];
    const parts = lastTime.split(':').map(Number);
    
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    
    return 0;
  }

  static isNewSong(songInfo, duration) {
    const titleChanged = songInfo.title !== this.lastTitle;
    const artistChanged = songInfo.artist !== this.lastArtist;
    const durationChanged = Math.abs(duration - this.lastDuration) > 10000; // 10 detik
    
    return titleChanged || (artistChanged && songInfo.artist !== 'Tidak diketahui') || durationChanged;
  }

  static shouldForceUpdate() {
    this.updateCount++;
    
    // Force update setiap 10 kali update atau 30 detik
    if (this.updateCount >= 10) {
      this.updateCount = 0;
      return true;
    }
    
    return Date.now() - state.currentSong.timestamp > 30000;
  }

  static async sendToServer(songInfo, duration, isNewSong) {
    try {
      const songData = {
        ...songInfo,
        duration,
        timestamp: Date.now(),
        isNewSong,
        url: window.location.href
      };

      const response = await fetch(`${CONFIG.SERVER_URL}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(songData)
      });

      if (response.ok) {
        // Update state
        this.lastTitle = songInfo.title;
        this.lastArtist = songInfo.artist;
        this.lastDuration = duration;
        state.currentSong = songData;
        
        if (isNewSong) {
          this.log(`🎵 New song detected: ${songInfo.title} - ${songInfo.artist}`);
          
          // Verifikasi kecocokan dengan request
          setTimeout(() => this.verifyRequestMatch(songInfo), 2000);
        }
        
        // Update debug panel
        DebugPanel.update(songInfo, duration);
      }
    } catch (error) {
      console.error('❌ Failed to send song data:', error);
    }
  }

  static async verifyRequestMatch(songInfo) {
    try {
      const response = await fetch(`${CONFIG.SERVER_URL}/verify-match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(songInfo)
      });
      
      const result = await response.json();
      
      if (result.isMatch && result.requestId) {
        this.log(`✅ Song matches request: ${result.requestQuery}`);
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
  }

  start() {
    this.log('Starting search autoplay...');
    
    this.interval = setInterval(() => {
      this.attempts++;
      this.findAndPlay();
    }, 1000);
    
    // Timeout setelah waktu maksimum
    setTimeout(() => {
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
  }

  findAndPlay() {
    // Cek jika sudah ada video yang diputar
    const video = document.querySelector('video');
    if (video && (video.currentTime > 0 || !video.paused)) {
      this.log('Video already playing, stopping search');
      this.stop();
      this.goBackAfterDelay();
      return;
    }

    // Urutan selector berdasarkan prioritas
    const selectors = [
      // Tombol play di hasil pencarian
      'ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer button',
      'ytmusic-responsive-list-item-renderer [aria-label*="Play"]',
      
      // Link ke video
      'ytmusic-responsive-list-item-renderer a.yt-simple-endpoint',
      'ytmusic-responsive-list-item-renderer #play-button',
      
      // Fallback: tombol apa saja dengan label play
      'button[aria-label*="play" i]',
      '[title*="play" i]',
      '.play-button',
      '[play-button]'
    ];

    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          const element = elements[0];
          
          this.log(`Found ${elements.length} elements with selector: ${selector}`);
          
          // Scroll ke element
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Tunggu sebentar lalu klik
          setTimeout(() => {
            element.click();
            this.log('Clicked play element');
            
            // Verifikasi bahwa lagu mulai diputar
            this.verifyPlayback();
          }, 500);
          
          this.stop();
          return;
        }
      } catch (error) {
        this.error(`Error with selector ${selector}:`, error);
      }
    }

    // Jika mencapai max attempts, coba metode alternatif
    if (this.attempts >= this.maxAttempts) {
      this.tryAlternativeMethods();
    }
  }

  async verifyPlayback() {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const video = document.querySelector('video');
    if (video && (video.currentTime > 0 || !video.paused)) {
      this.log('✅ Playback verified successfully');
      this.goBackAfterDelay();
    } else {
      this.log('❌ Playback not detected, retrying...');
      // Coba lagi
      this.attempts = 0;
      this.start();
    }
  }

  tryAlternativeMethods() {
    this.log('Trying alternative search methods...');
    
    // Method 1: Klik link pertama yang mengarah ke watch
    const links = document.querySelectorAll('a[href*="/watch"]');
    for (const link of links) {
      if (!link.href.includes('list=')) { // Hindari playlist
        link.click();
        this.log('Clicked watch link:', link.href);
        this.goBackAfterDelay();
        return;
      }
    }
    
    // Method 2: Gunakan keyboard shortcut (Space untuk play)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    this.log('Sent space key for playback');
    
    // Tunggu dan cek
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
        this.log('↩️ Returning to previous page...');
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
  static cooldown = 5000; // 5 detik cooldown

  static async checkRequests() {
    // Cooldown untuk menghindari spam
    if (this.isProcessing || Date.now() - this.lastRequestTime < this.cooldown) {
      return;
    }

    this.isProcessing = true;
    
    try {
      const response = await fetch(`${CONFIG.SERVER_URL}/get-request`);
      
      if (response.status === 423) { // Locked
        const data = await response.json();
        this.log(`Request locked: ${data.remainingFormatted} remaining`);
        return;
      }
      
      if (response.status === 204) { // No content
        return;
      }
      
      const request = await response.json();
      if (request && request.query) {
        this.processRequest(request);
      }
    } catch (error) {
      console.error('❌ Error checking requests:', error);
    } finally {
      this.isProcessing = false;
      this.lastRequestTime = Date.now();
    }
  }

  static async processRequest(request) {
    this.log(`Processing request: "${request.query}"`);
    
    // Simpan request yang sedang diproses
    state.lastProcessedRequest = request;
    state.isProcessingRequest = true;
    
    // Update debug panel
    DebugPanel.setStatus(`Processing: ${request.query}`);
    
    // Redirect ke halaman pencarian
    const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(request.query)}`;
    
    // Cek jika kita sudah di halaman yang sama
    if (window.location.href === searchUrl) {
      this.log('Already on search page, starting autoplay');
      new SearchAutoplay().start();
    } else {
      this.log(`Redirecting to: ${searchUrl}`);
      window.location.href = searchUrl;
    }
  }

  static log(...args) {
    if (CONFIG.DEBUG) console.log('[RequestProcessor]', ...args);
  }
}

// ================= SERVER API =================
class ServerAPI {
  static async notifySongEnded() {
    try {
      const response = await fetch(`${CONFIG.SERVER_URL}/song-ended`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          timestamp: Date.now(),
          url: window.location.href 
        })
      });
      
      return response.json();
    } catch (error) {
      console.error('Failed to notify server:', error);
      throw error;
    }
  }

  static async skipCurrent() {
    try {
      const response = await fetch(`${CONFIG.SERVER_URL}/skip-current`, {
        method: 'POST'
      });
      
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
  static isVisible = true;

  static create() {
    if (this.panel) return;
    
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
          <div style="font-weight: 800; color: #ff4757; font-size: 14px; letter-spacing: 0.5px;">🎵 YT MUSIC BRIDGE</div>
        </div>
        <div style="display: flex; gap: 6px;">
          <button id="debug-toggle" style="background: #333; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; transition: background 0.2s;">Toggle</button>
          <button id="debug-refresh" style="background: #333; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 10px; transition: background 0.2s;">Refresh</button>
        </div>
      </div>
      
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
      
      <div>
        <div style="font-weight: 600; color: #aaa; margin-bottom: 4px;">AKSI CEPAT</div>
        <div style="display: flex; gap: 6px;">
          <button id="debug-skip" style="flex: 1; background: #ffa502; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Skip Lagu</button>
          <button id="debug-check" style="flex: 1; background: #3742fa; color: white; border: none; padding: 6px; border-radius: 4px; cursor: pointer; font-size: 11px; transition: background 0.2s;">Cek Request</button>
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
        #debug-skip:hover { background: #ffb142 !important; }
        #debug-check:hover { background: #5352ed !important; }
      </style>
    `;
    
    document.body.appendChild(this.panel);
    this.setupEventListeners();
  }

  static setupEventListeners() {
    // Toggle visibility
    document.getElementById('debug-toggle').addEventListener('click', () => {
      this.isVisible = !this.isVisible;
      this.panel.style.display = this.isVisible ? 'block' : 'none';
    });
    
    // Refresh page
    document.getElementById('debug-refresh').addEventListener('click', () => {
      location.reload();
    });
    
    // Skip current song
    document.getElementById('debug-skip').addEventListener('click', async () => {
      try {
        await ServerAPI.skipCurrent();
        this.setStatus('Skipping current song...');
        setTimeout(() => RequestProcessor.checkRequests(), 1000);
      } catch (error) {
        this.setStatus('Skip failed', true);
      }
    });
    
    // Check requests
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
    document.getElementById('debug-duration').textContent = 
      `${minutes}:${seconds.toString().padStart(2, '0')}`;
    document.getElementById('debug-time').textContent = 
      new Date().toLocaleTimeString();
  }

  static setStatus(message, isError = false) {
    if (!this.panel) this.create();
    
    const statusElement = document.getElementById('debug-status');
    statusElement.textContent = message;
    statusElement.style.color = isError ? '#ff4757' : '#2ed573';
    
    // Reset setelah 3 detik
    setTimeout(() => {
      statusElement.textContent = 'Aktif';
      statusElement.style.color = '#2ed573';
    }, 3000);
  }
}

// ================= URL MONITOR =================
class URLMonitor {
  static lastURL = '';
  
  static init() {
    this.lastURL = window.location.href;
    
    // Monitor perubahan URL
    setInterval(() => {
      const currentURL = window.location.href;
      if (currentURL !== this.lastURL) {
        this.handleURLChange(this.lastURL, currentURL);
        this.lastURL = currentURL;
      }
    }, 1000);
    
    // Event listener untuk popstate (back/forward)
    window.addEventListener('popstate', () => {
      setTimeout(() => {
        this.handleURLChange(this.lastURL, window.location.href);
        this.lastURL = window.location.href;
      }, 100);
    });
  }
  
  static handleURLChange(oldURL, newURL) {
    console.log(`🌐 URL changed: ${oldURL} → ${newURL}`);
    
    // Jika pindah ke halaman search
    if (newURL.includes('/search?q=')) {
      console.log('🔍 Search page detected, starting autoplay in 1.5s');
      setTimeout(() => new SearchAutoplay().start(), 1500);
    }
    
    // Reset song detection jika pindah halaman
    if (!oldURL.includes('music.youtube.com') || !newURL.includes('music.youtube.com')) {
      SongManager.lastTitle = '';
      SongManager.lastArtist = '';
    }
  }
}

// ================= INISIALISASI UTAMA =================
function initialize() {
  console.log('🚀 Initializing YouTube Music Bridge...');
  
  // Inisialisasi komponen
  new VideoMonitor();
  URLMonitor.init();
  DebugPanel.create();
  
  // Setup interval untuk update lagu
  setInterval(() => SongManager.update(), CONFIG.UPDATE_INTERVAL);
  
  // Setup interval untuk cek request
  setInterval(() => RequestProcessor.checkRequests(), CONFIG.REQUEST_CHECK_INTERVAL);
  
  // Update pertama kali
  setTimeout(() => SongManager.update(), 1000);
  
  // Cek request pertama kali
  setTimeout(() => RequestProcessor.checkRequests(), 2000);
  
  // Cek jika di halaman search
  if (window.location.href.includes('/search?q=')) {
    setTimeout(() => new SearchAutoplay().start(), 2000);
  }
  
  console.log('✅ YouTube Music Bridge initialized successfully!');
  DebugPanel.setStatus('Sistem aktif dan berjalan');
}

// ================= START APPLICATION =================
// Tunggu DOM siap
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}