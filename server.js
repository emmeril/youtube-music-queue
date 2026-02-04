const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const REQUEST_FILE = path.join(__dirname, 'requests.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentSong = { 
  title: "N/A", 
  artist: "N/A", 
  duration: 180000,
  lastUpdate: Date.now(),
  confidence: 0 // Tingkat kepercayaan durasi (0-100)
};
let requestLockUntil = 0;

const readRequests = () => {
  try {
    return JSON.parse(fs.readFileSync(REQUEST_FILE, 'utf8'));
  } catch {
    return [];
  }
};

const writeRequests = (data) => {
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(data, null, 2));
};

// Update lagu dengan validasi durasi
app.post('/update', (req, res) => {
  const { title, artist, duration = 180000 } = req.body;
  const now = Date.now();
  
  // Validasi durasi
  let validDuration = duration;
  
  if (duration < 10000) { // Kurang dari 10 detik
    console.log(`⚠️ Durasi terlalu pendek: ${duration}ms, menggunakan default 3 menit`);
    validDuration = 180000;
  } else if (duration > 3600000) { // Lebih dari 1 jam
    console.log(`⚠️ Durasi terlalu panjang: ${duration}ms, menggunakan maksimal 10 menit`);
    validDuration = 600000;
  }
  
  // Hitung confidence berdasarkan durasi
  let confidence = 50; // Default
  
  // Durasi lagu umum: 2-5 menit (120000-300000 ms)
  if (validDuration >= 120000 && validDuration <= 300000) {
    confidence = 90;
  } else if (validDuration >= 60000 && validDuration <= 600000) {
    confidence = 70;
  }
  
  // Jika lagu sama, kita bisa meningkatkan confidence
  if (title === currentSong.title && artist === currentSong.artist) {
    confidence = Math.min(100, confidence + 10);
  }
  
  currentSong = { 
    title, 
    artist, 
    duration: validDuration,
    lastUpdate: now,
    confidence
  };
  
  console.log(`📊 Updated: ${title} - ${artist} (${Math.round(validDuration/1000)}s, confidence: ${confidence}%)`);
  
  res.sendStatus(200);
});

app.get('/status', (req, res) => {
  res.json({ 
    title: currentSong.title, 
    artist: currentSong.artist,
    duration: currentSong.duration,
    confidence: currentSong.confidence
  });
});

app.post('/request-song', (req, res) => {
  const { query } = req.body;
  
  if (!query || query.trim() === '') {
    return res.status(400).json({ error: 'Query tidak boleh kosong' });
  }
  
  const requests = readRequests();
  
  if (requests.some(req => req.query.toLowerCase() === query.toLowerCase())) {
    return res.status(409).json({ error: 'Lagu sudah ada dalam antrian' });
  }
  
  requests.push({
    query: query.trim(),
    time: Date.now(),
    status: 'pending'
  });
  
  writeRequests(requests);
  res.json({ success: true, message: 'Request berhasil ditambahkan' });
});

app.get('/get-request', (req, res) => {
  const now = Date.now();

  if (now < requestLockUntil) {
    const remainingTime = Math.ceil((requestLockUntil - now) / 1000);
    return res.status(423).json({ 
      error: 'Request terkunci', 
      lockRemaining: remainingTime,
      lockedUntil: requestLockUntil 
    });
  }

  const requests = readRequests();
  
  if (requests.length === 0) {
    return res.json(null);
  }

  const nextRequest = requests.shift();
  
  // Gunakan durasi lagu saat ini untuk lock time
  // Tambahkan buffer 5 detik untuk memastikan lagu sudah mulai
  const lockDuration = currentSong.duration + 5000;
  requestLockUntil = now + lockDuration;
  
  writeRequests(requests);
  
  console.log(`🔒 Lock set for ${Math.round(lockDuration/1000)}s for: ${nextRequest.query}`);
  
  res.json(nextRequest);
});

app.get('/requests', (req, res) => {
  res.json(readRequests());
});

app.get('/lock-status', (req, res) => {
  const now = Date.now();
  const isLocked = now < requestLockUntil;
  const remainingTime = isLocked ? Math.ceil((requestLockUntil - now) / 1000) : 0;
  
  res.json({
    isLocked,
    lockUntil: requestLockUntil,
    remainingSeconds: remainingTime,
    currentSong: currentSong
  });
});

app.delete('/clear-requests', (req, res) => {
  writeRequests([]);
  requestLockUntil = 0;
  res.json({ success: true, message: 'Semua request telah dihapus' });
});

app.delete('/remove-request/:index', (req, res) => {
  const index = parseInt(req.params.index);
  const requests = readRequests();
  
  if (index < 0 || index >= requests.length) {
    return res.status(404).json({ error: 'Request tidak ditemukan' });
  }
  
  requests.splice(index, 1);
  writeRequests(requests);
  
  res.json({ success: true, message: 'Request berhasil dihapus' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(3000, () => {
  console.log("✅ Server running → http://localhost:3000");
  console.log("📂 Current directory:", __dirname);
});