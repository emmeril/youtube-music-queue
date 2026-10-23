'use strict';

const elements = {
  bridgeContent: document.getElementById('bridge-content'),
  unsupportedState: document.getElementById('unsupported-state'),
  connectionStatus: document.getElementById('connection-status'),
  connectionLabel: document.getElementById('connection-label'),
  activityStatus: document.getElementById('activity-status'),
  songTitle: document.getElementById('song-title'),
  songArtist: document.getElementById('song-artist'),
  songDuration: document.getElementById('song-duration'),
  serverUrl: document.getElementById('server-url'),
  adminSecret: document.getElementById('admin-secret'),
  adminSecretState: document.getElementById('admin-secret-state'),
  durationMin: document.getElementById('duration-min'),
  durationMax: document.getElementById('duration-max'),
  lastUpdate: document.getElementById('last-update'),
  extensionVersion: document.getElementById('extension-version')
};

let activeTabId = null;
let pollIntervalId = null;
let actionInFlight = false;

function isYouTubeMusicUrl(url) {
  return typeof url === 'string' && url.startsWith('https://music.youtube.com/');
}

function formatDuration(durationMs) {
  const secondsTotal = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  const hours = Math.floor(secondsTotal / 3600);
  const minutes = Math.floor((secondsTotal % 3600) / 60);
  const seconds = secondsTotal % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatUpdateTime(timestamp) {
  if (!timestamp) return '–';
  return new Date(timestamp).toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function setConnection(status, label) {
  elements.connectionStatus.classList.remove('is-online', 'is-offline');
  if (status) elements.connectionStatus.classList.add(status);
  elements.connectionLabel.textContent = label;
}

function setActivity(message, isError = false) {
  elements.activityStatus.textContent = message;
  elements.activityStatus.classList.toggle('is-error', isError);
}

function setInputUnlessFocused(input, value) {
  if (document.activeElement !== input) input.value = value;
}

function renderBridgeState(data) {
  elements.bridgeContent.hidden = false;
  elements.unsupportedState.hidden = true;
  setConnection('is-online', data.isProcessingRequest ? 'Bridge memproses request' : 'Bridge terhubung');

  elements.songTitle.textContent = data.currentSong?.title || 'Belum ada lagu';
  elements.songArtist.textContent = data.currentSong?.artist || 'Tidak diketahui';
  elements.songDuration.textContent = formatDuration(data.currentSong?.duration);
  setActivity(data.status?.message || 'Aktif', Boolean(data.status?.isError));
  elements.lastUpdate.textContent = formatUpdateTime(data.status?.updatedAt || data.currentSong?.timestamp);

  setInputUnlessFocused(elements.serverUrl, data.serverUrl || '');
  setInputUnlessFocused(elements.durationMin, String(data.durationSettings?.minSeconds || ''));
  setInputUnlessFocused(elements.durationMax, String(data.durationSettings?.maxSeconds || ''));

  elements.adminSecretState.textContent = data.hasAdminSecret
    ? 'Password tersimpan pada tab YouTube Music ini.'
    : 'Password belum disimpan.';
  elements.adminSecret.placeholder = data.hasAdminSecret ? 'Password tersimpan' : 'Belum disimpan';
}

function showUnsupported(message = 'Buka tab YouTube Music untuk menjalankan bridge.') {
  elements.bridgeContent.hidden = true;
  elements.unsupportedState.hidden = false;
  setConnection('is-offline', message);
  document.getElementById('refresh-page').disabled = !activeTabId;
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0] || null));
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    if (!activeTabId) {
      reject(new Error('Tab YouTube Music tidak ditemukan'));
      return;
    }

    chrome.tabs.sendMessage(
      activeTabId,
      { source: 'ytm-bridge-popup', ...message },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error('Bridge belum siap. Muat ulang tab YouTube Music.'));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || 'Aksi bridge gagal'));
          return;
        }
        resolve(response.data);
      }
    );
  });
}

async function refreshState() {
  if (actionInFlight) return;
  try {
    renderBridgeState(await sendMessage({ action: 'get-state' }));
  } catch (error) {
    showUnsupported(error.message);
  }
}

async function runAction(button, action, payload = {}) {
  if (actionInFlight) return;
  actionInFlight = true;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Memproses…';

  try {
    const data = await sendMessage({ action, ...payload });
    renderBridgeState(data);
    if (action === 'save-admin' || action === 'reset-admin') elements.adminSecret.value = '';
  } catch (error) {
    setActivity(error.message, true);
  } finally {
    actionInFlight = false;
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function bindAction(id, action, getPayload = () => ({})) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => runAction(button, action, getPayload()));
}

async function initializePopup() {
  elements.extensionVersion.textContent = `Versi ${chrome.runtime.getManifest().version}`;
  const activeTab = await queryActiveTab();

  if (!activeTab || !isYouTubeMusicUrl(activeTab.url)) {
    showUnsupported();
    return;
  }

  activeTabId = activeTab.id;
  await refreshState();
  pollIntervalId = window.setInterval(refreshState, 1000);
}

bindAction('skip-song', 'skip-song');
bindAction('check-request', 'check-request');
bindAction('refresh-page', 'refresh-page');
bindAction('save-server', 'save-server', () => ({ value: elements.serverUrl.value }));
bindAction('detect-server', 'detect-server');
bindAction('reset-server', 'reset-server');
bindAction('save-admin', 'save-admin', () => ({ value: elements.adminSecret.value }));
bindAction('reset-admin', 'reset-admin');
bindAction('save-duration', 'save-duration', () => ({
  minSeconds: elements.durationMin.value,
  maxSeconds: elements.durationMax.value
}));
bindAction('reset-duration', 'reset-duration');

document.getElementById('open-youtube-music').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://music.youtube.com/' });
  window.close();
});

window.addEventListener('unload', () => {
  if (pollIntervalId) window.clearInterval(pollIntervalId);
});

initializePopup().catch((error) => showUnsupported(error.message));
