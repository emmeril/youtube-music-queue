'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ADMIN_PRIORITY_LIMIT, getPriorityStatus } = require('../priority-policy');

function queueWithPriorityCount(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `priority-${index + 1}`,
    isPriority: true
  }));
}

test('admin can add priority songs below the limit', () => {
  const status = getPriorityStatus('admin', queueWithPriorityCount(ADMIN_PRIORITY_LIMIT - 1));

  assert.equal(status.allowed, true);
  assert.equal(status.priorityCount, 2);
  assert.equal(status.limit, ADMIN_PRIORITY_LIMIT);
});

test('admin cannot add more than three queued priority songs', () => {
  const queue = [
    ...queueWithPriorityCount(ADMIN_PRIORITY_LIMIT),
    { id: 'regular-1', isPriority: false }
  ];
  const status = getPriorityStatus('admin', queue);

  assert.equal(status.allowed, false);
  assert.equal(status.priorityCount, ADMIN_PRIORITY_LIMIT);
  assert.equal(status.limit, ADMIN_PRIORITY_LIMIT);
});

test('super admin has no priority limit', () => {
  const status = getPriorityStatus('super', queueWithPriorityCount(10));

  assert.equal(status.allowed, true);
  assert.equal(status.priorityCount, 10);
  assert.equal(status.limit, null);
});
