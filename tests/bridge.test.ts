import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBridge } from '../bridge/server.ts';

class FakeSerial {
  static instances: FakeSerial[] = [];
  listeners = new Map<string, Array<(...args: any[]) => void>>();
  writes: string[] = [];
  closed = false;
  closeError: Error | null = null;
  failCloseCount = 0;
  failWriteOnce = false;
  constructor(public options: { path: string; baudRate: number }) { FakeSerial.instances.push(this); }
  on(name: string, callback: (...args: any[]) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); return this; }
  write(data: string, callback?: (error?: Error | null) => void) {
    this.writes.push(data);
    if (this.failWriteOnce) { this.failWriteOnce = false; callback?.(new Error('write failed')); }
    else callback?.();
    return true;
  }
  close(callback?: (error?: Error | null) => void) {
    if (this.failCloseCount > 0) { this.failCloseCount--; this.closeError = new Error('close failed'); callback?.(this.closeError); return; }
    this.closed = true; this.closeError = null; callback?.();
  }
  emit(name: string, ...args: any[]) { for (const listener of this.listeners.get(name) ?? []) listener(...args); }
  open() { this.emit('open'); }
  data(data: string) { this.emit('data', Buffer.from(data)); }
}

class Inbox {
  messages: any[] = [];
  constructor(readonly socket: WebSocket) { socket.on('message', (data) => this.messages.push(JSON.parse(data.toString()))); }
  async waitFor(predicate: (message: any) => boolean, from = 0, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.slice(from).find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for snapshot after message ${from}; received ${JSON.stringify(this.messages.slice(from))}`);
  }
}

async function fixture(SerialPort: any = FakeSerial, options: Record<string, unknown> = {}) {
  const serialStart = FakeSerial.instances.length;
  const bridge = await createBridge({ SerialPort, serialPath: '/dev/fake', baudRate: 9600, wsHost: '127.0.0.1', wsPort: 0, reconnectMs: 10, bootGraceMs: 15, maxLineBytes: 64, ...options });
  const clients: WebSocket[] = [];
  let cleaned = false;
  return {
    bridge,
    clients,
    serials() { return FakeSerial.instances.slice(serialStart); },
    async client() { return openClient(); },
    async clientWithOrigin(origin: string) { return openClient({ Origin: origin }); },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const client of clients) client.terminate();
      await bridge.close();
    },
  };
  async function openClient(headers?: Record<string, string>) {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, headers ? { headers } : undefined);
    clients.push(socket);
    const inbox = new Inbox(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return inbox;
  }
}

async function waitForSerialCount(f: Awaited<ReturnType<typeof fixture>>, count: number, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (f.serials().length >= count) return f.serials();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} serial generations`);
}

