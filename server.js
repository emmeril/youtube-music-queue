require("dotenv").config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
const PORT = 4786;

// Konstanta batas antrian
const QUEUE_LIMIT = 100;

// Konstanta admin dengan dua level
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
let adminSession = null;
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 jam

// Pastikan direktori data ada
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// ================= INISIALISASI SEQUELIZE =================
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(__dirname, 'data', 'database.sqlite'),
  logging: false
});

// Definisikan model Request (antrian)
const Request = sequelize.define('Request', {
  id: { type: DataTypes.STRING, primaryKey: true },
  query: { type: DataTypes.STRING, allowNull: false },
  time: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  addedBy: { type: DataTypes.STRING },
  title: { type: DataTypes.STRING },
  artist: { type: DataTypes.STRING },
  userAgent: { type: DataTypes.STRING },
  originalQuery: { type: DataTypes.STRING },
  isPriority: { type: DataTypes.BOOLEAN, defaultValue: false },
  addedByAdmin: { type: DataTypes.BOOLEAN, defaultValue: false },
  queueOrder: { type: DataTypes.INTEGER, allowNull: false } // untuk urutan
});

// Definisikan model History (riwayat)
const History = sequelize.define('History', {
  id: { type: DataTypes.STRING, primaryKey: true },
  song: { type: DataTypes.JSON, allowNull: false },
  request: { type: DataTypes.JSON },
  timestamp: { type: DataTypes.INTEGER, allowNull: false },
  duration: { type: DataTypes.INTEGER, allowNull: false }
});

// Definisikan model AppState (menyimpan state global: activeRequest, lock, currentSong, dll)
const AppState = sequelize.define('AppState', {
  key: { type: DataTypes.STRING, primaryKey: true }, // hanya satu baris dengan key 'state'
  activeRequest: { type: DataTypes.JSON },
  requestLockUntil: { type: DataTypes.INTEGER },
  currentSong: { type: DataTypes.JSON },
  stats: { type: DataTypes.JSON },
  requestStartTime: { type: DataTypes.INTEGER },
  originalLockDuration: { type: DataTypes.INTEGER }
});

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
  
  if (Date.now() > adminSession.expires) {
    adminSession = null;
    return res.status(403).json({ 
      error: 'Session admin telah kadaluarsa. Silakan login kembali.',
      sessionExpired: true 
    });
  }
  
  req.adminRole = adminSession.role;
  next();
}

function requireSuperAdmin(req, res, next) {
  const sessionToken = req.headers['x-admin-token'];
  
  if (!sessionToken || !adminSession || adminSession.token !== sessionToken) {
    return res.status(403).json({ 
      error: 'Akses ditolak. Hanya admin yang bisa melakukan aksi ini.',
      requiresAdmin: true 
    });
  }
  
  if (Date.now() > adminSession.expires) {
    adminSession = null;
    return res.status(403).json({ 
      error: 'Session admin telah kadaluarsa. Silakan login kembali.',
      sessionExpired: true 
    });
  }
  
  if (adminSession.role !== 'super') {
    return res.status(403).json({ 
      error: 'Akses ditolak. Hanya Super Admin yang bisa melakukan aksi ini.',
      requiresSuperAdmin: true 
    });
  }
  
  req.adminRole = adminSession.role;
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
// ... (semua fungsi helper tetap sama: formatDuration, formatWaitTime, calculateConfidence, dll)
// (tidak diubah, hanya fungsi load/save yang dimodifikasi)

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
  if (song.duration >= 120000 && song.duration <= 300000) confidence += 30;
  if (song.title && song.title !== 'Tidak diketahui') confidence += 10;
  if (song.artist && song.artist !== 'Tidak diketahui') confidence += 10;
  return Math.min(confidence, 95);
}

function calculateLockDuration(songDuration) {
  return (songDuration || 180000) + 1;
}

function scheduleAutoUnlock(lockDuration) {
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
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
          saveRequests(); // async, tidak perlu await di sini
        }
      }
    }, lockDuration);
  }
}

function calculateWaitTime(position) {
  const avgSongDuration = 3;
  return position * avgSongDuration;
}

