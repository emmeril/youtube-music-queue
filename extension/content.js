// Fungsi untuk mendapatkan durasi lagu yang AKURAT dari YouTube Music
function getAccurateSongDuration() {
  try {
    // ================= METODE 1: DARI VIDEO ELEMENT (Paling Akurat) =================
    const videoElement = document.querySelector('video');
    if (videoElement && !isNaN(videoElement.duration) && videoElement.duration > 0) {
      console.log(`🎥 Video element duration: ${videoElement.duration.toFixed(0)}s`);
      return videoElement.duration * 1000; // Convert to milliseconds
    }
    
    // ================= METODE 2: DARI PROGRESS BAR UTAMA =================
    // Cari semua progress bar dan pilih yang memiliki nilai terbesar
    const progressBars = document.querySelectorAll('tp-yt-paper-progress, paper-progress, [role="progressbar"]');
    
    let maxDuration = 0;
    let bestProgressBar = null;
    
    progressBars.forEach(bar => {
      try {
        // Coba baca dari aria-valuemax
        const ariaMax = bar.getAttribute('aria-valuemax');
        const ariaNow = bar.getAttribute('aria-valuenow');
        
        if (ariaMax && !isNaN(ariaMax)) {
          const duration = parseFloat(ariaMax);
          if (duration > maxDuration && duration > 60) { // Minimal 1 menit
            maxDuration = duration;
            bestProgressBar = bar;
          }
        }
        
        // Coba baca dari style transform
        const primaryProgress = bar.querySelector('#primaryProgress, .progress-bar, [class*="progress"]');
        if (primaryProgress) {
          const style = window.getComputedStyle(primaryProgress);
          const transform = style.transform;
          if (transform && transform.includes('scaleX')) {
            // Transform menunjukkan progress, tapi kita butuh total duration
            // Cari di parent element untuk total time
            const parent = bar.closest('ytmusic-player-bar, [player-bar], .player-bar');
            if (parent) {
              const timeElements = parent.querySelectorAll('span, div');
              timeElements.forEach(el => {
                const text = el.textContent;
                if (text && text.includes('/')) {
                  const parts = text.split('/');
                  if (parts.length === 2) {
                    const totalTime = parts[1].trim();
                    const seconds = convertTimeToSeconds(totalTime);
                    if (seconds > maxDuration) {
                      maxDuration = seconds;
                    }
                  }
                }
              });
            }
          }
        }
      } catch (e) {
        console.log('Error reading progress bar:', e);
      }
    });
    
    if (maxDuration > 0) {
      console.log(`📊 Progress bar duration: ${maxDuration}s`);
      return maxDuration * 1000;
    }
    
    // ================= METODE 3: DARI TIME DISPLAY =================
    // Cari semua elemen yang mungkin menampilkan waktu
    const timeDisplays = document.querySelectorAll(
      '.time-info, .ytp-time-duration, [class*="time"], [aria-label*="time"], span, div'
    );
    
    let foundDuration = 0;
    
    for (const element of timeDisplays) {
      try {
        const text = element.textContent || element.getAttribute('aria-label') || '';
        
        // Pattern 1: "3:30 / 4:20" atau "1:23:45 / 2:34:56"
        if (text.includes('/')) {
          const parts = text.split('/');
          if (parts.length === 2) {
            const totalPart = parts[1].trim();
            const seconds = convertTimeToSeconds(totalPart);
            if (seconds > foundDuration && seconds > 60) {
              foundDuration = seconds;
              console.log(`⏰ Time display found: ${totalPart} = ${seconds}s`);
            }
          }
        }
        
        // Pattern 2: Hanya durasi saja "3:30"
        const timeMatch = text.match(/(\d+):(\d+)(?::(\d+))?/);
        if (timeMatch) {
          let seconds = 0;
          if (timeMatch[3]) {
            // Format HH:MM:SS
            seconds = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
          } else {
            // Format MM:SS
            seconds = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
          }
          
          // Cek jika ini durasi lagu yang wajar (30 detik - 1 jam)
          if (seconds >= 30 && seconds <= 3600 && seconds > foundDuration) {
            // Cari konteks: apakah ini elemen durasi atau elemen lain?
            const parentText = element.parentElement?.textContent || '';
            if (parentText.includes('duration') || parentText.includes('length') || 
                element.classList.contains('duration') || 
                element.getAttribute('aria-label')?.includes('duration')) {
              foundDuration = seconds;
              console.log(`⏱️ Duration element found: ${text} = ${seconds}s`);
            }
          }
        }
      } catch (e) {
        // Continue to next element
      }
    }
    
    if (foundDuration > 0) {
      return foundDuration * 1000;
    }
    
    // ================= METODE 4: DARI PLAYER BAR =================
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (playerBar) {
      // Cari semua teks di dalam player bar
      const playerText = playerBar.textContent;
      
      // Cari pola waktu
      const timeRegex = /(\d+:\d+(?::\d+)?)\s*\/\s*(\d+:\d+(?::\d+)?)/g;
      let match;
      while ((match = timeRegex.exec(playerText)) !== null) {
        const totalTime = match[2];
        const seconds = convertTimeToSeconds(totalTime);
        if (seconds > foundDuration) {
          foundDuration = seconds;
          console.log(`🎵 Player bar duration: ${totalTime} = ${seconds}s`);
        }
      }
    }
    
    if (foundDuration > 0) {
      return foundDuration * 1000;
    }
    
    // ================= METODE 5: OBSERVER UNTUK MENDETEKSI PERUBAHAN =================
    // Cari elemen yang mungkin update durasi secara dinamis
    const possibleElements = document.querySelectorAll(
      'ytmusic-player-bar, video, [duration], [aria-valuemax]'
    );
    
    for (const element of possibleElements) {
      // Coba berbagai properti
      if (element.duration && !isNaN(element.duration)) {
        return element.duration * 1000;
      }
      
      if (element.getAttribute('aria-valuemax')) {
        const max = parseFloat(element.getAttribute('aria-valuemax'));
        if (max > 60) {
          return max * 1000;
        }
      }
    }
    
  } catch (error) {
    console.error('Error in getAccurateSongDuration:', error);
  }
  
  // Default fallback
  console.log('⚠️ Using default duration: 3 minutes');
  return 180000; // 3 minutes
}