async function waitForSerialWrite(serial: FakeSerial, prefix: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = serial.writes.find((value) => value.startsWith(prefix));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for serial write ${prefix}`);
}

function ownCleanup(t: { after(callback: () => void | Promise<void>): void }, f: Awaited<ReturnType<typeof fixture>>) {
  t.after(() => f.cleanup());
}

const payload = '{"spots":[true,false,true,false]}';

test('provides unknown initial state, SYNC on open and boot, and retained late-join/disconnect snapshots', async (t) => {
  const f = await fixture(); ownCleanup(t, f);
  try {
    const inbox = await f.client();
    assert.deepEqual(await inbox.waitFor((m) => m.type === 'snapshot'), { type: 'snapshot', spots: null, connected: false, updatedAt: null, barriers: null });
    const serial = f.serials().at(-1)!;
    serial.open();
    assert.equal(serial.writes[0], 'SYNC\n');
    serial.data('{"spots":[true,false');
    serial.data(',true,false]}\n');
    const updated = await inbox.waitFor((m) => m.spots !== null);
    assert.deepEqual(updated.spots, [true, false, true, false]);
    const timestamp = updated.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(serial.writes.filter((value) => value === 'SYNC\n').length, 2);
    const late = await f.client();
    assert.deepEqual((await late.waitFor((m) => m.spots !== null)).spots, updated.spots);
    const from = inbox.messages.length;
    serial.emit('close');
    const disconnected = await inbox.waitFor((m) => m.connected === false && m.spots !== null, from);
    assert.equal(disconnected.updatedAt, timestamp);
    assert.deepEqual(disconnected.spots, updated.spots);
  } finally { await f.cleanup(); }
});

test('rejects malformed and oversized lines without changing public retained state or timestamp', async (t) => {
  const f = await fixture(); ownCleanup(t, f);
  try {
    const inbox = await f.client();
    await inbox.waitFor((m) => m.type === 'snapshot');
    const serial = FakeSerial.instances.at(-1)!;
    serial.open();
    serial.data(`${payload}\n`);
    const valid = await inbox.waitFor((m) => m.spots !== null);
    const count = inbox.messages.length;
    serial.data(`${'x'.repeat(80)}${payload}\n`);
    serial.data('{malformed}\n');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(inbox.messages.length, count);
    assert.deepEqual(f.bridge.snapshot.spots, valid.spots);
    assert.equal(f.bridge.snapshot.updatedAt, valid.updatedAt);
    assert.deepEqual(inbox.messages.at(-1).spots, valid.spots);
    assert.equal(inbox.messages.at(-1).updatedAt, valid.updatedAt);
  } finally { await f.cleanup(); }
});

test('closes a serial descriptor on error, reconnects once, retains state, and ignores stale events', async (t) => {
  const f = await fixture(); ownCleanup(t, f);
  try {
    const inbox = await f.client();
    await inbox.waitFor((m) => m.type === 'snapshot');
    const old = f.serials().at(-1)!;
    old.open(); old.data(`${payload}\n`);
    const initial = await inbox.waitFor((m) => m.spots !== null);
    const from = inbox.messages.length;
    old.emit('error', new Error('serial lost'));
    const offline = await inbox.waitFor((m) => m.connected === false, from);
    assert.equal(offline.updatedAt, initial.updatedAt);
    assert.equal(old.closed, true);
    const deadline = Date.now() + 1000;
    while (f.serials().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.serials().length, 2);
    old.data('{"spots":[false,false,false,false]}\n');
    const next = f.serials()[1]!;
    next.open();
    const online = await inbox.waitFor((m) => m.connected && m.spots !== null, from);
    assert.deepEqual(online.spots, initial.spots);
    assert.equal(online.updatedAt, initial.updatedAt);
    assert.equal(next.writes[0], 'SYNC\n');
  } finally { await f.cleanup(); }
});

test('retries synchronous constructor failure with explicit path diagnostic and shuts down timers and clients', async (t) => {
  FakeSerial.instances = [];
  let attempts = 0;
  class FlakySerial extends FakeSerial {
    constructor(options: { path: string; baudRate: number }) {
      attempts++;
      if (attempts === 1) throw new Error('adapter startup failed');
      super(options);
    }
  }
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(FlakySerial);
    ownCleanup(t, f);
    const inbox = await f.client();
    await inbox.waitFor((m) => m.type === 'snapshot');
    const deadline = Date.now() + 1000;
    while (attempts < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(attempts, 2);
    assert.ok(errors.some((line) => line.includes('/dev/fake') && line.includes('adapter startup failed')));
    const serial = f.serials().at(-1)!;
    serial.emit('close');
    const count = f.serials().length;
    const closed = inbox.socket.readyState === WebSocket.CLOSED
      ? Promise.resolve()
      : new Promise<void>((resolve) => inbox.socket.once('close', () => resolve()));
    await f.cleanup();
    await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for WebSocket close')), 1000))]);
    assert.equal(inbox.socket.readyState, WebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(f.serials().length, count);
  } finally {
    console.error = originalError;
    await f?.cleanup();
  }
});

test('retains a descriptor after close callback failure and resumes only after it closes', async (t) => {
  const f = await fixture(); ownCleanup(t, f);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    const inbox = await f.client();
    await inbox.waitFor((m) => m.type === 'snapshot');
    const old = f.serials()[0]!;
    old.open(); old.data(`${payload}\n`);
    const before = await inbox.waitFor((m) => m.spots !== null);
    old.failCloseCount = 1;
    const from = inbox.messages.length;
    old.emit('error', new Error('serial lost'));
    const offline = await inbox.waitFor((m) => m.connected === false, from);
    assert.deepEqual(offline.spots, before.spots);
    assert.equal(offline.updatedAt, before.updatedAt);
    old.data('{"spots":[false,false,false,false]}\n');
    assert.deepEqual(f.bridge.snapshot.spots, before.spots);
    assert.equal(f.serials().length, 1);
    assert.ok(errors.some((line) => line.includes('/dev/fake') && line.includes('close failed')));

    const deadline = Date.now() + 1000;
    while (f.serials().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(old.closed, true);
    assert.equal(f.serials().length, 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.serials().length, 2);
    f.serials()[1]!.open();
    assert.equal((await inbox.waitFor((m) => m.connected)).connected, true);
    await f.bridge.close();
  } finally { console.error = originalError; await f.cleanup(); }
});

test('reports serial close failure during shutdown', async () => {
  const f = await fixture();
  const originalError = console.error;
  console.error = () => {};
  try {
    const old = f.serials()[0]!;
    old.failCloseCount = 1;
    await assert.rejects(() => f.bridge.close(), /close failed/);
  } finally { console.error = originalError; await f.cleanup(); }
});

test('dispatches an origin-guarded gate command and changes confirmed state only after matching ACK', async (t) => {
  const f = await fixture(FakeSerial, { gateAckTimeoutMs: 500, maxLineBytes: 1024 }); ownCleanup(t, f);
  const socket = new WebSocket(`ws://127.0.0.1:${f.bridge.port}`, { headers: { Origin: 'http://localhost:4321' } });
  f.clients.push(socket);
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await inbox.waitFor((m) => m.type === 'snapshot');
  const serial = f.serials()[0]!;
  serial.open();
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  const ready = await inbox.waitFor((m) => m.gateReady === true);
  assert.equal(ready.gate, 'closed');
  socket.send(JSON.stringify({ type: 'gate-command', requestId: 'browser-1', action: 'open' }));
  const wire = await new Promise<string>((resolve) => {
    const deadline = Date.now() + 500;
    const poll = () => serial.writes.find((value) => value.startsWith('GATE_OPEN ')) ? resolve(serial.writes.find((value) => value.startsWith('GATE_OPEN '))!) : Date.now() < deadline ? setTimeout(poll, 5) : resolve('');
    poll();
  });
  assert.match(wire, /^GATE_OPEN [A-Za-z0-9_-]{36}\n$/);
  assert.equal(f.bridge.snapshot.gate, 'closed');
  const nonce = wire.slice('GATE_OPEN '.length).trim();
  serial.data(`{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"${nonce}"}\n`);
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'browser-1', status: 'confirmed', gate: 'open' });
  assert.equal(f.bridge.snapshot.gate, 'open');
  serial.data('{"spots":[true,true,true,true],"gate":"open"}\n');
  await inbox.waitFor((m) => m.spots?.every(Boolean));
  socket.send(JSON.stringify({ type: 'gate-command', requestId: 'browser-close', action: 'close' }));
  const closeWire = await new Promise<string>((resolve) => {
    const deadline = Date.now() + 500;
    const poll = () => serial.writes.find((value) => value.startsWith('GATE_CLOSE ')) ? resolve(serial.writes.find((value) => value.startsWith('GATE_CLOSE '))!) : Date.now() < deadline ? setTimeout(poll, 5) : resolve('');
    poll();
  });
  assert.match(closeWire, /^GATE_CLOSE [A-Za-z0-9_-]{36}\n$/);
  const closeNonce = closeWire.slice('GATE_CLOSE '.length).trim();
  serial.data(`{"spots":[true,true,true,true],"gate":"closed","ack":"GATE_CLOSE","requestId":"${closeNonce}"}\n`);
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result' && m.requestId === 'browser-close'), { type: 'gate-result', requestId: 'browser-close', status: 'confirmed', gate: 'closed' });
});

