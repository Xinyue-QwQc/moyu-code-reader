const test = require('node:test');
const assert = require('node:assert/strict');
const { updateMemento } = require('../out/net/state');

test('progress, positions and UI state share one Memento write queue instead of overwriting snapshots', async () => {
  let active = 0, maximum = 0;
  const values = {}, order = [];
  const state = { update: async (key, value) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    values[key] = value;
    order.push(key);
    active--;
  } };
  const position = { line: 12 };
  const one = updateMemento(state, 'positions', position);
  const two = updateMemento(state, 'history', { chapter: 2 });
  const three = updateMemento(state, 'shelf', { chapter: 2 });
  position.line = 99;
  await Promise.all([one, two, three]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, ['positions', 'history', 'shelf']);
  assert.deepEqual(values, { positions: { line: 12 }, history: { chapter: 2 }, shelf: { chapter: 2 } });
});

test('a failed Memento write remains observable but cannot stall later writes', async () => {
  let value;
  const state = { update: async (key, next) => { if (key === 'fail') throw new Error('disk full'); value = next; } };
  await assert.rejects(updateMemento(state, 'fail', 1), /disk full/);
  await updateMemento(state, 'ok', 2);
  assert.equal(value, 2);
});
