import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSpotChanges, parseArduinoMessage, parseSnapshot, parseGateCommand, parseGateResult, toSerialGateCommand } from '../src/lib/protocol.ts';

test('parses valid Arduino messages and rejects malformed or unsafe data', () => {
  assert.deepEqual(parseArduinoMessage('{"spots":[false,true,false,true]}'), { spots: [false, true, false, true] });
  assert.deepEqual(parseArduinoMessage('{"spots":[false,true,false,true],"barriers":{"entry":"open","exit":"closed"}}'), { spots: [false, true, false, true], barriers: { entry: 'open', exit: 'closed' } });
  for (const line of ['', '{bad', '{"spots":[0,true,false,true]}', '{"spots":[true]}', '{"spots":[true,false,false,false],"barriers":{"entry":"open","exit":"wat"}}']) assert.equal(parseArduinoMessage(line), null);
});

test('validates gate commands, identifiers, and serial encoding', () => {
  const id = 'a'.repeat(48);
  assert.deepEqual(parseGateCommand({ type: 'gate-command', requestId: id, action: 'open' }), { type: 'gate-command', requestId: id, action: 'open' });
  assert.deepEqual(parseGateCommand({ type: 'gate-command', requestId: 'x', action: 'close' }), { type: 'gate-command', requestId: 'x', action: 'close' });
  for (const requestId of ['', 'a'.repeat(49), 'bad id', 'x\\n', 'x\n', 'x\r']) assert.equal(parseGateCommand({ type: 'gate-command', requestId, action: 'open' }), null);
  for (const input of [{ type: 'x', requestId: 'id', action: 'open' }, { type: 'gate-command', requestId: 'id', action: 'halt' }, { type: 'gate-command', requestId: 'id', action: 'close', extra: true }, null]) assert.equal(parseGateCommand(input), null);
  assert.equal(toSerialGateCommand('open', 'wire-1'), 'GATE_OPEN wire-1\n');
  assert.equal(toSerialGateCommand('close', 'wire-1'), 'GATE_CLOSE wire-1\n');
  assert.equal(toSerialGateCommand('open', 'bad id'), null);
  assert.equal(toSerialGateCommand('open', 'bad\nGATE_CLOSE'), null);
});

test('validates gate results and Arduino gate metadata strictly', () => {
  assert.deepEqual(parseGateResult({ type: 'gate-result', requestId: 'id', status: 'confirmed', gate: 'open' }), { type: 'gate-result', requestId: 'id', status: 'confirmed', gate: 'open' });
  assert.deepEqual(parseGateResult({ type: 'gate-result', requestId: null, status: 'rejected', gate: null, error: 'PARKING_FULL' }), { type: 'gate-result', requestId: null, status: 'rejected', gate: null, error: 'PARKING_FULL' });
  assert.deepEqual(parseGateResult({ type: 'gate-result', requestId: null, status: 'rejected', gate: 'open', error: 'GATE_BUSY' }), { type: 'gate-result', requestId: null, status: 'rejected', gate: 'open', error: 'GATE_BUSY' });
  for (const result of [{ type: 'gate-result', requestId: 'id', status: 'confirmed', gate: 'up' }, { type: 'gate-result', requestId: 'id', status: 'confirmed', gate: 'open', error: 'GATE_BUSY' }, { type: 'gate-result', requestId: null, status: 'rejected', gate: null, error: 'UNKNOWN' }]) assert.equal(parseGateResult(result), null);
  assert.deepEqual(parseArduinoMessage('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}'), { spots: [false, false, false, false], gate: 'closed', ack: 'SYNC' });
  assert.equal(parseArduinoMessage('{"spots":[false,false,false,false],"gate":"sideways"}'), null);
  assert.equal(parseArduinoMessage('{"spots":[false,false,false,false],"requestId":"id"}'), null);
  assert.equal(parseArduinoMessage('{"spots":[false,false,false,false],"gate":"open","ack":["GATE_OPEN"]}'), null);
  assert.equal(parseArduinoMessage('{"spots":[false,false,false,false],"gate":"open","error":["PARKING_FULL"]}'), null);
});

test('validates snapshots and reports only real transitions', () => {
  const snapshot = { type: 'snapshot', spots: [false, true, false, true], connected: true, updatedAt: null, barriers: null };
  assert.deepEqual(parseSnapshot(snapshot), snapshot);
  assert.equal(parseSnapshot({ ...snapshot, spots: [false] }), null);
  assert.deepEqual(parseSnapshot({ ...snapshot, gate: 'open', gateReady: true, gatePending: 'close' }), { ...snapshot, gate: 'open', gateReady: true, gatePending: 'close' });
  assert.equal(parseSnapshot({ ...snapshot, gateReady: true }), null);
  assert.equal(parseSnapshot({ ...snapshot, gate: 'unknown' }), null);
  assert.deepEqual(getSpotChanges(null, [true, false, false, false]), []);
  assert.deepEqual(getSpotChanges([false, true, false, false], [true, false, false, false]), [{ index: 0, occupied: true }, { index: 1, occupied: false }]);
});