test('keeps originless readers read-only and rejects full-capacity opens without serial writes', async (t) => {
  const f = await fixture(FakeSerial, { gateAckTimeoutMs: 500, maxLineBytes: 1024, bootGraceMs: 10_000 }); ownCleanup(t, f);
  const inbox = await f.client();
  await inbox.waitFor((m) => m.type === 'snapshot');
  const serial = f.serials()[0]!;
  serial.open();
  serial.data('{"spots":[true,true,true,true],"gate":"closed","ack":"SYNC"}\n');
  const before = await inbox.waitFor((m) => m.gateReady === true);
  const writes = [...serial.writes];
  inbox.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'originless', action: 'close' }));
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'originless', status: 'rejected', gate: 'closed', error: 'ORIGIN_NOT_ALLOWED' });
  assert.deepEqual(serial.writes, writes);
  assert.equal(f.bridge.snapshot.updatedAt, before.updatedAt);
  const allowed = new WebSocket(`ws://127.0.0.1:${f.bridge.port}`, { headers: { Origin: 'http://localhost:4321' } });
  f.clients.push(allowed);
  const allowedInbox = new Inbox(allowed);
  await new Promise<void>((resolve, reject) => { allowed.once('open', resolve); allowed.once('error', reject); });
  await allowedInbox.waitFor((m) => m.type === 'snapshot');
  allowed.send(JSON.stringify({ type: 'gate-command', requestId: 'full-open', action: 'open' }));
  assert.deepEqual(await allowedInbox.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'full-open', status: 'rejected', gate: 'closed', error: 'PARKING_FULL' });
  assert.deepEqual(serial.writes, writes);
  assert.equal(f.bridge.snapshot.updatedAt, before.updatedAt);
  const blocked = new WebSocket(`ws://127.0.0.1:${f.bridge.port}`, { headers: { Origin: 'http://evil.example' } });
  f.clients.push(blocked);
  const blockedInbox = new Inbox(blocked);
  await new Promise<void>((resolve, reject) => { blocked.once('open', resolve); blocked.once('error', reject); });
  await blockedInbox.waitFor((m) => m.type === 'snapshot');
  blocked.send(JSON.stringify({ type: 'gate-command', requestId: 'evil', action: 'open' }));
  assert.deepEqual(await blockedInbox.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'evil', status: 'rejected', gate: 'closed', error: 'ORIGIN_NOT_ALLOWED' });
  assert.deepEqual(serial.writes, writes);
});