// Helper function untuk konversi string waktu ke detik
function convertTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  
  timeStr = timeStr.trim();
  
  // Remove any non-numeric characters except colons
  timeStr = timeStr.replace(/[^0-9:]/g, '');
  
  const parts = timeStr.split(':').map(part => parseInt(part) || 0);
  
  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // SS only
    return parts[0];
  }
  
  return 0;
}

// Fungsi untuk mendapatkan info lagu
function getSongInfo() {
  let title = 'Tidak diketahui';
  let artist = 'Tidak diketahui';
  
  // Cari title
  const titleElements = [
    document.querySelector('ytmusic-player-bar .title'),
    document.querySelector('.title.ytmusic-player-bar'),
    document.querySelector('[title]'),
    document.querySelector('h1, h2, h3')
  ];
  
  for (const el of titleElements) {
    if (el && el.textContent && el.textContent.trim()) {
      title = el.textContent.trim();
      break;
    }
  }
  
  // Cari artist
  const artistElements = [
    document.querySelector('ytmusic-player-bar .byline'),
    document.querySelector('.byline.ytmusic-player-bar'),
    document.querySelector('.subtitle'),
    document.querySelector('[class*="artist"], [class*="singer"]')
  ];
  
  for (const el of artistElements) {
    if (el && el.textContent && el.textContent.trim()) {
      artist = el.textContent.trim();
      
      // Bersihkan artist name
      if (artist.includes('•')) artist = artist.split('•')[0].trim();
      if (artist.includes('-')) artist = artist.split('-')[0].trim();
      if (artist.includes('·')) artist = artist.split('·')[0].trim();
      
      break;
    }
  }
  
  return { title, artist };
}

// Fungsi untuk debug semua elemen waktu di halaman
function debugAllTimeElements() {
  console.log('🔍 Debug semua elemen waktu:');
  
  // Cari semua elemen dengan teks yang mengandung kolon
  const allElements = document.querySelectorAll('*');
  const timeElements = [];
  
  allElements.forEach(el => {
    if (el.textContent && el.textContent.includes(':')) {
      const text = el.textContent.trim();
      const timeMatch = text.match(/\d+:\d+(?::\d+)?/);
      if (timeMatch) {
        timeElements.push({
          element: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className : ''),
          text: text.substring(0, 100),
          time: timeMatch[0]
        });
      }
    }
  });
  
  // Log unique time elements
  const uniqueTimes = [...new Set(timeElements.map(t => t.time))];
  console.log('⏰ Waktu unik ditemukan:', uniqueTimes);
  
  // Cari yang kemungkinan adalah total duration (biasanya terakhir dalam format "current/total")
  timeElements.forEach(item => {
    if (item.text.includes('/')) {
      console.log('📋 Format waktu dengan slash:', item);
    }
  });
}

// ================= MAIN SCRIPT =================

let lastSongTitle = '';
let lastDuration = 0;
let debugMode = true;