function calculateMatchConfidence(requestQuery, songTitle, songArtist) {
  let confidence = 0;
  if (songTitle === requestQuery) confidence = 100;
  else if (songTitle.includes(requestQuery) || requestQuery.includes(songTitle)) confidence = 85;
  else if (songArtist.includes(requestQuery) || requestQuery.includes(songArtist)) confidence = 75;
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

function sanitizeInput(text) {
  if (!text) return '';
  text = text.trim().replace(/\s+/g, ' ');
  return text.replace(/[<>{}]/g, '');
}

function validateSongRequest(query) {
  const errors = [];
  if (!query || query.trim() === '') errors.push('Query tidak boleh kosong');
  if (query.length > 200) errors.push('Query terlalu panjang (maksimal 200 karakter)');
  if (/[<>{}]/.test(query)) errors.push('Query mengandung karakter yang tidak diperbolehkan');
  const queryParts = query.split('-').map(part => part.trim());
  if (queryParts.length < 2) errors.push('Format harus: Judul Lagu - Nama Artis');
  if (queryParts[0] && queryParts[0].length < 2) errors.push('Judul lagu minimal 2 karakter');
  if (queryParts[1] && queryParts[1].length < 2) errors.push('Nama artis minimal 2 karakter');
  if (queryParts[0] && queryParts[0].length > 100) errors.push('Judul lagu maksimal 100 karakter');
  if (queryParts[1] && queryParts[1].length > 100) errors.push('Nama artis maksimal 100 karakter');
  if (queryParts[0] && /^\d+$/.test(queryParts[0])) errors.push('Judul lagu tidak boleh hanya angka');
  const validCharsRegex = /^[a-zA-Z0-9\s.,'&!?()\-"@]+$/;
  if (queryParts[0] && !validCharsRegex.test(queryParts[0])) errors.push('Judul lagu mengandung karakter tidak valid');
  if (queryParts[1] && !validCharsRegex.test(queryParts[1])) errors.push('Nama artis mengandung karakter tidak valid');
  return {
    isValid: errors.length === 0,
    errors,
    title: queryParts[0] || '',
    artist: queryParts.slice(1).join('-') || ''
  };
}

function addOfficialToTitle(query) {
  try {
    const parts = query.split('-').map(part => part.trim());
    if (parts.length < 2) return query + ' official';
    const title = parts[0];
    const artist = parts.slice(1).join('-');
    if (!title.toLowerCase().includes('original')) {
      return `${title} original - ${artist}`;
    }
    return query;
  } catch (error) {
    console.error('Error in addOfficialToTitle:', error);
    return query;
  }
}

// ================= FUNGSI DATABASE =================
async function loadData() {
  try {
    await sequelize.sync(); // pastikan tabel ada

    // Load antrian
    const requests = await Request.findAll({ order: [['queueOrder', 'ASC']] });
    state.requestQueue = requests.map(r => ({
      id: r.id,
      query: r.query,
      time: r.time,
      status: r.status,
      addedBy: r.addedBy,
      title: r.title,
      artist: r.artist,
      userAgent: r.userAgent,
      originalQuery: r.originalQuery,
      isPriority: r.isPriority,
      addedByAdmin: r.addedByAdmin
    }));

    // Load state global
    const appState = await AppState.findByPk('state');
    if (appState) {
      state.activeRequest = appState.activeRequest;
      state.requestLockUntil = appState.requestLockUntil || 0;
      state.currentSong = appState.currentSong || state.currentSong;
      state.stats = appState.stats || state.stats;
      state.requestStartTime = appState.requestStartTime || 0;
      state.originalLockDuration = appState.originalLockDuration || 0;
    }

    // Load history
    const historyItems = await History.findAll({ order: [['timestamp', 'DESC']] });
    state.history = historyItems.map(h => ({
      id: h.id,
      song: h.song,
      request: h.request,
      timestamp: h.timestamp,
      duration: h.duration
    }));

    // Jika masih ada lock tersisa, jadwalkan ulang auto-unlock
    if (state.requestLockUntil > Date.now()) {
      const remaining = state.requestLockUntil - Date.now();
      scheduleAutoUnlock(remaining);
    }

    console.log(`📂 Loaded ${state.requestQueue.length} requests from database`);
    console.log(`📂 Loaded ${state.history.length} history items`);
  } catch (error) {
    console.error('Error loading data from database:', error);
    state.requestQueue = [];
    state.history = [];
  }
}

async function saveRequests() {
  try {
    // Hapus semua request lama
    await Request.destroy({ where: {} });
    
    // Insert ulang dengan urutan baru
    const requestsToInsert = state.requestQueue.map((req, index) => ({
      id: req.id,
      query: req.query,
      time: req.time,
      status: req.status || 'pending',
      addedBy: req.addedBy,
      title: req.title,
      artist: req.artist,
      userAgent: req.userAgent,
      originalQuery: req.originalQuery,
      isPriority: req.isPriority || false,
      addedByAdmin: req.addedByAdmin || false,
      queueOrder: index
    }));
    
    if (requestsToInsert.length > 0) {
      await Request.bulkCreate(requestsToInsert);
    }
    
    // Simpan juga state global
    await saveAppState();
  } catch (error) {
    console.error('Error saving requests:', error);
  }
}

async function saveHistory() {
  try {
    // Simpan hanya 100 item terakhir
    const historyToSave = state.history.slice(0, 100);
    await History.destroy({ where: {} });
    const historyToInsert = historyToSave.map(h => ({
      id: h.id,
      song: h.song,
      request: h.request,
      timestamp: h.timestamp,
      duration: h.duration
    }));
    if (historyToInsert.length > 0) {
      await History.bulkCreate(historyToInsert);
    }
  } catch (error) {
    console.error('Error saving history:', error);
  }
}

async function saveAppState() {
  try {
    await AppState.upsert({
      key: 'state',
      activeRequest: state.activeRequest,
      requestLockUntil: state.requestLockUntil,
      currentSong: state.currentSong,
      stats: state.stats,
      requestStartTime: state.requestStartTime,
      originalLockDuration: state.originalLockDuration
    });
  } catch (error) {
    console.error('Error saving app state:', error);
  }
}

async function addToHistory(song, request = null) {
  const historyItem = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    song: { ...song },
    request: request ? { ...request } : null,
    timestamp: Date.now(),
    duration: song.duration || 180000
  };
  
  state.history.unshift(historyItem);
  state.stats.totalSongsPlayed++;
  state.stats.totalPlayTime += Math.round((song.duration || 180000) / 60000);
  
  await saveHistory();
}

// ================= API ENDPOINTS =================
// (Semua endpoint diubah menjadi async dan menambahkan await pada fungsi save)

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password diperlukan' });
  let role = null;
  if (password === SUPER_ADMIN_PASSWORD) role = 'super';
  else if (password === ADMIN_PASSWORD) role = 'admin';
  else return res.status(401).json({ error: 'Password salah' });
  const token = Date.now().toString(36) + Math.random().toString(36).substr(2);
  adminSession = {
    token,
    role,
    expires: Date.now() + SESSION_DURATION,
    createdAt: Date.now()
  };
  console.log(`🔐 ${role === 'super' ? 'Super Admin' : 'Admin'} login successful`);
  res.json({ success: true, token, role, expiresIn: SESSION_DURATION, expiresAt: adminSession.expires });
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  adminSession = null;
  console.log(`🔐 Admin logged out`);
  res.json({ success: true, message: 'Logout berhasil' });
});

