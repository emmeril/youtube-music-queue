const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let currentSong = { title: "N/A", artist: "N/A" };
let requests = [];

app.post('/update', (req, res) => {
    currentSong = req.body;
    console.log("Playing:", currentSong.title);
    res.sendStatus(200);
});

app.get('/status', (req, res) => res.json(currentSong));

app.post('/request-song', (req, res) => {
    requests.push(req.body.query);
    res.json({ success: true });
});

app.get('/get-request', (req, res) => {
    res.json({ query: requests.shift() || null });
});

app.listen(3000, () => console.log("Server: http://localhost:3000"));