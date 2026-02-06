require("dotenv").config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 4786;

// Konstanta batas antrian
const QUEUE_LIMIT = 100;

// Konstanta admin
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
let adminSession = null;
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 jam

// File untuk persistensi data
const REQUESTS_FILE = path.join(__dirname, 'data', 'requests.json');
const HISTORY_FILE = path.join(__dirname, 'data', 'history.json');

// Pastikan direktori data ada
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= MIDDLEWARE ADMIN =================
function requireAdmin(req, res, next) {
  const sessionToken = req.headers['x-admin-token'];
  
  if (!sessionToken || !adminSession || adminSession.token !== sessionToken) {
    return res.status(403).json({ 
      error: 'Akses ditolak. Hanya admin yang bisa melakukan aksi ini.',
      requiresAdmin: true 
    });
  }
  
  // Cek session expired
  if (Date.now() > adminSession.expires) {
    adminSession = null;
    return res.status(403).json({ 
      error: 'Session admin telah kadaluarsa. Silakan login kembali.',
      sessionExpired: true 
    });
  }
  
  next();
}

// ================= STATE MANAGEMENT =================
let state = {
  currentSong: {
    title: 'Tidak ada lagu',
    artist: 'Tidak diketahui',
    duration: 180000,
    timestamp: Date.now(),
    confidence: 0,
    isPlaying: false
  },
  activeRequest: null,
  requestLockUntil: 0,
  requestQueue: [],
  history: [],
  stats: {
    totalRequests: 0,
    totalSongsPlayed: 0,
    totalPlayTime: 0
  },
  songEndTimeout: null,
  requestStartTime: 0,
  originalLockDuration: 0
};

// ================= HELPER FUNCTIONS =================
function loadData() {
  try {
    // Load requests
    if (fs.existsSync(REQUESTS_FILE)) {
      const requestsData = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
      state.requestQueue = requestsData.queue || [];
      
      // Batasi hanya 100 item terakhir
      if (state.requestQueue.length > QUEUE_LIMIT) {
        console.log(`⚠️ Queue truncated from ${state.requestQueue.length} to ${QUEUE_LIMIT} items`);
        state.requestQueue = state.requestQueue.slice(-QUEUE_LIMIT);
      }
      
      state.activeRequest = requestsData.activeRequest || null;
      state.requestLockUntil = requestsData.lockUntil || 0;
      console.log(`📂 Loaded ${state.requestQueue.length} requests from file (max ${QUEUE_LIMIT})`);
    }
    
    // Load history
    if (fs.existsSync(HISTORY_FILE)) {
      const historyData = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      state.history = historyData.history || [];
      state.stats = historyData.stats || state.stats;
      console.log(`📂 Loaded ${state.history.length} history items`);
    }
  } catch (error) {
    console.error('Error loading data:', error);
    // Reset to defaults
    state.requestQueue = [];
    state.history = [];
  }
}

function saveRequests() {
  try {
    const data = {
      queue: state.requestQueue,
      activeRequest: state.activeRequest,
      lockUntil: state.requestLockUntil,
      lastUpdated: Date.now(),
      queueLimit: QUEUE_LIMIT
    };
    
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving requests:', error);
  }
}

function saveHistory() {
  try {
    const data = {
      history: state.history.slice(-100), // Simpan 100 item terakhir
      stats: state.stats,
      lastUpdated: Date.now()
    };
    
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving history:', error);
  }
}

function addToHistory(song, request = null) {
  const historyItem = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    song: { ...song },
    request: request ? { ...request } : null,
    timestamp: Date.now(),
    duration: song.duration || 180000
  };
  
  state.history.unshift(historyItem);
  state.stats.totalSongsPlayed++;
  state.stats.totalPlayTime += Math.round((song.duration || 180000) / 60000); // dalam menit
  
  // Simpan history
  saveHistory();
}

