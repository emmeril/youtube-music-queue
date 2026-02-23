require("dotenv").config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Sequelize, DataTypes } = require('sequelize');

const app = express();
const PORT = 4786;
const APP_VERSION = '2.3.0';

// Konstanta
const QUEUE_LIMIT = 100;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 jam
const SESSION_REFRESH_THRESHOLD = 60 * 60 * 1000; // 1 jam (sliding expiration)
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_UNKNOWN = 'unknown';
const DEFAULT_UNKNOWN_ARTIST = 'Unknown Artist';

let adminSession = null;

// Pastikan direktori data ada
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// ================= INISIALISASI SEQUELIZE =================
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(dataDir, 'database.sqlite'),
  logging: false
});

// Model Request (antrian)
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
  queueOrder: { type: DataTypes.INTEGER, allowNull: false }
});

// Model History (riwayat)
const History = sequelize.define('History', {
  id: { type: DataTypes.STRING, primaryKey: true },
  song: { type: DataTypes.JSON, allowNull: false },
  request: { type: DataTypes.JSON },
  timestamp: { type: DataTypes.INTEGER, allowNull: false },
  duration: { type: DataTypes.INTEGER, allowNull: false }
});

// Model AppState (state global)
const AppState = sequelize.define('AppState', {
  key: { type: DataTypes.STRING, primaryKey: true },
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

// ================= MIDDLEWARE ADMIN (dengan sliding expiration) =================
function validateAdminSession(sessionToken, refreshLabel = 'Admin') {
  if (!sessionToken || !adminSession || adminSession.token !== sessionToken) {
    return { ok: false, reason: 'unauthorized' };
  }

  if (Date.now() > adminSession.expires) {
    adminSession = null;
    return { ok: false, reason: 'expired' };
  }

  const remaining = adminSession.expires - Date.now();
  if (remaining < SESSION_REFRESH_THRESHOLD) {
    adminSession.expires = Date.now() + SESSION_DURATION;
    console.log(`[SESSION] ${refreshLabel} session extended, new expiry: ${new Date(adminSession.expires).toLocaleString()}`);
  }

  return { ok: true, session: adminSession };
}

function sendAdminDenied(res) {
  return res.status(403).json({
    error: 'Akses ditolak. Hanya admin yang bisa melakukan aksi ini.',
    requiresAdmin: true
  });
}

function sendAdminExpired(res) {
  return res.status(403).json({
    error: 'Session admin telah kadaluarsa. Silakan login kembali.',
    sessionExpired: true
  });
}

function requireAdmin(req, res, next) {
  const validation = validateAdminSession(req.headers['x-admin-token'], 'Admin');
  if (!validation.ok) {
    return validation.reason === 'expired' ? sendAdminExpired(res) : sendAdminDenied(res);
  }

  req.adminRole = validation.session.role;
  next();
}

function requireSuperAdmin(req, res, next) {
  const validation = validateAdminSession(req.headers['x-admin-token'], 'Super admin');
  if (!validation.ok) {
    return validation.reason === 'expired' ? sendAdminExpired(res) : sendAdminDenied(res);
  }

  if (validation.session.role !== 'super') {
    return res.status(403).json({ 
      error: 'Akses ditolak. Hanya Super Admin yang bisa melakukan aksi ini.',
      requiresSuperAdmin: true 
    });
  }
  
  req.adminRole = validation.session.role;
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

function normalizeInput(value) {
  if (typeof value !== 'string') return '';
  return sanitizeInput(value);
}

function isBlank(value) {
  return normalizeInput(value).length === 0;
}

function generateId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function parseSongQuery(query) {
  const parts = normalizeInput(query).split('-').map(part => part.trim());
  return {
    title: parts[0] || '',
    artist: parts.slice(1).join('-') || ''
  };
}

function isStrictPositiveInteger(value) {
  return /^\d+$/.test(String(value));
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

function clearSongEndTimeout() {
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
}

function scheduleAutoUnlock(lockDuration) {
  clearSongEndTimeout();
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
          saveRequests(); // async, tidak perlu await
        }
      }
    }, lockDuration);
  }
}

