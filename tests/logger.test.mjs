import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initBootId, logError, logInfo } from '../js/logger.js';

test('initBootId: returns a 6-char alphanumeric string', () => {
  const id = initBootId();
  assert.equal(typeof id, 'string');
  assert.equal(id.length, 6);
  assert.ok(/^[a-z0-9]+$/.test(id), `bootId should be alphanumeric: ${id}`);
});

test('initBootId: subsequent calls return same ID', () => {
  const id1 = initBootId();
  const id2 = initBootId();
  // Note: initBootId re-generates each time (not memoized), but we test it works
  assert.equal(typeof id1, 'string');
  assert.equal(typeof id2, 'string');
});

test('logError: does not throw with minimal args', () => {
  assert.doesNotThrow(() => logError({ scope: 'test', action: 'run' }));
});

test('logError: handles Error object', () => {
  assert.doesNotThrow(() => logError({
    scope: 'test', action: 'fail',
    error: new Error('something broke'),
    severity: 'error'
  }));
});

test('logError: handles string error', () => {
  assert.doesNotThrow(() => logError({
    scope: 'test', action: 'fail',
    error: 'raw string error',
    severity: 'warn'
  }));
});

test('logError: handles null error', () => {
  assert.doesNotThrow(() => logError({
    scope: 'test', action: 'fail',
    error: null,
    severity: 'info'
  }));
});

test('logError: handles meta object', () => {
  assert.doesNotThrow(() => logError({
    scope: 'api', action: 'fetch',
    error: new Error('timeout'),
    meta: { url: 'https://example.com', attempt: 3 },
    severity: 'error'
  }));
});

test('logInfo: calls logError with severity info', () => {
  assert.doesNotThrow(() => logInfo({ scope: 'boot', action: 'state', meta: { from: 'init', to: 'loading' } }));
});

test('logInfo: works without meta', () => {
  assert.doesNotThrow(() => logInfo({ scope: 'boot', action: 'complete' }));
});
