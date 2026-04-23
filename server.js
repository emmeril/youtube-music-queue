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
const MAX_REQUESTS_PER_ARTIST = 3;
const DEFAULT_ADMIN_DB_PASSWORD = process.env.ADMIN_PASSWORD || 'Monse@2026';
const DEFAULT_SUPER_ADMIN_DB_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Kucing@123';
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 jam
const SESSION_REFRESH_THRESHOLD = 60 * 60 * 1000; // 1 jam (sliding expiration)
const MAX_HISTORY_LIMIT = 100;
const FAIR_RANDOM_POOL_SIZE = 20;
const DEFAULT_AVG_SONG_DURATION_MINUTES = 3;
const DEFAULT_UNKNOWN_TITLE = 'Tidak ada lagu';
const DEFAULT_UNKNOWN_LABEL = 'Tidak diketahui';
const DEFAULT_UNKNOWN = 'unknown';
const DEFAULT_UNKNOWN_ARTIST = 'Unknown Artist';

const adminSessions = new Map();
let lastUpdateSignature = null;
let lastUpdateAt = 0;

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

const AdminCredential = sequelize.define('AdminCredential', {
  role: { type: DataTypes.STRING, primaryKey: true },
  password: { type: DataTypes.STRING, allowNull: false },
  updatedAtMs: { type: DataTypes.INTEGER, allowNull: false }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ================= MIDDLEWARE ADMIN (dengan sliding expiration) =================
function validateAdminSession(sessionToken, refreshLabel = 'Admin') {
  if (!sessionToken) {
    return { ok: false, reason: 'unauthorized' };
  }

  const session = adminSessions.get(sessionToken);
  if (!session) {
    return { ok: false, reason: 'unauthorized' };
  }

  if (Date.now() > session.expires) {
    adminSessions.delete(sessionToken);
    return { ok: false, reason: 'expired' };
  }

  const remaining = session.expires - Date.now();
  if (remaining < SESSION_REFRESH_THRESHOLD) {
    session.expires = Date.now() + SESSION_DURATION;
    console.log(`[SESSION] ${refreshLabel} session extended, new expiry: ${new Date(session.expires).toLocaleString()}`);
  }

  return { ok: true, session };
}

async function validateAdminPassword(password, requiredRole = null) {
  const normalizedPassword = normalizeInput(password);
  if (isBlank(normalizedPassword)) {
    return { ok: false, reason: 'unauthorized' };
  }

  const superCredential = await getAdminCredential('super');
  const adminCredential = await getAdminCredential('admin');

  let role = null;
  if (superCredential && normalizedPassword === superCredential.password) {
    role = 'super';
  } else if (adminCredential && normalizedPassword === adminCredential.password) {
    role = 'admin';
  }

  if (!role) {
    return { ok: false, reason: 'unauthorized' };
  }

  if (requiredRole === 'super' && role !== 'super') {
    return { ok: false, reason: 'forbidden', role };
  }

  return {
    ok: true,
    session: {
      role,
      authMethod: 'password'
    }
  };
}

function isAdminSessionTokenValid(sessionToken) {
  if (!sessionToken) return false;
  const session = adminSessions.get(sessionToken);
  if (!session) return false;
  if (Date.now() > session.expires) {
    adminSessions.delete(sessionToken);
    return false;
  }
  return true;
}

function sendAdminDenied(res) {
  return sendError(
    res,
    403,
    'ADMIN_REQUIRED',
    'Akses ditolak. Hanya admin yang bisa melakukan aksi ini.',
    { requiresAdmin: true }
  );
}

function sendAdminExpired(res) {
  return sendError(
    res,
    403,
    'ADMIN_SESSION_EXPIRED',
    'Session admin telah kadaluarsa. Silakan login kembali.',
    { sessionExpired: true }
  );
}

async function requireAdmin(req, res, next) {
  const passwordHeader = req.headers['x-admin-password'];
  const tokenHeader = req.headers['x-admin-token'];
  const validation = passwordHeader
    ? await validateAdminPassword(passwordHeader)
    : validateAdminSession(tokenHeader, 'Admin');

  if (!validation.ok) {
    return validation.reason === 'expired' ? sendAdminExpired(res) : sendAdminDenied(res);
  }

  req.adminRole = validation.session.role;
  req.adminAuthMethod = validation.session.authMethod || 'session';
  next();
}

async function requireSuperAdmin(req, res, next) {
  const passwordHeader = req.headers['x-admin-password'];
  const tokenHeader = req.headers['x-admin-token'];
  const validation = passwordHeader
    ? await validateAdminPassword(passwordHeader, 'super')
    : validateAdminSession(tokenHeader, 'Super admin');

  if (!validation.ok) {
    if (validation.reason === 'expired') {
      return sendAdminExpired(res);
    }

    if (validation.reason === 'forbidden') {
      return sendError(
        res,
        403,
        'SUPER_ADMIN_REQUIRED',
        'Akses ditolak. Hanya Super Admin yang bisa melakukan aksi ini.',
        { requiresSuperAdmin: true }
      );
    }

    return sendAdminDenied(res);
  }

  if (validation.session.role !== 'super') {
    return sendError(
      res,
      403,
      'SUPER_ADMIN_REQUIRED',
      'Akses ditolak. Hanya Super Admin yang bisa melakukan aksi ini.',
      { requiresSuperAdmin: true }
    );
  }
  
  req.adminRole = validation.session.role;
  req.adminAuthMethod = validation.session.authMethod || 'session';
  next();
}

// ================= STATE MANAGEMENT =================
let state = {
  currentSong: {
    title: DEFAULT_UNKNOWN_TITLE,
    artist: DEFAULT_UNKNOWN_LABEL,
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
  randomQueueEnabled: false,
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
  if (song.title && song.title !== DEFAULT_UNKNOWN_LABEL) confidence += 10;
  if (song.artist && song.artist !== DEFAULT_UNKNOWN_LABEL) confidence += 10;
  return Math.min(confidence, 95);
}

function calculateLockDuration(songDuration) {
  return (songDuration || 180000) + 1000;
}

function clearSongEndTimeout() {
  if (state.songEndTimeout) {
    clearTimeout(state.songEndTimeout);
    state.songEndTimeout = null;
  }
}

function resetRequestLockState() {
  state.requestLockUntil = 0;
  state.requestStartTime = 0;
  state.originalLockDuration = 0;
}

function stopCurrentPlayback() {
  state.currentSong.isPlaying = false;
}

function isPlaceholderSong(song) {
  if (!song || typeof song !== 'object') return true;

  const title = normalizeInput(song.title).toLowerCase();
  const artist = normalizeInput(song.artist).toLowerCase();

  return title === DEFAULT_UNKNOWN_TITLE.toLowerCase() && artist === DEFAULT_UNKNOWN_LABEL.toLowerCase();
}

function finalizeActiveRequest(status, extraFields = {}) {
  if (!state.activeRequest) return null;

  const finalizedRequest = {
    ...state.activeRequest,
    status,
    ...extraFields
  };

  state.activeRequest.status = status;
  Object.assign(state.activeRequest, extraFields);
  state.activeRequest = null;

  return finalizedRequest;
}

async function finalizeAndArchiveActiveRequest(status, extraFields = {}) {
  if (!state.activeRequest) return null;

  const songSnapshot = { ...state.currentSong };
  const finalizedRequest = finalizeActiveRequest(status, extraFields);
  await addToHistory(songSnapshot, finalizedRequest);

  return finalizedRequest;
}

function scheduleAutoUnlock(lockDuration) {
  clearSongEndTimeout();
  if (lockDuration > 0) {
    state.songEndTimeout = setTimeout(() => {
      const now = Date.now();
      if (state.requestLockUntil > 0 && now >= state.requestLockUntil) {
        console.log(`[LOCK] Auto-unlock triggered for song completion`);
        resetRequestLockState();
        stopCurrentPlayback();
        if (state.activeRequest) {
          finalizeAndArchiveActiveRequest('auto_completed', { autoCompletedAt: now })
            .then(() => saveRequests())
            .catch((error) => console.error('Error archiving auto-completed request:', error));
        } else {
          saveAppState(); // async, tidak perlu await
        }
      }
    }, lockDuration);
  }
}

function calculateWaitTime(position, currentRemainingSeconds = 0) {
  if (position <= 0) return 0;
  const currentRemainingMinutes = Math.max(0, currentRemainingSeconds) / 60;
  return Math.round(currentRemainingMinutes + (position * DEFAULT_AVG_SONG_DURATION_MINUTES));
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

function normalizeComparisonText(value) {
  return sanitizeInput(value).toLowerCase();
}

function looksLikeArtistName(value) {
  const cleaned = sanitizeInput(value);
  if (!cleaned || cleaned.length > 60) return false;
  if (/[0-9()[\]{}]/.test(cleaned)) return false;
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  return words.every(word => /^[a-zA-Z][a-zA-Z'.-]*$/.test(word));
}

function looksLikeSongTitle(value) {
  const cleaned = sanitizeInput(value);
  if (!cleaned) return false;
  if (/[0-9()[\]{}]/.test(cleaned)) return true;
  if (/-/.test(cleaned)) return true;
  if (/\b(feat\.?|ft\.?|official|lyrics?|lirik|remix|cover|live|version|ost|soundtrack|video)\b/i.test(cleaned)) return true;
  const words = cleaned.split(' ').filter(Boolean);
  return words.length >= 3;
}

function hasStrongSongTitleSignals(value) {
  const cleaned = sanitizeInput(value);
  if (!cleaned) return false;

  if (/[0-9()[\]{}]/.test(cleaned)) return true;
  if (/-/.test(cleaned)) return true;
  if (/\b(feat\.?|ft\.?|official|lyrics?|lirik|remix|cover|live|version|ost|soundtrack|video)\b/i.test(cleaned)) return true;
  if (/\b(a|an|the|and|or|but|of|in|on|at|to|for|with|without|from|aku|kamu|dia|kami|kita|mereka|yang|dan|dengan|untuk|pada|dalam|my|your|you|me|we|they|our|their|love)\b/i.test(cleaned)) return true;

  const words = cleaned.split(' ').filter(Boolean);
  return words.length >= 4;
}

function looksLikePersonFullName(value) {
  const cleaned = sanitizeInput(value);
  if (!cleaned) return false;
  if (/[0-9()[\]{}]/.test(cleaned)) return false;
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  const nonNameWords = new Set([
    'dan', 'yang', 'di', 'ke', 'untuk', 'dengan',
    'and', 'the', 'of', 'in', 'on', 'to', 'for'
  ]);
  return words.every((word) => {
    const lower = word.toLowerCase();
    if (nonNameWords.has(lower)) return false;
    return /^[a-zA-Z][a-zA-Z'.-]*$/.test(word);
  });
}

function isLikelySingleWordSongTitle(value) {
  const cleaned = sanitizeInput(value);
  if (!cleaned || cleaned.includes(' ')) return false;
  if (cleaned.length < 3 || cleaned.length > 40) return false;
  return /^[a-zA-Z0-9'.-]+$/.test(cleaned);
}

function classifyQueueRequestError(error = '') {
  if (error.includes('penuh')) {
    return { status: 429, code: 'QUEUE_FULL' };
  }
  if (error.includes('baru saja diputar')) {
    return { status: 429, code: 'SONG_COOLDOWN_ACTIVE' };
  }
  if (error.includes('Maksimal') && error.includes('artis')) {
    return { status: 429, code: 'ARTIST_QUEUE_LIMIT_REACHED' };
  }
  if (error.includes('sudah ada')) {
    return { status: 409, code: 'DUPLICATE_QUEUE_REQUEST' };
  }
  if (error.includes('sedang diputar')) {
    return { status: 409, code: 'SONG_ALREADY_PLAYING' };
  }
  return { status: 400, code: 'INVALID_REQUEST' };
}

function sendQueueRequestFailure(res, result) {
  const { status, code } = classifyQueueRequestError(result.error);
  return sendError(res, status, code, result.error, {
    details: result.details || null,
    queueLimit: result.queueLimit,
    cooldown: result.cooldown,
    artist: result.artist,
    limit: result.limit
  });
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

function normalizeDurationMs(value, fallback = 180000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(10000, Math.min(parsed, 3600000));
}

function normalizeSongField(value, fallback) {
  const normalized = normalizeInput(value);
  if (!normalized) return fallback;
  return normalized.slice(0, 200);
}

function normalizeOptionalUrl(value) {
  const normalized = normalizeInput(value);
  if (!normalized) return null;
  return normalized.slice(0, 1000);
}

function buildUpdateSignature(payload) {
  const title = normalizeSongField(payload?.title, DEFAULT_UNKNOWN_LABEL).toLowerCase();
  const artist = normalizeSongField(payload?.artist, DEFAULT_UNKNOWN_LABEL).toLowerCase();
  const duration = normalizeDurationMs(payload?.duration, 180000);
  const isNewSong = normalizeBoolean(payload?.isNewSong) ? '1' : '0';
  const url = normalizeOptionalUrl(payload?.url) || '';
  return [title, artist, duration, isNewSong, url].join('|');
}

async function getAdminCredential(role = 'admin') {
  return AdminCredential.findByPk(role);
}

async function hasAdminCredential(role = 'admin') {
  const credential = await getAdminCredential(role);
  return Boolean(credential && !isBlank(credential.password));
}

async function upsertAdminCredential(role, password) {
  const normalizedPassword = normalizeInput(password);
  return AdminCredential.upsert({
    role,
    password: normalizedPassword,
    updatedAtMs: Date.now()
  });
}

async function ensureDefaultAdminCredentials() {
  const credentialsToSeed = [
    { role: 'admin', password: DEFAULT_ADMIN_DB_PASSWORD },
    { role: 'super', password: DEFAULT_SUPER_ADMIN_DB_PASSWORD }
  ];

  for (const credential of credentialsToSeed) {
    if (await hasAdminCredential(credential.role)) continue;
    await upsertAdminCredential(credential.role, credential.password);
    console.log(`[AUTH] Default ${credential.role === 'super' ? 'Super Admin' : 'Admin'} credential inserted into database`);
  }
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value === 1;
  return false;
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
  const remainingSlots = Math.max(0, QUEUE_LIMIT - state.requestQueue.length);
  return {
    queueLimit: QUEUE_LIMIT,
    remainingSlots,
    queueFull: state.requestQueue.length >= QUEUE_LIMIT
  };
}

function getQueueWithPosition() {
  return state.requestQueue.map((req, index) => ({ ...req, position: index + 1 }));
}

function extractRandomQueueEnabled(statsPayload) {
  if (!statsPayload || typeof statsPayload !== 'object') return false;
  return normalizeBoolean(statsPayload._queueSettings?.randomQueueEnabled);
}

function sanitizeStats(statsPayload) {
  const safeStats = statsPayload && typeof statsPayload === 'object' ? { ...statsPayload } : {};
  delete safeStats._queueSettings;
  return {
    totalRequests: Number.isFinite(Number(safeStats.totalRequests)) ? Number(safeStats.totalRequests) : 0,
    totalSongsPlayed: Number.isFinite(Number(safeStats.totalSongsPlayed)) ? Number(safeStats.totalSongsPlayed) : 0,
    totalPlayTime: Number.isFinite(Number(safeStats.totalPlayTime)) ? Number(safeStats.totalPlayTime) : 0
  };
}

function buildPersistedStats() {
  return {
    ...state.stats,
    _queueSettings: {
      randomQueueEnabled: state.randomQueueEnabled
    }
  };
}

function resetSystemStatsMetrics() {
  state.stats.totalSongsPlayed = 0;
  state.stats.totalPlayTime = 0;
}

function getRandomQueueMeta() {
  return {
    enabled: state.randomQueueEnabled,
    mode: state.randomQueueEnabled ? 'fair-random' : 'fifo',
    poolSize: FAIR_RANDOM_POOL_SIZE,
    description: state.randomQueueEnabled
      ? `Lagu berikutnya dipilih acak dari ${FAIR_RANDOM_POOL_SIZE} antrian teratas. Request yang paling lama menunggu punya peluang terbesar, request baru tidak memotong antrean lama, dan priority tetap didahulukan.`
      : 'Antrian diputar sesuai urutan masuk.',
    shortLabel: state.randomQueueEnabled ? `Fair random ${FAIR_RANDOM_POOL_SIZE}` : 'FIFO'
  };
}

function pickWeightedRandomIndex(poolSize) {
  if (poolSize <= 1) return 0;

  let totalWeight = 0;
  for (let index = 0; index < poolSize; index++) {
    totalWeight += (poolSize - index);
  }

  let randomWeight = Math.random() * totalWeight;
  for (let index = 0; index < poolSize; index++) {
    randomWeight -= (poolSize - index);
    if (randomWeight < 0) {
      return index;
    }
  }

  return 0;
}

function insertRequestIntoQueue(newRequest, position) {
  if (position === 'first') {
    state.requestQueue.unshift(newRequest);
    return 1;
  }

  if (!state.randomQueueEnabled) {
    state.requestQueue.push(newRequest);
    return state.requestQueue.length;
  }

  // Fair random mode: preserve the relative order of requests that are already queued.
  // New regular requests join after the existing non-priority block instead of cutting in line.
  const insertIndex = state.requestQueue.length;
  state.requestQueue.splice(insertIndex, 0, newRequest);
  return insertIndex + 1;
}

function pickNextQueueRequest() {
  if (state.requestQueue.length === 0) return null;

  const priorityIndex = state.requestQueue.findIndex((request) => request.isPriority);
  if (priorityIndex !== -1) {
    return state.requestQueue.splice(priorityIndex, 1)[0];
  }

  if (!state.randomQueueEnabled) {
    return state.requestQueue.shift();
  }

  const weightedCandidates = state.requestQueue
    .map((request, index) => ({ request, index }))
    .sort((left, right) => {
      if (left.request.time !== right.request.time) {
        return left.request.time - right.request.time;
      }
      return left.index - right.index;
    })
    .slice(0, FAIR_RANDOM_POOL_SIZE);

  const selectedCandidateIndex = pickWeightedRandomIndex(weightedCandidates.length);
  const selectedQueueIndex = weightedCandidates[selectedCandidateIndex].index;
  return state.requestQueue.splice(selectedQueueIndex, 1)[0];
}

function getCurrentLockProgress(now = Date.now()) {
  if (state.requestStartTime <= 0 || state.originalLockDuration <= 0) return 0;
  return Math.min(100, ((now - state.requestStartTime) / state.originalLockDuration) * 100);
}

function sendInternalError(res, context, error) {
  console.error(`Error in ${context}:`, error);
  return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'Internal server error');
}

function sendError(res, status, code, message, meta = null) {
  const payload = {
    success: false,
    error: {
      code,
      message
    }
  };
  if (meta && typeof meta === 'object') {
    const cleanedMeta = Object.fromEntries(
      Object.entries(meta).filter(([, value]) => value !== undefined && value !== null)
    );
    if (Object.keys(cleanedMeta).length > 0) {
      payload.error.meta = cleanedMeta;
    }
  }
  return res.status(status).json(payload);
}

function logQueueCount() {
  console.log(`[QUEUE] Total queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
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
    if (parts.length < 2) return query;
    
    let title = parts[0];
    const artist = parts.slice(1).join('-');
    title = title
      .replace(/\b(original\s+lirik|lyrics?|lirik)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title) title = parts[0];
    
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
  const parsedQuery = parseSongQuery(queryWithOfficial);
  const requestedArtist = normalizeComparisonText(parsedQuery.artist);
  
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

  // Batas maksimal lagu per artis dalam antrian
  const sameArtistCount = state.requestQueue.filter((queuedRequest) => {
    const queuedArtist = normalizeComparisonText(queuedRequest.artist || parseSongQuery(queuedRequest.query).artist);
    return queuedArtist && queuedArtist === requestedArtist;
  }).length;

  if (sameArtistCount >= MAX_REQUESTS_PER_ARTIST) {
    return {
      success: false,
      error: `Maksimal ${MAX_REQUESTS_PER_ARTIST} lagu untuk artis yang sama dalam antrian`,
      artist: parsedQuery.artist,
      limit: MAX_REQUESTS_PER_ARTIST
    };
  }
  
  const newRequest = createRequestObject(normalizedQuery, ip, userAgent, isPriority, addedByAdmin);
  
  const queuePosition = insertRequestIntoQueue(newRequest, position);
  
  await saveRequests();
  
  const currentRemainingSeconds = Math.ceil(getLockRemainingMs() / 1000);

  return {
    success: true,
    request: newRequest,
    warnings: [],
    queuePosition,
    estimatedWait: calculateWaitTime(queuePosition, currentRemainingSeconds),
    queueLimit: QUEUE_LIMIT,
    remainingSlots: QUEUE_LIMIT - state.requestQueue.length
  };
}

// ================= FUNGSI DATABASE =================
async function loadData() {
  try {
    await sequelize.sync();
    await ensureDefaultAdminCredentials();

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
      state.randomQueueEnabled = extractRandomQueueEnabled(appState.stats);
      state.stats = sanitizeStats(appState.stats);
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

    // Sinkronkan signature awal agar write pertama tidak redundant
    lastPersistedQueueSignature = getQueueSignature();
    lastPersistedHistorySignature = getHistorySignature();
    lastPersistedAppStateSignature = getAppStateSignature();

    console.log(`[DB] Loaded ${state.requestQueue.length} requests from database`);
    console.log(`[DB] Loaded ${state.history.length} history items`);
  } catch (error) {
    console.error('Error loading data from database:', error);
    state.requestQueue = [];
    state.history = [];
    lastPersistedQueueSignature = null;
    lastPersistedHistorySignature = null;
    lastPersistedAppStateSignature = null;
  }
}

let saveRequestsInFlight = null;
let saveRequestsPending = false;
let saveHistoryInFlight = null;
let saveHistoryPending = false;
let saveAppStateInFlight = null;
let saveAppStatePending = false;
let lastPersistedQueueSignature = null;
let lastPersistedHistorySignature = null;
let lastPersistedAppStateSignature = null;
const LATENCY_SAMPLE_LIMIT = 200;
const persistenceMetrics = {
  requests: { executed: 0, skipped: 0, errors: 0, lastDurationMs: 0, lastRunAt: 0, latencySamples: [] },
  history: { executed: 0, skipped: 0, errors: 0, lastDurationMs: 0, lastRunAt: 0, latencySamples: [] },
  appState: { executed: 0, skipped: 0, errors: 0, lastDurationMs: 0, lastRunAt: 0, latencySamples: [] }
};

function getPercentile(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(position, sorted.length - 1));
  return sorted[index];
}

function recordPersistenceLatency(metric, durationMs) {
  metric.lastDurationMs = durationMs;
  metric.lastRunAt = Date.now();
  metric.latencySamples.push(durationMs);
  if (metric.latencySamples.length > LATENCY_SAMPLE_LIMIT) {
    metric.latencySamples.shift();
  }
}

function buildPersistenceMetricSnapshot(metric) {
  const samples = metric.latencySamples;
  const maxLatency = samples.length > 0 ? Math.max(...samples) : 0;
  return {
    executed: metric.executed,
    skipped: metric.skipped,
    errors: metric.errors,
    lastDurationMs: metric.lastDurationMs,
    lastRunAt: metric.lastRunAt,
    latency: {
      sampleCount: samples.length,
      p95Ms: getPercentile(samples, 95),
      p99Ms: getPercentile(samples, 99),
      maxMs: maxLatency
    }
  };
}

function getPersistenceMetricsSnapshot() {
  return {
    requests: buildPersistenceMetricSnapshot(persistenceMetrics.requests),
    history: buildPersistenceMetricSnapshot(persistenceMetrics.history),
    appState: buildPersistenceMetricSnapshot(persistenceMetrics.appState)
  };
}

function getQueueSignature() {
  return JSON.stringify(state.requestQueue.map((req, index) => ({
    id: req.id,
    query: req.query,
    time: req.time,
    status: req.status || 'pending',
    addedBy: req.addedBy,
    title: req.title,
    artist: req.artist,
    userAgent: req.userAgent,
    originalQuery: req.originalQuery,
    isPriority: Boolean(req.isPriority),
    addedByAdmin: Boolean(req.addedByAdmin),
    queueOrder: index
  })));
}

function getHistorySignature() {
  return JSON.stringify(state.history.slice(0, MAX_HISTORY_LIMIT).map(item => ({
    id: item.id,
    timestamp: item.timestamp,
    duration: item.duration
  })));
}

function getAppStateSignature() {
  return JSON.stringify({
    activeRequest: state.activeRequest,
    requestLockUntil: state.requestLockUntil,
    currentSong: state.currentSong,
    stats: buildPersistedStats(),
    requestStartTime: state.requestStartTime,
    originalLockDuration: state.originalLockDuration
  });
}

function buildAppStatePayload() {
  return {
    key: 'state',
    activeRequest: state.activeRequest,
    requestLockUntil: state.requestLockUntil,
    currentSong: state.currentSong,
    stats: buildPersistedStats(),
    requestStartTime: state.requestStartTime,
    originalLockDuration: state.originalLockDuration
  };
}

async function persistAppStateNow() {
  const startedAt = Date.now();
  const appStateSignature = getAppStateSignature();
  if (appStateSignature === lastPersistedAppStateSignature) {
    persistenceMetrics.appState.skipped++;
    return;
  }

  await AppState.upsert(buildAppStatePayload());

  persistenceMetrics.appState.executed++;
  recordPersistenceLatency(persistenceMetrics.appState, Date.now() - startedAt);
  lastPersistedAppStateSignature = appStateSignature;
}

async function persistRequestsNow() {
  const startedAt = Date.now();
  const queueSignature = getQueueSignature();
  const appStateSignature = getAppStateSignature();
  if (queueSignature === lastPersistedQueueSignature) {
    persistenceMetrics.requests.skipped++;
    await saveAppState();
    return;
  }

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

  await sequelize.transaction(async (transaction) => {
    await Request.destroy({ where: {}, transaction });

    if (requestsToInsert.length > 0) {
      await Request.bulkCreate(requestsToInsert, { transaction });
    }

    await AppState.upsert(buildAppStatePayload(), { transaction });
  });

  persistenceMetrics.requests.executed++;
  recordPersistenceLatency(persistenceMetrics.requests, Date.now() - startedAt);
  lastPersistedQueueSignature = queueSignature;
  lastPersistedAppStateSignature = appStateSignature;
}

async function persistHistoryNow() {
  const startedAt = Date.now();
  const historySignature = getHistorySignature();
  if (historySignature === lastPersistedHistorySignature) {
    persistenceMetrics.history.skipped++;
    return;
  }

  const historyToSave = state.history.slice(0, MAX_HISTORY_LIMIT);
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

  persistenceMetrics.history.executed++;
  recordPersistenceLatency(persistenceMetrics.history, Date.now() - startedAt);
  lastPersistedHistorySignature = historySignature;
}

async function saveRequests() {
  saveRequestsPending = true;
  if (!saveRequestsInFlight) {
    saveRequestsInFlight = (async () => {
      while (saveRequestsPending) {
        saveRequestsPending = false;
        await persistRequestsNow();
      }
    })().finally(() => {
      saveRequestsInFlight = null;
    });
  }

  try {
    await saveRequestsInFlight;
  } catch (error) {
    persistenceMetrics.requests.errors++;
    console.error('Error saving requests:', error);
  }
}

async function saveHistory() {
  saveHistoryPending = true;
  if (!saveHistoryInFlight) {
    saveHistoryInFlight = (async () => {
      while (saveHistoryPending) {
        saveHistoryPending = false;
        await persistHistoryNow();
      }
    })().finally(() => {
      saveHistoryInFlight = null;
    });
  }

  try {
    await saveHistoryInFlight;
  } catch (error) {
    persistenceMetrics.history.errors++;
    console.error('Error saving history:', error);
  }
}

async function saveAppState() {
  saveAppStatePending = true;
  if (!saveAppStateInFlight) {
    saveAppStateInFlight = (async () => {
      while (saveAppStatePending) {
        saveAppStatePending = false;
        await persistAppStateNow();
      }
    })().finally(() => {
      saveAppStateInFlight = null;
    });
  }

  try {
    await saveAppStateInFlight;
  } catch (error) {
    persistenceMetrics.appState.errors++;
    console.error('Error saving app state:', error);
  }
}

async function addToHistory(song, request = null) {
  if (isPlaceholderSong(song)) {
    return;
  }

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
  await saveAppState();
}

// ================= API ENDPOINTS =================
app.post('/admin/login', async (req, res) => {
  const rawPassword = req.body?.password ?? req.body?.adminPassword ?? '';
  const password = normalizeInput(rawPassword);
  if (isBlank(password)) return sendError(res, 400, 'PASSWORD_REQUIRED', 'Password diperlukan');
  try {
    const superCredential = await getAdminCredential('super');
    const adminCredential = await getAdminCredential('admin');
    const hasSuperAdminCredential = superCredential && !isBlank(superCredential.password);
    const hasAdminCredential = adminCredential && !isBlank(adminCredential.password);

    if (!hasSuperAdminCredential && !hasAdminCredential) {
      return sendError(
        res,
        500,
        'ADMIN_PASSWORD_NOT_CONFIGURED',
        'Konfigurasi admin belum diatur di database. Buat Super Admin terlebih dahulu.'
      );
    }

    let role = null;
    if (hasSuperAdminCredential && password === superCredential.password) role = 'super';
    else if (hasAdminCredential && password === adminCredential.password) role = 'admin';
    else return sendError(res, 401, 'INVALID_PASSWORD', 'Password salah');

    const token = generateId();
    const session = {
      token,
      role,
      expires: Date.now() + SESSION_DURATION,
      createdAt: Date.now()
    };
    adminSessions.set(token, session);
    console.log(`[AUTH] ${role === 'super' ? 'Super Admin' : 'Admin'} login successful`);
    res.json({ success: true, token, role, expiresIn: SESSION_DURATION, expiresAt: session.expires });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/admin/logout', requireAdmin, (req, res) => {
  const sessionToken = req.headers['x-admin-token'];
  if (sessionToken) {
    adminSessions.delete(sessionToken);
  }
  console.log('[AUTH] Admin logged out');
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
    remainingTime: isAdmin ? Math.max(0, expiresAt - Date.now()) : 0
  });
});

app.post('/admin/bootstrap-super-admin', async (req, res) => {
  try {
    if (await hasAdminCredential('super')) {
      return sendError(res, 409, 'SUPER_ADMIN_ALREADY_CONFIGURED', 'Super Admin sudah dikonfigurasi');
    }

    const password = normalizeInput(req.body?.password ?? '');
    if (isBlank(password)) {
      return sendError(res, 400, 'PASSWORD_REQUIRED', 'Password Super Admin diperlukan');
    }
    if (password.length < 4) {
      return sendError(res, 400, 'PASSWORD_TOO_SHORT', 'Password Super Admin minimal 4 karakter');
    }
    if (password.length > 100) {
      return sendError(res, 400, 'PASSWORD_TOO_LONG', 'Password Super Admin maksimal 100 karakter');
    }

    await upsertAdminCredential('super', password);
    console.log('[AUTH] Initial Super Admin password stored in database');

    res.json({
      success: true,
      message: 'Super Admin pertama berhasil dibuat di database'
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/admin/set-password', requireSuperAdmin, async (req, res) => {
  try {
    const role = normalizeInput(req.body?.role || 'admin').toLowerCase();
    if (!['admin', 'super'].includes(role)) {
      return sendError(res, 400, 'INVALID_ROLE', 'Role harus admin atau super');
    }

    const password = normalizeInput(req.body?.password ?? '');
    if (isBlank(password)) {
      return sendError(res, 400, 'PASSWORD_REQUIRED', `Password ${role} diperlukan`);
    }
    if (password.length < 4) {
      return sendError(res, 400, 'PASSWORD_TOO_SHORT', `Password ${role} minimal 4 karakter`);
    }
    if (password.length > 100) {
      return sendError(res, 400, 'PASSWORD_TOO_LONG', `Password ${role} maksimal 100 karakter`);
    }

    await upsertAdminCredential(role, password);
    console.log(`[AUTH] ${role === 'super' ? 'Super Admin' : 'Admin'} password updated in database`);
    res.json({
      success: true,
      message: `Password ${role} berhasil disimpan ke database`
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/update', async (req, res) => {
  try {
    const { title, artist, duration, isNewSong, url } = req.body;
    const now = Date.now();
    const validDuration = normalizeDurationMs(duration, 180000);
    const isNewSongFlag = normalizeBoolean(isNewSong);
    const normalizedTitle = normalizeSongField(title, DEFAULT_UNKNOWN_LABEL);
    const normalizedArtist = normalizeSongField(artist, DEFAULT_UNKNOWN_LABEL);
    const normalizedUrl = normalizeOptionalUrl(url);
    const updateSignature = buildUpdateSignature(req.body);
    if (updateSignature === lastUpdateSignature && (now - lastUpdateAt) < 2000) {
      return res.json({
        success: true,
        deduped: true,
        message: 'Song update ignored because it was already processed',
        song: state.currentSong,
        timestamp: state.currentSong.timestamp,
        lockRemaining: getLockRemainingMs(now)
      });
    }

    lastUpdateSignature = updateSignature;
    lastUpdateAt = now;

    const confidence = calculateConfidence({ title: normalizedTitle, artist: normalizedArtist, duration: validDuration });
    const previousSong = { ...state.currentSong };
    
    state.currentSong = {
      title: normalizedTitle,
      artist: normalizedArtist,
      duration: validDuration,
      timestamp: now,
      confidence,
      isPlaying: true,
      url: normalizedUrl
    };
    
    console.log(`[SONG] Updated: ${normalizedTitle} - ${normalizedArtist} (${formatDuration(validDuration)}, ${confidence}%)`);
    
    if (state.activeRequest && state.requestLockUntil > 0) {
      if (isNewSongFlag || Math.abs(validDuration - (previousSong.duration || 0)) > 5000) {
        const newLockDuration = calculateLockDuration(validDuration);
        state.requestLockUntil = now + newLockDuration;
        state.originalLockDuration = newLockDuration;
        scheduleAutoUnlock(newLockDuration);
        console.log(`[LOCK] Updated to ${Math.round(newLockDuration / 1000)}s for new song`);
      }
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
    randomQueueEnabled: state.randomQueueEnabled,
    lockInfo: {
      basedOnSongDuration: state.currentSong.duration,
      originalLock: state.originalLockDuration,
      currentProgress: getCurrentLockProgress(now)
    },
    randomQueue: getRandomQueueMeta()
  });
});

app.get('/get-request', async (req, res) => {
  try {
    const now = Date.now();
    if (now < state.requestLockUntil) {
      const remaining = Math.ceil((state.requestLockUntil - now) / 1000);
      return sendError(res, 423, 'REQUEST_LOCKED', 'Request terkunci', {
        lockRemaining: remaining,
        remainingFormatted: formatWaitTime(remaining),
        currentPlaying: state.activeRequest?.query || state.currentSong.title,
        estimatedFinish: new Date(state.requestLockUntil).toLocaleTimeString()
      });
    }
    
    if (state.requestQueue.length === 0) {
      if (state.activeRequest) {
        clearSongEndTimeout();
        resetRequestLockState();
        stopCurrentPlayback();
        await finalizeAndArchiveActiveRequest('completed', { completedAt: now });
        await saveRequests();
      }
      return res.status(204).send();
    }
    
    const nextRequest = pickNextQueueRequest();
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
    console.log(`[QUEUE] Next request: "${nextRequest.query}"`);
    console.log(`[QUEUE] Parsed as: Title="${parsedQuery.title || nextRequest.query}", Artist="${parsedQuery.artist || DEFAULT_UNKNOWN_ARTIST}"`);
    console.log(`[LOCK] Duration: ${Math.round(lockDuration / 1000)}s`);
    res.json({
      query: nextRequest.query,
      id: nextRequest.id,
      time: nextRequest.time,
      parsedTitle: parsedQuery.title || nextRequest.query,
      parsedArtist: parsedQuery.artist || DEFAULT_UNKNOWN_ARTIST,
      estimatedDuration: lockDuration,
      randomQueueEnabled: state.randomQueueEnabled,
      randomQueue: getRandomQueueMeta(),
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
      return sendError(res, 400, 'QUERY_REQUIRED', 'Query tidak boleh kosong');
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
      return sendQueueRequestFailure(res, result);
    }
    console.log(`[QUEUE] Request added: "${query}" -> "${result.request.query}"`);
    logQueueCount();
    
    res.json({
      success: true,
      message: 'Request berhasil ditambahkan',
      request: result.request,
      warnings: result.warnings || [],
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
    if (state.randomQueueEnabled) {
      return sendError(
        res,
        409,
        'MOVE_DISABLED_IN_RANDOM_MODE',
        'Pindah posisi hanya tersedia saat mode acak dimatikan'
      );
    }

    const { requestId } = req.body;
    if (!requestId || !isStrictPositiveInteger(req.body.newPosition)) {
      return sendError(res, 400, 'REQUEST_ID_AND_POSITION_REQUIRED', 'requestId dan newPosition diperlukan');
    }
    const newPosition = Number.parseInt(req.body.newPosition, 10);
    if (!Number.isInteger(newPosition)) {
      return sendError(res, 400, 'INVALID_NEW_POSITION', 'newPosition harus berupa angka bulat');
    }
    if (newPosition < 1 || newPosition > state.requestQueue.length) {
      return sendError(res, 400, 'POSITION_OUT_OF_RANGE', `Posisi harus antara 1 dan ${state.requestQueue.length}`);
    }
    
    const currentIndex = state.requestQueue.findIndex(req => req.id === requestId);
    if (currentIndex === -1) return sendError(res, 404, 'REQUEST_NOT_FOUND', 'Request tidak ditemukan');
    
    if (currentIndex + 1 === newPosition) {
      return res.json({ success: true, message: 'Posisi tidak berubah' });
    }
    
    const [requestToMove] = state.requestQueue.splice(currentIndex, 1);
    state.requestQueue.splice(newPosition - 1, 0, requestToMove);
    await saveRequests();
    
    console.log(`[QUEUE] Admin moved request "${requestToMove.query}" from position ${currentIndex + 1} to ${newPosition}`);
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

app.post('/admin/request-priority/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const currentIndex = state.requestQueue.findIndex(req => req.id === id);
    if (currentIndex === -1) {
      return sendError(res, 404, 'REQUEST_NOT_FOUND', 'Request tidak ditemukan');
    }

    const requestToPromote = state.requestQueue[currentIndex];
    if (requestToPromote.isPriority) {
      return res.json({
        success: true,
        message: 'Request sudah berstatus priority',
        request: requestToPromote
      });
    }

    requestToPromote.isPriority = true;
    requestToPromote.addedByAdmin = true;

    const firstRegularIndex = state.requestQueue.findIndex((request) => !request.isPriority && request.id !== id);
    const targetIndex = firstRegularIndex === -1 ? state.requestQueue.length - 1 : firstRegularIndex;

    state.requestQueue.splice(currentIndex, 1);
    const normalizedTargetIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
    state.requestQueue.splice(normalizedTargetIndex, 0, requestToPromote);

    await saveRequests();

    console.log(`[QUEUE] Admin promoted request "${requestToPromote.query}" to priority`);
    res.json({
      success: true,
      message: 'Request berhasil dijadikan priority',
      request: requestToPromote,
      queuePosition: state.requestQueue.findIndex(req => req.id === id) + 1
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.get('/requests', (req, res) => {
  const { isLocked, lockRemaining } = getLockState();
  const queueMeta = getQueueMeta();
  const remainingSeconds = isLocked ? Math.ceil(lockRemaining / 1000) : 0;
  const requestsWithWait = state.requestQueue.map((req, index) => ({
    ...req,
    position: index + 1,
    estimatedWait: calculateWaitTime(index + 1, remainingSeconds),
    estimatedWaitFormatted: formatWaitTime(calculateWaitTime(index + 1, remainingSeconds) * 60)
  }));
  res.json({
    activeRequest: state.activeRequest,
    queue: requestsWithWait,
    total: state.requestQueue.length,
    randomQueueEnabled: state.randomQueueEnabled,
    randomQueue: getRandomQueueMeta(),
    isLocked,
    lockRemaining,
    ...queueMeta
  });
});

app.post('/admin/queue-random-mode', requireSuperAdmin, async (req, res) => {
  try {
    const nextEnabled = normalizeBoolean(req.body?.enabled);
    state.randomQueueEnabled = nextEnabled;
    await saveAppState();

    res.json({
      success: true,
      message: `Mode antrian acak ${state.randomQueueEnabled ? 'diaktifkan' : 'dimatikan'}`,
      randomQueueEnabled: state.randomQueueEnabled,
      randomQueue: getRandomQueueMeta()
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/admin/reset-system-stats', requireSuperAdmin, async (req, res) => {
  try {
    const previousStats = {
      totalRequests: state.stats.totalRequests,
      totalSongsPlayed: state.stats.totalSongsPlayed,
      totalPlayTime: state.stats.totalPlayTime
    };

    resetSystemStatsMetrics();
    await saveAppState();

    res.json({
      success: true,
      message: 'Statistik sistem berhasil direset untuk Total Diputar dan Total Menit',
      stats: state.stats,
      previousStats
    });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.post('/song-ended', async (req, res) => {
  try {
    const now = Date.now();
    console.log('[PLAYBACK] Song ended notification received');
    clearSongEndTimeout();
    
    resetRequestLockState();
    stopCurrentPlayback();
    await finalizeAndArchiveActiveRequest('completed', {
      completedAt: now,
      actualDuration: state.activeRequest ? now - state.activeRequest.startedAt : undefined
    });
    
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
  
  const parsedRequest = parseSongQuery(state.activeRequest.query);
  const requestTitle = (parsedRequest.title || state.activeRequest.query).toLowerCase();
  const requestArtist = (parsedRequest.artist || '').toLowerCase();
  const requestQuery = state.activeRequest.query.toLowerCase();
  const songTitle = normalizeInput(title).toLowerCase();
  const songArtist = normalizeInput(artist).toLowerCase();
  const titleMatch = songTitle.length > 0 && (
    songTitle.includes(requestTitle) ||
    requestTitle.includes(songTitle)
  );
  const artistMatch = songArtist.length > 0 && (
    (requestArtist.length > 0 && songArtist.includes(requestArtist)) ||
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
    console.log(`[MATCH] Song confirmed: "${title}" matches request "${requestQuery}"`);
  }
  res.json(matchData);
});

app.post('/skip-current', requireSuperAdmin, async (req, res) => {
  try {
    const skippedAt = Date.now();
    console.log('[PLAYBACK] Skip current request requested');
    clearSongEndTimeout();
    
    resetRequestLockState();
    stopCurrentPlayback();
    await finalizeAndArchiveActiveRequest('skipped', { skippedAt });
    
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
    const forceSkippedAt = Date.now();
    console.log('[PLAYBACK] Force next requested');
    clearSongEndTimeout();
    
    resetRequestLockState();
    stopCurrentPlayback();
    await finalizeAndArchiveActiveRequest('force_skipped', { forceSkippedAt });
    
    await saveRequests();
    res.json({ success: true, message: 'Force skip completed', timestamp: forceSkippedAt });
  } catch (error) {
    return sendInternalError(res, req.path, error);
  }
});

app.delete('/remove-request/:id', requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const index = state.requestQueue.findIndex(req => req.id === id);
    if (index === -1) return sendError(res, 404, 'REQUEST_NOT_FOUND', 'Request tidak ditemukan');
    
    const removed = state.requestQueue.splice(index, 1)[0];
    
    if (state.activeRequest && state.activeRequest.id === id) {
      const removedAt = Date.now();
      clearSongEndTimeout();
      resetRequestLockState();
      stopCurrentPlayback();
      await finalizeAndArchiveActiveRequest('removed', { removedAt });
      console.log(`[QUEUE] Active request removed: "${removed.query}"`);
    }
    
    await saveRequests();
    console.log(`[QUEUE] Request removed: "${removed.query}"`);
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
    if (state.activeRequest) {
      await finalizeAndArchiveActiveRequest('cleared', { clearedAt: Date.now() });
    }
    stopCurrentPlayback();
    resetRequestLockState();
    
    clearSongEndTimeout();
    
    await saveRequests();
    console.log(`[QUEUE] Cleared ${previousCount} requests`);
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
  
  let totalQueueMinutes = state.requestQueue.length * DEFAULT_AVG_SONG_DURATION_MINUTES;
  if (isLocked) totalQueueMinutes += remainingSeconds / 60;
  
  res.json({
    isLocked,
    lockUntil: state.requestLockUntil,
    remainingSeconds,
    remainingFormatted: formatWaitTime(remainingSeconds),
    currentRequest: state.activeRequest,
    currentSong: state.currentSong,
    queue: getQueueWithPosition(),
    queueLength: state.requestQueue.length,
    randomQueueEnabled: state.randomQueueEnabled,
    randomQueue: getRandomQueueMeta(),
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
  const uptime = Math.round(process.uptime());
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
    randomQueueEnabled: state.randomQueueEnabled,
    randomQueue: getRandomQueueMeta(),
    persistence: getPersistenceMetricsSnapshot(),
    isLocked,
    lockRemaining
  });
});

app.post('/admin/request-first', requireAdmin, async (req, res) => {
  try {
    const { query } = req.body;
    if (isBlank(query)) {
      return sendError(res, 400, 'QUERY_REQUIRED', 'Query tidak boleh kosong');
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
      return sendQueueRequestFailure(res, result);
    }
    console.log(`[QUEUE] Priority request added (first position): "${query}" -> "${result.request.query}"`);
    logQueueCount();
    
    res.json({
      success: true,
      message: 'Priority request berhasil ditambahkan di posisi pertama',
      request: result.request,
      warnings: result.warnings || [],
      queuePosition: 1,
      estimatedWait: result.estimatedWait,
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
    features: ['queue-limit-100', 'multi-level-admin', 'auto-refresh', 'official-tag-automatic', 'random-queue-toggle'],
    serverUptime: process.uptime(),
    queueSize: state.requestQueue.length,
    randomQueueEnabled: state.randomQueueEnabled,
    activeUsers: adminSessions.size
  });
});

app.get('/health', (req, res) => {
  const { isLocked, lockRemaining } = getLockState();
  const { queueLimit } = getQueueMeta();
  const persistence = getPersistenceMetricsSnapshot();
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    version: APP_VERSION,
    uptime: process.uptime(),
    queueLimit,
    currentQueue: state.requestQueue.length,
    randomQueueEnabled: state.randomQueueEnabled,
    persistence,
    isLocked,
    lockRemaining
  });
});

// ================= AUTO-UNLOCK TIMER =================
setInterval(async () => {
  const now = Date.now();
  let changed = false;
  
  if (now > state.requestLockUntil && state.requestLockUntil > 0) {
    console.log('[LOCK] Auto-unlock: lock expired');
    resetRequestLockState();
    stopCurrentPlayback();
    if (state.activeRequest) {
      await finalizeAndArchiveActiveRequest('auto_completed', { autoCompletedAt: now });
      changed = true;
    }
    clearSongEndTimeout();
    changed = true;
  }
  
  if (state.currentSong.isPlaying && now - state.currentSong.timestamp > 60000) {
    console.log('[SONG] Auto-reset: No song update for 1 minute');
    stopCurrentPlayback();
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
  const now = Date.now();
  let expiredCount = 0;

  for (const [token, session] of adminSessions.entries()) {
    if (now > session.expires) {
      adminSessions.delete(token);
      expiredCount++;
    }
  }

  if (expiredCount > 0) {
    console.log(`[AUTH] Cleaned up ${expiredCount} expired admin session(s)`);
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
    console.log('=== YouTube Music Bridge Server with Multi-Level Admin (Sequelize) ===');
    console.log(`[START] Running at: http://localhost:${PORT}`);
    console.log(`[START] Current queue: ${state.requestQueue.length}/${QUEUE_LIMIT} requests`);
    console.log(`[START] Current song: ${state.currentSong.title}`);
    console.log('[START] Super Admin: Full access');
    console.log('[START] Admin: Can add priority and move only (no delete)');
    console.log(`[START] Queue limit: ${QUEUE_LIMIT} songs`);
    console.log('[START] Auto-refresh: Enabled');
    console.log('[START] Auto "official" tag: Enabled');
    console.log("=".repeat(50));
    if (state.requestLockUntil > 0) {
      const remaining = Math.ceil((state.requestLockUntil - Date.now()) / 1000);
      console.log(`[LOCK] Current lock: ${formatWaitTime(remaining)} remaining`);
    }
  });
}

initialize().catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Shutting down server...');
  clearSongEndTimeout();
  
  try {
    await saveRequests();
    await saveHistory();
    console.log('[SHUTDOWN] Data saved. Goodbye!');
  } catch (err) {
    console.error('Error saving data on shutdown:', err);
  } finally {
    process.exit(0);
  }
});


