import test from 'node:test';
import assert from 'node:assert/strict';
import { savedCost } from '../src/utils/costs.js';

test('savings subtract decimal costs exactly and identify positive savings', () => {
  assert.deepEqual(savedCost('200.000000000000', '50.000000000000'), { amount: '150.000000000000', positive: true });
  assert.deepEqual(savedCost('0.300000000000', '0.200000000000'), { amount: '0.100000000000', positive: true });
  assert.deepEqual(savedCost('100.000000000000', '120.000000000000'), { amount: '-20.000000000000', positive: false });
  assert.deepEqual(savedCost('0.000000000000', '0.000000000000'), { amount: '0.000000000000', positive: false });
  assert.deepEqual(savedCost('999999999999999999.000000000001', '999999999999999999.000000000000'), { amount: '0.000000000001', positive: true });
});
