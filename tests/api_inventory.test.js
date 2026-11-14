import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const inventory = JSON.parse(readFileSync(new URL('../docs/tradingview-api-method-inventory-2026-11-08.json', import.meta.url), 'utf8'));
const owners = ['chart', 'collection', 'api'];

test('API inventory contains exactly the three independently enumerated runtime roots', () => {
  assert.deepEqual(Object.keys(inventory.methods).sort(), owners.slice().sort());
  assert.deepEqual(owners.map(owner => inventory.methods[owner].length), [166, 184, 173]);
  assert.equal(owners.reduce((sum, owner) => sum + inventory.methods[owner].length, 0), 523);
});

test('every discovered method has one unique, evidence-labelled disposition', () => {
  for (const owner of owners) {
    const names = inventory.methods[owner];
    assert.equal(new Set(names).size, names.length, owner + ' duplicate names');
    assert.deepEqual(Object.keys(inventory.method_status[owner]).sort(), names.slice().sort());
    assert.deepEqual(Object.keys(inventory.method_metadata[owner]).sort(), names.slice().sort());
    for (const name of names) {
      const meta = inventory.method_metadata[owner][name];
      const status = inventory.method_status[owner][name];
      assert.ok(typeof status === 'string' && status.length > 0, owner + '.' + name);
      assert.equal(meta.verification, status, owner + '.' + name);
      assert.equal(meta.behavior_verified, status === 'invoked_successfully', owner + '.' + name);
      assert.ok(Number.isInteger(meta.arity) && meta.arity >= 0, owner + '.' + name);
      assert.ok(typeof meta.source_excerpt === 'string' && meta.source_excerpt.length > 0, owner + '.' + name);
      assert.ok(['private', 'public'].includes(meta.access), owner + '.' + name);
      assert.ok(['account_or_destructive', 'state_changing_or_event_subscription', 'internal_private', 'read_or_pure_candidate'].includes(meta.risk_screen), owner + '.' + name);
      assert.notEqual(status, 'present_not_behavior_tested', owner + '.' + name);
    }
  }
});

test('status totals reconcile with all 523 methods, without silently promoting failures', () => {
  const counts = {};
  for (const owner of owners) {
    for (const status of Object.values(inventory.method_status[owner])) {
      counts[status] = (counts[status] || 0) + 1;
    }
  }
  assert.deepEqual(counts, inventory.status_counts);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 523);
  assert.ok(counts.invoked_successfully < 523, 'never conflate mapped with certified');
  assert.equal(inventory.audit_scope.live_orders_performed, false);
  assert.equal(inventory.audit_scope.account_deletions_performed, false);
});
