        function app() {
            return {
                // State
                appVersion: '2.3.0',
                currentSong: {
                    title: 'Tidak ada lagu',
                    artist: 'Tidak diketahui',
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
                randomQueueEnabled: false,
                randomQueue: {
                    enabled: false,
                    mode: 'fifo',
                    poolSize: 20,
                    description: 'Antrian diputar sesuai urutan masuk.',
                    shortLabel: 'FIFO'
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
                isPageVisible: true,
                isPollingData: false,
                
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
                    this.isPageVisible = !document.hidden;

                    document.addEventListener('visibilitychange', async () => {
                        this.isPageVisible = !document.hidden;
                        if (this.isPageVisible) {
                            await this.loadData();
                            await this.checkVersion();
                        }
                    });

                    // Inisialisasi event listener untuk toast dari service worker
                    document.addEventListener('show-toast', (event) => {
                        this.showToast(event.detail.message, event.detail.type);
                    });
                    
                    // Cek admin session dari localStorage
                    const savedToken = localStorage.getItem('adminToken');
                    const savedExpires = localStorage.getItem('adminExpires');
                    const savedRole = localStorage.getItem('adminRole');
                    const parsedExpires = Number.parseInt(savedExpires || '', 10);
                    
                    if (savedToken && Number.isFinite(parsedExpires) && Date.now() < parsedExpires) {
                        this.adminToken = savedToken;
                        this.adminRole = savedRole;
                        this.adminSessionExpires = parsedExpires;
                        await this.checkAdminSession();
                    } else if (savedToken || savedExpires || savedRole) {
                        this.clearAdminSession();
                    }
                    
                    await this.loadData();
                    
                    // Cek versi aplikasi
                    await this.checkVersion();
                    
                    // Auto refresh data every 3 seconds
                    setInterval(async () => {
                        if (!this.isPageVisible) return;
                        await this.loadData();
                    }, 3000);
                    
                    // Update lock progress every second
                    setInterval(() => {
                        this.updateLockProgress();
                    }, 1000);
                    
                    // Cek admin session setiap menit
                    setInterval(() => {
                        if (this.isAdmin && this.isPageVisible) {
                            this.checkAdminSession();
                        }
                    }, 60000);
                    
                    // Cek versi aplikasi setiap 2 menit
                    setInterval(async () => {
                        if (!this.isPageVisible) return;
                        await this.checkVersion();
                    }, 120000);
                },

                getAdminHeaders(includeJson = false) {
                    const headers = {};
                    if (includeJson) headers['Content-Type'] = 'application/json';
                    if (this.adminToken) {
                        headers['x-admin-token'] = this.adminToken;
                    }
                    return headers;
                },

                clearAdminSession(showExpiredToast = false) {
                    this.isAdmin = false;
                    this.adminToken = null;
                    this.adminRole = null;
                    this.adminSessionExpires = null;

                    localStorage.removeItem('adminToken');
                    localStorage.removeItem('adminRole');
                    localStorage.removeItem('adminExpires');

                    if (showExpiredToast) {
                        this.showToast('Session admin telah kadaluarsa', 'warning');
                    }
                },

                async readJsonSafe(response) {
                    try {
                        return await response.json();
                    } catch (_) {
                        return null;
                    }
                },

                getApiErrorCode(result) {
                    return result?.error?.code || null;
                },

                getApiErrorMessage(result, fallback = 'Terjadi kesalahan pada server') {
                    if (result?.error?.message) return result.error.message;
                    if (typeof result?.error === 'string' && result.error.trim()) return result.error;
                    return fallback;
                },

                shouldClearSessionOnError(result) {
                    const code = this.getApiErrorCode(result);
                    return code === 'ADMIN_REQUIRED' || code === 'ADMIN_SESSION_EXPIRED';
                },

                getRequestFailureMessage(apiResult, fallback = 'Terjadi kesalahan pada server') {
                    if (apiResult?.status === 0) {
                        return 'Server tidak terjangkau. Periksa koneksi atau coba lagi.';
                    }
                    return this.getApiErrorMessage(apiResult?.data, fallback);
                },

                handleApiFailure(apiResult, fallback) {
                    if (this.shouldClearSessionOnError(apiResult?.data)) {
                        this.clearAdminSession(true);
                    }
                    this.showToast(this.getRequestFailureMessage(apiResult, fallback), 'error');
                },

                async apiRequest(url, options = {}) {
                    try {
                        const response = await fetch(url, options);
                        const data = await this.readJsonSafe(response);
                        return {
                            ok: response.ok,
                            status: response.status,
                            data
                        };
                    } catch (_) {
                        return {
                            ok: false,
                            status: 0,
                            data: null
                        };
                    }
                },
                
                // Load all data
                async loadData() {
                    if (this.isPollingData) return;
                    this.isPollingData = true;
                    try {
                        const headers = this.getAdminHeaders();
                        
                        const [statusResult, queueResult] = await Promise.all([
                            this.apiRequest('/status', { headers }),
                            this.apiRequest('/queue-info', { headers })
                        ]);
                        
                        this.isConnected = statusResult.ok;
                        
                        if (statusResult.ok) {
                            const statusData = statusResult.data || {};
                            this.currentSong = statusData.song || this.currentSong;
                            this.activeRequest = statusData.activeRequest || null;
                            const lockRemainingMs = Number(statusData.lockRemaining || 0);
                            this.lockRemaining = Math.round(lockRemainingMs / 1000);
                            this.lockInfo = statusData.lockInfo || this.lockInfo;
                            this.stats.totalSongs = statusData.stats.totalSongsPlayed || 0;
                            this.stats.totalTime = statusData.stats.totalPlayTime || 0;
                            this.queueLimit = statusData.queueLimit || 100;
                            this.randomQueueEnabled = Boolean(statusData.randomQueueEnabled);
                            this.randomQueue = statusData.randomQueue || this.randomQueue;
                        }
                        
                        if (queueResult.ok) {
                            const queueData = queueResult.data || {};
                            this.queue = Array.isArray(queueData.queue) ? queueData.queue : [];
                            this.stats.queueLength = queueData.queueLength || 0;
                            this.queueLimit = queueData.queueLimit || 100;
                            this.randomQueueEnabled = Boolean(queueData.randomQueueEnabled);
                            this.randomQueue = queueData.randomQueue || this.randomQueue;
                        }
                        
                    } catch (error) {
                        console.error('Error loading data:', error);
                        this.isConnected = false;
                    } finally {
                        this.isPollingData = false;
                    }
                },

                sanitizeInput(value) {
                    if (typeof value !== 'string') return '';
                    return value.trim().replace(/\s+/g, ' ').replace(/[<>{}]/g, '');
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
                
                // Format query tetap natural agar hasil pencarian lebih relevan
                prepareQuery(title, artist) {
                    return `${title.trim()} - ${artist.trim()}`;
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
                        const isPriorityRequest = this.isAdmin && this.priorityRequest;

                        // Gabungkan judul dan artis menjadi satu query
                        const combinedQuery = this.prepareQuery(this.newRequest.title, this.newRequest.artist);
                        
                        // Jika admin dan priority request, gunakan endpoint khusus
                        let endpoint = '/request-song';
                        let method = 'POST';
                        let bodyData = { query: combinedQuery };
                        let requestHeaders = this.getAdminHeaders(true);
                        
                        if (isPriorityRequest) {
                            endpoint = '/admin/request-first';
                        }
                        
                        const result = await this.apiRequest(endpoint, {
                            method: method,
                            headers: requestHeaders,
                            body: JSON.stringify(bodyData)
                        });
                        
                        if (result.ok) {
                            // Reset form
                            this.newRequest = {
                                title: '',
                                artist: ''
                            };
                            this.priorityRequest = false;
                            
                            await this.loadData();
                            
                            if (isPriorityRequest) {
                                this.showToast(`Ditambahkan sebagai PRIORITAS (Posisi: ${result.data?.queuePosition})`, 'success');
                            } else {
                                this.showToast(`Ditambahkan ke antrian (Posisi: ${result.data?.queuePosition})`, 'success');
                            }
                        } else {
                            this.handleApiFailure(result, 'Gagal menambahkan request');
                        }
                    } catch (error) {
                        this.showToast('Gagal menambahkan request', 'error');
                    } finally {
                        this.isLoading = false;
                    }
                },
                
                // Remove request (Hanya Super Admin)
                async removeRequest(id) {
                    if (!this.isAdmin || this.adminRole !== 'super') {
                        this.showToast('Hanya Super Admin yang bisa menghapus request', 'error');
                        return;
                    }
                    
                    if (!confirm('Hapus request ini dari antrian?')) return;
                    
                    try {
                        const result = await this.apiRequest(`/remove-request/${id}`, {
                            method: 'DELETE',
                            headers: this.getAdminHeaders()
                        });

                        if (result.ok) {
                            await this.loadData();
                            this.showToast(`Dihapus: ${result.data?.removed}`, 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal menghapus request');
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
                        const result = await this.apiRequest('/skip-current', {
                            method: 'POST',
                            headers: this.getAdminHeaders()
                        });

                        if (result.ok) {
                            await this.loadData();
                            this.showToast('Request berhasil diskip', 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal skip request');
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
                        const result = await this.apiRequest('/force-next', {
                            method: 'POST',
                            headers: this.getAdminHeaders()
                        });
                        
                        if (result.ok) {
                            await this.loadData();
                            this.showToast('Force skip berhasil', 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal force skip');
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
                        const result = await this.apiRequest('/clear-requests', {
                            method: 'DELETE',
                            headers: this.getAdminHeaders()
                        });

                        if (result.ok) {
                            await this.loadData();
                            this.showToast(`Dihapus ${result.data?.clearedCount} request`, 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal menghapus antrian');
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

                    if (this.randomQueueEnabled) {
                        this.showToast('Pindah posisi hanya tersedia saat mode acak dimatikan', 'warning');
                        return;
                    }
                    
                    const newPosition = currentIndex; // Pindah ke posisi sebelumnya
                    if (newPosition < 1) return;
                    
                    try {
                        const result = await this.apiRequest('/admin/move-request', {
                            method: 'POST',
                            headers: this.getAdminHeaders(true),
                            body: JSON.stringify({ 
                                requestId, 
                                newPosition 
                            })
                        });

                        if (result.ok) {
                            await this.loadData();
                            this.showToast(result.data?.message, 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal memindahkan request');
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

                    if (this.randomQueueEnabled) {
                        this.showToast('Pindah posisi hanya tersedia saat mode acak dimatikan', 'warning');
                        return;
                    }
                    
                    const newPosition = currentIndex + 2; // Pindah ke posisi berikutnya
                    if (newPosition > this.queue.length) return;
                    
                    try {
                        const result = await this.apiRequest('/admin/move-request', {
                            method: 'POST',
                            headers: this.getAdminHeaders(true),
                            body: JSON.stringify({ 
                                requestId, 
                                newPosition 
                            })
                        });

                        if (result.ok) {
                            await this.loadData();
                            this.showToast(result.data?.message, 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal memindahkan request');
                        }
                    } catch (error) {
                        this.showToast('Gagal memindahkan request', 'error');
                    }
                },

                async promoteRequestToPriority(requestId) {
                    if (!this.isAdmin) {
                        this.showToast('Hanya admin yang bisa mengubah request menjadi priority', 'error');
                        return;
                    }

                    try {
                        const result = await this.apiRequest(`/admin/request-priority/${requestId}`, {
                            method: 'POST',
                            headers: this.getAdminHeaders()
                        });

                        if (result.ok) {
                            await this.loadData();
                            this.showToast(result.data?.message || 'Request dijadikan priority', 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal mengubah request menjadi priority');
                        }
                    } catch (error) {
                        this.showToast('Gagal mengubah request menjadi priority', 'error');
                    }
                },

                async toggleRandomQueue() {
                    if (!this.isAdmin || this.adminRole !== 'super') {
                        this.showToast('Hanya Super Admin yang bisa mengubah mode antrian', 'error');
                        return;
                    }

                    const nextValue = !this.randomQueueEnabled;

                    try {
                        const result = await this.apiRequest('/admin/queue-random-mode', {
                            method: 'POST',
                            headers: this.getAdminHeaders(true),
                            body: JSON.stringify({
                                enabled: nextValue
                            })
                        });

                        if (result.ok) {
                            this.randomQueueEnabled = Boolean(result.data?.randomQueueEnabled);
                            this.randomQueue = result.data?.randomQueue || this.randomQueue;
                            await this.loadData();
                            this.showToast(result.data?.message || 'Mode antrian diperbarui', 'success');
                        } else {
                            this.handleApiFailure(result, 'Gagal mengubah mode antrian');
                        }
                    } catch (error) {
                        this.showToast('Gagal mengubah mode antrian', 'error');
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
                        const result = await this.apiRequest('/admin/login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ password: this.adminPassword })
                        });

                        if (result.ok) {
                            this.adminToken = result.data?.token;
                            this.adminRole = result.data?.role; // Simpan role
                            this.adminSessionExpires = result.data?.expiresAt;
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
                            this.handleApiFailure(result, 'Login gagal');
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
                            await this.apiRequest('/admin/logout', {
                                method: 'POST',
                                headers: this.getAdminHeaders()
                            });
                        }
                        
                        this.clearAdminSession();
                        
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
                        const result = await this.apiRequest('/admin/status', {
                            headers: this.getAdminHeaders()
                        });

                        if (!result.ok) {
                            if (this.shouldClearSessionOnError(result.data)) {
                                this.clearAdminSession(true);
                            }
                            return;
                        }

                        if (!result.data?.isAdmin) {
                            this.clearAdminSession(true);
                        } else {
                            this.isAdmin = true;
                            this.adminRole = result.data.role; // Update role
                            this.adminSessionExpires = result.data.expiresAt;
                            localStorage.setItem('adminToken', this.adminToken);
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
                        const result = await this.apiRequest('/version');
                        if (result.ok) {
                            const data = result.data || {};
                            const savedVersion = localStorage.getItem('appVersion');
                            
                            if (savedVersion && savedVersion !== data.version) {
                                localStorage.setItem('appVersion', data.version);
                                this.appVersion = data.version;
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
        
        document.addEventListener('DOMContentLoaded', async function() {
            try {
                const response = await fetch('/health');
                if (!response.ok) {
                    console.warn('Server health check failed');
                }
            } catch (_) {
                console.warn('Server is not reachable');
            }
        });