function formatDuration(ms) {
  if (!ms) return '0:00';
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function formatWaitTime(seconds) {
  if (!seconds || seconds <= 0) return 'Segera';
  if (seconds < 60) return `${seconds} detik`;
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit`;
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} jam ${remainingMinutes} menit`;
}

function calculateConfidence(song) {
  let confidence = 50;
  
  // Durasi normal (2-5 menit)
  if (song.duration >= 120000 && song.duration <= 300000) {
    confidence += 30;
  }
  
  // Title dan artist valid
  if (song.title && song.title !== 'Tidak diketahui') confidence += 10;
  if (song.artist && song.artist !== 'Tidak diketahui') confidence += 10;
  
  return Math.min(confidence, 95);
}

function calculateLockDuration(songDuration) {
  // Durasi lock = durasi lagu + buffer 1 detik
  return (songDuration || 180000) + 1;
}

function scheduleAutoUnlock(lockDuration) {
  // Hapus timeout sebelumnya jika ada
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
  
  // Jadwalkan auto-unlock
  if (lockDuration > 0) {
    state.songEndTimeout = setTimeout(() => {
      const now = Date.now();
      if (now < state.requestLockUntil) {
        console.log(`⏰ Auto-unlock triggered for song completion`);
        state.requestLockUntil = 0;
        state.currentSong.isPlaying = false;
        
        if (state.activeRequest) {
          state.activeRequest.status = 'auto_completed';
          state.activeRequest.autoCompletedAt = now;
          state.activeRequest = null;
          saveRequests();
        }
      }
    }, lockDuration);
  }
}

function calculateWaitTime(position) {
  // Estimasi waktu tunggu dalam menit
  const avgSongDuration = 3; // 3 menit rata-rata
  return position * avgSongDuration;
}

function calculateMatchConfidence(requestQuery, songTitle, songArtist) {
  let confidence = 0;
  
  // Exact match di title
  if (songTitle === requestQuery) confidence = 100;
  // Contains match di title
  else if (songTitle.includes(requestQuery) || requestQuery.includes(songTitle)) confidence = 85;
  // Contains match di artist
  else if (songArtist.includes(requestQuery) || requestQuery.includes(songArtist)) confidence = 75;
  // Partial match
  else {
    const requestWords = requestQuery.split(' ');
    const titleWords = songTitle.split(' ');
    const artistWords = songArtist.split(' ');
    
    const matchingWords = requestWords.filter(word => 
      titleWords.some(tw => tw.includes(word)) || 
      artistWords.some(aw => aw.includes(word))
    );
    
    confidence = Math.round((matchingWords.length / requestWords.length) * 100);
  }
  
  return confidence;
}

// ================= API ENDPOINTS =================

// 1. ADMIN LOGIN
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Password diperlukan' });
  }
  
  if (password === ADMIN_PASSWORD) {
    // Buat session token
    const token = Date.now().toString(36) + Math.random().toString(36).substr(2);
    
    adminSession = {
      token,
      expires: Date.now() + SESSION_DURATION,
      createdAt: Date.now()
    };
    
    console.log(`🔐 Admin login successful`);
    
    res.json({
      success: true,
      token,
      expiresIn: SESSION_DURATION,
      expiresAt: adminSession.expires
    });
  } else {
    res.status(401).json({ error: 'Password salah' });
  }
});

// 2. ADMIN LOGOUT
app.post('/admin/logout', requireAdmin, (req, res) => {
  adminSession = null;
  console.log(`🔐 Admin logged out`);
  res.json({ success: true, message: 'Logout berhasil' });
});

// 3. CHECK ADMIN STATUS
app.get('/admin/status', (req, res) => {
  const sessionToken = req.headers['x-admin-token'];
  const isAdmin = adminSession && 
                  adminSession.token === sessionToken && 
                  Date.now() < adminSession.expires;
  
  res.json({
    isAdmin,
    expiresAt: isAdmin ? adminSession.expires : null,
    remainingTime: isAdmin ? adminSession.expires - Date.now() : 0
  });
});

