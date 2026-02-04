const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const REQUEST_FILE = path.join(__dirname, 'requests.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentSong = { title: "N/A", artist: "N/A" };
let requestLockUntil = 0;
const LOCK_DURATION = 5 * 60 * 1000; // 5 menit


// helper
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

// update lagu yang sedang diputar
app.post('/update', (req, res) => {
  currentSong = req.body;
  res.sendStatus(200);
});

app.get('/status', (req, res) => res.json(currentSong));

// tambah request
app.post('/request-song', (req, res) => {
  const requests = readRequests();
  requests.push({
    query: req.body.query,
    time: Date.now()
  });
  writeRequests(requests);
  res.json({ success: true });
});

// ambil request paling atas (queue)
app.get('/get-request', (req, res) => {
  const now = Date.now();

  // 🔒 masih dikunci
  if (now < requestLockUntil) {
    return res.json(null);
  }

  const requests = readRequests();
  const next = requests.shift() || null;

  if (next) {
    // kunci 5 menit
    requestLockUntil = now + LOCK_DURATION;
    writeRequests(requests);
  }

  res.json(next);
});


// list request buat frontend
app.get('/requests', (req, res) => {
  res.json(readRequests());
});

app.listen(3000, () =>
  console.log("Server running → http://localhost:3000")
);
