export type Spots = [boolean, boolean, boolean, boolean];
export type BarrierState = 'open' | 'closed' | 'unknown';
export type GateState = 'open' | 'closed';
export type GateAction = 'open' | 'close';
export type GateCommand = { type: 'gate-command'; requestId: string; action: GateAction };
export type GateErrorCode = 'INVALID_COMMAND' | 'ORIGIN_NOT_ALLOWED' | 'ARDUINO_DISCONNECTED' | 'NOT_SYNCHRONIZED' | 'PARKING_FULL' | 'GATE_BUSY' | 'SERIAL_WRITE_FAILED' | 'ACK_TIMEOUT' | 'FIRMWARE_REJECTED';
export type GateResult = { type: 'gate-result'; requestId: string | null; status: 'confirmed' | 'rejected'; gate: GateState | null; error?: GateErrorCode };
export type Snapshot = {
  type: 'snapshot'; spots: Spots | null; connected: boolean; updatedAt: string | null;
  barriers: { entry: BarrierState; exit: BarrierState } | null;
  gate?: GateState | null; gateReady?: boolean; gatePending?: GateAction | null;
};
export type ArduinoMessage = {
  spots: Spots; barriers?: { entry: BarrierState; exit: BarrierState };
  gate?: GateState; ack?: 'SYNC' | 'GATE_OPEN' | 'GATE_CLOSE'; requestId?: string;
  error?: 'PARKING_FULL' | 'GATE_BUSY' | 'INVALID_COMMAND';
};

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value);
const isGate = (value: unknown): value is GateState => value === 'open' || value === 'closed';
const isGateAction = (value: unknown): value is GateAction => value === 'open' || value === 'close';
const validBarriers = (value: unknown): value is { entry: BarrierState; exit: BarrierState } => {
  if (!value || typeof value !== 'object') return false;
  const barriers = value as Record<string, unknown>;
  return ['open', 'closed', 'unknown'].includes(String(barriers.entry)) && ['open', 'closed', 'unknown'].includes(String(barriers.exit));
};
const validSpots = (value: unknown): value is Spots => Array.isArray(value) && value.length === 4 && value.every((spot) => typeof spot === 'boolean');
const gateErrors: GateErrorCode[] = ['INVALID_COMMAND', 'ORIGIN_NOT_ALLOWED', 'ARDUINO_DISCONNECTED', 'NOT_SYNCHRONIZED', 'PARKING_FULL', 'GATE_BUSY', 'SERIAL_WRITE_FAILED', 'ACK_TIMEOUT', 'FIRMWARE_REJECTED'];
const ownKeysOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));

export function parseGateCommand(input: unknown): GateCommand | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!ownKeysOnly(value, ['type', 'requestId', 'action']) || value.type !== 'gate-command' || !safeId(value.requestId) || !isGateAction(value.action)) return null;
  return { type: 'gate-command', requestId: value.requestId, action: value.action };
}

export function parseGateResult(input: unknown): GateResult | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (!ownKeysOnly(value, ['type', 'requestId', 'status', 'gate', 'error']) || value.type !== 'gate-result') return null;
  if (value.status === 'confirmed' && safeId(value.requestId) && isGate(value.gate) && value.error === undefined) return { type: 'gate-result', requestId: value.requestId, status: 'confirmed', gate: value.gate };
  if (value.status === 'rejected' && (value.requestId === null || safeId(value.requestId)) && (value.gate === null || isGate(value.gate)) && typeof value.error === 'string' && gateErrors.includes(value.error as GateErrorCode)) return { type: 'gate-result', requestId: value.requestId as string | null, status: 'rejected', gate: value.gate as GateState | null, error: value.error as GateErrorCode };
  return null;
}

export function toSerialGateCommand(action: GateAction, requestId: string): string | null {
  if (!isGateAction(action) || !safeId(requestId)) return null;
  return `GATE_${action === 'open' ? 'OPEN' : 'CLOSE'} ${requestId}\n`;
}

export function parseArduinoMessage(line: string): ArduinoMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!validSpots(record.spots)) return null;
    if (record.barriers !== undefined && !validBarriers(record.barriers)) return null;
    const hasGateMetadata = ['ack', 'requestId', 'error'].some((key) => record[key] !== undefined);
    if (record.gate !== undefined && !isGate(record.gate)) return null;
    if (hasGateMetadata && !isGate(record.gate)) return null;
    if (record.ack !== undefined && (typeof record.ack !== 'string' || !['SYNC', 'GATE_OPEN', 'GATE_CLOSE'].includes(record.ack))) return null;
    if (record.requestId !== undefined && !safeId(record.requestId)) return null;
    if (record.error !== undefined && (typeof record.error !== 'string' || !['PARKING_FULL', 'GATE_BUSY', 'INVALID_COMMAND'].includes(record.error))) return null;
    return { spots: record.spots, ...(record.barriers === undefined ? {} : { barriers: record.barriers }), ...(record.gate === undefined ? {} : { gate: record.gate }), ...(record.ack === undefined ? {} : { ack: record.ack }), ...(record.requestId === undefined ? {} : { requestId: record.requestId }), ...(record.error === undefined ? {} : { error: record.error }) } as ArduinoMessage;
  } catch { return null; }
}

export function parseSnapshot(input: unknown): Snapshot | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.type !== 'snapshot' || (value.spots !== null && !validSpots(value.spots)) || typeof value.connected !== 'boolean') return null;
  if (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)))) return null;
  if (value.barriers !== null && !validBarriers(value.barriers)) return null;
  if (value.gate !== undefined && value.gate !== null && !isGate(value.gate)) return null;
  if (value.gateReady !== undefined && typeof value.gateReady !== 'boolean') return null;
  if (value.gatePending !== undefined && value.gatePending !== null && !isGateAction(value.gatePending)) return null;
  if (value.gateReady === true && !isGate(value.gate)) return null;
  return { type: 'snapshot', spots: value.spots, connected: value.connected, updatedAt: value.updatedAt, barriers: value.barriers, ...(value.gate === undefined ? {} : { gate: value.gate }), ...(value.gateReady === undefined ? {} : { gateReady: value.gateReady }), ...(value.gatePending === undefined ? {} : { gatePending: value.gatePending }) } as Snapshot;
}

export function getSpotChanges(previous: Spots | null, next: Spots): Array<{ index: number; occupied: boolean }> {
  if (!previous) return [];
  return next.flatMap((occupied, index) => previous[index] === occupied ? [] : [{ index, occupied }]);
}
