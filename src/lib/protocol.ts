export type Spots = [boolean, boolean, boolean, boolean];
export type BarrierState = 'open' | 'closed' | 'unknown';
export type Snapshot = {
  type: 'snapshot';
  spots: Spots | null;
  connected: boolean;
  updatedAt: string | null;
  barriers: { entry: BarrierState; exit: BarrierState } | null;
};
export type ArduinoMessage = { spots: Spots; barriers?: { entry: BarrierState; exit: BarrierState } };

const validBarriers = (value: unknown): value is { entry: BarrierState; exit: BarrierState } => {
  if (!value || typeof value !== 'object') return false;
  const barriers = value as Record<string, unknown>;
  return ['open', 'closed', 'unknown'].includes(String(barriers.entry)) && ['open', 'closed', 'unknown'].includes(String(barriers.exit));
};
const validSpots = (value: unknown): value is Spots => Array.isArray(value) && value.length === 4 && value.every((spot) => typeof spot === 'boolean');

export function parseArduinoMessage(line: string): ArduinoMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (!validSpots(record.spots)) return null;
    if (record.barriers !== undefined && !validBarriers(record.barriers)) return null;
    return { spots: record.spots, ...(record.barriers === undefined ? {} : { barriers: record.barriers }) };
  } catch { return null; }
}

export function parseSnapshot(input: unknown): Snapshot | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.type !== 'snapshot' || (value.spots !== null && !validSpots(value.spots)) || typeof value.connected !== 'boolean') return null;
  if (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt)))) return null;
  if (value.barriers !== null && !validBarriers(value.barriers)) return null;
  return { type: 'snapshot', spots: value.spots, connected: value.connected, updatedAt: value.updatedAt, barriers: value.barriers } as Snapshot;
}

export function getSpotChanges(previous: Spots | null, next: Spots): Array<{ index: number; occupied: boolean }> {
  if (!previous) return [];
  return next.flatMap((occupied, index) => previous[index] === occupied ? [] : [{ index, occupied }]);
}
