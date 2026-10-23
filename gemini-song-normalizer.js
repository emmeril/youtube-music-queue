'use strict';

const {
  DEFAULT_FAIR_RANDOM_PROFILE,
  buildGeminiFairRandomProfile
} = require('./fair-random');

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 4;
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

function cleanText(value, maxLength = 100) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[<>\u0000-\u001f]/g, '')
    .slice(0, maxLength);
}

function buildFallback(title, artist, reason = 'Gemini tidak dikonfigurasi') {
  return {
    title: cleanText(title),
    artist: cleanText(artist),
    usedGemini: false,
    changed: false,
    fairRandom: { ...DEFAULT_FAIR_RANDOM_PROFILE },
    reason
  };
}

function parseGeminiJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      const parsed = JSON.parse(objectMatch[0]);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }
}

function extractResponseText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim() || '';
}

function isUsableResult(result) {
  if (!result || typeof result !== 'object') return false;
  const title = cleanText(result.title);
  const artist = cleanText(result.artist);
  if (title.length < 2 || artist.length < 2) return false;
  if (title.toLowerCase() === artist.toLowerCase()) return false;
  const confidence = Number(result.confidence);
  return Number.isFinite(confidence) && confidence >= 0.7 && confidence <= 1;
}

function parseRetryAfterMs(response, now = Date.now()) {
  try {
    const retryAfter = response?.headers?.get?.('retry-after');
    if (!retryAfter) return 0;

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }

    const retryAt = Date.parse(retryAfter);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
  } catch (_) {
    return 0;
  }
}

function getRetryDelayMs(response, retryIndex, randomImpl = Math.random, now = Date.now()) {
  const exponentialDelay = Math.min(8000, 1000 * (2 ** retryIndex));
  const randomValue = Number(randomImpl());
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(0.999999, randomValue))
    : 0;
  const jitter = Math.round(exponentialDelay * 0.5 * normalizedRandom);
  return Math.max(exponentialDelay + jitter, parseRetryAfterMs(response, now));
}

function waitForRetryDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('request aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      clearTimeout(timer);
      const error = new Error('request aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener?.('abort', handleAbort, { once: true });
  });
}

/**
 * Normalize a user-provided song pair. Gemini is optional: without a key or
 * when the API is unavailable, the original input is returned unchanged.
 */
async function normalizeSongWithGemini({
  title,
  artist,
  apiKey,
  model,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  sleepImpl = waitForRetryDelay,
  randomImpl = Math.random,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  nowImpl = Date.now
}) {
  const fallback = buildFallback(title, artist);
  const normalizedApiKey = cleanText(apiKey, 300);
  if (!normalizedApiKey || typeof fetchImpl !== 'function') return fallback;

  const inputTitle = cleanText(title);
  const inputArtist = cleanText(artist);
  if (inputTitle.length < 2 || inputArtist.length < 2) {
    return buildFallback(inputTitle, inputArtist, 'Input lagu belum lengkap');
  }

  const selectedModel = cleanText(model || DEFAULT_MODEL, 100) || DEFAULT_MODEL;
  const requestTimeout = Math.max(1000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 15000));
  const attemptLimit = Math.max(1, Math.min(Number.parseInt(maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS, 6));
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(normalizedApiKey)}`;
  const prompt = [
    'Anda adalah normalizer metadata musik.',
    'Periksa pasangan judul lagu dan nama artis berikut. Kembalikan JSON saja.',
    'Pertahankan input jika sudah benar; boleh memperbaiki kapitalisasi, typo kecil, urutan, atau mengambil nama resmi yang sangat yakin.',
    'Jangan mengarang lagu/artis. Jika ragu, gunakan nilai input apa adanya.',
    'Isi confidence dengan angka 0 sampai 1 berdasarkan keyakinan Anda.',
    'Klasifikasikan lagu ke tepat satu fairRandomCategory dan tentukan sendiri fairRandomWeight berupa bilangan bulat.',
    'Gunakan rentang: dangdut_koplo 76-100, indonesia 51-75, western 26-50, korean_kpop 1-25.',
    'Dangdut atau koplo selalu masuk dangdut_koplo. Lagu Indonesia selain dangdut masuk indonesia. Lagu Korea atau K-pop masuk korean_kpop. Lagu asing lainnya masuk western.',
    'Pilih angka di dalam rentang berdasarkan seberapa kuat lagu cocok dengan kategorinya; jangan selalu memakai nilai tengah.',
    `Judul input: ${JSON.stringify(inputTitle)}`,
    `Artis input: ${JSON.stringify(inputArtist)}`
  ].join('\n');

  const controller = new AbortController();
  const deadline = nowImpl() + requestTimeout;
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  try {
    for (let attempt = 0; attempt < attemptLimit; attempt++) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                artist: { type: 'STRING' },
                confidence: { type: 'NUMBER' },
                fairRandomCategory: {
                  type: 'STRING',
                  enum: ['dangdut_koplo', 'indonesia', 'western', 'korean_kpop']
                },
                fairRandomWeight: { type: 'INTEGER' }
              },
              required: ['title', 'artist', 'confidence', 'fairRandomCategory', 'fairRandomWeight']
            }
          }
        })
      });

      if (!response.ok) {
        const canRetry = RETRYABLE_STATUS_CODES.has(response.status) && attempt + 1 < attemptLimit;
        if (!canRetry) {
          const attemptSuffix = attempt > 0 ? ` setelah ${attempt + 1} percobaan` : '';
          return buildFallback(inputTitle, inputArtist, `Gemini HTTP ${response.status}${attemptSuffix}`);
        }

        const retryDelay = getRetryDelayMs(response, attempt, randomImpl, nowImpl());
        if (nowImpl() + retryDelay >= deadline) {
          return buildFallback(inputTitle, inputArtist, 'Gemini timeout');
        }
        await sleepImpl(retryDelay, controller.signal);
        continue;
      }

      const payload = await response.json();
      const parsed = parseGeminiJson(extractResponseText(payload));
      if (!isUsableResult(parsed)) return buildFallback(inputTitle, inputArtist, 'Respons Gemini tidak valid');

      const resultTitle = cleanText(parsed.title);
      const resultArtist = cleanText(parsed.artist);
      const fairRandom = buildGeminiFairRandomProfile(parsed.fairRandomCategory, parsed.fairRandomWeight);
      return {
        title: resultTitle,
        artist: resultArtist,
        usedGemini: true,
        changed: resultTitle !== inputTitle || resultArtist !== inputArtist,
        confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
        fairRandom,
        reason: 'Gemini berhasil menormalisasi metadata'
      };
    }

    return buildFallback(inputTitle, inputArtist, 'Gemini tidak dapat dihubungi');
  } catch (error) {
    return buildFallback(inputTitle, inputArtist, error?.name === 'AbortError' ? 'Gemini timeout' : 'Gemini tidak dapat dihubungi');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MODEL,
  normalizeSongWithGemini,
  parseGeminiJson,
  cleanText
};
