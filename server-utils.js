'use strict';

const crypto = require('crypto');

function normalizePassword(value) {
  return typeof value === 'string' ? value : '';
}

function isBlankPassword(value) {
  return normalizePassword(value).trim().length === 0;
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function timingSafeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function calculateMatchConfidence(requestQuery, songTitle, songArtist) {
  const lowerQuery = typeof requestQuery === 'string' ? requestQuery.toLowerCase() : '';
  const lowerTitle = typeof songTitle === 'string' ? songTitle.toLowerCase() : '';
  const lowerArtist = typeof songArtist === 'string' ? songArtist.toLowerCase() : '';
  if (!lowerQuery || (!lowerTitle && !lowerArtist)) return 0;

  if (lowerTitle === lowerQuery) return 100;
  if (lowerTitle && (lowerTitle.includes(lowerQuery) || lowerQuery.includes(lowerTitle))) return 85;
  if (lowerArtist && (lowerArtist.includes(lowerQuery) || lowerQuery.includes(lowerArtist))) return 75;

  const requestWords = lowerQuery.split(' ').filter(Boolean);
  if (requestWords.length === 0) return 0;
  const titleWords = lowerTitle.split(' ').filter(Boolean);
  const artistWords = lowerArtist.split(' ').filter(Boolean);
  const matchingWords = requestWords.filter((word) =>
    titleWords.some((titleWord) => titleWord.includes(word)) ||
    artistWords.some((artistWord) => artistWord.includes(word))
  );
  return Math.round((matchingWords.length / requestWords.length) * 100);
}

module.exports = {
  calculateMatchConfidence,
  generateSessionToken,
  isBlankPassword,
  normalizePassword,
  timingSafeStringEqual
};
