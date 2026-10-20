import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSpotChanges, parseArduinoMessage, parseSnapshot } from '../src/lib/protocol.ts';

test('parses valid Arduino messages and rejects malformed or unsafe data', () => {
  assert.deepEqual(parseArduinoMessage('{"spots":[false,true,false,true]}'), { spots: [false, true, false, true] });
  assert.deepEqual(parseArduinoMessage('{"spots":[false,true,false,true],"barriers":{"entry":"open","exit":"closed"}}'), { spots: [false, true, false, true], barriers: { entry: 'open', exit: 'closed' } });
  for (const line of ['', '{bad', '{"spots":[0,true,false,true]}', '{"spots":[true]}', '{"spots":[true,false,false,false],"barriers":{"entry":"open","exit":"wat"}}']) assert.equal(parseArduinoMessage(line), null);
});

test('validates snapshots and reports only real transitions', () => {
  const snapshot = { type: 'snapshot', spots: [false, true, false, true], connected: true, updatedAt: null, barriers: null };
  assert.deepEqual(parseSnapshot(snapshot), snapshot);
  assert.equal(parseSnapshot({ ...snapshot, spots: [false] }), null);
  assert.deepEqual(getSpotChanges(null, [true, false, false, false]), []);
  assert.deepEqual(getSpotChanges([false, true, false, false], [true, false, false, false]), [{ index: 0, occupied: true }, { index: 1, occupied: false }]);
});
