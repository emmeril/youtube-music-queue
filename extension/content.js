// ================= FUNGSI UTAMA UNTUK MENDAPATKAN DURASI =================
function getAccurateSongDuration() {
  try {
    // Method 1: Dari video element
    const videoElement = document.querySelector('video');
    if (videoElement && !isNaN(videoElement.duration) && videoElement.duration > 0) {
      console.log(`🎥 Video duration: ${videoElement.duration}s`);
      return videoElement.duration * 1000;
    }
    
    // Method 2: Dari progress bar YouTube Music
    const progressBar = document.querySelector('tp-yt-paper-progress#sliderBar');
    if (progressBar) {
      const maxDuration = progressBar.getAttribute('aria-valuemax');
      if (maxDuration && !isNaN(maxDuration) && parseFloat(maxDuration) > 0) {
        console.log(`📊 Progress bar duration: ${maxDuration}s`);
        return parseFloat(maxDuration) * 1000;
      }
    }
    
    // Method 3: Dari time display (format: "1:23 / 3:45")
    const timeDisplays = document.querySelectorAll('.time-info, .ytp-time-duration');
    for (const display of timeDisplays) {
      const text = display.textContent || '';
      if (text.includes('/')) {
        const parts = text.split('/');
        if (parts.length === 2) {
          const totalTime = parts[1].trim();
          const seconds = convertTimeToSeconds(totalTime);
          if (seconds > 0) {
            console.log(`⏰ Time display: ${totalTime} = ${seconds}s`);
            return seconds * 1000;
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error in getAccurateSongDuration:', error);
  }
  
  // Default fallback
  console.log('⚠️ Using default duration: 180s');
  return 180000; // 3 minutes
}

function convertTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  
  const parts = timeStr.trim().split(':').map(part => parseInt(part) || 0);
  
  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  }
  
  return 0;
}

// ================= FUNGSI UNTUK MENDAPATKAN INFO LAGU =================
function getCurrentSongInfo() {
  // Cari title
  const titleElement = document.querySelector('ytmusic-player-bar .title') ||
                      document.querySelector('.title.ytmusic-player-bar');
  
  // Cari artist
  const artistElement = document.querySelector('ytmusic-player-bar .byline') ||
                       document.querySelector('.byline.ytmusic-player-bar');
  
  let title = titleElement?.textContent?.trim() || 'Tidak diketahui';
  let artist = artistElement?.textContent?.trim() || 'Tidak diketahui';
  
  // Bersihkan artist name
  if (artist.includes('•')) artist = artist.split('•')[0].trim();
  if (artist.includes('-')) artist = artist.split('-')[0].trim();
  
  return { title, artist };
}

// ================= AUTO-PLAY UNTUK HALAMAN PENCARIAN =================
function setupSearchAutoPlay() {
  console.log('🔍 Setting up auto-play for search page...');
  
  let attempts = 0;
  const maxAttempts = 30; // Maksimal 30 detik
  
  const searchInterval = setInterval(() => {
    attempts++;
    console.log(`🔄 Attempt ${attempts} to find search results...`);
    
    // Coba dengan selector yang berbeda-beda
    const selectors = [
      // Selector utama
      'ytmusic-responsive-list-item-renderer a',
      
      // Selector alternatif
      'ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer',
      'ytmusic-responsive-list-item-renderer [play-button]',
      'ytmusic-responsive-list-item-renderer .play-button',
      
      // Selector fallback
      'a[href*="/watch"]',
      '.ytmusic-shelf-renderer a',
      '.content-container a'
    ];
    
    // Coba setiap selector
    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          console.log(`✅ Found element with selector: ${selector}`);
          
          // Klik elemen
          element.click();
          console.log('🎵 Clicked on song!');
          
          // Tunggu sebentar lalu kembali ke halaman sebelumnya
          setTimeout(() => {
            // Hanya kembali jika kita masih di halaman pencarian
            if (window.location.href.includes('/search?q=')) {
              console.log('↩️ Going back to previous page...');
              if (window.history.length > 1) {
                window.history.back();
              }
            }
          }, 2000);
          
          clearInterval(searchInterval);
          return;
        }
      } catch (error) {
        console.error(`Error with selector ${selector}:`, error);
      }
    }
    
    // Jika tidak ada yang ditemukan, coba cari dengan cara lain
    if (attempts === 5 || attempts === 15) {
      console.log('🔍 Trying alternative search methods...');
      
      // Method 1: Cari semua link yang mungkin
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.includes('/watch') && !href.includes('list=')) {
          console.log('✅ Found watch link:', href);
          link.click();
          
          setTimeout(() => {
            if (window.history.length > 1) {
              window.history.back();
            }
          }, 2000);
          
          clearInterval(searchInterval);
          return;
        }
      }
      
      // Method 2: Cari tombol play
      const playButtons = document.querySelectorAll('button, [role="button"]');
      for (const button of playButtons) {
        const label = button.getAttribute('aria-label') || button.textContent || '';
        if (label.toLowerCase().includes('play') || label.includes('▶')) {
          console.log('✅ Found play button:', label);
          button.click();
          
          setTimeout(() => {
            if (window.history.length > 1) {
              window.history.back();
            }
          }, 2000);
          
          clearInterval(searchInterval);
          return;
        }
      }
    }
    
    // Berhenti setelah maksimal attempts
    if (attempts >= maxAttempts) {
      console.log('⏰ Failed to find playable element after 30 seconds');
      clearInterval(searchInterval);
    }
  }, 1000);
}

