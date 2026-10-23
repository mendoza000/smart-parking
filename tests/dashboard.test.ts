import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EntryGateControls from '../src/components/EntryGateControls.tsx';
import { createDashboard, receiveGateResult, receiveSnapshot, toggleDemoSpot } from '../src/lib/dashboard-state.ts';

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

test('gate state changes only on confirmed snapshots and gate activity follows known transitions', () => {
  let state = createDashboard(false);
  state = receiveSnapshot(state, { type: 'snapshot', spots: [false, false, false, false], connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true });
  assert.equal(state.gate, 'closed');
  const pending = { ...state, gateRequest: { requestId: 'req-1', action: 'open' as const } };
  const pendingSnapshot = receiveSnapshot(pending, { type: 'snapshot', spots: state.spots, connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true, gatePending: 'open' });
  assert.equal(pendingSnapshot.gateRequest?.requestId, 'req-1');
  assert.equal(pendingSnapshot.gatePending, 'open');
  const result = receiveGateResult(pendingSnapshot, { type: 'gate-result', requestId: 'req-1', status: 'rejected', gate: 'closed', error: 'PARKING_FULL' });
  assert.equal(result.gate, 'closed');
  assert.equal(result.gatePending, 'open');
  assert.equal(result.gateRequest, null);
  assert.equal(result.gateError, 'PARKING_FULL');
  const afterError = receiveSnapshot(result, { type: 'snapshot', spots: [false, false, false, false], connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true });
  assert.equal(afterError.gateError, 'PARKING_FULL');
  const opened = receiveSnapshot(afterError, { type: 'snapshot', spots: [false, false, false, false], connected: true, updatedAt: null, barriers: null, gate: 'open', gateReady: true });
  assert.equal(opened.gate, 'open');
  assert.equal(opened.gatePending, null);
  assert.equal(opened.gateRequest, null);
  assert.equal(opened.events[0]?.message, 'Barrera de entrada abierta');
  const disconnected = receiveSnapshot(opened, { type: 'snapshot', spots: opened.spots, connected: false, updatedAt: null, barriers: null, gateReady: false });
  assert.equal(disconnected.gate, 'open');
  assert.equal(disconnected.gateReady, false);
});

test('hardware snapshots cannot contaminate demonstration state, and events stay bounded', () => {
  let state = createDashboard(true);
  assert.equal(receiveSnapshot(state, { type: 'snapshot', spots: [true, true, true, true], connected: true, updatedAt: null, barriers: null }), state);
  for (let i = 0; i < 50; i++) state = toggleDemoSpot(state, 0);
  assert.equal(state.events.length, 30);
});

test('an unknown occupancy snapshot replaces stale counts without inventing occupancy events', () => {
  const known = receiveSnapshot(createDashboard(false), { type: 'snapshot', spots: [false, false, false, false], connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true });
  const unknown = receiveSnapshot(known, { type: 'snapshot', spots: null, connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true });
  assert.equal(unknown.spots, null);
  assert.equal(unknown.gate, 'closed');
  assert.deepEqual(unknown.events, known.events);
  const synchronized = receiveSnapshot(unknown, { type: 'snapshot', spots: [true, true, true, true], connected: true, updatedAt: null, barriers: null, gate: 'closed', gateReady: true });
  assert.deepEqual(synchronized.spots, [true, true, true, true]);
  assert.deepEqual(synchronized.events, known.events);
});

test('disabled gate controls visibly explain bridge, Arduino, and synchronization readiness', () => {
  let calls = 0;
  const base = { demo: false, available: 4, socketOnline: true, serialOnline: true, gateReady: true, gate: 'closed' as const, serverPending: null, localPending: null, error: null, onAction: () => { calls++; } };
  const cases = [
    { props: { socketOnline: false }, message: 'Sin conexión con el bridge.' },
    { props: { serialOnline: false }, message: 'Arduino está desconectado.' },
    { props: { gateReady: false }, message: 'Esperando un estado confirmado de Arduino.' },
  ];
  for (const entry of cases) {
    const html = renderToStaticMarkup(createElement(EntryGateControls, { ...base, ...entry.props }));
    assert.ok(html.includes(`<p id="entry-gate-status" role="status" aria-live="polite">${entry.message}</p>`));
    assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
    assert.ok(html.includes('Abrir barrera'));
    assert.ok(html.includes('Cerrar barrera'));
  }
  assert.equal(calls, 0);
});
