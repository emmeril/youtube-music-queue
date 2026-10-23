'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionDir = path.join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const popupHtml = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');

test('Chrome action opens the bridge toolbar popup', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.action.default_title, 'YT Music Bridge');
  assert.match(popupHtml, /<script src="popup\.js"><\/script>/);
  assert.match(popupHtml, /<link rel="stylesheet" href="popup\.css">/);
});

test('content script exposes popup messaging without mounting the page panel', () => {
  const initializeStart = contentSource.indexOf('function initialize()');
  const initializeSource = contentSource.slice(initializeStart);

  assert.match(contentSource, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(contentSource, /message\?\.source !== 'ytm-bridge-popup'/);
  assert.doesNotMatch(contentSource, /ytm-debug-panel/);
  assert.doesNotMatch(contentSource, /position:\s*fixed/);
  assert.doesNotMatch(initializeSource, /DebugPanel\.create\(\)/);
});
