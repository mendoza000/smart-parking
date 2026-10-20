import { pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import { CompatibleSerialPort } from './serial-port.ts';
import { WebSocketServer, WebSocket } from 'ws';
import { parseArduinoMessage, type Snapshot } from '../src/lib/protocol.ts';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

type SerialLike = {
  readonly isOpen?: boolean;
  readonly opening?: boolean;
  readonly closing?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  write(data: string, callback?: (error?: Error | null) => void): unknown;
  close(callback?: (error?: Error | null) => void): unknown;
};
type SerialConstructor = new (options: { path: string; baudRate: number }) => SerialLike;
type BridgeOptions = { SerialPort?: SerialConstructor; serialPath?: string; baudRate?: number; wsHost?: string; wsPort?: number; reconnectMs?: number; bootGraceMs?: number; maxLineBytes?: number };

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export async function createBridge(options: BridgeOptions = {}) {
  const Serial = options.SerialPort ?? CompatibleSerialPort as unknown as SerialConstructor;
  const serialPath = options.serialPath ?? process.env.ARDUINO_PORT;
  if (!serialPath?.trim()) throw new Error('ARDUINO_PORT is required');
  const baudRate = integer(options.baudRate ?? process.env.ARDUINO_BAUD_RATE ?? 9600, 'ARDUINO_BAUD_RATE', 1, 4_000_000);
  const wsPort = integer(options.wsPort ?? process.env.WS_PORT ?? 8080, 'WS_PORT', 0, 65535);
  const wsHost = options.wsHost ?? process.env.WS_HOST ?? '127.0.0.1';
  const reconnectMs = integer(options.reconnectMs ?? 1000, 'reconnectMs', 1, 2_147_483_647);
  const bootGraceMs = integer(options.bootGraceMs ?? 2000, 'bootGraceMs', 0, 2_147_483_647);
  const maxLineBytes = integer(options.maxLineBytes ?? 1024, 'maxLineBytes', 1, 1_048_576);
  const server = new WebSocketServer({ host: wsHost, port: wsPort });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WebSocket server did not provide a TCP address');
  let snapshot: Snapshot = { type: 'snapshot', spots: null, connected: false, updatedAt: null, barriers: null };
  let serial: SerialLike | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let bootTimer: NodeJS.Timeout | null = null;
  let closed = false;
  let buffer = '';
  let discardingLine = false;
  let generation = 0;
  let closeRetryTimer: NodeJS.Timeout | null = null;
  let quarantined: SerialLike | null = null;
  let shutdownError: Error | null = null;
  const broadcast = () => {
    const message = JSON.stringify(snapshot);
    for (const client of server.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  };
  const updateConnection = (connected: boolean) => { if (snapshot.connected !== connected) { snapshot = { ...snapshot, connected }; broadcast(); } };
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectMs);
  };
  const connect = () => {
    if (closed || serial) return;
    let current: SerialLike;
    try {
      current = new Serial({ path: serialPath, baudRate });
    } catch (error) {
      console.error(`Serial bridge error for ${serialPath}: ${error instanceof Error ? error.message : String(error)}`);
      updateConnection(false);
      scheduleReconnect();
      return;
    }
    serial = current;
    const token = ++generation;
    buffer = '';
    discardingLine = false;
    current.on('open', () => {
      if (serial !== current || closed || quarantined === current) return;
      updateConnection(true);
      current.write('SYNC\n', (error) => { if (error) handleError(current, token, error); });
      if (bootTimer) clearTimeout(bootTimer);
      bootTimer = setTimeout(() => { bootTimer = null; if (serial === current && !closed) current.write('SYNC\n', (error) => { if (error) handleError(current, token, error); }); }, bootGraceMs);
    });
    current.on('data', (chunk: Buffer | string) => {
      if (serial !== current || closed || quarantined === current) return;
      let remaining = chunk.toString();
      while (remaining.length) {
        if (discardingLine) {
          const end = remaining.indexOf('\n');
          if (end < 0) return;
          remaining = remaining.slice(end + 1);
          discardingLine = false;
          buffer = '';
          continue;
        }
        const end = remaining.indexOf('\n');
        if (end < 0) {
          const tail = remaining;
          if (Buffer.byteLength(buffer) + Buffer.byteLength(tail) > maxLineBytes) {
            buffer = '';
            discardingLine = true;
          } else buffer += tail;
          return;
        }
        const part = remaining.slice(0, end);
        if (Buffer.byteLength(buffer) + Buffer.byteLength(part) <= maxLineBytes) {
          const parsed = parseArduinoMessage((buffer + part).trim());
          if (parsed) {
            snapshot = { ...snapshot, spots: parsed.spots, barriers: parsed.barriers ?? snapshot.barriers, updatedAt: new Date().toISOString() };
            broadcast();
          }
        }
        buffer = '';
        remaining = remaining.slice(end + 1);
      }
    });
    current.on('close', () => handleClose(current, token));
    current.on('error', (error: Error) => handleError(current, token, error));
  };
  const handleClose = (current: SerialLike, token: number) => {
    if (serial !== current || closed || token !== generation) return;
    release(current, token);
  };
  const release = (current: SerialLike, token: number) => {
    if (serial !== current || token !== generation) return;
    serial = null;
    quarantined = null;
    if (closeRetryTimer) { clearTimeout(closeRetryTimer); closeRetryTimer = null; }
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    buffer = '';
    discardingLine = false;
    updateConnection(false);
    if (!closed) scheduleReconnect();
  };
  const attemptClose = (current: SerialLike, token: number) => {
    if (serial !== current || token !== generation || closed) return;
    try {
      current.close((error) => {
        if (serial !== current || token !== generation) return;
        if (error) {
          console.error(`Serial close error for ${serialPath}: ${error.message}`);
          if (/port is not open/i.test(error.message) && current.isOpen === false && !current.opening && !current.closing) { release(current, token); return; }
          closeRetryTimer = setTimeout(() => { closeRetryTimer = null; attemptClose(current, token); }, reconnectMs);
          return;
        }
        release(current, token);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Serial close error for ${serialPath}: ${detail}`);
      closeRetryTimer = setTimeout(() => { closeRetryTimer = null; attemptClose(current, token); }, reconnectMs);
    }
  };
  const handleError = (current: SerialLike, token: number, error: Error) => {
    if (serial !== current || closed || token !== generation || quarantined === current) return;
    console.error(`Serial bridge error for ${serialPath}: ${error.message}`);
    quarantined = current;
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    buffer = '';
    discardingLine = false;
    updateConnection(false);
    attemptClose(current, token);
  };
  server.on('connection', (client) => client.send(JSON.stringify(snapshot)));
  connect();
  return {
    port: address.port,
    host: wsHost,
    get snapshot() { return snapshot; },
    async close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (bootTimer) clearTimeout(bootTimer);
      if (closeRetryTimer) clearTimeout(closeRetryTimer);
      reconnectTimer = bootTimer = closeRetryTimer = null;
      const current = serial;
      if (current) await new Promise<void>((resolve, reject) => {
        try {
          current.close((error) => {
            if (error) {
              shutdownError = error;
              console.error(`Serial close error for ${serialPath}: ${error.message}`);
              reject(error);
            } else { serial = null; resolve(); }
          });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          shutdownError = failure;
          console.error(`Serial close error for ${serialPath}: ${failure.message}`);
          reject(failure);
        }
      }).catch((error) => { shutdownError ??= error instanceof Error ? error : new Error(String(error)); });
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (shutdownError) throw shutdownError;
    },
  };
}

async function main() {
  const bridge = await createBridge();
  console.log(`Smart Parking bridge listening on ws://${bridge.host}:${bridge.port}`);
  const shutdown = () => { void bridge.close().then(() => process.exit(0), (error) => { console.error(`Bridge shutdown failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`Bridge startup failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
