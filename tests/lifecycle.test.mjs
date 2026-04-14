import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerCleanup, runCleanup, clearCleanup } from '../js/lifecycle.js';

test('registerCleanup + runCleanup: runs registered function', () => {
  let called = false;
  registerCleanup('test-a', () => { called = true; });
  runCleanup('test-a');
  assert.ok(called, 'cleanup function should have been called');
});

test('registerCleanup: multiple functions run in order', () => {
  const order = [];
  registerCleanup('test-b', () => order.push(1));
  registerCleanup('test-b', () => order.push(2));
  registerCleanup('test-b', () => order.push(3));
  runCleanup('test-b');
  assert.deepEqual(order, [1, 2, 3]);
});

test('runCleanup: second call is a no-op (cleanups deleted after run)', () => {
  let count = 0;
  registerCleanup('test-c', () => count++);
  runCleanup('test-c');
  runCleanup('test-c');
  assert.equal(count, 1, 'cleanup should only run once');
});

test('runCleanup: error in one cleanup does not prevent others', () => {
  const results = [];
  registerCleanup('test-d', () => results.push('first'));
  registerCleanup('test-d', () => { throw new Error('boom'); });
  registerCleanup('test-d', () => results.push('third'));
  runCleanup('test-d');
  assert.deepEqual(results, ['first', 'third']);
});

test('runCleanup: unknown screenId is a no-op', () => {
  assert.doesNotThrow(() => runCleanup('nonexistent-screen'));
});

test('clearCleanup: removes cleanups without running them', () => {
  let called = false;
  registerCleanup('test-e', () => { called = true; });
  clearCleanup('test-e');
  runCleanup('test-e');
  assert.ok(!called, 'cleanup should not have been called after clearCleanup');
});

test('registerCleanup: ignores non-function argument', () => {
  assert.doesNotThrow(() => registerCleanup('test-f', null));
  assert.doesNotThrow(() => registerCleanup('test-f', 'string'));
  assert.doesNotThrow(() => registerCleanup('test-f', 42));
  // Should not crash when running empty list
  runCleanup('test-f');
});

test('registerCleanup: works with multiple screens independently', () => {
  const results = { main: false, spots: false };
  registerCleanup('main-test', () => { results.main = true; });
  registerCleanup('spots-test', () => { results.spots = true; });
  runCleanup('main-test');
  assert.ok(results.main, 'main cleanup should have run');
  assert.ok(!results.spots, 'spots cleanup should not have run');
  runCleanup('spots-test');
  assert.ok(results.spots, 'spots cleanup should have run after its own runCleanup');
});
