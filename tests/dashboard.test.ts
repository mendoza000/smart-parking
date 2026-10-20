import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDashboard, receiveSnapshot, toggleDemoSpot } from '../src/lib/dashboard-state.ts';

test('demo toggles independently with immediate metrics and actual transition events', () => {
  const initial = createDashboard(true);
  const occupied = toggleDemoSpot(initial, 2, '2026-01-01T12:00:00Z');
  assert.deepEqual(occupied.spots, [false, false, true, false]);
  assert.equal(occupied.events[0]?.message, 'Puesto 03 ocupado');
  const free = toggleDemoSpot(occupied, 2, '2026-01-01T12:00:01Z');
  assert.deepEqual(free.spots, [false, false, false, false]);
  assert.equal(free.events[0]?.message, 'Puesto 03 liberado');
  assert.deepEqual(initial.spots, [false, false, false, false]);
  assert.equal(toggleDemoSpot(initial, 4), initial);
});

test('hardware stays unknown initially and cannot be changed by demo actions', () => {
  const state = createDashboard(false);
  assert.equal(state.spots, null);
  assert.equal(toggleDemoSpot(state, 0), state);
  const next = receiveSnapshot(state, { type: 'snapshot', spots: [false, true, false, true], connected: true, updatedAt: '2026-01-01T12:00:00Z', barriers: null });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0]?.message, 'Arduino conectado');
  const changed = receiveSnapshot(next, { type: 'snapshot', spots: [true, true, false, false], connected: true, updatedAt: '2026-01-01T12:00:01Z', barriers: null });
  assert.equal(changed.events.length, 3);
  const disconnected = receiveSnapshot(changed, { type: 'snapshot', spots: changed.spots, connected: false, updatedAt: changed.updatedAt, barriers: null });
  assert.deepEqual(disconnected.spots, changed.spots);
  assert.equal(disconnected.events[0]?.message, 'Arduino desconectado');
  assert.equal(receiveSnapshot(disconnected, { type: 'snapshot', spots: disconnected.spots, connected: false, updatedAt: disconnected.updatedAt, barriers: null }).events.length, 4);
});

test('hardware snapshots cannot contaminate demonstration state, and events stay bounded', () => {
  let state = createDashboard(true);
  assert.equal(receiveSnapshot(state, { type: 'snapshot', spots: [true, true, true, true], connected: true, updatedAt: null, barriers: null }), state);
  for (let i = 0; i < 50; i++) state = toggleDemoSpot(state, 0);
  assert.equal(state.events.length, 30);
});
