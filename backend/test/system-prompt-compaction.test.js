import assert from 'node:assert/strict';
import test from 'node:test';
import { compactSystemBody, compactText, compactionOptions, validateCompaction } from '../src/services/system-prompt-compaction.js';

const all = Object.fromEntries(compactionOptions.map(key => [key, true]));
test('compacts prose and fenced JSON while preserving literal tokens', () => {
  const source = 'A  <!-- note -->  B\n\n\n-   item\n\n`a  b`\n```json\n{ "id": 999999999999999999, "id": "a  b" }\n```';
  const expected = 'A B\n\n- item\n\n`a  b`\n```json\n{"id":999999999999999999,"id":"a  b"}\n```';
  assert.equal(compactText(source, all), expected);
  assert.equal(compactText(expected, all), expected);
  for (const literal of ['```js\n<!-- keep -->  x\n```', '```json\n{ bad  json }\n```', '<!-- only -->', '    literal  text', 'a  | b  |', 'A  \nB'])
    assert.equal(compactText(literal, all), literal);
  assert.equal(compactText('  -  one\n  -  two', { compactLists: true }), '- one\n- two');
  assert.equal(compactText('- one\n  - two', all), '- one\n  - two');
});
test('visits only protocol-specific system text', () => {
  const original = 'A  B', compact = 'A B';
  const system = { role: 'system', content: original };
  const conversation = ['developer', 'user', 'assistant', 'tool'].map(role => ({ role, content: original }));
  function run(protocol, input) {
    return JSON.parse(compactSystemBody(Buffer.from(JSON.stringify(input)), protocol, { cleanWhitespace: true }));
  }
  assert.deepEqual(run('OPENAI', { messages: [system, ...conversation] }).messages,
    [{ ...system, content: compact }, ...conversation]);
  const tool = { type: 'function_call', ...system };
  const part = { type: 'input_text', text: original };
  const msg = { ...system, content: [part] };
  assert.deepEqual(run('OPENAI_RESPONSES', { instructions: original, input: [msg, tool, ...conversation] }),
    { instructions: compact, input: [{ ...msg, content: [{ ...part, text: compact }] }, tool, ...conversation] });
  const block = { type: 'text', text: original, cache_control: { type: 'ephemeral' } };
  assert.deepEqual(run('ANTHROPIC', { system: [block], messages: conversation }),
    { system: [{ ...block, text: compact }], messages: conversation });
  const buffer = Buffer.from('{ "input": "A  B" }');
  assert.equal(compactSystemBody(buffer, 'OPENAI_RESPONSES', all), buffer);
});
test('validates role options and preserves large request numbers', () => {
  for (const bad of [null, [], { cleanWhitespace: 1 }, { other: true }])
    assert.throws(() => validateCompaction(bad), { status: 400 });
  const body = Buffer.from('{"instructions":"A  B","seed":9223372036854775807}');
  assert.match(compactSystemBody(body, 'OPENAI_RESPONSES', all).toString(), /9223372036854775807/);
});