test('times out without replaying motion and requires a fresh SYNC before another command', async (t) => {
  const f = await fixture(FakeSerial, { gateAckTimeoutMs: 40, maxLineBytes: 1024, bootGraceMs: 10_000 }); ownCleanup(t, f);
  const socket = new WebSocket(`ws://127.0.0.1:${f.bridge.port}`, { headers: { Origin: 'http://localhost:4321' } });
  f.clients.push(socket);
  const inbox = new Inbox(socket);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await inbox.waitFor((m) => m.type === 'snapshot');
  const serial = f.serials()[0]!;
  serial.open();
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await inbox.waitFor((m) => m.gateReady === true);
  const syncCount = serial.writes.filter((value) => value === 'SYNC\n').length;
  socket.send(JSON.stringify({ type: 'gate-command', requestId: 'timeout-1', action: 'open' }));
  const rejected = await inbox.waitFor((m) => m.type === 'gate-result');
  assert.deepEqual(rejected, { type: 'gate-result', requestId: 'timeout-1', status: 'rejected', gate: 'closed', error: 'ACK_TIMEOUT' });
  assert.equal(serial.writes.filter((value) => value.startsWith('GATE_OPEN ')).length, 1);
  assert.equal(serial.writes.filter((value) => value === 'SYNC\n').length, syncCount + 1);
  assert.equal(f.bridge.snapshot.gateReady, false);
  socket.send(JSON.stringify({ type: 'gate-command', requestId: 'timeout-2', action: 'close' }));
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result' && m.requestId === 'timeout-2'), { type: 'gate-result', requestId: 'timeout-2', status: 'rejected', gate: 'closed', error: 'NOT_SYNCHRONIZED' });
  const beforeFreshSync = inbox.messages.length;
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  assert.equal((await inbox.waitFor((m) => m.gateReady === true, beforeFreshSync)).gateReady, true);
  const oldWire = serial.writes.find((value) => value.startsWith('GATE_OPEN '))!;
  const oldNonce = oldWire.slice('GATE_OPEN '.length).trim();
  serial.data(`{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"${oldNonce}"}\n`);
  assert.equal(f.bridge.snapshot.gatePending, null);
  const beforeResync = inbox.messages.length;
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  assert.equal((await inbox.waitFor((m) => m.type === 'snapshot' && m.gateReady === true && m.gate === 'closed', beforeResync)).gate, 'closed');
  socket.send(JSON.stringify({ type: 'gate-command', requestId: 'timeout-3', action: 'close' }));
  const second = await new Promise<string>((resolve) => {
    const deadline = Date.now() + 500;
    const poll = () => serial.writes.filter((value) => value.startsWith('GATE_CLOSE ')).length ? resolve(serial.writes.filter((value) => value.startsWith('GATE_CLOSE ')).at(-1)!) : Date.now() < deadline ? setTimeout(poll, 5) : resolve('');
    poll();
  });
  assert.match(second, /^GATE_CLOSE [A-Za-z0-9_-]{36}\n$/);
  const currentNonce = second.slice('GATE_CLOSE '.length).trim();
  assert.notEqual(currentNonce, oldNonce);
  serial.data(`{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"${oldNonce}"}\n`);
  assert.equal(f.bridge.snapshot.gatePending, 'close');
  serial.data(`{"spots":[false,false,false,false],"gate":"closed","ack":"GATE_CLOSE","requestId":"${currentNonce}"}\n`);
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result' && m.requestId === 'timeout-3'), { type: 'gate-result', requestId: 'timeout-3', status: 'confirmed', gate: 'closed' });
});

