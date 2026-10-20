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
  constructor(public options: { path: string; baudRate: number }) { FakeSerial.instances.push(this); }
  on(name: string, callback: (...args: any[]) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); return this; }
  write(data: string, callback?: (error?: Error | null) => void) { this.writes.push(data); callback?.(); return true; }
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
  async waitFor(predicate: (message: any) => boolean, from = 0) {
    const deadline = Date.now() + 2000;
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
    async client() {
      const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
      clients.push(socket);
      const inbox = new Inbox(socket);
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      return inbox;
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const client of clients) client.terminate();
      await bridge.close();
    },
  };
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

test('validates configuration before constructing serial transport', async () => {
  let constructed = false;
  class ShouldNotConstruct extends FakeSerial { constructor(options: { path: string; baudRate: number }) { constructed = true; super(options); } }
  await assert.rejects(() => createBridge({ SerialPort: ShouldNotConstruct as any, serialPath: '/dev/fake', baudRate: 0, wsHost: '127.0.0.1', wsPort: 0 }));
  assert.equal(constructed, false);
});