// 4. UPDATE SONG (dipanggil oleh extension)
app.post('/update', (req, res) => {
  try {
    const { title, artist, duration, timestamp, isNewSong, url } = req.body;
    const now = Date.now();
    
    // Validasi input
    const validDuration = Math.max(10000, Math.min(duration || 180000, 3600000));
    
    // Hitung confidence
    const confidence = calculateConfidence({ title, artist, duration: validDuration });
    
    // Update state
    state.currentSong = {
      title: title || 'Tidak diketahui',
      artist: artist || 'Tidak diketahui',
      duration: validDuration,
      timestamp: now,
      confidence,
      isPlaying: true,
      url: url || null
    };
    
    console.log(`📊 Song updated: ${title} - ${artist} (${formatDuration(validDuration)}, ${confidence}%)`);
    
    // JIKA ADA REQUEST AKTIF, UPDATE LOCK DURATION
    if (state.activeRequest && state.requestLockUntil > 0) {
      // Hitung sisa waktu dari lock sebelumnya
      const remainingLock = state.requestLockUntil - now;
      
      // Jika lagu baru atau durasi berubah, reset lock berdasarkan durasi lagu baru
      if (isNewSong || Math.abs(validDuration - state.currentSong.duration) > 5000) {
        const newLockDuration = calculateLockDuration(validDuration);
        state.requestLockUntil = now + newLockDuration;
        state.originalLockDuration = newLockDuration;
        
        // Jadwalkan ulang auto-unlock
        scheduleAutoUnlock(newLockDuration);
        
        console.log(`🔒 Lock updated to ${Math.round(newLockDuration/1000)}s for new song`);
      }
    }
    
    // Jika ini lagu baru dan ada request aktif, tambahkan ke history
    if (isNewSong && state.activeRequest) {
      addToHistory(state.currentSong, state.activeRequest);
    }
    
    res.json({
      success: true,
      message: 'Song updated',
      song: state.currentSong,
      timestamp: now,
      lockRemaining: state.requestLockUntil > 0 ? Math.max(0, state.requestLockUntil - now) : 0
    });
    
  } catch (error) {
    console.error('Error in /update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 5. GET CURRENT STATUS
app.get('/status', (req, res) => {
  const now = Date.now();
  const lockRemaining = Math.max(0, state.requestLockUntil - now);
  
  res.json({
    song: state.currentSong,
    isLocked: now < state.requestLockUntil,
    lockRemaining: lockRemaining,
    lockRemainingFormatted: formatWaitTime(Math.round(lockRemaining / 1000)),
    activeRequest: state.activeRequest,
    queueLength: state.requestQueue.length,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    stats: state.stats,
    // Tambahan info tentang lock
    lockInfo: {
      basedOnSongDuration: state.currentSong.duration,
      originalLock: state.originalLockDuration,
      currentProgress: state.requestStartTime > 0 ? 
        Math.min(100, ((now - state.requestStartTime) / state.originalLockDuration) * 100) : 0
    }
  });
});

// 6. GET NEXT REQUEST (dipanggil oleh extension)
app.get('/get-request', (req, res) => {
  const now = Date.now();
  
  // Cek lock
  if (now < state.requestLockUntil) {
    const remaining = Math.ceil((state.requestLockUntil - now) / 1000);
    return res.status(423).json({
      error: 'Request terkunci',
      lockRemaining: remaining,
      remainingFormatted: formatWaitTime(remaining),
      currentPlaying: state.activeRequest?.query || state.currentSong.title,
      estimatedFinish: new Date(state.requestLockUntil).toLocaleTimeString()
    });
  }
  
  // Cek jika queue kosong
  if (state.requestQueue.length === 0) {
    // Reset active request jika sudah tidak ada lock
    if (state.activeRequest) {
      state.activeRequest.status = 'completed';
      state.activeRequest.completedAt = now;
      state.activeRequest = null;
      saveRequests();
    }
    
    return res.status(204).send(); // No content
  }
  
  // Ambil request berikutnya
  const nextRequest = state.requestQueue.shift();
  
  // Parse judul dan artis dari query
  const queryParts = nextRequest.query.split('-').map(part => part.trim());
  
  state.activeRequest = {
    ...nextRequest,
    parsedTitle: queryParts[0] || nextRequest.query,
    parsedArtist: queryParts[1] || 'Unknown Artist',
    status: 'playing',
    startedAt: now
  };
  
  // Set lock time berdasarkan DURASI LAGU YANG SEDANG DIPUTAR
  const lockDuration = calculateLockDuration(state.currentSong.duration);
  state.requestLockUntil = now + lockDuration;
  state.requestStartTime = now;
  state.originalLockDuration = lockDuration;
  
  // Jadwalkan auto-unlock berdasarkan durasi lagu
  scheduleAutoUnlock(lockDuration);
  
  // Update stats
  state.stats.totalRequests++;
  
  // Simpan perubahan
  saveRequests();
  
  console.log(`🎵 Next request: "${nextRequest.query}"`);
  console.log(`🎵 Parsed as: Title="${queryParts[0] || nextRequest.query}", Artist="${queryParts[1] || 'Unknown Artist'}"`);
  console.log(`🔒 Lock duration: ${Math.round(lockDuration/1000)}s`);
  
  res.json({
    query: nextRequest.query,
    id: nextRequest.id,
    time: nextRequest.time,
    parsedTitle: queryParts[0] || nextRequest.query,
    parsedArtist: queryParts[1] || 'Unknown Artist',
    estimatedDuration: lockDuration,
    queueRemaining: state.requestQueue.length,
    lockUntil: state.requestLockUntil,
    songDuration: state.currentSong.duration
  });
});

// 7. ADD NEW REQUEST (Dengan validasi format)
app.post('/request-song', (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({ error: 'Query tidak boleh kosong' });
    }
    
    // Validasi format: harus mengandung tanda pemisah
    const queryParts = query.split('-').map(part => part.trim());
    
    if (queryParts.length < 2) {
      console.log(`⚠️ Query tanpa pemisah: "${query}"`);
      // Tetap diterima, tapi beri warning di log
    }
    
    // CEK BATAS ANTRIAN (100 LAGU)
    if (state.requestQueue.length >= QUEUE_LIMIT) {
      return res.status(429).json({ 
        error: `Antrian penuh (maksimal ${QUEUE_LIMIT} lagu). Tunggu hingga beberapa lagu selesai diputar.`,
        queueLimit: QUEUE_LIMIT,
        currentQueue: state.requestQueue.length
      });
    }
    
    // Cek duplikat di queue
    const isDuplicate = state.requestQueue.some(req => 
      req.query.toLowerCase() === query.toLowerCase()
    );
    
    if (isDuplicate) {
      return res.status(409).json({ error: 'Lagu sudah ada dalam antrian' });
    }
    
    // Buat request baru
    const newRequest = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      query: query.trim(),
      time: Date.now(),
      status: 'pending',
      addedBy: req.ip || 'unknown',
      // Parse judul dan artis jika ada pemisah
      title: queryParts[0] || query,
      artist: queryParts[1] || 'Unknown Artist'
    };
    
    // Tambahkan ke queue
    state.requestQueue.push(newRequest);
    saveRequests();
    
    console.log(`📝 Request added: "${query}"`);
    console.log(`📝 Parsed as: Title="${queryParts[0] || query}", Artist="${queryParts[1] || 'Unknown Artist'}"`);
    console.log(`📊 Total queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
    
    // Jika tidak ada request aktif, set ini sebagai berikutnya
    if (!state.activeRequest && state.requestLockUntil === 0) {
      console.log(`🎯 No active request, "${query}" will be played next`);
    }
    
    res.json({
      success: true,
      message: 'Request berhasil ditambahkan',
      request: newRequest,
      queuePosition: state.requestQueue.length,
      estimatedWait: calculateWaitTime(state.requestQueue.length),
      queueLimit: QUEUE_LIMIT,
      remainingSlots: QUEUE_LIMIT - state.requestQueue.length
    });
    
  } catch (error) {
    console.error('Error in /request-song:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 8. MOVE REQUEST POSITION (Admin only)
app.post('/admin/move-request', requireAdmin, (req, res) => {
  const { requestId, newPosition } = req.body;
  
  if (!requestId || !newPosition) {
    return res.status(400).json({ error: 'requestId dan newPosition diperlukan' });
  }
  
  // Validasi newPosition (1-based index)
  if (newPosition < 1 || newPosition > state.requestQueue.length) {
    return res.status(400).json({ 
      error: `Posisi harus antara 1 dan ${state.requestQueue.length}` 
    });
  }
  
  const currentIndex = state.requestQueue.findIndex(req => req.id === requestId);
  
  if (currentIndex === -1) {
    return res.status(404).json({ error: 'Request tidak ditemukan' });
  }
  
  // Jika posisi sama, tidak perlu melakukan apa-apa
  if (currentIndex + 1 === newPosition) {
    return res.json({ 
      success: true, 
      message: 'Posisi tidak berubah' 
    });
  }
  
  // Pindahkan request ke posisi baru (0-based index)
  const [requestToMove] = state.requestQueue.splice(currentIndex, 1);
  state.requestQueue.splice(newPosition - 1, 0, requestToMove);
  
  saveRequests();
  
  console.log(`🔄 Admin moved request "${requestToMove.query}" from position ${currentIndex + 1} to ${newPosition}`);
  
  res.json({
    success: true,
    message: `Request berhasil dipindahkan ke posisi ${newPosition}`,
    request: requestToMove,
    oldPosition: currentIndex + 1,
    newPosition,
    queue: state.requestQueue.map((req, idx) => ({
      id: req.id,
      query: req.query,
      position: idx + 1
    }))
  });
});

// 9. GET ALL REQUESTS
app.get('/requests', (req, res) => {
  const requestsWithWait = state.requestQueue.map((req, index) => ({
    ...req,
    position: index + 1,
    estimatedWait: calculateWaitTime(index + 1),
    estimatedWaitFormatted: formatWaitTime(calculateWaitTime(index + 1) * 60)
  }));
  
  res.json({
    activeRequest: state.activeRequest,
    queue: requestsWithWait,
    total: state.requestQueue.length,
    isLocked: Date.now() < state.requestLockUntil,
    lockRemaining: Math.max(0, state.requestLockUntil - Date.now()),
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    queueFull: state.requestQueue.length >= QUEUE_LIMIT
  });
});

// 10. SONG ENDED (dipanggil ketika lagu selesai)
app.post('/song-ended', (req, res) => {
  const now = Date.now();
  
  console.log(`⏭️ Song ended notification received`);
  
  // Hapus timeout auto-unlock
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
  
  // Reset lock
  state.requestLockUntil = 0;
  state.currentSong.isPlaying = false;
  
  // Update active request status
  if (state.activeRequest) {
    state.activeRequest.status = 'completed';
    state.activeRequest.completedAt = now;
    state.activeRequest.actualDuration = now - state.activeRequest.startedAt;
    state.activeRequest = null;
  }
  
  saveRequests();
  
  res.json({
    success: true,
    message: 'Lock released for next request',
    timestamp: now,
    nextRequestAvailable: state.requestQueue.length > 0
  });
});

// 11. VERIFY SONG MATCH
app.post('/verify-match', (req, res) => {
  const { title, artist } = req.body;
  
  if (!state.activeRequest) {
    return res.json({ isMatch: false, reason: 'No active request' });
  }
  
  const requestQuery = state.activeRequest.query.toLowerCase();
  const songTitle = (title || '').toLowerCase();
  const songArtist = (artist || '').toLowerCase();
  
  // Cek kecocokan sederhana
  const isMatch = songTitle.includes(requestQuery) || 
                 requestQuery.includes(songTitle) ||
                 songArtist.includes(requestQuery) ||
                 requestQuery.includes(songArtist);
  
  const matchData = {
    isMatch,
    requestId: state.activeRequest.id,
    requestQuery: state.activeRequest.query,
    songTitle: title,
    songArtist: artist,
    confidence: calculateMatchConfidence(requestQuery, songTitle, songArtist)
  };
  
  if (isMatch) {
    console.log(`✅ Song match confirmed: "${title}" matches request "${requestQuery}"`);
  }
  
  res.json(matchData);
});

// 12. SKIP CURRENT REQUEST (Admin only)
app.post('/skip-current', requireAdmin, (req, res) => {
  console.log('⏭️ Skip current request requested');
  
  // Hapus timeout auto-unlock
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
  
  // Reset lock
  state.requestLockUntil = 0;
  
  // Update active request status
  if (state.activeRequest) {
    state.activeRequest.status = 'skipped';
    state.activeRequest.skippedAt = Date.now();
    
    state.activeRequest = null;
  }
  
  saveRequests();
  
  res.json({
    success: true,
    message: 'Request skipped successfully',
    nextRequest: state.requestQueue.length > 0 ? state.requestQueue[0] : null,
    queueLength: state.requestQueue.length
  });
});

// 13. FORCE NEXT (Admin only)
app.post('/force-next', requireAdmin, (req, res) => {
  console.log('⚡ Force next requested');
  
  // Hapus timeout auto-unlock
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
  
  // Reset semua state terkait playback
  state.requestLockUntil = 0;
  state.currentSong.isPlaying = false;
  
  if (state.activeRequest) {
    state.activeRequest.status = 'force_skipped';
    state.activeRequest.forceSkippedAt = Date.now();
    state.activeRequest = null;
  }
  
  saveRequests();
  
  res.json({
    success: true,
    message: 'Force skip completed',
    timestamp: Date.now()
  });
});

// 14. REMOVE SPECIFIC REQUEST (Admin only)
app.delete('/remove-request/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const index = state.requestQueue.findIndex(req => req.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Request tidak ditemukan' });
  }
  
  const removed = state.requestQueue.splice(index, 1)[0];
  
  // Jika yang dihapus adalah active request, reset lock
  if (state.activeRequest && state.activeRequest.id === id) {
    // Hapus timeout auto-unlock
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
    
    state.requestLockUntil = 0;
    state.activeRequest = null;
    console.log(`⚠️ Active request removed: "${removed.query}"`);
  }
  
  saveRequests();
  
  console.log(`🗑️ Request removed: "${removed.query}"`);
  
  res.json({
    success: true,
    message: 'Request berhasil dihapus',
    removed: removed.query,
    newQueueLength: state.requestQueue.length,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length
  });
});

// 15. CLEAR ALL REQUESTS (Admin only)
app.delete('/clear-requests', requireAdmin, (req, res) => {
  const previousCount = state.requestQueue.length;
  
  state.requestQueue = [];
  state.activeRequest = null;
  state.requestLockUntil = 0;
  
  // Hapus timeout auto-unlock
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
  
  saveRequests();
  
  console.log(`🗑️ Cleared ${previousCount} requests`);
  
  res.json({
    success: true,
    message: 'Semua request telah dihapus',
    clearedCount: previousCount,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT
  });
});

// 16. GET QUEUE INFO
app.get('/queue-info', (req, res) => {
  const now = Date.now();
  const isLocked = now < state.requestLockUntil;
  const remainingSeconds = isLocked ? Math.ceil((state.requestLockUntil - now) / 1000) : 0;
  
  // Hitung total waktu antrian
  let totalQueueMinutes = 0;
  if (isLocked) {
    totalQueueMinutes += remainingSeconds / 60;
  }
  
  // Tambahkan durasi setiap lagu dalam antrian
  state.requestQueue.forEach(() => {
    totalQueueMinutes += (state.currentSong.duration / 60000);
  });
  
  const queueInfo = {
    isLocked,
    lockUntil: state.requestLockUntil,
    remainingSeconds,
    remainingFormatted: formatWaitTime(remainingSeconds),
    currentRequest: state.activeRequest,
    currentSong: state.currentSong,
    queue: state.requestQueue.map((req, index) => ({
      ...req,
      position: index + 1
    })),
    queueLength: state.requestQueue.length,
    totalQueueTime: Math.round(totalQueueMinutes * 10) / 10,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    queueFull: state.requestQueue.length >= QUEUE_LIMIT
  };
  
  res.json(queueInfo);
});

// 17. GET HISTORY
app.get('/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  
  const paginatedHistory = state.history.slice(offset, offset + limit);
  
  res.json({
    history: paginatedHistory,
    total: state.history.length,
    offset,
    limit,
    stats: state.stats
  });
});

// 18. GET STATS
app.get('/stats', (req, res) => {
  const now = Date.now();
  const uptime = Math.round((now - (state.history[0]?.timestamp || now)) / 1000);
  
  res.json({
    serverTime: now,
    uptimeSeconds: uptime,
    currentSong: state.currentSong,
    activeRequest: state.activeRequest,
    queueLength: state.requestQueue.length,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    historyCount: state.history.length,
    stats: state.stats,
    isLocked: now < state.requestLockUntil,
    lockRemaining: Math.max(0, state.requestLockUntil - now)
  });
});

// 19. ADD PRIORITY REQUEST (Admin only - langsung ke posisi pertama)
app.post('/admin/request-first', requireAdmin, (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || query.trim() === '') {
      return res.status(400).json({ error: 'Query tidak boleh kosong' });
    }

    // Validasi format: harus mengandung tanda pemisah
    const queryParts = query.split('-').map(part => part.trim());
    
    if (queryParts.length < 2) {
      console.log(`⚠️ Query tanpa pemisah: "${query}"`);
      // Tetap diterima, tapi beri warning di log
    }

    // CEK BATAS ANTRIAN (100 LAGU)
    if (state.requestQueue.length >= QUEUE_LIMIT) {
      return res.status(429).json({ 
        error: `Antrian penuh (maksimal ${QUEUE_LIMIT} lagu). Tunggu hingga beberapa lagu selesai diputar.`,
        queueLimit: QUEUE_LIMIT,
        currentQueue: state.requestQueue.length
      });
    }

    // Cek duplikat di queue
    const isDuplicate = state.requestQueue.some(req => 
      req.query.toLowerCase() === query.toLowerCase()
    );

    if (isDuplicate) {
      return res.status(409).json({ error: 'Lagu sudah ada dalam antrian' });
    }

    // Buat request baru dengan flag priority
    const newRequest = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      query: query.trim(),
      time: Date.now(),
      status: 'pending',
      addedBy: req.ip || 'unknown',
      title: queryParts[0] || query,
      artist: queryParts[1] || 'Unknown Artist',
      isPriority: true,
      addedByAdmin: true
    };

    // Tambahkan ke awal queue (posisi pertama)
    state.requestQueue.unshift(newRequest);
    saveRequests();

    console.log(`📝 Priority request added (first position): "${query}"`);
    console.log(`📝 Parsed as: Title="${queryParts[0] || query}", Artist="${queryParts[1] || 'Unknown Artist'}"`);
    console.log(`📊 Total queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);

    res.json({
      success: true,
      message: 'Priority request berhasil ditambahkan di posisi pertama',
      request: newRequest,
      queuePosition: 1,
      estimatedWait: 0, // Langsung pertama
      queueLimit: QUEUE_LIMIT,
      remainingSlots: QUEUE_LIMIT - state.requestQueue.length
    });

  } catch (error) {
    console.error('Error in /admin/request-first:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 20. GET APP VERSION
app.get('/version', (req, res) => {
  res.json({
    version: '2.3.0',
    buildTime: Date.now(),
    features: ['queue-limit-100', 'admin-priority-request', 'auto-refresh'],
    serverUptime: process.uptime(),
    queueSize: state.requestQueue.length,
    activeUsers: Object.keys(adminSession || {}).length > 0 ? 1 : 0
  });
});

// 21. HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    version: '2.3.0',
    uptime: process.uptime(),
    queueLimit: QUEUE_LIMIT,
    currentQueue: state.requestQueue.length,
    isLocked: Date.now() < state.requestLockUntil,
    lockRemaining: Math.max(0, state.requestLockUntil - Date.now())
  });
});

// ================= AUTO-UNLOCK TIMER =================
setInterval(() => {
  const now = Date.now();
  
  // Auto-unlock jika lock sudah expired tetapi masih aktif
  if (now > state.requestLockUntil && state.requestLockUntil > 0) {
    console.log(`🔄 Auto-unlock: Lock expired`);
    state.requestLockUntil = 0;
    
    if (state.activeRequest) {
      state.activeRequest.status = 'auto_completed';
      state.activeRequest.autoCompletedAt = now;
      state.activeRequest = null;
      saveRequests();
    }
    
    // Hapus timeout
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
  }
  
  // Auto-reset current song jika tidak ada update dalam 2 menit
  if (state.currentSong.isPlaying && now - state.currentSong.timestamp > 120000) {
    console.log('🔄 Auto-reset: No song update for 2 minutes');
    state.currentSong.isPlaying = false;
  }
}, 10000); // Cek setiap 10 detik

// ================= AUTO-CLEANUP ADMIN SESSION =================
setInterval(() => {
  if (adminSession && Date.now() > adminSession.expires) {
    console.log('🔄 Admin session expired, cleaning up');
    adminSession = null;
  }
}, 60000); // Cek setiap menit

// ================= SERVE WEB INTERFACE =================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= START SERVER =================
// Load data sebelum start
loadData();

app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log("✅ YouTube Music Bridge Server with Admin");
  console.log(`📍 Running at: http://localhost:${PORT}`);
  console.log(`📊 Current queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
  console.log(`🎵 Current song: ${state.currentSong.title}`);
  console.log(`🔐 Admin password: ${ADMIN_PASSWORD}`);
  console.log(`⚡ Queue limit: ${QUEUE_LIMIT} songs`);
  console.log(`🔄 Auto-refresh: Enabled`);
  console.log(`👑 Priority requests: Admin only`);
  console.log("=".repeat(50));
  
  // Log lock status jika ada
  if (state.requestLockUntil > 0) {
    const remaining = Math.ceil((state.requestLockUntil - Date.now()) / 1000);
    console.log(`⏰ Current lock: ${formatWaitTime(remaining)} remaining`);
  }
});

// Handle shutdown gracefully
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  
  // Hapus timeout sebelum shutdown
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
  }
  
  // Save data before exit
  saveRequests();
  saveHistory();
  
  console.log('✅ Data saved. Goodbye!');
  process.exit(0);
});