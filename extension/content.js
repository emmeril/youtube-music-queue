let lastTrack = "";

// 1. KIRIM DATA KE BACKEND
setInterval(() => {
    const title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim();
    const artist = document.querySelector('ytmusic-player-bar .byline')?.textContent?.trim();

    if (title && title !== lastTrack) {
        lastTrack = title;
        fetch('http://localhost:3000/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, artist })
        }).catch(() => console.log("Server Offline"));
    }
}, 2000);

// 2. CEK REQUEST DARI BACKEND
setInterval(() => {
    fetch('http://localhost:3000/get-request')
        .then(res => res.json())
        .then(data => {
            if (data.query) {
                window.location.href = `https://music.youtube.com/search?q=${encodeURIComponent(data.query)}`;
            }
        }).catch(() => {});
}, 3000);

// 3. AUTO PLAY JIKA DI HALAMAN SEARCH
if (window.location.href.includes('/search?q=')) {
    const checkExist = setInterval(() => {
        const firstResult = document.querySelector('ytmusic-responsive-list-item-renderer');
        if (firstResult) {
            firstResult.querySelector('a').click();
            clearInterval(checkExist);
        }
    }, 1000);
}