// ================= FUNGSI UTAMA UNTUK UPDATE LAGU =================
let lastSongTitle = '';
let lastUpdateTime = 0;

async function updateCurrentSong() {
  try {
    const { title, artist } = getCurrentSongInfo();
    const duration = getAccurateSongDuration();
    
    // Update hanya jika lagu berbeda atau sudah 30 detik
    if (title !== lastSongTitle || Date.now() - lastUpdateTime > 30000) {
      if (title && title !== 'Tidak diketahui') {
        console.log(`🎵 Updating: ${title} - ${artist} (${Math.round(duration/1000)}s)`);
        
        const response = await fetch('http://localhost:3000/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            title, 
            artist, 
            duration: Math.round(duration)
          })
        });
        
        if (response.ok) {
          lastSongTitle = title;
          lastUpdateTime = Date.now();
          updateDebugPanel(title, artist, duration);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Error updating song:', error);
  }
}

// ================= DEBUG PANEL =================
function createDebugPanel() {
  if (document.getElementById('ytm-debug-panel')) return;
  
  const panel = document.createElement('div');
  panel.id = 'ytm-debug-panel';
  panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.95);
    color: white;
    padding: 15px;
    border-radius: 10px;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    font-size: 12px;
    z-index: 999999;
    border: 2px solid #ff0000;
    max-width: 350px;
    min-width: 300px;
    box-shadow: 0 0 20px rgba(255, 0, 0, 0.3);
    backdrop-filter: blur(10px);
  `;
  
  panel.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <div style="font-weight: bold; color: #ff0000; font-size: 14px;">🎵 YT Music Bridge</div>
      <button id="debug-refresh" style="background: #333; color: white; border: none; padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;">Refresh</button>
    </div>
    <div style="margin-bottom: 5px;"><strong>Lagu:</strong> <span id="debug-title">-</span></div>
    <div style="margin-bottom: 5px;"><strong>Artis:</strong> <span id="debug-artist">-</span></div>
    <div style="margin-bottom: 5px;"><strong>Durasi:</strong> <span id="debug-duration">-</span></div>
    <div style="margin-bottom: 5px;"><strong>Status:</strong> <span id="debug-status" style="color: #00ff00;">Aktif</span></div>
    <div><strong>Waktu:</strong> <span id="debug-time">${new Date().toLocaleTimeString()}</span></div>
  `;
  
  document.body.appendChild(panel);
  
  // Refresh button
  document.getElementById('debug-refresh').addEventListener('click', () => {
    location.reload();
  });
}

function updateDebugPanel(title, artist, duration) {
  const panel = document.getElementById('ytm-debug-panel');
  if (!panel) createDebugPanel();
  
  const durationSec = Math.round(duration / 1000);
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  
  document.getElementById('debug-title').textContent = title;
  document.getElementById('debug-artist').textContent = artist;
  document.getElementById('debug-duration').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  document.getElementById('debug-time').textContent = new Date().toLocaleTimeString();
}

// ================= PROSES REQUEST DARI SERVER =================
async function processRequests() {
  try {
    const response = await fetch('http://localhost:3000/get-request');
    
    if (response.status === 423) {
      const data = await response.json();
      const minutes = Math.ceil(data.lockRemaining / 60);
      console.log(`⏳ Request locked: ${minutes} minutes remaining`);
      return;
    }
    
    const data = await response.json();
    if (data?.query) {
      console.log(`🎵 Processing request: "${data.query}"`);
      
      // Redirect ke halaman pencarian
      const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(data.query)}`;
      window.location.href = searchUrl;
    }
  } catch (error) {
    console.error('❌ Error processing request:', error);
  }
}

// ================= INISIALISASI =================

// Buat debug panel
createDebugPanel();

// Update lagu setiap 1 detik
setInterval(updateCurrentSong, 1000);

// Update pertama kali
setTimeout(updateCurrentSong, 1000);

// Proses request setiap 10 detik
setInterval(processRequests, 10000);

// ================= AUTO-PLAY DI HALAMAN PENCARIAN =================
if (window.location.href.includes('/search?q=')) {
  console.log('🔍 Search page detected, starting auto-play...');
  
  // Tunggu sebentar agar halaman selesai loading
  setTimeout(() => {
    setupSearchAutoPlay();
  }, 2000);
}

// ================= STYLE TAMBAHAN =================
const style = document.createElement('style');
style.textContent = `
  #ytm-debug-panel {
    animation: pulse 2s infinite;
    transition: all 0.3s ease;
  }
  
  #ytm-debug-panel:hover {
    transform: scale(1.02);
    box-shadow: 0 0 30px rgba(255, 0, 0, 0.5);
  }
  
  @keyframes pulse {
    0% { border-color: #ff0000; }
    50% { border-color: #ff6666; }
    100% { border-color: #ff0000; }
  }
  
  #debug-refresh:hover {
    background: #555 !important;
  }
`;
document.head.appendChild(style);

console.log('🎵 YouTube Music Bridge initialized successfully!');