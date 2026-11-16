import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../src/services/routing.js';

const activeKey = { status: 'ACTIVE', user_status: 'ACTIVE' };

test('future and unset proxy key expiries remain authorized with mysql2 result types', () => {
  for (const expired of ['0', 0, null]) {
    assert.doesNotThrow(() => authorize({ ...activeKey, expired }));
  }
});

test('expired proxy keys are rejected with numeric and string comparison results', () => {
  for (const expired of ['1', 1]) {
    assert.throws(() => authorize({ ...activeKey, expired }), {
      status: 401, code: 'expired_api_key'
    });
  }
});
