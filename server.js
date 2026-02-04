const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const REQUEST_FILE = path.join(__dirname, 'requests.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// State untuk lagu saat ini
let currentSong = { 
  title: "N/A", 
  artist: "N/A", 
  duration: 180000, // 3 menit default
  lastUpdate: Date.now(),
  confidence: 0
};

// State untuk antrian request
let requestLockUntil = 0; // Waktu hingga request terkunci
let activeRequest = null; // Request yang sedang diproses
let requestQueue = []; // Antrian request

// ================= FUNGSI UTILITAS =================
const loadQueueFromFile = () => {
  try {
    if (fs.existsSync(REQUEST_FILE)) {
      const data = fs.readFileSync(REQUEST_FILE, 'utf8');
      requestQueue = JSON.parse(data);
      console.log(`📂 Loaded ${requestQueue.length} requests from file`);
      return requestQueue;
    }
  } catch (error) {
    console.error('Error loading queue file:', error);
  }
  return [];
};

const saveQueueToFile = () => {
  try {
    fs.writeFileSync(REQUEST_FILE, JSON.stringify(requestQueue, null, 2));
  } catch (error) {
    console.error('Error saving queue file:', error);
  }
};

// Inisialisasi queue saat server start
loadQueueFromFile();

// ================= ENDPOINT UNTUK EXTENSION =================

// 1. Update lagu saat ini (dipanggil oleh content.js setiap 3 detik)
app.post('/update', (req, res) => {
  const { title, artist, duration = 180000 } = req.body;
  const now = Date.now();
  
  // Validasi durasi
  let validDuration = duration;
  
  // Validasi range durasi yang masuk akal
  if (duration < 10000) { // Kurang dari 10 detik
    console.log(`⚠️ Durasi terlalu pendek: ${duration}ms, menggunakan default`);
    validDuration = 180000;
  } else if (duration > 3600000) { // Lebih dari 1 jam
    console.log(`⚠️ Durasi terlalu panjang: ${duration}ms, menggunakan maksimal`);
    validDuration = 600000; // 10 menit maksimal
  }
  
  // Hitung confidence berdasarkan durasi
  let confidence = 50;
  if (validDuration >= 120000 && validDuration <= 300000) { // 2-5 menit
    confidence = 90;
  } else if (validDuration >= 60000 && validDuration <= 600000) { // 1-10 menit
    confidence = 70;
  }
  
  // Update lagu saat ini
  currentSong = { 
    title: title || "N/A", 
    artist: artist || "N/A", 
    duration: validDuration,
    lastUpdate: now,
    confidence
  };
  
  console.log(`📊 Song updated: ${title} - ${artist} (${Math.round(validDuration/1000)}s, ${confidence}%)`);
  
  res.json({ 
    success: true, 
    message: 'Song updated',
    duration: validDuration
  });
});

// 2. Get current song status
app.get('/status', (req, res) => {
  res.json({ 
    title: currentSong.title, 
    artist: currentSong.artist,
    duration: currentSong.duration,
    confidence: currentSong.confidence
  });
});

// 3. Get next request (dipanggil oleh content.js setiap 10 detik)
app.get('/get-request', (req, res) => {
  const now = Date.now();
  
  // Cek jika masih terkunci
  if (now < requestLockUntil) {
    const remainingSeconds = Math.ceil((requestLockUntil - now) / 1000);
    const minutes = Math.ceil(remainingSeconds / 60);
    
    return res.status(423).json({ 
      error: 'Request terkunci', 
      lockRemaining: remainingSeconds,
      minutesRemaining: minutes,
      currentPlaying: activeRequest?.query || currentSong.title,
      queueLength: requestQueue.length
    });
  }
  
  // Jika queue kosong
  if (requestQueue.length === 0) {
    activeRequest = null;
    return res.json(null);
  }
  
  // Ambil request berikutnya dari queue
  const nextRequest = requestQueue.shift();
  activeRequest = nextRequest;
  
  // Set lock time berdasarkan durasi lagu saat ini
  const lockDuration = currentSong.duration + 5000; // Durasi + buffer 5 detik
  requestLockUntil = now + lockDuration;
  
  // Simpan perubahan ke file
  saveQueueToFile();
  
  console.log(`🎵 Next request: "${nextRequest.query}" (Lock: ${Math.round(lockDuration/1000)}s)`);
  console.log(`⏰ Lock until: ${new Date(requestLockUntil).toLocaleTimeString()}`);
  
  // Kembalikan request ke extension
  res.json({
    query: nextRequest.query,
    time: nextRequest.time,
    estimatedDuration: lockDuration,
    queueRemaining: requestQueue.length
  });
});

// ================= ENDPOINT UNTUK WEB INTERFACE =================

// 4. Add new request
app.post('/request-song', (req, res) => {
  const { query } = req.body;
  
  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Query tidak boleh kosong' });
  }
  
  // Cek duplikat
  const isDuplicate = requestQueue.some(req => 
    req.query.toLowerCase() === query.toLowerCase()
  );
  
  if (isDuplicate) {
    return res.status(409).json({ error: 'Lagu sudah ada dalam antrian' });
  }
  
  const newRequest = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    query: query.trim(),
    time: Date.now(),
    status: 'pending'
  };
  
  requestQueue.push(newRequest);
  saveQueueToFile();
  
  console.log(`📝 Request added: "${query}" (Total: ${requestQueue.length})`);
  
  // Jika tidak ada request aktif dan tidak ada lock, set ini sebagai aktif
  if (!activeRequest && requestLockUntil === 0) {
    activeRequest = newRequest;
    console.log(`🎵 Set as active request: ${query}`);
  }
  
  res.json({ 
    success: true, 
    message: 'Request berhasil ditambahkan',
    request: newRequest,
    queuePosition: requestQueue.length
  });
});