test('requires fresh SYNC after reconnect and ignores stale descriptor data', async (t) => {
  const f = await fixture(FakeSerial, { bootGraceMs: 10_000, maxLineBytes: 1024 }); ownCleanup(t, f);
  const inbox = await f.clientWithOrigin('http://localhost:4321');
  const old = f.serials()[0]!;
  old.open();
  old.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await inbox.waitFor((m) => m.gateReady === true);
  inbox.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'before-disconnect', action: 'open' }));
  const oldWire = await waitForSerialWrite(old, 'GATE_OPEN ');
  const oldNonce = oldWire.slice('GATE_OPEN '.length).trim();
  old.emit('error', new Error('disconnect'));
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'before-disconnect', status: 'rejected', gate: 'closed', error: 'ARDUINO_DISCONNECTED' });
  const generations = await waitForSerialCount(f, 2);
  const current = generations[1]!;
  assert.equal(old.closed, true);
  const retained = f.bridge.snapshot;
  old.data(`{"spots":[true,true,true,true],"gate":"open","ack":"GATE_OPEN","requestId":"${oldNonce}"}\n`);
  assert.equal(f.bridge.snapshot.spots, retained.spots);
  assert.equal(f.bridge.snapshot.gate, retained.gate);
  current.open();
  inbox.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'reconnect-before-sync', action: 'close' }));
  assert.deepEqual(await inbox.waitFor((m) => m.type === 'gate-result' && m.requestId === 'reconnect-before-sync'), { type: 'gate-result', requestId: 'reconnect-before-sync', status: 'rejected', gate: 'closed', error: 'NOT_SYNCHRONIZED' });
  current.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC","error":"INVALID_COMMAND"}\n');
  assert.equal(f.bridge.snapshot.gateReady, false);
  const beforeFreshSync = inbox.messages.length;
  current.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  assert.equal((await inbox.waitFor((m) => m.gateReady === true, beforeFreshSync)).gateReady, true);
  inbox.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'after-reconnect', action: 'close' }));
  const newWire = await waitForSerialWrite(current, 'GATE_CLOSE ');
  assert.notEqual(newWire.slice('GATE_CLOSE '.length).trim(), oldNonce);
  current.data(`{"spots":[false,false,false,false],"gate":"closed","ack":"GATE_CLOSE","requestId":"${newWire.slice('GATE_CLOSE '.length).trim()}"}\n`);
  assert.equal((await inbox.waitFor((m) => m.type === 'gate-result' && m.requestId === 'after-reconnect')).status, 'confirmed');
});

