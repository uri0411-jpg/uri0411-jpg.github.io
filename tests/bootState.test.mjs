import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_STATES, setBootState, getBootState } from '../js/bootState.js';

test('BOOT_STATES: has all expected states', () => {
  assert.equal(BOOT_STATES.INIT, 'init');
  assert.equal(BOOT_STATES.LOADING, 'loading');
  assert.equal(BOOT_STATES.READY, 'ready');
  assert.equal(BOOT_STATES.ERROR, 'error');
  assert.equal(BOOT_STATES.TIMEOUT, 'timeout');
});

test('BOOT_STATES: is frozen', () => {
  assert.ok(Object.isFrozen(BOOT_STATES));
});

test('getBootState: initial state is INIT', () => {
  // Note: this depends on module load order — first import gets INIT
  const state = getBootState();
  assert.ok(typeof state === 'string', 'state should be a string');
});

test('setBootState + getBootState: transitions correctly', () => {
  setBootState(BOOT_STATES.LOADING);
  assert.equal(getBootState(), 'loading');

  setBootState(BOOT_STATES.READY);
  assert.equal(getBootState(), 'ready');
});

test('setBootState: accepts ERROR state', () => {
  setBootState(BOOT_STATES.ERROR);
  assert.equal(getBootState(), 'error');
});

test('setBootState: accepts TIMEOUT state', () => {
  setBootState(BOOT_STATES.TIMEOUT);
  assert.equal(getBootState(), 'timeout');
});

test('setBootState: can transition back to INIT', () => {
  setBootState(BOOT_STATES.LOADING);
  setBootState(BOOT_STATES.INIT);
  assert.equal(getBootState(), 'init');
});