app.get('/admin/status', (req, res) => {
  const sessionToken = req.headers['x-admin-token'];
  const isAdmin = adminSession && adminSession.token === sessionToken && Date.now() < adminSession.expires;
  res.json({ isAdmin, role: isAdmin ? adminSession.role : null, expiresAt: isAdmin ? adminSession.expires : null, remainingTime: isAdmin ? adminSession.expires - Date.now() : 0 });
});

app.post('/update', async (req, res) => {
  try {
    const { title, artist, duration, timestamp, isNewSong, url } = req.body;
    const now = Date.now();
    const validDuration = Math.max(10000, Math.min(duration || 180000, 3600000));
    const confidence = calculateConfidence({ title, artist, duration: validDuration });
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
    
    if (state.activeRequest && state.requestLockUntil > 0) {
      const remainingLock = state.requestLockUntil - now;
      if (isNewSong || Math.abs(validDuration - state.currentSong.duration) > 5000) {
        const newLockDuration = calculateLockDuration(validDuration);
        state.requestLockUntil = now + newLockDuration;
        state.originalLockDuration = newLockDuration;
        scheduleAutoUnlock(newLockDuration);
        console.log(`🔒 Lock updated to ${Math.round(newLockDuration/1000)}s for new song`);
      }
    }
    
    if (isNewSong && state.activeRequest) {
      await addToHistory(state.currentSong, state.activeRequest);
    }
    
    await saveAppState(); // simpan currentSong dan lock
    
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

app.get('/status', (req, res) => {
  const now = Date.now();
  const lockRemaining = Math.max(0, state.requestLockUntil - now);
  res.json({
    song: state.currentSong,
    isLocked: now < state.requestLockUntil,
    lockRemaining,
    lockRemainingFormatted: formatWaitTime(Math.round(lockRemaining / 1000)),
    activeRequest: state.activeRequest,
    queueLength: state.requestQueue.length,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    stats: state.stats,
    lockInfo: {
      basedOnSongDuration: state.currentSong.duration,
      originalLock: state.originalLockDuration,
      currentProgress: state.requestStartTime > 0 ? Math.min(100, ((now - state.requestStartTime) / state.originalLockDuration) * 100) : 0
    }
  });
});

app.get('/get-request', async (req, res) => {
  try {
    const now = Date.now();
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
    
    if (state.requestQueue.length === 0) {
      if (state.activeRequest) {
        state.activeRequest.status = 'completed';
        state.activeRequest.completedAt = now;
        state.activeRequest = null;
        await saveRequests();
      }
      return res.status(204).send();
    }
    
    const nextRequest = state.requestQueue.shift();
    const queryParts = nextRequest.query.split('-').map(part => part.trim());
    state.activeRequest = {
      ...nextRequest,
      parsedTitle: queryParts[0] || nextRequest.query,
      parsedArtist: queryParts[1] || 'Unknown Artist',
      status: 'playing',
      startedAt: now
    };
    const lockDuration = calculateLockDuration(state.currentSong.duration);
    state.requestLockUntil = now + lockDuration;
    state.requestStartTime = now;
    state.originalLockDuration = lockDuration;
    scheduleAutoUnlock(lockDuration);
    state.stats.totalRequests++;
    await saveRequests();
    
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
  } catch (error) {
    console.error('Error in /get-request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/request-song', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim() === '') return res.status(400).json({ error: 'Query tidak boleh kosong' });
    
    const validation = validateSongRequest(query);
    if (!validation.isValid) return res.status(400).json({ error: validation.errors[0], details: validation.errors });
    
    const queryWithOfficial = addOfficialToTitle(query);
    
    if (state.requestQueue.length >= QUEUE_LIMIT) {
      return res.status(429).json({ error: `Antrian penuh (maksimal ${QUEUE_LIMIT} lagu).`, queueLimit: QUEUE_LIMIT, currentQueue: state.requestQueue.length });
    }
    
    const isDuplicate = state.requestQueue.some(req => req.query.toLowerCase() === queryWithOfficial.toLowerCase());
    if (isDuplicate) return res.status(409).json({ error: 'Lagu sudah ada dalam antrian' });
    if (state.activeRequest && state.activeRequest.query.toLowerCase() === queryWithOfficial.toLowerCase()) {
      return res.status(409).json({ error: 'Lagu sedang diputar' });
    }
    
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    const recentDuplicate = state.history.some(item => 
      item.request && item.request.query.toLowerCase() === queryWithOfficial.toLowerCase() && item.timestamp > tenMinutesAgo
    );
    if (recentDuplicate) {
      return res.status(429).json({ error: 'Lagu ini baru saja diputar. Tunggu 10 menit.', cooldown: '10 menit' });
    }
    
    const officialQueryParts = queryWithOfficial.split('-').map(part => part.trim());
    const newRequest = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      query: queryWithOfficial,
      time: Date.now(),
      status: 'pending',
      addedBy: req.ip || 'unknown',
      title: officialQueryParts[0] || queryWithOfficial,
      artist: officialQueryParts[1] || 'Unknown Artist',
      userAgent: req.headers['user-agent'] || 'unknown',
      originalQuery: query
    };
    
    state.requestQueue.push(newRequest);
    await saveRequests();
    
    console.log(`📝 Request added: "${query}" → "${queryWithOfficial}"`);
    console.log(`📝 Validated as: Title="${officialQueryParts[0] || queryWithOfficial}", Artist="${officialQueryParts[1] || 'Unknown Artist'}"`);
    console.log(`📊 Total queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
    
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

app.post('/admin/move-request', requireAdmin, async (req, res) => {
  try {
    const { requestId, newPosition } = req.body;
    if (!requestId || !newPosition) return res.status(400).json({ error: 'requestId dan newPosition diperlukan' });
    if (newPosition < 1 || newPosition > state.requestQueue.length) {
      return res.status(400).json({ error: `Posisi harus antara 1 dan ${state.requestQueue.length}` });
    }
    
    const currentIndex = state.requestQueue.findIndex(req => req.id === requestId);
    if (currentIndex === -1) return res.status(404).json({ error: 'Request tidak ditemukan' });
    
    if (currentIndex + 1 === newPosition) {
      return res.json({ success: true, message: 'Posisi tidak berubah' });
    }
    
    const [requestToMove] = state.requestQueue.splice(currentIndex, 1);
    state.requestQueue.splice(newPosition - 1, 0, requestToMove);
    await saveRequests();
    
    console.log(`🔄 Admin moved request "${requestToMove.query}" from position ${currentIndex + 1} to ${newPosition}`);
    res.json({
      success: true,
      message: `Request berhasil dipindahkan ke posisi ${newPosition}`,
      request: requestToMove,
      oldPosition: currentIndex + 1,
      newPosition,
      queue: state.requestQueue.map((req, idx) => ({ id: req.id, query: req.query, position: idx + 1 }))
    });
  } catch (error) {
    console.error('Error in /admin/move-request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

app.post('/song-ended', async (req, res) => {
  try {
    const now = Date.now();
    console.log(`⏭️ Song ended notification received`);
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
    state.requestLockUntil = 0;
    state.currentSong.isPlaying = false;
    if (state.activeRequest) {
      state.activeRequest.status = 'completed';
      state.activeRequest.completedAt = now;
      state.activeRequest.actualDuration = now - state.activeRequest.startedAt;
      state.activeRequest = null;
    }
    await saveRequests();
    res.json({ success: true, message: 'Lock released for next request', timestamp: now, nextRequestAvailable: state.requestQueue.length > 0 });
  } catch (error) {
    console.error('Error in /song-ended:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/verify-match', (req, res) => {
  const { title, artist } = req.body;
  if (!state.activeRequest) return res.json({ isMatch: false, reason: 'No active request' });
  const requestQuery = state.activeRequest.query.toLowerCase();
  const songTitle = (title || '').toLowerCase();
  const songArtist = (artist || '').toLowerCase();
  const isMatch = songTitle.includes(requestQuery) || requestQuery.includes(songTitle) || songArtist.includes(requestQuery) || requestQuery.includes(songArtist);
  const matchData = {
    isMatch,
    requestId: state.activeRequest.id,
    requestQuery: state.activeRequest.query,
    songTitle: title,
    songArtist: artist,
    confidence: calculateMatchConfidence(requestQuery, songTitle, songArtist)
  };
  if (isMatch) console.log(`✅ Song match confirmed: "${title}" matches request "${requestQuery}"`);
  res.json(matchData);
});

app.post('/skip-current', requireSuperAdmin, async (req, res) => {
  try {
    console.log('⏭️ Skip current request requested');
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
    state.requestLockUntil = 0;
    if (state.activeRequest) {
      state.activeRequest.status = 'skipped';
      state.activeRequest.skippedAt = Date.now();
      state.activeRequest = null;
    }
    await saveRequests();
    res.json({ success: true, message: 'Request skipped successfully', nextRequest: state.requestQueue.length > 0 ? state.requestQueue[0] : null, queueLength: state.requestQueue.length });
  } catch (error) {
    console.error('Error in /skip-current:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/force-next', requireSuperAdmin, async (req, res) => {
  try {
    console.log('⚡ Force next requested');
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
    state.requestLockUntil = 0;
    state.currentSong.isPlaying = false;
    if (state.activeRequest) {
      state.activeRequest.status = 'force_skipped';
      state.activeRequest.forceSkippedAt = Date.now();
      state.activeRequest = null;
    }
    await saveRequests();
    res.json({ success: true, message: 'Force skip completed', timestamp: Date.now() });
  } catch (error) {
    console.error('Error in /force-next:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/remove-request/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const index = state.requestQueue.findIndex(req => req.id === id);
    if (index === -1) return res.status(404).json({ error: 'Request tidak ditemukan' });
    
    const removed = state.requestQueue.splice(index, 1)[0];
    if (state.activeRequest && state.activeRequest.id === id) {
      if (state.songEndTimeout) {
        clearTimeout(state.songEndTimeout);
        state.songEndTimeout = null;
      }
      state.requestLockUntil = 0;
      state.activeRequest = null;
      console.log(`⚠️ Active request removed: "${removed.query}"`);
    }
    await saveRequests();
    console.log(`🗑️ Request removed: "${removed.query}"`);
    res.json({ success: true, message: 'Request berhasil dihapus', removed: removed.query, newQueueLength: state.requestQueue.length, queueLimit: QUEUE_LIMIT, remainingSlots: QUEUE_LIMIT - state.requestQueue.length });
  } catch (error) {
    console.error('Error in /remove-request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/clear-requests', requireSuperAdmin, async (req, res) => {
  try {
    const previousCount = state.requestQueue.length;
    state.requestQueue = [];
    state.activeRequest = null;
    state.requestLockUntil = 0;
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
    await saveRequests();
    console.log(`🗑️ Cleared ${previousCount} requests`);
    res.json({ success: true, message: 'Semua request telah dihapus', clearedCount: previousCount, queueLimit: QUEUE_LIMIT, remainingSlots: QUEUE_LIMIT });
  } catch (error) {
    console.error('Error in /clear-requests:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/queue-info', (req, res) => {
  const now = Date.now();
  const isLocked = now < state.requestLockUntil;
  const remainingSeconds = isLocked ? Math.ceil((state.requestLockUntil - now) / 1000) : 0;
  let totalQueueMinutes = 0;
  if (isLocked) totalQueueMinutes += remainingSeconds / 60;
  state.requestQueue.forEach(() => totalQueueMinutes += (state.currentSong.duration / 60000));
  res.json({
    isLocked,
    lockUntil: state.requestLockUntil,
    remainingSeconds,
    remainingFormatted: formatWaitTime(remainingSeconds),
    currentRequest: state.activeRequest,
    currentSong: state.currentSong,
    queue: state.requestQueue.map((req, index) => ({ ...req, position: index + 1 })),
    queueLength: state.requestQueue.length,
    totalQueueTime: Math.round(totalQueueMinutes * 10) / 10,
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    queueFull: state.requestQueue.length >= QUEUE_LIMIT
  });
});

app.get('/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const paginatedHistory = state.history.slice(offset, offset + limit);
  res.json({ history: paginatedHistory, total: state.history.length, offset, limit, stats: state.stats });
});

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

app.post('/admin/request-first', requireAdmin, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim() === '') return res.status(400).json({ error: 'Query tidak boleh kosong' });
    
    const validation = validateSongRequest(query);
    if (!validation.isValid) return res.status(400).json({ error: validation.errors[0], details: validation.errors });
    
    const queryWithOfficial = addOfficialToTitle(query);
    
    if (state.requestQueue.length >= QUEUE_LIMIT) {
      return res.status(429).json({ error: `Antrian penuh (maksimal ${QUEUE_LIMIT} lagu).`, queueLimit: QUEUE_LIMIT, currentQueue: state.requestQueue.length });
    }
    
    const isDuplicate = state.requestQueue.some(req => req.query.toLowerCase() === queryWithOfficial.toLowerCase());
    if (isDuplicate) return res.status(409).json({ error: 'Lagu sudah ada dalam antrian' });
    if (state.activeRequest && state.activeRequest.query.toLowerCase() === queryWithOfficial.toLowerCase()) {
      return res.status(409).json({ error: 'Lagu sedang diputar' });
    }
    
    const officialQueryParts = queryWithOfficial.split('-').map(part => part.trim());
    const newRequest = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      query: queryWithOfficial,
      time: Date.now(),
      status: 'pending',
      addedBy: req.ip || 'unknown',
      title: officialQueryParts[0] || queryWithOfficial,
      artist: officialQueryParts[1] || 'Unknown Artist',
      isPriority: true,
      addedByAdmin: true,
      userAgent: req.headers['user-agent'] || 'unknown',
      originalQuery: query
    };
    
    state.requestQueue.unshift(newRequest);
    await saveRequests();
    
    console.log(`📝 Priority request added (first position): "${query}" → "${queryWithOfficial}"`);
    console.log(`📝 Validated as: Title="${officialQueryParts[0] || queryWithOfficial}", Artist="${officialQueryParts[1] || 'Unknown Artist'}"`);
    console.log(`📊 Total queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
    
    res.json({
      success: true,
      message: 'Priority request berhasil ditambahkan di posisi pertama',
      request: newRequest,
      queuePosition: 1,
      estimatedWait: 0,
      queueLimit: QUEUE_LIMIT,
      remainingSlots: QUEUE_LIMIT - state.requestQueue.length
    });
  } catch (error) {
    console.error('Error in /admin/request-first:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/version', (req, res) => {
  res.json({
    version: '2.3.0',
    buildTime: Date.now(),
    features: ['queue-limit-100', 'multi-level-admin', 'auto-refresh', 'official-tag-automatic'],
    serverUptime: process.uptime(),
    queueSize: state.requestQueue.length,
    activeUsers: Object.keys(adminSession || {}).length > 0 ? 1 : 0
  });
});

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
setInterval(async () => {
  const now = Date.now();
  let changed = false;
  
  if (now > state.requestLockUntil && state.requestLockUntil > 0) {
    console.log(`🔄 Auto-unlock: Lock expired`);
    state.requestLockUntil = 0;
    if (state.activeRequest) {
      state.activeRequest.status = 'auto_completed';
      state.activeRequest.autoCompletedAt = now;
      state.activeRequest = null;
      changed = true;
    }
    if (state.songEndTimeout) {
      clearTimeout(state.songEndTimeout);
      state.songEndTimeout = null;
    }
    changed = true;
  }
  
  if (state.currentSong.isPlaying && now - state.currentSong.timestamp > 120000) {
    console.log('🔄 Auto-reset: No song update for 2 minutes');
    state.currentSong.isPlaying = false;
    changed = true;
  }
  
  if (changed) {
    try {
      await saveRequests();
    } catch (err) {
      console.error('Error in auto-unlock timer:', err);
    }
  }
}, 10000);

// ================= AUTO-CLEANUP ADMIN SESSION =================
setInterval(() => {
  if (adminSession && Date.now() > adminSession.expires) {
    console.log('🔄 Admin session expired, cleaning up');
    adminSession = null;
  }
}, 60000);

// ================= SERVE WEB INTERFACE =================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= START SERVER =================
async function initialize() {
  await loadData();
  app.listen(PORT, () => {
    console.log("=".repeat(50));
    console.log("✅ YouTube Music Bridge Server with Multi-Level Admin (Sequelize)");
    console.log(`📍 Running at: http://localhost:${PORT}`);
    console.log(`📊 Current queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
    console.log(`🎵 Current song: ${state.currentSong.title}`);
    console.log(`👑 Super Admin: Full access`);
    console.log(`👨‍💼 Admin: Can add priority, move, delete (single), no clear all`);
    console.log(`⚡ Queue limit: ${QUEUE_LIMIT} songs`);
    console.log(`🔄 Auto-refresh: Enabled`);
    console.log(`🏷️  Auto "official" tag: Enabled`);
    console.log("=".repeat(50));
    
    if (state.requestLockUntil > 0) {
      const remaining = Math.ceil((state.requestLockUntil - Date.now()) / 1000);
      console.log(`⏰ Current lock: ${formatWaitTime(remaining)} remaining`);
    }
  });
}

initialize().catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
  }
  
  try {
    await saveRequests();
    await saveHistory();
    console.log('✅ Data saved. Goodbye!');
  } catch (err) {
    console.error('Error saving data on shutdown:', err);
  } finally {
    process.exit(0);
  }
});