test('write errors reject once and quarantine the generation; closing the owner does not cancel accepted motion', async (t) => {
  const f = await fixture(FakeSerial, { bootGraceMs: 10_000, gateAckTimeoutMs: 1000, maxLineBytes: 1024 }); ownCleanup(t, f);
  const failedOwner = await f.clientWithOrigin('http://localhost:4321');
  const observer = await f.clientWithOrigin('http://127.0.0.1:4321');
  const first = f.serials()[0]!;
  first.open();
  first.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await failedOwner.waitFor((m) => m.gateReady === true);
  first.failWriteOnce = true;
  failedOwner.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'write-fail', action: 'open' }));
  assert.deepEqual(await failedOwner.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'write-fail', status: 'rejected', gate: 'closed', error: 'SERIAL_WRITE_FAILED' });
  assert.equal(f.bridge.snapshot.gateReady, false);
  assert.equal(first.closed, true);
  const generations = await waitForSerialCount(f, 2);
  const current = generations[1]!;
  current.open();
  const observerBeforeSync = observer.messages.length;
  current.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await observer.waitFor((m) => m.gateReady === true, observerBeforeSync);
  failedOwner.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'owner-closing', action: 'open' }));
  const accepted = await waitForSerialWrite(current, 'GATE_OPEN ');
  const nonce = accepted.slice('GATE_OPEN '.length).trim();
  failedOwner.socket.terminate();
  current.data(`{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"${nonce}"}\n`);
  const confirmed = await observer.waitFor((m) => m.gate === 'open' && m.gatePending === null);
  assert.equal(confirmed.gate, 'open');
  assert.equal(current.writes.filter((value) => value.startsWith('GATE_OPEN ')).length, 1);
});

test('shutdown cancels an accepted command deadline and never writes SYNC afterward', async (t) => {
  const f = await fixture(FakeSerial, { bootGraceMs: 10_000, gateAckTimeoutMs: 80, maxLineBytes: 1024 }); ownCleanup(t, f);
  const inbox = await f.clientWithOrigin('http://localhost:4321');
  const serial = f.serials()[0]!;
  serial.open();
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await inbox.waitFor((m) => m.gateReady === true);
  inbox.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'shutdown-pending', action: 'open' }));
  await waitForSerialWrite(serial, 'GATE_OPEN ');
  const writesAtShutdown = serial.writes.length;
  await f.bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(serial.writes.length, writesAtShutdown);
  assert.equal(serial.writes.filter((value) => value === 'SYNC\n').length, 1);
});

test('validates configuration before constructing serial transport or leaving WebSocket resources open', async () => {
  let constructed = false;
  class ShouldNotConstruct extends FakeSerial { constructor(options: { path: string; baudRate: number }) { constructed = true; super(options); } }
  const base = { SerialPort: ShouldNotConstruct as any, serialPath: '/dev/fake', wsHost: '127.0.0.1', wsPort: 0 };
  const rejectAndCloseUnexpectedBridge = async (options: Record<string, unknown>) => {
    let bridge: Awaited<ReturnType<typeof createBridge>>;
    try { bridge = await createBridge({ ...base, ...options } as any); }
    catch { return; }
    await bridge.close();
    assert.fail('Invalid configuration unexpectedly created a bridge');
  };
  await rejectAndCloseUnexpectedBridge({ baudRate: 0 });
  await rejectAndCloseUnexpectedBridge({ allowedOrigins: ['*'] });
  await rejectAndCloseUnexpectedBridge({ allowedOrigins: ['file://example.com'] });
  await rejectAndCloseUnexpectedBridge({ allowedOrigins: ['https://example.com/path'] });
  await rejectAndCloseUnexpectedBridge({ allowedOrigins: ['https://user:pass@example.com'] });
  await rejectAndCloseUnexpectedBridge({ allowedOrigins: ['https://example.com?x=1'] });
  await rejectAndCloseUnexpectedBridge({ allowedOrigins: ['https://example.com#fragment'] });
  await rejectAndCloseUnexpectedBridge({ gateAckTimeoutMs: 0 });
  assert.equal(constructed, false);
});

