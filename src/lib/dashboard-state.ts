import type { Snapshot, Spots } from './protocol';

export interface ActivityEvent {
  id: number;
  message: string;
  time: string;
  kind: 'occupied' | 'free' | 'connection';
}

export interface DashboardState {
  demo: boolean;
  spots: Spots | null;
  connected: boolean;
  updatedAt: string | null;
  barriers: Snapshot['barriers'];
  events: ActivityEvent[];
  sequence: number;
}

export function createDashboard(demo: boolean): DashboardState {
  return { demo, spots: demo ? [false, false, false, false] : null, connected: false, updatedAt: null, barriers: null, events: [], sequence: 0 };
}

function addEvent(state: DashboardState, message: string, kind: ActivityEvent['kind'], time: string): DashboardState {
  const id = state.sequence + 1;
  return { ...state, sequence: id, events: [{ id, message, kind, time }, ...state.events].slice(0, 30) };
}

function transition(state: DashboardState, spots: Spots, time: string): DashboardState {
  let next: DashboardState = { ...state, spots, updatedAt: time };
  if (state.spots) {
    spots.forEach((occupied, index) => {
      if (state.spots![index] !== occupied) {
        next = addEvent(next, `Puesto ${String(index + 1).padStart(2, '0')} ${occupied ? 'ocupado' : 'liberado'}`, occupied ? 'occupied' : 'free', time);
      }
    });
  }
  return next;
}

export function toggleDemoSpot(state: DashboardState, index: number, time = new Date().toISOString()): DashboardState {
  if (!state.demo || !state.spots || !Number.isInteger(index) || index < 0 || index > 3) return state;
  const spots: Spots = [...state.spots];
  spots[index] = !spots[index];
  return transition(state, spots, time);
}

export function receiveSnapshot(state: DashboardState, snapshot: Snapshot): DashboardState {
  if (state.demo) return state;
  const time = new Date().toISOString();
  let next = snapshot.spots ? transition(state, snapshot.spots, snapshot.updatedAt ?? time) : state;
  if (state.connected !== snapshot.connected) {
    next = addEvent(next, snapshot.connected ? 'Arduino conectado' : 'Arduino desconectado', 'connection', time);
  }
  return { ...next, connected: snapshot.connected, updatedAt: snapshot.updatedAt, barriers: snapshot.barriers };
}
