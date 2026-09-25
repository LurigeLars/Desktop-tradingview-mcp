import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionReclaimable } from '../src/server/http.js';

test('session pressure reclaim never evicts an in-flight request', () => {
  const now = 100_000;

  assert.equal(
    isSessionReclaimable({ lastSeen: 0, activeRequests: 1 }, now, 30_000),
    false
  );
  assert.equal(
    isSessionReclaimable({ lastSeen: 0, activeRequests: 0 }, now, 30_000),
    true
  );
  assert.equal(
    isSessionReclaimable({ lastSeen: 90_000, activeRequests: 0 }, now, 30_000),
    false
  );
});
