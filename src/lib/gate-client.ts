import type { GateAction, GateCommand } from './protocol';

export function createGateCommand(action: GateAction, requestId: string): GateCommand | null {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(requestId) || (action !== 'open' && action !== 'close')) return null;
  return { type: 'gate-command', requestId, action };
}

export function newGateRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '_');
}
