// kirim lagu yang sedang diputar
setInterval(() => {
  const title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim();
  const artist = document.querySelector('ytmusic-player-bar .byline')?.textContent?.trim();

  if (title) {
    fetch('http://localhost:3000/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist })
    }).catch(() => {});
  }
}, 2000);

// ambil request (backend SUDAH NGUNCI)
setInterval(() => {
  fetch('http://localhost:3000/get-request')
    .then(res => res.json())
    .then(data => {
      if (data?.query) {
        window.location.href =
          `https://music.youtube.com/search?q=${encodeURIComponent(data.query)}`;
      }
    })
    .catch(() => {});
}, 4000);

// auto play hasil pertama
if (location.href.includes('/search?q=')) {
  const wait = setInterval(() => {
    const song = document.querySelector('ytmusic-responsive-list-item-renderer a');
    if (song) {
      song.click();
      clearInterval(wait);
    }
  }, 1000);
}
