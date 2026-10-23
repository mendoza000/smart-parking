import type { GateAction, GateState } from '../lib/protocol';

interface Props {
  demo: boolean;
  available: number | null;
  socketOnline: boolean;
  serialOnline: boolean;
  gateReady: boolean;
  gate: GateState | null | undefined;
  serverPending: GateAction | null;
  localPending: GateAction | null;
  error: string | null;
  onAction: (action: GateAction) => void;
}

const errors: Record<string, string> = {
  PARKING_FULL: 'No se puede abrir: todos los puestos están ocupados.',
  GATE_BUSY: 'La barrera ya está en movimiento. Espera a que termine.',
  ACK_TIMEOUT: 'No llegó la confirmación. Comprueba la conexión; no se reenviará el comando.',
  ARDUINO_DISCONNECTED: 'Arduino está desconectado. Comprueba el cable USB.',
  NOT_SYNCHRONIZED: 'Esperando sincronización con Arduino.',
  SERIAL_WRITE_FAILED: 'No se pudo enviar el comando. Comprueba el bridge y el puerto serie.',
  FIRMWARE_REJECTED: 'Arduino rechazó el comando. Comprueba el estado y vuelve a intentarlo.',
  INVALID_COMMAND: 'El bridge rechazó el comando.',
  ORIGIN_NOT_ALLOWED: 'El origen de esta página no está autorizado por el bridge.',
};

export default function EntryGateControls({ demo, available, socketOnline, serialOnline, gateReady, gate, serverPending, localPending, error, onAction }: Props) {
  const usable = !demo && socketOnline && serialOnline && gateReady && gate !== null && gate !== undefined;
  const pending = Boolean(serverPending || localPending);
  const openReason = demo ? 'Los controles de hardware no están disponibles en la simulación.'
    : !socketOnline ? 'Sin conexión con el bridge.' : !serialOnline ? 'Arduino está desconectado.'
    : !gateReady || gate == null ? 'Esperando un estado confirmado de Arduino.'
    : pending ? 'Hay un comando de barrera pendiente.' : available === 0 ? 'No hay puestos disponibles.' : '';
  const closeReason = demo ? 'Los controles de hardware no están disponibles en la simulación.'
    : !socketOnline ? 'Sin conexión con el bridge.' : !serialOnline ? 'Arduino está desconectado.'
    : !gateReady || gate == null ? 'Esperando un estado confirmado de Arduino.'
    : pending ? 'Hay un comando de barrera pendiente.' : '';
  const status = localPending ? `Enviando comando para ${localPending === 'open' ? 'abrir' : 'cerrar'}; se espera confirmación de Arduino.`
    : serverPending ? 'Arduino está moviendo la barrera; se conserva el último estado confirmado.'
    : error ? errors[error] ?? 'No se pudo completar el comando. Comprueba la conexión.'
    : !usable ? (demo ? 'Simulación: el movimiento de la barrera no se representa como hardware.' : openReason)
    : 'El SG90 no tiene sensor de posición: Arduino confirma su objetivo de software, no una medición física.';
  return <section className="entry-gate-controls" aria-label="Control de barrera de entrada">
    <div className="entry-gate-actions">
      <button type="button" onClick={() => onAction('open')} disabled={!usable || pending || available == null || available <= 0 || gate === 'open'} aria-describedby="entry-gate-status" title={openReason || undefined}>Abrir barrera</button>
      <button type="button" onClick={() => onAction('close')} disabled={!usable || pending || gate === 'closed'} aria-describedby="entry-gate-status" title={closeReason || undefined}>Cerrar barrera</button>
    </div>
    <p id="entry-gate-status" role={error ? 'alert' : 'status'} aria-live="polite">{status}</p>
    {(!usable || pending || available === 0) && <span className="sr-only">{openReason || closeReason}</span>}
  </section>;
}
