        function app() {
            return {
                // State
                appVersion: '2.3.0',
                currentSong: {
                    title: '',
                    artist: '',
                    duration: 0,
                    timestamp: 0,
                    confidence: 0,
                    isPlaying: false
                },
                activeRequest: null,
                queue: [],
                history: [],
                stats: {
                    queueLength: 0,
                    totalSongs: 0,
                    totalTime: 0
                },
                lockRemaining: 0,
                lockProgress: 0,
                lockInfo: {
                    originalLock: 0,
                    basedOnSongDuration: 0
                },
                queueLimit: 100,
                newRequest: {
                    title: '',
                    artist: ''
                },
                priorityRequest: false,
                showTitleError: false,
                showArtistError: false,
                titleError: '',
                artistError: '',
                isConnected: false,
                isLoading: false,
                isRefreshing: false,
                showSettings: false,
                
                // Admin State
                isAdmin: false,
                adminRole: null, // 'super' atau 'admin'
                adminToken: null,
                adminSessionExpires: null,
                showAdminLogin: false,
                adminPassword: '',
                
                // Toast
                toast: {
                    show: false,
                    message: '',
                    type: 'info'
                },
                
                // Initialize
                async init() {
                    // Inisialisasi event listener untuk toast dari service worker
                    document.addEventListener('show-toast', (event) => {
                        this.showToast(event.detail.message, event.detail.type);
                    });
                    
                    // Cek admin session dari localStorage
                    const savedToken = localStorage.getItem('adminToken');
                    const savedExpires = localStorage.getItem('adminExpires');
                    const savedRole = localStorage.getItem('adminRole');
                    
                    if (savedToken && savedExpires && Date.now() < parseInt(savedExpires)) {
                        this.adminToken = savedToken;
                        this.adminRole = savedRole;
                        this.adminSessionExpires = parseInt(savedExpires);
                        await this.checkAdminSession();
                    }
                    
                    await this.loadData();
                    
                    // Cek versi aplikasi
                    await this.checkVersion();
                    
                    // Auto refresh data every 3 seconds
                    setInterval(async () => {
                        await this.loadData();
                    }, 3000);
                    
                    // Update lock progress every second
                    setInterval(() => {
                        this.updateLockProgress();
                    }, 1000);
                    
                    // Cek admin session setiap menit
                    setInterval(() => {
                        if (this.isAdmin) {
                            this.checkAdminSession();
                        }
                    }, 60000);
                    
                    // Cek versi aplikasi setiap 2 menit
                    setInterval(async () => {
                        await this.checkVersion();
                    }, 120000);
                },
                
                // Load all data
                async loadData() {
                    try {
                        // Tambahkan admin token jika ada
                        const headers = {};
                        if (this.isAdmin && this.adminToken) {
                            headers['x-admin-token'] = this.adminToken;
                        }
                        
                        const [statusRes, queueRes] = await Promise.all([
                            fetch('/status', { headers }).catch(() => null),
                            fetch('/queue-info', { headers }).catch(() => null)
                        ]);
                        
                        this.isConnected = statusRes && statusRes.ok;
                        
                        if (statusRes && statusRes.ok) {
                            const statusData = await statusRes.json();
                            this.currentSong = statusData.song;
                            this.activeRequest = statusData.activeRequest;
                            this.lockRemaining = Math.round(statusData.lockRemaining / 1000);
                            this.lockInfo = statusData.lockInfo || {};
                            this.stats.totalSongs = statusData.stats.totalSongsPlayed || 0;
                            this.stats.totalTime = statusData.stats.totalPlayTime || 0;
                            this.queueLimit = statusData.queueLimit || 100;
                        }
                        
                        if (queueRes && queueRes.ok) {
                            const queueData = await queueRes.json();
                            this.queue = queueData.queue || [];
                            this.stats.queueLength = queueData.queueLength || 0;
                            this.queueLimit = queueData.queueLimit || 100;
                        }
                        
                    } catch (error) {
                        console.error('Error loading data:', error);
                        this.isConnected = false;
                    }
                },
                
                // Validasi input di frontend
                validateInput() {
                    // Reset error states
                    this.showTitleError = false;
                    this.showArtistError = false;
                    this.titleError = '';
                    this.artistError = '';
                    
                    // Trim input
                    const title = this.newRequest.title.trim();
                    const artist = this.newRequest.artist.trim();
                    
                    let isValid = true;
                    
                    // Validasi 1: Input tidak boleh kosong
                    if (!title) {
                        this.showTitleError = true;
                        this.titleError = 'Judul lagu wajib diisi';
                        isValid = false;
                    }
                    
                    if (!artist) {
                        this.showArtistError = true;
                        this.artistError = 'Nama artis wajib diisi';
                        isValid = false;
                    }
                    
                    // Validasi 2: Panjang minimum
                    if (title && title.length < 2) {
                        this.showTitleError = true;
                        this.titleError = 'Judul lagu minimal 2 karakter';
                        isValid = false;
                    }
                    
                    if (artist && artist.length < 2) {
                        this.showArtistError = true;
                        this.artistError = 'Nama artis minimal 2 karakter';
                        isValid = false;
                    }
                    
                    // Validasi 3: Panjang maksimum
                    if (title && title.length > 100) {
                        this.showTitleError = true;
                        this.titleError = 'Judul lagu maksimal 100 karakter';
                        isValid = false;
                    }
                    
                    if (artist && artist.length > 100) {
                        this.showArtistError = true;
                        this.artistError = 'Nama artis maksimal 100 karakter';
                        isValid = false;
                    }
                    
                    // Validasi 4: Format karakter
                    const validCharsRegex = /^[a-zA-Z0-9\s.,'&!?()\-"@]+$/;
                    
                    if (title && !validCharsRegex.test(title)) {
                        this.showTitleError = true;
                        this.titleError = 'Judul lagu mengandung karakter tidak valid';
                        isValid = false;
                    }
                    
                    if (artist && !validCharsRegex.test(artist)) {
                        this.showArtistError = true;
                        this.artistError = 'Nama artis mengandung karakter tidak valid';
                        isValid = false;
                    }
                    
                    // Validasi 5: Cek input yang sama berulang
                    if (title && artist && title.toLowerCase() === artist.toLowerCase()) {
                        this.showTitleError = true;
                        this.showArtistError = true;
                        this.titleError = 'Judul dan artis tidak boleh sama';
                        this.artistError = 'Judul dan artis tidak boleh sama';
                        isValid = false;
                    }
                    
                    // Validasi 6: Cek apakah judul hanya berisi angka
                    if (title && /^\d+$/.test(title)) {
                        this.showTitleError = true;
                        this.titleError = 'Judul lagu tidak boleh hanya angka';
                        isValid = false;
                    }
                    
                    return isValid;
                },
                
                // Fungsi untuk menambahkan "official" ke judul jika belum ada
                prepareQuery(title, artist) {
                    let judul = title.trim();
                    const kataOfficial = "lirik";
                    
                    // Cek apakah judul sudah mengandung kata "official" (case insensitive)
                    if (!judul.toLowerCase().includes(kataOfficial)) {
                        judul = judul + ' ' + kataOfficial;
                    }
                    
                    return `${judul} - ${artist.trim()}`;
                },
                
                // Add new request
                async addRequest() {
                    // Validasi input
                    if (!this.validateInput()) {
                        return;
                    }
                    
                    // Cek batas antrian lokal
                    if (this.queue.length >= this.queueLimit) {
                        this.showToast(`Antrian penuh (maksimal ${this.queueLimit} lagu). Tunggu hingga beberapa lagu selesai.`, 'warning');
                        return;
                    }
                    
                    this.isLoading = true;
                    
                    try {
                        // Gabungkan judul dan artis menjadi satu query dengan menambahkan "official" jika perlu
                        const combinedQuery = this.prepareQuery(this.newRequest.title, this.newRequest.artist);
                        
                        // Jika admin dan priority request, gunakan endpoint khusus
                        let endpoint = '/request-song';
                        let method = 'POST';
                        let bodyData = { query: combinedQuery };
                        let requestHeaders = { 'Content-Type': 'application/json' };
                        
                        if (this.isAdmin && this.priorityRequest) {
                            endpoint = '/admin/request-first';
                            requestHeaders['x-admin-token'] = this.adminToken;
                        }
                        
                        const response = await fetch(endpoint, {
                            method: method,
                            headers: requestHeaders,
                            body: JSON.stringify(bodyData)
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            // Reset form
                            this.newRequest = {
                                title: '',
                                artist: ''
                            };
                            this.priorityRequest = false;
                            
                            await this.loadData();
                            
                            if (this.isAdmin && this.priorityRequest) {
                                this.showToast(`Ditambahkan sebagai PRIORITAS (Posisi: ${result.queuePosition})`, 'success');
                            } else {
                                this.showToast(`Ditambahkan ke antrian (Posisi: ${result.queuePosition})`, 'success');
                            }
                        } else {
                            if (response.status === 403) {
                                this.showToast('Akses ditolak. Hanya admin yang bisa menambahkan prioritas.', 'error');
                                this.isAdmin = false;
                                this.adminRole = null;
                            } else {
                                this.showToast(`Error: ${result.error}`, 'error');
                            }
                        }
                    } catch (error) {
                        this.showToast('Gagal menambahkan request', 'error');
                    } finally {
                        this.isLoading = false;
                    }
                },
                
                // Remove request (Admin & Super Admin)
                async removeRequest(id) {
                    if (!this.isAdmin) {
                        this.showToast('Hanya admin yang bisa menghapus request', 'error');
                        return;
                    }
                    
                    if (!confirm('Hapus request ini dari antrian?')) return;
                    
                    try {
                        const response = await fetch(`/remove-request/${id}`, {
                            method: 'DELETE',
                            headers: this.isAdmin ? { 'x-admin-token': this.adminToken } : {}
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            await this.loadData();
                            this.showToast(`Dihapus: ${result.removed}`, 'success');
                        } else if (response.status === 403) {
                            this.showToast('Akses ditolak. Hanya admin yang bisa menghapus request.', 'error');
                            this.isAdmin = false;
                            this.adminRole = null;
                        }
                    } catch (error) {
                        this.showToast('Gagal menghapus request', 'error');
                    }
                },
                
                // Skip current request (Hanya Super Admin)
                async skipCurrent() {
                    if (!this.isAdmin || this.adminRole !== 'super') {
                        this.showToast('Hanya Super Admin yang bisa skip lagu', 'error');
                        return;
                    }
                    
                    if (!confirm('Skip lagu saat ini?')) return;
                    
                    try {
                        const response = await fetch('/skip-current', {
                            method: 'POST',
                            headers: this.isAdmin ? { 'x-admin-token': this.adminToken } : {}
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            await this.loadData();
                            this.showToast('Request berhasil diskip', 'success');
                        } else if (response.status === 403) {
                            this.showToast('Akses ditolak. Hanya Super Admin yang bisa skip.', 'error');
                            this.isAdmin = false;
                            this.adminRole = null;
                        }
                    } catch (error) {
                        this.showToast('Gagal skip request', 'error');
                    }
                },
                
                // Force next request (Hanya Super Admin)
                async forceNext() {
                    if (!this.isAdmin || this.adminRole !== 'super') {
                        this.showToast('Hanya Super Admin yang bisa force next', 'error');
                        return;
                    }
                    
                    if (!confirm('Force skip ke lagu berikutnya?')) return;
                    
                    try {
                        const response = await fetch('/force-next', {
                            method: 'POST',
                            headers: this.isAdmin ? { 'x-admin-token': this.adminToken } : {}
                        });
                        
                        if (response.ok) {
                            await this.loadData();
                            this.showToast('Force skip berhasil', 'success');
                        } else if (response.status === 403) {
                            this.showToast('Akses ditolak. Hanya Super Admin yang bisa force next.', 'error');
                            this.isAdmin = false;
                            this.adminRole = null;
                        }
                    } catch (error) {
                        this.showToast('Gagal force skip', 'error');
                    }
                },
                
                // Clear all requests (Hanya Super Admin)
                async clearQueue() {
                    if (!this.isAdmin || this.adminRole !== 'super') {
                        this.showToast('Hanya Super Admin yang bisa menghapus semua antrian', 'error');
                        return;
                    }
                    
                    if (this.queue.length === 0) {
                        this.showToast('Antrian sudah kosong', 'info');
                        return;
                    }
                    
                    if (!confirm(`Hapus semua ${this.queue.length} request dari antrian?`)) return;
                    
                    try {
                        const response = await fetch('/clear-requests', {
                            method: 'DELETE',
                            headers: this.isAdmin ? { 'x-admin-token': this.adminToken } : {}
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            await this.loadData();
                            this.showToast(`Dihapus ${result.clearedCount} request`, 'success');
                        } else if (response.status === 403) {
                            this.showToast('Akses ditolak. Hanya Super Admin yang bisa menghapus antrian.', 'error');
                            this.isAdmin = false;
                            this.adminRole = null;
                        }
                    } catch (error) {
                        this.showToast('Gagal menghapus antrian', 'error');
                    }
                },
                
                // Move request up (Admin & Super Admin)
                async moveRequestUp(requestId, currentIndex) {
                    if (!this.isAdmin) {
                        this.showToast('Hanya admin yang bisa memindahkan request', 'error');
                        return;
                    }
                    
                    const newPosition = currentIndex; // Pindah ke posisi sebelumnya
                    
                    try {
                        const response = await fetch('/admin/move-request', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'x-admin-token': this.adminToken 
                            },
                            body: JSON.stringify({ 
                                requestId, 
                                newPosition 
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            await this.loadData();
                            this.showToast(result.message, 'success');
                        } else {
                            this.showToast(result.error, 'error');
                        }
                    } catch (error) {
                        this.showToast('Gagal memindahkan request', 'error');
                    }
                },
                
                // Move request down (Admin & Super Admin)
                async moveRequestDown(requestId, currentIndex) {
                    if (!this.isAdmin) {
                        this.showToast('Hanya admin yang bisa memindahkan request', 'error');
                        return;
                    }
                    
                    const newPosition = currentIndex + 2; // Pindah ke posisi berikutnya
                    
                    try {
                        const response = await fetch('/admin/move-request', {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'x-admin-token': this.adminToken 
                            },
                            body: JSON.stringify({ 
                                requestId, 
                                newPosition 
                            })
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            await this.loadData();
                            this.showToast(result.message, 'success');
                        } else {
                            this.showToast(result.error, 'error');
                        }
                    } catch (error) {
                        this.showToast('Gagal memindahkan request', 'error');
                    }
                },
                
                // Refresh all data
                async refreshAll() {
                    this.isRefreshing = true;
                    await this.loadData();
                    setTimeout(() => {
                        this.isRefreshing = false;
                    }, 500);
                    this.showToast('Data diperbarui', 'success');
                },
                
                // Update lock progress
                updateLockProgress() {
                    if (this.lockRemaining > 0 && this.lockInfo.originalLock > 0) {
                        const elapsed = (this.lockInfo.originalLock / 1000) - this.lockRemaining;
                        this.lockProgress = Math.min(100, (elapsed / (this.lockInfo.originalLock / 1000)) * 100);
                        
                        if (this.lockRemaining > 0) {
                            this.lockRemaining--;
                        }
                    } else {
                        this.lockProgress = 0;
                    }
                },
                
                // Admin methods
                async adminLogin() {
                    if (!this.adminPassword.trim()) {
                        this.showToast('Masukkan password admin', 'error');
                        return;
                    }
                    
                    this.isLoading = true;
                    
                    try {
                        const response = await fetch('/admin/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: this.adminPassword })
                        });
                        
                        const result = await response.json();
                        
                        if (response.ok) {
                            this.adminToken = result.token;
                            this.adminRole = result.role; // Simpan role
                            this.adminSessionExpires = result.expiresAt;
                            this.isAdmin = true;
                            this.adminPassword = '';
                            this.showAdminLogin = false;
                            
                            // Simpan token di localStorage
                            localStorage.setItem('adminToken', this.adminToken);
                            localStorage.setItem('adminRole', this.adminRole);
                            localStorage.setItem('adminExpires', this.adminSessionExpires);
                            
                            this.showToast(`Login ${this.adminRole === 'super' ? 'Super Admin' : 'Admin'} berhasil`, 'success');
                            
                            // Load data dengan admin token
                            await this.loadData();
                        } else {
                            this.showToast(result.error || 'Login gagal', 'error');
                        }
                    } catch (error) {
                        this.showToast('Gagal menghubungi server', 'error');
                    } finally {
                        this.isLoading = false;
                    }
                },
                
                async adminLogout() {
                    if (!confirm('Logout dari mode admin?')) return;
                    
                    try {
                        if (this.adminToken) {
                            await fetch('/admin/logout', {
                                method: 'POST',
                                headers: { 'x-admin-token': this.adminToken }
                            });
                        }
                        
                        this.isAdmin = false;
                        this.adminToken = null;
                        this.adminRole = null;
                        this.adminSessionExpires = null;
                        
                        // Hapus dari localStorage
                        localStorage.removeItem('adminToken');
                        localStorage.removeItem('adminRole');
                        localStorage.removeItem('adminExpires');
                        
                        this.showToast('Logout admin berhasil', 'info');
                        
                        // Load data tanpa admin token
                        await this.loadData();
                    } catch (error) {
                        console.error('Logout error:', error);
                    }
                },
                
                async checkAdminSession() {
                    if (!this.adminToken) return;
                    
                    try {
                        const response = await fetch('/admin/status', {
                            headers: { 'x-admin-token': this.adminToken }
                        });
                        
                        const result = await response.json();
                        
                        if (!result.isAdmin) {
                            // Session expired
                            this.isAdmin = false;
                            this.adminToken = null;
                            this.adminRole = null;
                            this.adminSessionExpires = null;
                            
                            localStorage.removeItem('adminToken');
                            localStorage.removeItem('adminRole');
                            localStorage.removeItem('adminExpires');
                            
                            this.showToast('Session admin telah kadaluarsa', 'warning');
                        } else {
                            this.adminRole = result.role; // Update role
                            this.adminSessionExpires = result.expiresAt;
                            localStorage.setItem('adminExpires', this.adminSessionExpires);
                            localStorage.setItem('adminRole', this.adminRole);
                        }
                    } catch (error) {
                        console.error('Session check error:', error);
                    }
                },
                
                // Check app version
                async checkVersion() {
                    try {
                        const response = await fetch('/version');
                        if (response.ok) {
                            const data = await response.json();
                            const savedVersion = localStorage.getItem('appVersion');
                            
                            if (savedVersion && savedVersion !== data.version) {
                                // Versi berubah, reload halaman
                                this.showToast('Aplikasi telah diperbarui. Memuat ulang...', 'info');
                                setTimeout(() => {
                                    window.location.reload();
                                }, 2000);
                            } else {
                                // Simpan versi baru
                                localStorage.setItem('appVersion', data.version);
                                this.appVersion = data.version;
                            }
                        }
                    } catch (error) {
                        console.error('Version check error:', error);
                    }
                },
                
                // Format helpers
                formatDuration(ms) {
                    if (!ms) return '0:00';
                    const seconds = Math.round(ms / 1000);
                    const minutes = Math.floor(seconds / 60);
                    const remainingSeconds = seconds % 60;
                    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
                },
                
                formatTime(timestamp, mobile = false) {
                    if (!timestamp) return '';
                    const date = new Date(timestamp);
                    const now = new Date();
                    const diff = now - date;
                    
                    if (diff < 60000) return 'Baru saja';
                    
                    if (date.toDateString() === now.toDateString()) {
                        if (mobile) {
                            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        }
                        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    }
                    
                    const yesterday = new Date(now);
                    yesterday.setDate(yesterday.getDate() - 1);
                    if (date.toDateString() === yesterday.toDateString()) {
                        if (mobile) {
                            return 'Kemarin';
                        }
                        return 'Kemarin ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    }
                    
                    if (mobile) {
                        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
                    }
                    
                    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                },
                
                formatWaitTime(seconds) {
                    if (!seconds || seconds <= 0) return 'Segera';
                    if (seconds < 60) return `${seconds} detik`;
                    
                    const minutes = Math.floor(seconds / 60);
                    if (minutes < 60) return `${minutes} menit`;
                    
                    const hours = Math.floor(minutes / 60);
                    const remainingMinutes = minutes % 60;
                    return `${hours} jam ${remainingMinutes} menit`;
                },
                
                calculateWaitTime(position) {
                    if (position <= 0) return 0;
                    
                    const currentRemaining = this.lockRemaining > 0 ? 
                        this.lockRemaining / 60 : 0;
                    
                    const avgSongDuration = (this.currentSong.duration || 180000) / 60000;
                    
                    return Math.round(currentRemaining + (position * avgSongDuration));
                },
                
                // Toast notification
                showToast(message, type = 'info') {
                    this.toast = {
                        show: true,
                        message,
                        type
                    };
                    
                    // Untuk error, tambahkan durasi lebih lama
                    const duration = type === 'error' ? 5000 : 3000;
                    
                    setTimeout(() => {
                        this.toast.show = false;
                    }, duration);
                }
            }
        }
        
        document.addEventListener('DOMContentLoaded', function() {
            fetch('/health')
                .then(response => {
                    if (response.ok) {
                        console.log('Server is healthy');
                    }
                })
                .catch(() => {
                    console.warn('Server is not reachable');
                });
        });