// 5. Get all requests
app.get('/requests', (req, res) => {
  // Tambahkan informasi estimasi waktu tunggu
  const requestsWithWaitTime = requestQueue.map((req, index) => {
    // Estimasi waktu tunggu: durasi lagu saat ini × posisi
    const estimatedWait = Math.round((currentSong.duration * (index + 1)) / 1000);
    
    return {
      ...req,
      position: index + 1,
      estimatedWait: estimatedWait, // dalam detik
      estimatedWaitFormatted: formatWaitTime(estimatedWait)
    };
  });
  
  res.json(requestsWithWaitTime);
});

// 6. Get queue information
app.get('/queue-info', (req, res) => {
  const now = Date.now();
  const isLocked = now < requestLockUntil;
  const remainingSeconds = isLocked ? Math.ceil((requestLockUntil - now) / 1000) : 0;
  
  // Hitung total waktu antrian (dalam menit)
  let totalQueueTime = 0;
  if (isLocked) {
    totalQueueTime += remainingSeconds / 60; // waktu lock tersisa
  }
  
  // Tambahkan durasi untuk setiap lagu dalam antrian
  requestQueue.forEach(() => {
    totalQueueTime += (currentSong.duration / 60000); // durasi dalam menit
  });
  
  const queueInfo = {
    isLocked,
    lockUntil: requestLockUntil,
    remainingSeconds,
    remainingFormatted: formatWaitTime(remainingSeconds),
    currentRequest: activeRequest,
    currentSong: currentSong,
    queue: requestQueue.map((req, index) => ({
      ...req,
      position: index + 1
    })),
    queueLength: requestQueue.length,
    totalQueueTime: Math.round(totalQueueTime * 10) / 10 // 1 desimal
  };
  
  res.json(queueInfo);
});

// 7. Clear all requests
app.delete('/clear-requests', (req, res) => {
  const previousCount = requestQueue.length;
  requestQueue = [];
  activeRequest = null;
  requestLockUntil = 0;
  saveQueueToFile();
  
  console.log(`🗑️ Cleared ${previousCount} requests`);
  
  res.json({ 
    success: true, 
    message: 'Semua request telah dihapus',
    clearedCount: previousCount
  });
});

// 8. Remove specific request
app.delete('/remove-request/:id', (req, res) => {
  const { id } = req.params;
  const index = requestQueue.findIndex(req => req.id === id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Request tidak ditemukan' });
  }
  
  const removed = requestQueue.splice(index, 1)[0];
  
  // Jika yang dihapus adalah request aktif, reset lock
  if (activeRequest && activeRequest.id === id) {
    activeRequest = null;
    requestLockUntil = 0;
    console.log(`⚠️ Active request removed: "${removed.query}"`);
  }
  
  saveQueueToFile();
  
  console.log(`🗑️ Request removed: "${removed.query}"`);
  
  res.json({ 
    success: true, 
    message: 'Request berhasil dihapus',
    removed: removed.query,
    newQueueLength: requestQueue.length
  });
});

// 9. Skip current request (unlock)
app.post('/skip-current', (req, res) => {
  if (!activeRequest && requestLockUntil === 0) {
    return res.status(400).json({ error: 'Tidak ada request yang sedang diputar' });
  }
  
  console.log(`⏭️ Skipping current request: "${activeRequest?.query || 'Unknown'}"`);
  
  // Reset lock time
  requestLockUntil = 0;
  
  // Jika ada request aktif, pindahkan ke akhir queue atau hapus
  if (activeRequest) {
    // Opsional: pindahkan ke akhir queue
    // requestQueue.push(activeRequest);
    activeRequest = null;
  }
  
  res.json({
    success: true,
    message: 'Request berhasil diskip',
    queueLength: requestQueue.length,
    nextRequest: requestQueue.length > 0 ? requestQueue[0] : null
  });
});

// 10. Get lock status (untuk monitoring)
app.get('/lock-status', (req, res) => {
  const now = Date.now();
  const isLocked = now < requestLockUntil;
  const remainingSeconds = isLocked ? Math.ceil((requestLockUntil - now) / 1000) : 0;
  
  res.json({
    isLocked,
    lockedUntil: requestLockUntil,
    remainingSeconds,
    remainingFormatted: formatWaitTime(remainingSeconds),
    activeRequest: activeRequest?.query || null,
    currentSong: currentSong.title,
    currentDuration: Math.round(currentSong.duration / 1000) + 's'
  });
});

// 11. Get server stats
app.get('/stats', (req, res) => {
  const now = Date.now();
  const uptime = Math.round((now - currentSong.lastUpdate) / 1000);
  
  res.json({
    serverTime: now,
    uptimeSeconds: uptime,
    currentSong: currentSong,
    activeRequest: activeRequest,
    queueLength: requestQueue.length,
    isLocked: now < requestLockUntil,
    lockRemaining: Math.max(0, requestLockUntil - now)
  });
});

// ================= HELPER FUNCTIONS =================

function formatWaitTime(seconds) {
  if (!seconds || seconds <= 0) return 'Segera';
  if (seconds < 60) return `${seconds} detik`;
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit`;
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} jam ${remainingMinutes} menit`;
}

// ================= SERVE HTML =================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================= START SERVER =================

const PORT = 3000;
app.listen(PORT, () => {
  console.log("✅ Server running → http://localhost:" + PORT);
  console.log(`📊 Current queue: ${requestQueue.length} requests`);
  console.log("🎵 Ready to process YouTube Music requests!");
  
  // Log initial state
  if (requestLockUntil > 0) {
    const remaining = Math.ceil((requestLockUntil - Date.now()) / 1000);
    console.log(`⏰ Current lock: ${remaining}s remaining`);
  }
});