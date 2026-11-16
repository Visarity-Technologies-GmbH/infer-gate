import test from 'node:test';
import assert from 'node:assert/strict';
import { filters } from '../src/routes/reports.js';

test('no group selection leaves all users included', () => {
  const result = filters({}, 'e', 'timestamp');
  assert.equal(result.params.length, 2);
  assert(!result.where.includes('user_groups'));
});

test('multiple groups match any membership without multiplying usage rows', () => {
  for (const [alias, column] of [['e', 'timestamp'], ['r', 'started_at']]) {
    const result = filters({ group_id: ['7', '9', '7'], model: 'model-a' }, alias, column);
    assert(result.where.includes(`EXISTS (SELECT 1 FROM user_groups g WHERE g.user_id=${alias}.user_id AND g.group_id IN (?,?))`));
    assert.deepEqual(result.params.slice(2), ['model-a', '7', '9']);
    assert(!result.where.includes('JOIN'));
  }
});

test('legacy single-group requests remain supported', () => {
  const result = filters({ group_id: '9007199254740993' }, 'r', 'started_at');
  assert.deepEqual(result.params.slice(2), ['9007199254740993']);
});

test('invalid group selections are rejected before querying', () => {
  for (const group_id of ['', '0', '1 OR 1=1', ['1', 'bad'], [], {}, ['1', {}], Array(501).fill('1')]) {
    assert.throws(() => filters({ group_id }, 'e', 'timestamp'), { code: 'invalid_filter' });
  }
});

test('multiple users match any selected identity and combine with other filters', () => {
  for (const [alias, column] of [['e', 'timestamp'], ['r', 'started_at']]) {
    const result = filters({ user_id: ['7', '9', '7'], group_id: ['3', '4'], request_status: 'SUCCESS' }, alias, column);
    assert(result.where.includes(`${alias}.user_id IN (?,?)`));
    assert(result.where.includes(`AND ${alias}.request_status=? AND EXISTS`));
    assert(result.where.includes(`g.user_id=${alias}.user_id AND g.group_id IN (?,?)`));
    assert.deepEqual(result.params.slice(2), ['7', '9', 'SUCCESS', '3', '4']);
  }
});

test('no users selected includes everyone and a legacy single user is supported', () => {
  assert(!filters({}, 'e', 'timestamp').where.includes('user_id'));
  const result = filters({ user_id: '9007199254740993' }, 'e', 'timestamp');
  assert(result.where.includes('e.user_id IN (?)'));
  assert.deepEqual(result.params.slice(2), ['9007199254740993']);
  const maximum = filters({ user_id: Array.from({ length: 500 }, (_, index) => String(index + 1)) }, 'r', 'started_at');
  assert.equal(maximum.params.length, 502);
});

test('invalid user selections are rejected before querying', () => {
  for (const user_id of ['', '0', '-1', '1 OR 1=1', ['1', 'bad'], [], {}, ['1', {}], Array(501).fill('1')]) {
    assert.throws(() => filters({ user_id }, 'e', 'timestamp'), { code: 'invalid_filter' });
  }
});