// Update lagu ke server
async function updateCurrentSong() {
  try {
    const { title, artist } = getSongInfo();
    const duration = getAccurateSongDuration();
    
    const durationSeconds = Math.round(duration / 1000);
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    
    console.log(`🎵 Lagu: ${title} - ${artist}`);
    console.log(`⏱️ Durasi terdeteksi: ${minutes}:${seconds.toString().padStart(2, '0')} (${durationSeconds} detik)`);
    
    // Update hanya jika lagu berbeda atau durasi berbeda signifikan (> 10 detik)
    if (title !== lastSongTitle || Math.abs(duration - lastDuration) > 10000) {
      if (title && title !== 'Tidak diketahui') {
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
          lastDuration = duration;
          console.log('✅ Lagu berhasil diupdate ke server');
        }
      }
    }
    
    // Update debug panel
    updateDebugPanel(title, artist, duration);
    
  } catch (error) {
    console.error('❌ Error updating song:', error);
  }
}

// Update debug panel
function updateDebugPanel(title, artist, duration) {
  const durationSeconds = Math.round(duration / 1000);
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  
  const debugElement = document.getElementById('ytm-debug-panel') || createDebugPanel();
  
  debugElement.innerHTML = `
    <div style="margin-bottom: 5px; font-weight: bold; color: #00ff00;">🎵 YT Music Bridge v2</div>
    <div><strong>Lagu:</strong> ${title}</div>
    <div><strong>Artist:</strong> ${artist}</div>
    <div><strong>Durasi:</strong> ${minutes}:${seconds.toString().padStart(2, '0')} (${durationSeconds}s)</div>
    <div><strong>Status:</strong> <span id="debug-status">Aktif</span></div>
    <div><strong>Waktu:</strong> ${new Date().toLocaleTimeString()}</div>
    <button id="debug-btn" style="margin-top: 5px; padding: 2px 5px; font-size: 10px;">Debug</button>
  `;
  
  // Debug button
  document.getElementById('debug-btn').addEventListener('click', () => {
    debugAllTimeElements();
    console.log('🔍 Manual debug triggered');
  });
}

// Create debug panel
function createDebugPanel() {
  const panel = document.createElement('div');
  panel.id = 'ytm-debug-panel';
  panel.style.cssText = `
    position: fixed;
    bottom: 10px;
    right: 10px;
    background: rgba(0, 0, 0, 0.9);
    color: white;
    padding: 10px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 11px;
    z-index: 9999;
    border: 1px solid #00ff00;
    max-width: 300px;
    box-shadow: 0 0 10px rgba(0, 255, 0, 0.3);
  `;
  document.body.appendChild(panel);
  return panel;
}

// ================= INTERVAL UPDATES =================

// Update lagu setiap 3 detik
setInterval(updateCurrentSong, 3000);

// Update pertama kali
setTimeout(updateCurrentSong, 1000);

// Ambil request dari server setiap 10 detik
setInterval(async () => {
  try {
    const response = await fetch('http://localhost:3000/get-request');
    
    if (response.status === 423) {
      const data = await response.json();
      const minutes = Math.ceil(data.lockRemaining / 60);
      console.log(`⏳ Request terkunci: ${minutes} menit tersisa`);
      return;
    }
    
    const data = await response.json();
    if (data?.query) {
      console.log(`🎵 Memproses request: ${data.query}`);
      
      const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(data.query)}`;
      
      if (window.location.href !== searchUrl) {
        window.location.href = searchUrl;
      }
    }
  } catch (error) {
    console.error('❌ Error fetching request:', error);
  }
}, 10000);

// Auto-play di halaman pencarian
if (window.location.href.includes('music.youtube.com/search')) {
  console.log('🔍 Di halaman pencarian, mencari lagu...');
  
  let attempts = 0;
  const maxAttempts = 30;
  
  const searchInterval = setInterval(() => {
    attempts++;
    
    // Cari tombol play pertama
    const playButtons = document.querySelectorAll(
      'ytmusic-play-button-renderer, [aria-label*="play"], button[aria-label*="play"]'
    );
    
    if (playButtons.length > 0) {
      console.log(`✅ Ditemukan ${playButtons.length} tombol play`);
      
      // Coba klik tombol play pertama yang valid
      for (const button of playButtons) {
        if (button.offsetParent !== null) { // Cek jika elemen terlihat
          button.click();
          console.log('🎶 Memutar lagu...');
          clearInterval(searchInterval);
          
          // Kembali ke halaman sebelumnya setelah 2 detik
          setTimeout(() => {
            if (window.history.length > 1) {
              window.history.back();
            }
          }, 2000);
          break;
        }
      }
    }
    
    if (attempts >= maxAttempts) {
      console.log('⏰ Gagal menemukan lagu setelah 30 detik');
      clearInterval(searchInterval);
    }
  }, 1000);
}

// Tambahkan style untuk debug panel
const style = document.createElement('style');
style.textContent = `
  #ytm-debug-panel {
    animation: pulse 2s infinite;
  }
  
  @keyframes pulse {
    0% { border-color: #00ff00; }
    50% { border-color: #009900; }
    100% { border-color: #00ff00; }
  }
`;
document.head.appendChild(style);

// Initial debug
console.log('🎵 YouTube Music Bridge v2 loaded');
console.log('📊 Debug mode:', debugMode);