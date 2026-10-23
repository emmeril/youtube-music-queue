'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appsSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'apps.js'),
  'utf8'
);

function loadApp() {
  let sequence = 0;
  const timers = new Map();
  const clearedTimers = [];
  const context = {
    document: { addEventListener() {} },
    console,
    setInterval() {},
    setTimeout(callback) {
      const id = ++sequence;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      timers.delete(id);
    }
  };
  vm.runInNewContext(`${appsSource}\nglobalThis.createApp = app;`, context);
  return { state: context.createApp(), timers, clearedTimers };
}

test('a newer toast cancels the previous dismissal timer', () => {
  const { state, timers, clearedTimers } = loadApp();

  state.showToast('Pertama');
  const firstTimer = state.toastTimeoutId;
  state.showToast('Kedua');
  const secondTimer = state.toastTimeoutId;

  assert.deepEqual(clearedTimers, [firstTimer]);
  assert.equal(state.toast.message, 'Kedua');
  assert.equal(timers.has(firstTimer), false);

  timers.get(secondTimer)();
  assert.equal(state.toast.show, false);
  assert.equal(state.toastTimeoutId, null);
});

test('add song modal moves focus in and returns it to the trigger', () => {
  const { state } = loadApp();
  let titleFocusCount = 0;
  let triggerFocusCount = 0;

  state.$nextTick = (callback) => callback();
  state.$refs = {
    addRequestTitleInput: {
      disabled: false,
      focus() { titleFocusCount += 1; }
    },
    addRequestTrigger: {
      focus() { triggerFocusCount += 1; }
    }
  };

  state.openAddRequestModal();
  assert.equal(state.showAddRequestModal, true);
  assert.equal(titleFocusCount, 1);

  state.closeAddRequestModal();
  assert.equal(state.showAddRequestModal, false);
  assert.equal(triggerFocusCount, 1);
});
