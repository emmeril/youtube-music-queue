'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getRequestScheduleStatus,
  normalizeRequestSchedule,
  resolveTimeZone,
  validateRequestSchedule
} = require('../request-schedule');

const timeZone = 'Asia/Jakarta';

function statusAt(schedule, isoTime) {
  return getRequestScheduleStatus(schedule, {
    timeZone,
    now: new Date(isoTime)
  });
}

test('disabled schedule keeps regular requests open', () => {
  const status = statusAt(
    { enabled: false, startTime: '09:00', endTime: '17:00' },
    '2026-10-01T00:00:00.000Z'
  );

  assert.equal(status.isOpen, true);
  assert.equal(status.nextOpenTime, null);
});

test('daily schedule opens at start and closes at end', () => {
  const schedule = { enabled: true, startTime: '09:00', endTime: '17:00' };

  assert.equal(statusAt(schedule, '2026-10-01T01:59:00.000Z').isOpen, false);
  assert.equal(statusAt(schedule, '2026-10-01T02:00:00.000Z').isOpen, true);
  assert.equal(statusAt(schedule, '2026-10-01T09:59:00.000Z').isOpen, true);
  assert.equal(statusAt(schedule, '2026-10-01T10:00:00.000Z').isOpen, false);
});

test('overnight schedule remains open across midnight', () => {
  const schedule = { enabled: true, startTime: '20:00', endTime: '02:00' };

  assert.equal(statusAt(schedule, '2026-10-01T14:00:00.000Z').isOpen, true);
  assert.equal(statusAt(schedule, '2026-10-01T18:00:00.000Z').isOpen, true);
  assert.equal(statusAt(schedule, '2026-09-30T19:00:00.000Z').isOpen, false);
  assert.equal(statusAt(schedule, '2026-09-30T19:00:00.000Z').nextOpenTime, '20:00');
});

test('schedule validation rejects invalid or equal times', () => {
  assert.equal(validateRequestSchedule({ startTime: '24:00', endTime: '17:00' }).ok, false);
  assert.equal(validateRequestSchedule({ startTime: '09:00', endTime: '09:00' }).ok, false);
  assert.equal(validateRequestSchedule({ startTime: '09:00', endTime: '17:00' }).ok, true);
});

test('stored schedule values are normalized safely', () => {
  assert.deepEqual(
    normalizeRequestSchedule({ enabled: 'true', startTime: '08:30', endTime: '23:15' }),
    { enabled: true, startTime: '08:30', endTime: '23:15' }
  );
  assert.deepEqual(
    normalizeRequestSchedule({ enabled: true, startTime: '99:00', endTime: null }),
    { enabled: true, startTime: '09:00', endTime: '22:00' }
  );
});

test('invalid timezone falls back to Asia/Jakarta', () => {
  assert.equal(resolveTimeZone('Not/A_Timezone'), 'Asia/Jakarta');
  assert.equal(resolveTimeZone('UTC'), 'UTC');
});