function calculateWaitTime(position) {
  const avgSongDuration = 3; // menit
  return position * avgSongDuration;
}

function calculateMatchConfidence(requestQuery, songTitle, songArtist) {
  let confidence = 0;
  const lowerQuery = requestQuery.toLowerCase();
  const lowerTitle = songTitle.toLowerCase();
  const lowerArtist = songArtist.toLowerCase();
  
  if (lowerTitle === lowerQuery) confidence = 100;
  else if (lowerTitle.includes(lowerQuery) || lowerQuery.includes(lowerTitle)) confidence = 85;
  else if (lowerArtist.includes(lowerQuery) || lowerQuery.includes(lowerArtist)) confidence = 75;
  else {
    const requestWords = lowerQuery.split(' ').filter(Boolean);
    const titleWords = lowerTitle.split(' ');
    const artistWords = lowerArtist.split(' ');
    if (requestWords.length === 0) return 0;
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
  return text.trim().replace(/\s+/g, ' ').replace(/[<>{}]/g, '');
}

function getQueueRequestErrorStatus(error = '') {
  if (error.includes('penuh')) return 429;
  if (error.includes('sudah ada')) return 409;
  return 400;
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

function getLockRemainingMs(now = Date.now()) {
  return Math.max(0, state.requestLockUntil - now);
}

function getLockState(now = Date.now()) {
  return {
    isLocked: now < state.requestLockUntil,
    lockRemaining: getLockRemainingMs(now)
  };
}

function getQueueMeta() {
  return {
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length,
    queueFull: state.requestQueue.length >= QUEUE_LIMIT
  };
}

function getQueueWithPosition() {
  return state.requestQueue.map((req, index) => ({ ...req, position: index + 1 }));
}

function getCurrentLockProgress(now = Date.now()) {
  if (state.requestStartTime <= 0 || state.originalLockDuration <= 0) return 0;
  return Math.min(100, ((now - state.requestStartTime) / state.originalLockDuration) * 100);
}

function sendInternalError(res, context, error) {
  console.error(`Error in ${context}:`, error);
  return res.status(500).json({ error: 'Internal server error' });
}

function logQueueCount() {
  console.log(`📊 Total queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
}

function validateSongRequest(query) {
  const errors = [];
  const trimmed = normalizeInput(query);
  if (!trimmed) errors.push('Query tidak boleh kosong');
  if (trimmed.length > 200) errors.push('Query terlalu panjang (maksimal 200 karakter)');
  if (/[<>{}]/.test(trimmed)) errors.push('Query mengandung karakter yang tidak diperbolehkan');
  
  const rawParts = trimmed.split('-').map(part => part.trim());
  const parsed = parseSongQuery(trimmed);
  if (rawParts.length < 2) errors.push('Format harus: Judul Lagu - Nama Artis');
  if (parsed.title && parsed.title.length < 2) errors.push('Judul lagu minimal 2 karakter');
  if (parsed.artist && parsed.artist.length < 2) errors.push('Nama artis minimal 2 karakter');
  if (parsed.title && parsed.title.length > 100) errors.push('Judul lagu maksimal 100 karakter');
  if (parsed.artist && parsed.artist.length > 100) errors.push('Nama artis maksimal 100 karakter');
  if (parsed.title && /^\d+$/.test(parsed.title)) errors.push('Judul lagu tidak boleh hanya angka');
  
  const validCharsRegex = /^[a-zA-Z0-9\s.,'&!?()\-"@]+$/;
  if (parsed.title && !validCharsRegex.test(parsed.title)) errors.push('Judul lagu mengandung karakter tidak valid');
  if (parsed.artist && !validCharsRegex.test(parsed.artist)) errors.push('Nama artis mengandung karakter tidak valid');
  
  return {
    isValid: errors.length === 0,
    errors,
    title: parsed.title,
    artist: parsed.artist
  };
}

function addOfficialToTitle(query) {
  try {
    const parts = query.split('-').map(part => part.trim());
    if (parts.length < 2) return query + ' original lirik';
    
    let title = parts[0];
    const artist = parts.slice(1).join('-');
    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes('original lirik')) {
      // Sudah mengandung "original lirik", tidak perlu diubah
      return query;
    } else if (lowerTitle.includes('lirik')) {
      // Ganti "lirik" pertama dengan "original lirik"
      title = title.replace(/lirik/i, 'original lirik');
    } else {
      // Tidak mengandung "lirik" sama sekali, tambahkan di akhir
      title = title + ' original lirik';
    }
    
    return `${title} - ${artist}`;
  } catch (error) {
    console.error('Error in addOfficialToTitle:', error);
    return query;
  }
}

// Fungsi untuk membuat objek request baru
function createRequestObject(query, ip, userAgent, isPriority = false, addedByAdmin = false) {
  const queryWithOfficial = addOfficialToTitle(query);
  const parsed = parseSongQuery(queryWithOfficial);
  return {
    id: generateId(),
    query: queryWithOfficial,
    time: Date.now(),
    status: 'pending',
    addedBy: ip || DEFAULT_UNKNOWN,
    title: parsed.title || queryWithOfficial,
    artist: parsed.artist || DEFAULT_UNKNOWN_ARTIST,
    userAgent: userAgent || DEFAULT_UNKNOWN,
    originalQuery: query,
    isPriority,
    addedByAdmin
  };
}

// Fungsi untuk menambahkan request ke antrian (dengan validasi dan pengecekan duplicate)
async function addRequestToQueue(query, ip, userAgent, position = 'last', isPriority = false, addedByAdmin = false) {
  const normalizedQuery = normalizeInput(query);

  // Validasi
  const validation = validateSongRequest(normalizedQuery);
  if (!validation.isValid) {
    return { success: false, error: validation.errors[0], details: validation.errors };
  }
  
  const queryWithOfficial = addOfficialToTitle(normalizedQuery);
  
  // Cek antrian penuh
  if (state.requestQueue.length >= QUEUE_LIMIT) {
    return { success: false, error: `Antrian penuh (maksimal ${QUEUE_LIMIT} lagu).`, queueLimit: QUEUE_LIMIT };
  }
  
  // Cek duplikat di antrian
  const isDuplicate = state.requestQueue.some(req => req.query.toLowerCase() === queryWithOfficial.toLowerCase());
  if (isDuplicate) {
    return { success: false, error: 'Lagu sudah ada dalam antrian' };
  }
  
  // Cek duplikat dengan lagu yang sedang diputar
  if (state.activeRequest && state.activeRequest.query.toLowerCase() === queryWithOfficial.toLowerCase()) {
    return { success: false, error: 'Lagu sedang diputar' };
  }
  
  // Cek riwayat 10 menit terakhir
  const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
  const recentDuplicate = state.history.some(item => 
    item.request && item.request.query.toLowerCase() === queryWithOfficial.toLowerCase() && item.timestamp > tenMinutesAgo
  );
  if (recentDuplicate) {
    return { success: false, error: 'Lagu ini baru saja diputar. Tunggu 10 menit.', cooldown: '10 menit' };
  }
  
  const newRequest = createRequestObject(normalizedQuery, ip, userAgent, isPriority, addedByAdmin);
  
  if (position === 'first') {
    state.requestQueue.unshift(newRequest);
  } else {
    state.requestQueue.push(newRequest);
  }
  
  await saveRequests();
  
  return {
    success: true,
    request: newRequest,
    queuePosition: position === 'first' ? 1 : state.requestQueue.length,
    estimatedWait: calculateWaitTime(state.requestQueue.length),
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length
  };
}

// ================= FUNGSI DATABASE =================
async function loadData() {
  try {
    await sequelize.sync();

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

    // Jadwalkan ulang auto-unlock jika masih ada lock
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
    await Request.destroy({ where: {} });
    
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
    
    await saveAppState();
  } catch (error) {
    console.error('Error saving requests:', error);
  }
}

async function saveHistory() {
  try {
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
    id: generateId(),
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
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (isBlank(password)) return res.status(400).json({ error: 'Password diperlukan' });
  
  let role = null;
  if (password === SUPER_ADMIN_PASSWORD) role = 'super';
  else if (password === ADMIN_PASSWORD) role = 'admin';
  else return res.status(401).json({ error: 'Password salah' });
  
  const token = generateId();
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
  let isAdmin = false;
  let role = null;
  let expiresAt = null;

  const validation = validateAdminSession(sessionToken, 'Admin via status check');
  if (validation.ok) {
    isAdmin = true;
    role = validation.session.role;
    expiresAt = validation.session.expires;
  }
  res.json({
    isAdmin,
    role,
    expiresAt,
    remainingTime: isAdmin ? expiresAt - Date.now() : 0
  });
});

app.post('/update', async (req, res) => {
  try {
    const { title, artist, duration, isNewSong, url } = req.body;
    const now = Date.now();
    const validDuration = Math.max(10000, Math.min(duration || 180000, 3600000));
    const confidence = calculateConfidence({ title, artist, duration: validDuration });
    const previousSong = { ...state.currentSong };
    
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
      if (isNewSong || Math.abs(validDuration - (previousSong.duration || 0)) > 5000) {
        const newLockDuration = calculateLockDuration(validDuration);
        state.requestLockUntil = now + newLockDuration;
        state.originalLockDuration = newLockDuration;
        scheduleAutoUnlock(newLockDuration);
        console.log(`🔒 Lock updated to ${Math.round(newLockDuration/1000)}s for new song`);
      }
    }
    
    if (isNewSong && state.activeRequest) {
      await addToHistory(previousSong, state.activeRequest);
    }
    
    await saveAppState();
    
    res.json({
      success: true,
      message: 'Song updated',
      song: state.currentSong,
      timestamp: now,
      lockRemaining: getLockRemainingMs(now)
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.get('/status', (req, res) => {
  const now = Date.now();
  const { isLocked, lockRemaining } = getLockState(now);
  const { queueLimit, remainingSlots } = getQueueMeta();
  res.json({
    song: state.currentSong,
    isLocked,
    lockRemaining,
    lockRemainingFormatted: formatWaitTime(Math.round(lockRemaining / 1000)),
    activeRequest: state.activeRequest,
    queueLength: state.requestQueue.length,
    queueLimit,
    remainingSlots,
    stats: state.stats,
    lockInfo: {
      basedOnSongDuration: state.currentSong.duration,
      originalLock: state.originalLockDuration,
      currentProgress: getCurrentLockProgress(now)
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
    const parsedQuery = parseSongQuery(nextRequest.query);
    state.activeRequest = {
      ...nextRequest,
      parsedTitle: parsedQuery.title || nextRequest.query,
      parsedArtist: parsedQuery.artist || DEFAULT_UNKNOWN_ARTIST,
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
    console.log(`🎵 Parsed as: Title="${parsedQuery.title || nextRequest.query}", Artist="${parsedQuery.artist || DEFAULT_UNKNOWN_ARTIST}"`);
    console.log(`🔒 Lock duration: ${Math.round(lockDuration/1000)}s`);
    
    res.json({
      query: nextRequest.query,
      id: nextRequest.id,
      time: nextRequest.time,
      parsedTitle: parsedQuery.title || nextRequest.query,
      parsedArtist: parsedQuery.artist || DEFAULT_UNKNOWN_ARTIST,
      estimatedDuration: lockDuration,
      queueRemaining: state.requestQueue.length,
      lockUntil: state.requestLockUntil,
      songDuration: state.currentSong.duration
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/request-song', async (req, res) => {
  try {
    const { query } = req.body;
    if (isBlank(query)) {
      return res.status(400).json({ error: 'Query tidak boleh kosong' });
    }
    
    const result = await addRequestToQueue(
      query, 
      req.ip, 
      req.headers['user-agent'], 
      'last', 
      false, 
      false
    );
    
    if (!result.success) {
      const status = getQueueRequestErrorStatus(result.error);
      return res.status(status).json(result);
    }
    
    console.log(`📝 Request added: "${query}" → "${result.request.query}"`);
    logQueueCount();
    
    res.json({
      success: true,
      message: 'Request berhasil ditambahkan',
      request: result.request,
      queuePosition: result.queuePosition,
      estimatedWait: result.estimatedWait,
      queueLimit: result.queueLimit,
      remainingSlots: result.remainingSlots
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/admin/move-request', requireAdmin, async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId || !isStrictPositiveInteger(req.body.newPosition)) {
      return res.status(400).json({ error: 'requestId dan newPosition diperlukan' });
    }
    const newPosition = Number.parseInt(req.body.newPosition, 10);
    if (!Number.isInteger(newPosition)) {
      return res.status(400).json({ error: 'newPosition harus berupa angka bulat' });
    }
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
      queue: getQueueWithPosition().map(({ id, query, position }) => ({ id, query, position }))
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.get('/requests', (req, res) => {
  const { isLocked, lockRemaining } = getLockState();
  const queueMeta = getQueueMeta();
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
    isLocked,
    lockRemaining,
    ...queueMeta
  });
});

app.post('/song-ended', async (req, res) => {
  try {
    const now = Date.now();
    console.log(`⏭️ Song ended notification received`);
    
    clearSongEndTimeout();
    
    state.requestLockUntil = 0;
    state.currentSong.isPlaying = false;
    
    if (state.activeRequest) {
      state.activeRequest.status = 'completed';
      state.activeRequest.completedAt = now;
      state.activeRequest.actualDuration = now - state.activeRequest.startedAt;
      state.activeRequest = null;
    }
    
    await saveRequests();
    res.json({ 
      success: true, 
      message: 'Lock released for next request', 
      timestamp: now, 
      nextRequestAvailable: state.requestQueue.length > 0 
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/verify-match', (req, res) => {
  const { title, artist } = req.body;
  if (!state.activeRequest) {
    return res.json({ isMatch: false, reason: 'No active request' });
  }
  
  const requestQuery = state.activeRequest.query.toLowerCase();
  const songTitle = (title || '').toLowerCase();
  const songArtist = (artist || '').toLowerCase();
  const titleMatch = songTitle.length > 0 && (
    songTitle.includes(requestQuery) ||
    requestQuery.includes(songTitle)
  );
  const artistMatch = songArtist.length > 0 && (
    songArtist.includes(requestQuery) ||
    requestQuery.includes(songArtist)
  );
  const isMatch = titleMatch || artistMatch;
  
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

app.post('/skip-current', requireSuperAdmin, async (req, res) => {
  try {
    console.log('⏭️ Skip current request requested');
    
    clearSongEndTimeout();
    
    state.requestLockUntil = 0;
    
    if (state.activeRequest) {
      state.activeRequest.status = 'skipped';
      state.activeRequest.skippedAt = Date.now();
      state.activeRequest = null;
    }
    
    await saveRequests();
    res.json({ 
      success: true, 
      message: 'Request skipped successfully', 
      nextRequest: state.requestQueue.length > 0 ? state.requestQueue[0] : null, 
      queueLength: state.requestQueue.length 
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/force-next', requireSuperAdmin, async (req, res) => {
  try {
    console.log('⚡ Force next requested');
    
    clearSongEndTimeout();
    
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
    return sendInternalError(res, req.path, error);
  }
});

app.delete('/remove-request/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const index = state.requestQueue.findIndex(req => req.id === id);
    if (index === -1) return res.status(404).json({ error: 'Request tidak ditemukan' });
    
    const removed = state.requestQueue.splice(index, 1)[0];
    
    if (state.activeRequest && state.activeRequest.id === id) {
      clearSongEndTimeout();
      state.requestLockUntil = 0;
      state.activeRequest = null;
      console.log(`⚠️ Active request removed: "${removed.query}"`);
    }
    
    await saveRequests();
    console.log(`🗑️ Request removed: "${removed.query}"`);
    res.json({ 
      success: true, 
      message: 'Request berhasil dihapus', 
      removed: removed.query, 
      newQueueLength: state.requestQueue.length, 
      queueLimit: QUEUE_LIMIT, 
      remainingSlots: QUEUE_LIMIT - state.requestQueue.length 
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.delete('/clear-requests', requireSuperAdmin, async (req, res) => {
  try {
    const previousCount = state.requestQueue.length;
    state.requestQueue = [];
    state.activeRequest = null;
    state.requestLockUntil = 0;
    
    clearSongEndTimeout();
    
    await saveRequests();
    console.log(`🗑️ Cleared ${previousCount} requests`);
    res.json({ 
      success: true, 
      message: 'Semua request telah dihapus', 
      clearedCount: previousCount, 
      queueLimit: QUEUE_LIMIT, 
      remainingSlots: QUEUE_LIMIT 
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.get('/queue-info', (req, res) => {
  const now = Date.now();
  const { isLocked, lockRemaining } = getLockState(now);
  const queueMeta = getQueueMeta();
  const remainingSeconds = isLocked ? Math.ceil(lockRemaining / 1000) : 0;
  
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
    queue: getQueueWithPosition(),
    queueLength: state.requestQueue.length,
    totalQueueTime: Math.round(totalQueueMinutes * 10) / 10,
    ...queueMeta
  });
});

app.get('/history', (req, res) => {
  const requestedLimit = parseNonNegativeInt(req.query.limit, 50) || 50;
  const limit = Math.min(requestedLimit, MAX_HISTORY_LIMIT);
  const offset = parseNonNegativeInt(req.query.offset, 0);
  const paginatedHistory = state.history.slice(offset, offset + limit);
  res.json({ history: paginatedHistory, total: state.history.length, offset, limit, stats: state.stats });
});

app.get('/stats', (req, res) => {
  const now = Date.now();
  const { isLocked, lockRemaining } = getLockState(now);
  const { queueLimit, remainingSlots } = getQueueMeta();
  const uptime = Math.round((now - (state.history[0]?.timestamp || now)) / 1000);
  res.json({
    serverTime: now,
    uptimeSeconds: uptime,
    currentSong: state.currentSong,
    activeRequest: state.activeRequest,
    queueLength: state.requestQueue.length,
    queueLimit,
    remainingSlots,
    historyCount: state.history.length,
    stats: state.stats,
    isLocked,
    lockRemaining
  });
});

app.post('/admin/request-first', requireAdmin, async (req, res) => {
  try {
    const { query } = req.body;
    if (isBlank(query)) {
      return res.status(400).json({ error: 'Query tidak boleh kosong' });
    }
    
    const result = await addRequestToQueue(
      query, 
      req.ip, 
      req.headers['user-agent'], 
      'first', 
      true, 
      true
    );
    
    if (!result.success) {
      const status = getQueueRequestErrorStatus(result.error);
      return res.status(status).json(result);
    }
    
    console.log(`📝 Priority request added (first position): "${query}" → "${result.request.query}"`);
    logQueueCount();
    
    res.json({
      success: true,
      message: 'Priority request berhasil ditambahkan di posisi pertama',
      request: result.request,
      queuePosition: 1,
      estimatedWait: 0,
      queueLimit: result.queueLimit,
      remainingSlots: result.remainingSlots
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.get('/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    buildTime: Date.now(),
    features: ['queue-limit-100', 'multi-level-admin', 'auto-refresh', 'official-tag-automatic'],
    serverUptime: process.uptime(),
    queueSize: state.requestQueue.length,
    activeUsers: adminSession ? 1 : 0
  });
});

app.get('/health', (req, res) => {
  const { isLocked, lockRemaining } = getLockState();
  const { queueLimit } = getQueueMeta();
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    version: APP_VERSION,
    uptime: process.uptime(),
    queueLimit,
    currentQueue: state.requestQueue.length,
    isLocked,
    lockRemaining
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
    clearSongEndTimeout();
    changed = true;
  }
  
  if (state.currentSong.isPlaying && now - state.currentSong.timestamp > 60000) {
    console.log('🔄 Auto-reset: No song update for 1 minutes');
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
  
  clearSongEndTimeout();
  
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
