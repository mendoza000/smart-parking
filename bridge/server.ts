import { pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { CompatibleSerialPort } from './serial-port.ts';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { parseArduinoMessage, parseGateCommand, toSerialGateCommand, type GateAction, type GateErrorCode, type GateState, type Snapshot } from '../src/lib/protocol.ts';

try { loadEnvFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

type SerialLike = {
  readonly isOpen?: boolean; readonly opening?: boolean; readonly closing?: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  write(data: string, callback?: (error?: Error | null) => void): unknown;
  close(callback?: (error?: Error | null) => void): unknown;
};
type SerialConstructor = new (options: { path: string; baudRate: number }) => SerialLike;
type BridgeOptions = { SerialPort?: SerialConstructor; serialPath?: string; baudRate?: number; wsHost?: string; wsPort?: number; reconnectMs?: number; bootGraceMs?: number; maxLineBytes?: number; allowedOrigins?: string[]; gateAckTimeoutMs?: number };
const DEFAULT_ORIGINS = ['http://localhost:4321', 'http://127.0.0.1:4321'];
function isExactHttpOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value === '*' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin === value && parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch { return false; }
}
function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
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
  const gateAckTimeoutMs = integer(options.gateAckTimeoutMs ?? process.env.GATE_ACK_TIMEOUT_MS ?? 4000, 'GATE_ACK_TIMEOUT_MS', 1, 2_147_483_647);
  const originConfig = options.allowedOrigins ?? (process.env.WS_ALLOWED_ORIGINS ? process.env.WS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean) : DEFAULT_ORIGINS);
  if (!Array.isArray(originConfig) || originConfig.some((origin) => !isExactHttpOrigin(origin))) throw new Error('allowedOrigins must contain exact HTTP(S) origins without paths, credentials, or wildcards');
  const allowedOrigins = new Set(originConfig);
  const server = new WebSocketServer({ host: wsHost, port: wsPort, maxPayload: 1024 });
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
  let synchronizedGeneration = -1;
  let gateCapability = false;
  let confirmedGate: GateState | null = null;
  let pending: { nonce: string; requestId: string; owner: WebSocket; action: GateAction; generation: number; timer: NodeJS.Timeout } | null = null;
  const publish = () => {
    if (gateCapability) snapshot = { ...snapshot, gate: confirmedGate, gateReady: !closed && snapshot.connected && synchronizedGeneration === generation && serial !== null && quarantined !== serial, gatePending: pending?.action ?? null };
    const message = JSON.stringify(snapshot);
    for (const client of server.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
  };
  const result = (client: WebSocket, requestId: string | null, status: 'confirmed' | 'rejected', gate: GateState | null, error?: GateErrorCode) => {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify({ type: 'gate-result', requestId, status, gate, ...(error ? { error } : {}) }));
  };
  const updateConnection = (connected: boolean) => { if (snapshot.connected !== connected) { snapshot = { ...snapshot, connected }; publish(); } };
  const takePending = () => {
    if (!pending) return null;
    const item = pending;
    pending = null;
    clearTimeout(item.timer);
    return item;
  };
  const rejectTaken = (item: NonNullable<typeof pending>, error: GateErrorCode) => {
    result(item.owner, item.requestId, 'rejected', confirmedGate, error);
  };
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectMs);
  };
  const connect = () => {
    if (closed || serial) return;
    let current: SerialLike;
    try { current = new Serial({ path: serialPath, baudRate }); }
    catch (error) { console.error(`Serial bridge error for ${serialPath}: ${error instanceof Error ? error.message : String(error)}`); updateConnection(false); scheduleReconnect(); return; }
    serial = current;
    const token = ++generation;
    synchronizedGeneration = -1;
    buffer = ''; discardingLine = false;
    if (gateCapability) publish();
    current.on('open', () => {
      if (serial !== current || closed || quarantined === current) return;
      updateConnection(true);
      current.write('SYNC\n', (error) => { if (error) handleError(current, token, error, 'SERIAL_WRITE_FAILED'); });
      if (bootTimer) clearTimeout(bootTimer);
      bootTimer = setTimeout(() => { bootTimer = null; if (serial === current && !closed) current.write('SYNC\n', (error) => { if (error) handleError(current, token, error, 'SERIAL_WRITE_FAILED'); }); }, bootGraceMs);
    });
    current.on('data', (chunk: Buffer | string) => {
      if (serial !== current || closed || quarantined === current) return;
      let remaining = chunk.toString();
      while (remaining.length) {
        if (discardingLine) { const end = remaining.indexOf('\n'); if (end < 0) return; remaining = remaining.slice(end + 1); discardingLine = false; buffer = ''; continue; }
        const end = remaining.indexOf('\n');
        if (end < 0) { const tail = remaining; if (Buffer.byteLength(buffer) + Buffer.byteLength(tail) > maxLineBytes) { buffer = ''; discardingLine = true; } else buffer += tail; return; }
        const part = remaining.slice(0, end);
        if (Buffer.byteLength(buffer) + Buffer.byteLength(part) <= maxLineBytes) {
          const parsed = parseArduinoMessage((buffer + part).trim());
          if (parsed) {
            const wasCapable = gateCapability;
            const inflight = pending;
            const expectedAck = inflight?.action === 'open' ? 'GATE_OPEN' : 'GATE_CLOSE';
            const matchesInflight = Boolean(
              inflight && inflight.generation === token &&
              parsed.requestId === inflight.nonce && parsed.ack === expectedAck,
            );
            const targetGate = inflight?.action === 'open' ? 'open' : 'closed';
            const confirmsInflight = matchesInflight && !parsed.error && parsed.gate === targetGate;
            snapshot = {
              ...snapshot,
              spots: parsed.spots,
              barriers: parsed.barriers ?? snapshot.barriers,
              updatedAt: new Date().toISOString(),
            };
            if (parsed.gate !== undefined && (!inflight || confirmsInflight)) {
              gateCapability = true;
              confirmedGate = parsed.gate;
              snapshot = { ...snapshot, gate: confirmedGate };
            }
            if (parsed.ack === 'SYNC' && parsed.gate !== undefined && !parsed.error) {
              synchronizedGeneration = token;
            }
            if (matchesInflight && inflight) {
              pending = null;
              clearTimeout(inflight.timer);
              if (parsed.error) {
                const error = parsed.error === 'PARKING_FULL' ? 'PARKING_FULL'
                  : parsed.error === 'GATE_BUSY' ? 'GATE_BUSY' : 'FIRMWARE_REJECTED';
                result(inflight.owner, inflight.requestId, 'rejected', confirmedGate, error);
              } else if (confirmsInflight) {
                result(inflight.owner, inflight.requestId, 'confirmed', parsed.gate!);
              } else {
                result(inflight.owner, inflight.requestId, 'rejected', confirmedGate, 'FIRMWARE_REJECTED');
              }
            }
            if (wasCapable || gateCapability || parsed.ack) {
              publish();
            } else {
              const message = JSON.stringify(snapshot);
              for (const client of server.clients) {
                if (client.readyState === WebSocket.OPEN) client.send(message);
              }
            }
          }
        }
        buffer = ''; remaining = remaining.slice(end + 1);
      }
    });
    current.on('close', () => handleClose(current, token));
    current.on('error', (error: Error) => handleError(current, token, error));
  };
  const handleClose = (current: SerialLike, token: number) => { if (serial !== current || closed || token !== generation) return; release(current, token); };
  const release = (current: SerialLike, token: number) => {
    if (serial !== current || token !== generation) return;
    serial = null;
    synchronizedGeneration = -1;
    quarantined = null;
    const canceled = takePending();
    if (closeRetryTimer) { clearTimeout(closeRetryTimer); closeRetryTimer = null; }
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    buffer = ''; discardingLine = false;
    const wasConnected = snapshot.connected;
    snapshot = { ...snapshot, connected: false };
    if (gateCapability || wasConnected) publish();
    if (canceled) rejectTaken(canceled, 'ARDUINO_DISCONNECTED');
    if (!closed) scheduleReconnect();
  };
  const attemptClose = (current: SerialLike, token: number) => {
    if (serial !== current || token !== generation || closed) return;
    try { current.close((error) => {
      if (serial !== current || token !== generation) return;
      if (error) { console.error(`Serial close error for ${serialPath}: ${error.message}`); if (/port is not open/i.test(error.message) && current.isOpen === false && !current.opening && !current.closing) { release(current, token); return; } closeRetryTimer = setTimeout(() => { closeRetryTimer = null; attemptClose(current, token); }, reconnectMs); return; }
      release(current, token);
    }); } catch (error) { const detail = error instanceof Error ? error.message : String(error); console.error(`Serial close error for ${serialPath}: ${detail}`); closeRetryTimer = setTimeout(() => { closeRetryTimer = null; attemptClose(current, token); }, reconnectMs); }
  };
  const handleError = (current: SerialLike, token: number, error: Error, pendingError: GateErrorCode = 'ARDUINO_DISCONNECTED') => {
    if (serial !== current || closed || token !== generation || quarantined === current) return;
    console.error(`Serial bridge error for ${serialPath}: ${error.message}`);
    quarantined = current;
    synchronizedGeneration = -1;
    const canceled = takePending();
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    buffer = ''; discardingLine = false;
    const wasConnected = snapshot.connected;
    snapshot = { ...snapshot, connected: false };
    if (gateCapability || wasConnected) publish();
    if (canceled) rejectTaken(canceled, pendingError);
    attemptClose(current, token);
  };
  const handleCommand = (client: WebSocket, origin: string | undefined, data: Buffer) => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(data.toString('utf8'));
    } catch {
      result(client, null, 'rejected', confirmedGate, 'INVALID_COMMAND');
      return;
    }

    const command = parseGateCommand(decoded);
    if (!command) {
      result(client, null, 'rejected', confirmedGate, 'INVALID_COMMAND');
      return;
    }
    if (origin === undefined || !allowedOrigins.has(origin)) {
      result(client, command.requestId, 'rejected', confirmedGate, 'ORIGIN_NOT_ALLOWED');
      return;
    }
    if (!serial || !snapshot.connected || quarantined === serial) {
      result(client, command.requestId, 'rejected', confirmedGate, 'ARDUINO_DISCONNECTED');
      return;
    }
    if (synchronizedGeneration !== generation) {
      result(client, command.requestId, 'rejected', confirmedGate, 'NOT_SYNCHRONIZED');
      return;
    }
    if (pending) {
      result(client, command.requestId, 'rejected', confirmedGate, 'GATE_BUSY');
      return;
    }
    if (command.action === 'open' && (!snapshot.spots || snapshot.spots.every(Boolean))) {
      result(client, command.requestId, 'rejected', confirmedGate, 'PARKING_FULL');
      return;
    }

    const wireNonce = randomUUID();
    const wire = toSerialGateCommand(command.action, wireNonce);
    if (!wire) {
      result(client, command.requestId, 'rejected', confirmedGate, 'INVALID_COMMAND');
      return;
    }
    const currentSerial = serial;
    const commandGeneration = generation;
    const timer = setTimeout(() => {
      if (!pending || pending.nonce !== wireNonce || pending.generation !== commandGeneration) return;
      const item = pending;
      pending = null;
      synchronizedGeneration = -1;
      result(item.owner, item.requestId, 'rejected', confirmedGate, 'ACK_TIMEOUT');
      publish();
      if (!closed && serial === currentSerial && generation === commandGeneration) {
        currentSerial.write('SYNC\n', (error) => {
          if (error) handleError(currentSerial, commandGeneration, error, 'SERIAL_WRITE_FAILED');
        });
      }
    }, gateAckTimeoutMs);

    pending = { nonce: wireNonce, requestId: command.requestId, owner: client, action: command.action, generation: commandGeneration, timer };
    publish();
    try {
      currentSerial.write(wire, (error) => {
        if (error && pending?.nonce === wireNonce && pending.generation === commandGeneration) {
          handleError(currentSerial, commandGeneration, error, 'SERIAL_WRITE_FAILED');
        }
      });
    } catch (error) {
      if (pending?.nonce === wireNonce && pending.generation === commandGeneration) {
        const failure = error instanceof Error ? error : new Error(String(error));
        handleError(currentSerial, commandGeneration, failure, 'SERIAL_WRITE_FAILED');
      }
    }
  };
  server.on('connection', (client, request) => {
    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? undefined : originHeader;
    client.on('error', () => {});
    client.on('message', (data, isBinary) => { if (isBinary) { result(client, null, 'rejected', confirmedGate, 'INVALID_COMMAND'); return; } handleCommand(client, origin, rawDataBuffer(data)); });
    client.send(JSON.stringify(snapshot));
  });
  server.on('error', () => {});
  connect();
  return {
    port: address.port, host: wsHost, get snapshot() { return snapshot; },
    async close() {
      if (closed) return;
      closed = true;
      synchronizedGeneration = -1;
      const canceled = takePending();
      const wasConnected = snapshot.connected;
      snapshot = { ...snapshot, connected: false };
      if (gateCapability || wasConnected) publish();
      if (canceled) rejectTaken(canceled, 'ARDUINO_DISCONNECTED');
      if (reconnectTimer) clearTimeout(reconnectTimer); if (bootTimer) clearTimeout(bootTimer); if (closeRetryTimer) clearTimeout(closeRetryTimer);
      reconnectTimer = bootTimer = closeRetryTimer = null;
      const current = serial;
      if (current) await new Promise<void>((resolve, reject) => {
        try { current.close((error) => { if (error) { shutdownError = error; console.error(`Serial close error for ${serialPath}: ${error.message}`); reject(error); } else { serial = null; resolve(); } }); }
        catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); shutdownError = failure; console.error(`Serial close error for ${serialPath}: ${failure.message}`); reject(failure); }
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
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`Bridge startup failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
