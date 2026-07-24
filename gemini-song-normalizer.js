'use strict';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 5000;

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

/**
 * Normalize a user-provided song pair. Gemini is optional: without a key or
 * when the API is unavailable, the original input is returned unchanged.
 */
async function normalizeSongWithGemini({ title, artist, apiKey, model, timeoutMs, fetchImpl = globalThis.fetch }) {
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
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent?key=${encodeURIComponent(normalizedApiKey)}`;
  const prompt = [
    'Anda adalah normalizer metadata musik.',
    'Periksa pasangan judul lagu dan nama artis berikut. Kembalikan JSON saja.',
    'Pertahankan input jika sudah benar; boleh memperbaiki kapitalisasi, typo kecil, urutan, atau mengambil nama resmi yang sangat yakin.',
    'Jangan mengarang lagu/artis. Jika ragu, gunakan nilai input apa adanya.',
    'Isi confidence dengan angka 0 sampai 1 berdasarkan keyakinan Anda.',
    `Judul input: ${JSON.stringify(inputTitle)}`,
    `Artis input: ${JSON.stringify(inputArtist)}`
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  try {
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
              confidence: { type: 'NUMBER' }
            },
            required: ['title', 'artist', 'confidence']
          }
        }
      })
    });

    if (!response.ok) return buildFallback(inputTitle, inputArtist, `Gemini HTTP ${response.status}`);
    const payload = await response.json();
    const parsed = parseGeminiJson(extractResponseText(payload));
    if (!isUsableResult(parsed)) return buildFallback(inputTitle, inputArtist, 'Respons Gemini tidak valid');

    const resultTitle = cleanText(parsed.title);
    const resultArtist = cleanText(parsed.artist);
    return {
      title: resultTitle,
      artist: resultArtist,
      usedGemini: true,
      changed: resultTitle !== inputTitle || resultArtist !== inputArtist,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
      reason: 'Gemini berhasil menormalisasi metadata'
    };
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
