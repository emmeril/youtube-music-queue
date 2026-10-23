'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

test('add song form only exists inside its modal', () => {
  const dashboardStart = html.indexOf('<!-- Main Dashboard -->');
  const queueStart = html.indexOf('<!-- Request Queue -->');
  const modalStart = html.indexOf('<!-- Add Song Modal -->');
  const nextModalStart = html.indexOf('<!-- Request Schedule Modal -->');

  assert.ok(dashboardStart >= 0);
  assert.ok(queueStart > dashboardStart);
  assert.ok(modalStart > queueStart);
  assert.ok(nextModalStart > modalStart);

  const dashboard = html.slice(dashboardStart, queueStart);
  const queue = html.slice(queueStart, modalStart);
  const modal = html.slice(modalStart, nextModalStart);

  assert.doesNotMatch(dashboard, /id="request-title"/);
  assert.match(queue, /@click="openAddRequestModal\(\)"/);
  assert.match(modal, /x-show="showAddRequestModal"/);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /<form @submit\.prevent="addRequest\(\)"/);
  assert.match(modal, /id="request-title"/);
  assert.match(modal, /id="request-artist"/);

  assert.equal((html.match(/id="request-title"/g) || []).length, 1);
  assert.equal((html.match(/id="request-artist"/g) || []).length, 1);
});