test('competing owners stay serialized and only the matching nonce, ACK, and gate confirms', async (t) => {
  const f = await fixture(FakeSerial, { bootGraceMs: 10_000, gateAckTimeoutMs: 1000, maxLineBytes: 1024 }); ownCleanup(t, f);
  const first = await f.clientWithOrigin('http://localhost:4321');
  const second = await f.clientWithOrigin('http://127.0.0.1:4321');
  const serial = f.serials()[0]!;
  serial.open();
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await first.waitFor((m) => m.gateReady === true);
  await second.waitFor((m) => m.gateReady === true);
  first.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'owner-1', action: 'open' }));
  const wire = await waitForSerialWrite(serial, 'GATE_OPEN ');
  const nonce = wire.slice('GATE_OPEN '.length).trim();
  second.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'owner-2', action: 'close' }));
  assert.deepEqual(await second.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'owner-2', status: 'rejected', gate: 'closed', error: 'GATE_BUSY' });
  assert.equal(serial.writes.filter((value) => value.startsWith('GATE_')).length, 1);
  serial.data('{"spots":[true,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"not-the-nonce"}\n');
  await first.waitFor((m) => m.spots?.[0] === true);
  serial.data(`{"spots":[true,true,false,false],"gate":"open","ack":"GATE_CLOSE","requestId":"${nonce}"}\n`);
  await first.waitFor((m) => m.spots?.[1] === true);
  assert.equal(first.messages.some((m) => m.type === 'gate-result'), false);
  assert.equal(f.bridge.snapshot.gate, 'closed');
  assert.equal(f.bridge.snapshot.gatePending, 'open');
  serial.data(`{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"${nonce}"}\n`);
  assert.deepEqual(await first.waitFor((m) => m.type === 'gate-result'), { type: 'gate-result', requestId: 'owner-1', status: 'confirmed', gate: 'open' });
  assert.equal(f.bridge.snapshot.gatePending, null);
  first.socket.send(JSON.stringify({ type: 'gate-command', requestId: 'firmware-reject', action: 'close' }));
  const closeWire = await waitForSerialWrite(serial, 'GATE_CLOSE ');
  const closeNonce = closeWire.slice('GATE_CLOSE '.length).trim();
  serial.data(`{"spots":[false,false,false,false],"gate":"open","ack":"GATE_CLOSE","requestId":"${closeNonce}","error":"GATE_BUSY"}\n`);
  assert.deepEqual(await first.waitFor((m) => m.type === 'gate-result' && m.requestId === 'firmware-reject'), { type: 'gate-result', requestId: 'firmware-reject', status: 'rejected', gate: 'open', error: 'GATE_BUSY' });
  assert.equal(f.bridge.snapshot.gate, 'open');
  assert.equal(f.serials().length, 1);
});

test('rejects malformed text and binary commands without mutating snapshots or serial state', async (t) => {
  const f = await fixture(FakeSerial, { bootGraceMs: 10_000, maxLineBytes: 1024 }); ownCleanup(t, f);
  const inbox = await f.clientWithOrigin('http://localhost:4321');
  const serial = f.serials()[0]!;
  serial.open();
  serial.data('{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n');
  await inbox.waitFor((m) => m.gateReady === true);
  const baseline = f.bridge.snapshot;
  const writes = [...serial.writes];
  const invalid = [
    '{"type":"gate-command","requestId":"bad","action":"open","extra":1}',
    '{"type":"gate-command","requestId":"bad\\n","action":"open"}',
    '{"type":"gate-command","requestId":"bad","action":"open"}\\nmore',
  ];
  for (const raw of invalid) {
    inbox.socket.send(raw);
    await inbox.waitFor((m) => m.type === 'gate-result', inbox.messages.length);
  }
  inbox.socket.send(Buffer.from('{"type":"gate-command","requestId":"binary","action":"open"}'), { binary: true });
  await inbox.waitFor((m) => m.type === 'gate-result', inbox.messages.length);
  assert.deepEqual(serial.writes, writes);
  assert.equal(f.bridge.snapshot.updatedAt, baseline.updatedAt);
  assert.equal(f.bridge.snapshot.gatePending, null);
});
