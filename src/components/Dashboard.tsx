import { useEffect, useState } from 'react';
import { Activity, ArrowDown, ArrowDownLeft, ArrowRight, ArrowUpRight, Cable, ChevronRight, CircleParking, Clock3, Cpu, FlaskConical, LayoutDashboard, Radio, ShieldCheck, SquareParking, Unplug, Wifi, WifiOff } from 'lucide-react';
import { createDashboard, receiveSnapshot, toggleDemoSpot } from '../lib/dashboard-state';
import { parseSnapshot } from '../lib/protocol';
import type { BarrierState } from '../lib/protocol';

interface Props { demo: boolean; wsUrl: string }
const timeLabel = (value: string) => new Date(value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Vehicle() {
  return <div className="vehicle" aria-hidden="true"><span className="car-windshield" /><span className="car-roof" /><span className="car-rear" /><i className="wheel w1" /><i className="wheel w2" /><i className="wheel w3" /><i className="wheel w4" /><i className="light l1" /><i className="light l2" /><i className="light l3" /><i className="light l4" /></div>;
}

function Barrier({ direction, state }: { direction: 'entry' | 'exit'; state: BarrierState | undefined }) {
  const entry = direction === 'entry';
  const real = state !== undefined && state !== 'unknown';
  return <div className="barrier-row"><div className="barrier-icon">{entry ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}</div><div className="barrier-copy"><strong>Barrera de {entry ? 'entrada' : 'salida'}</strong><span>{real ? 'Estado recibido de Arduino' : 'Servo SG90 · sin conectar'}</span></div><span className={`barrier-state ${real ? 'real' : ''}`}>{real ? state === 'open' ? 'Abierta' : 'Cerrada' : 'Demo'}</span></div>;
}

export default function Dashboard({ demo, wsUrl }: Props) {
  const [state, setState] = useState(() => createDashboard(demo));
  const [socketStatus, setSocketStatus] = useState<'connecting' | 'online' | 'offline'>(demo ? 'offline' : 'connecting');
  const [error, setError] = useState('');
  const [clock, setClock] = useState('');
  useEffect(() => {
    const update = () => setClock(new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (demo) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let watchdog: number | undefined;
    let attempts = 0;
    const connect = () => {
      if (disposed) return;
      setSocketStatus('connecting');
      try {
        const url = wsUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:8080`;
        socket = new WebSocket(url);
        watchdog = window.setTimeout(() => socket?.close(), 8000);
        socket.onopen = () => { window.clearTimeout(watchdog); attempts = 0; setSocketStatus('online'); setError(''); };
        socket.onmessage = (event: MessageEvent) => {
          try {
            const snapshot = parseSnapshot(JSON.parse(String(event.data)));
            if (!snapshot) { setError('Mensaje no válido del bridge. Se conserva la última lectura.'); return; }
            setError('');
            setState(previous => receiveSnapshot(previous, snapshot));
          } catch { setError('No se pudo interpretar el mensaje del bridge.'); }
        };
        socket.onerror = () => setError('No se pudo conectar con el bridge. Comprueba npm run dev:bridge.');
        socket.onclose = () => {
          window.clearTimeout(watchdog);
          if (disposed) return;
          setSocketStatus('offline');
          retry = window.setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10000));
        };
      } catch {
        setSocketStatus('offline');
        setError('URL WebSocket no válida. Revisa PUBLIC_WS_URL y reinicia Astro.');
      }
    };
    connect();
    return () => { disposed = true; window.clearTimeout(retry); window.clearTimeout(watchdog); if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null; socket.close(); } };
  }, [demo, wsUrl]);

  const occupied = state.spots?.filter(Boolean).length ?? null;
  const available = occupied === null ? null : 4 - occupied;
  const live = !demo && socketStatus === 'online' && state.connected;
  const stale = !demo && !live && state.spots !== null;
  const connectionLabel = demo ? 'Simulación activa' : live ? 'Arduino conectado' : socketStatus === 'online' ? 'Arduino desconectado' : socketStatus === 'connecting' ? 'Conectando al bridge' : 'Bridge desconectado';
  const changeSpot = (index: number) => setState(previous => toggleDemoSpot(previous, index));

  return <div className="app-shell">
    <aside className="rail" aria-label="Navegación principal">
      <a className="rail-brand" href="#overview" aria-label="Smart Parking, inicio"><SquareParking size={26} strokeWidth={2.2} /></a>
      <div className="rail-nav"><a className="rail-link active" href="#overview" aria-label="Resumen"><LayoutDashboard size={21} /></a><a className="rail-link" href="#parking" aria-label="Plano del estacionamiento"><CircleParking size={22} /></a><a className="rail-link" href="#activity" aria-label="Actividad reciente"><Activity size={21} /></a><a className="rail-link" href="#system" aria-label="Estado del sistema"><Cpu size={21} /></a></div>
      <a className="rail-bottom" href="#system" aria-label="Información de conexión"><Cable size={21} /></a>
    </aside>
    <div className="workspace" id="overview">
      <header className="topbar"><a href="#overview" className="brand"><span className="mobile-brand"><SquareParking size={24} /></span>Smart<span>Parking</span><span className="brand-divider" /><span className="brand-description">Sistema de estacionamiento inteligente</span></a><div className="topbar-right"><span className="realtime"><span className={`status-dot ${live ? 'green' : demo ? 'amber' : 'muted'}`} />{live ? 'En tiempo real' : demo ? 'Entorno de demostración' : 'Esperando conexión'}</span><span className="topbar-clock"><Clock3 size={14} />{clock || '—'}</span></div></header>
      <main>
        <section className="page-heading"><div><div className="breadcrumb">Smart Parking <ChevronRight size={13} /> Monitoreo</div><h1>Todo bajo control<span>.</span></h1><p>Tu estacionamiento, conectado en un solo lugar.</p></div><div className={`connection-badge ${live ? 'connected' : demo ? 'demo' : 'disconnected'}`} role="status">{demo ? <FlaskConical size={16} /> : live ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{connectionLabel}</span></div></section>
        <div className={`mode-banner ${demo ? 'demo-banner' : ''}`}><div>{demo ? <FlaskConical size={17} /> : <Radio size={17} />}<span>{demo ? <><strong>Modo simulación.</strong> Pulsa un puesto del plano para ocuparlo o liberarlo.</> : <><strong>Modo hardware.</strong> {stale ? 'Última lectura conservada. Los datos no están en vivo.' : live ? 'Los cambios del Arduino se reflejan automáticamente.' : 'La interfaz está lista. Esperando una lectura del Arduino.'}</>}</span></div><span className="mode-code">{demo ? 'SIN HARDWARE' : 'USB SERIAL'}</span></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <section className="metrics" aria-label="Métricas del estacionamiento">
          <div className="metric available"><div className="metric-label"><span>Puestos disponibles</span><CircleParking size={18} /></div><div className="metric-number">{available ?? '—'}<span>/ 04</span></div><div className="metric-foot"><span className="status-dot green" />{available === null ? 'Esperando datos' : available === 0 ? 'Sin espacios disponibles' : 'Listos para estacionar'}</div></div>
          <div className="metric occupied-metric"><div className="metric-label"><span>Puestos ocupados</span><SquareParking size={18} /></div><div className="metric-number">{occupied === null ? '—' : String(occupied).padStart(2, '0')}<span>/ 04</span></div><div className="metric-foot"><span className="status-dot coral" />{occupied === null ? 'Sin lectura de ocupación' : 'Vehículos en el estacionamiento'}</div></div>
          <div className="metric"><div className="metric-label"><span>Capacidad total</span><LayoutDashboard size={18} /></div><div className="metric-number">04<span>puestos</span></div><div className="metric-foot">Un espacio para cada vehículo</div></div>
          <div className="metric"><div className="metric-label"><span>Ocupación actual</span><Activity size={18} /></div><div className="metric-number">{occupied === null ? '—' : occupied * 25}<span>%</span></div><div className="occupancy-track" aria-hidden="true"><span style={{ width: `${(occupied ?? 0) * 25}%` }} /></div><div className="sr-only">{occupied === null ? 'Ocupación desconocida' : `${occupied * 25} por ciento de ocupación`}</div></div>
        </section>
        <div className="dashboard-grid">
          <section className="parking-panel panel" id="parking" aria-labelledby="parking-title"><div className="panel-heading"><div><h2 id="parking-title">Vista del estacionamiento</h2><p>Un reflejo digital de nuestra maqueta.</p></div><span className="floor-label">PLANTA 01</span></div>
            <div className="map-legend"><span><i className="legend-dot free-dot" />Disponible</span><span><i className="legend-dot busy-dot" />Ocupado</span><span><i className="legend-dot unknown-dot" />Sin datos</span><span className="map-orientation">N <ArrowUpRight size={14} /></span></div>
            <div className={`parking-map ${stale ? 'stale' : ''}`}>
              <div className="landscape"><span /><span /><span /><div>SMART PARKING</div><span /><span /><span /></div>
              <div className="bay-row">{[0, 1, 2, 3].map(index => {
                const known = state.spots !== null;
                const busy = state.spots?.[index] ?? false;
                const label = `Puesto ${String(index + 1).padStart(2, '0')}`;
                return <button key={index} className={`parking-bay ${known ? busy ? 'is-occupied' : 'is-free' : 'is-unknown'}`} disabled={!demo} onClick={() => changeSpot(index)} aria-label={`${label}: ${known ? busy ? 'ocupado' : 'libre' : 'sin datos'}${demo ? '. Cambiar estado' : ''}`} aria-pressed={demo ? busy : undefined}><span className="bay-number">{String(index + 1).padStart(2, '0')}</span><div className="bay-vehicle"><Vehicle /><span className="empty-space">{known ? <CircleParking size={31} strokeWidth={1.1} /> : <Unplug size={25} strokeWidth={1.2} />}</span></div><span className="bay-status"><i />{known ? busy ? 'Ocupado' : 'Libre' : 'Sin datos'}</span><span className="bay-caption">PUESTO {String(index + 1).padStart(2, '0')}</span></button>;
              })}</div>
              <div className="internal-road"><ArrowRight className="road-arrow first" size={33} strokeWidth={1.3} /><span className="road-label">CIRCULACIÓN</span><ArrowRight className="road-arrow last" size={33} strokeWidth={1.3} /><span className="road-dash" /></div>
              <div className="access-row"><div className="access-lane entry-lane"><div className="gate-arm" /><ArrowDown size={23} className="entry-arrow" /><span>ENTRADA</span></div><div className="map-island"><ShieldCheck size={20} /><span>Zona monitoreada</span><div className="island-stripes" /></div><div className="access-lane exit-lane"><div className="gate-arm" /><ArrowDown size={23} /><span>SALIDA</span></div></div>
            </div>
            <div className="map-bottom"><span><span className={`status-dot ${demo ? 'amber' : live ? 'green' : 'muted'}`} />{demo ? 'Control manual habilitado' : live ? 'Sincronizado con Arduino Uno' : stale ? 'Lectura anterior · conexión interrumpida' : 'Esperando primera lectura'}</span><span>{state.updatedAt ? `Actualizado ${timeLabel(state.updatedAt)}` : 'Sin actualizaciones'}</span></div>
            <div className="spot-summary" aria-label="Estado individual">{[0, 1, 2, 3].map(index => <div key={index}><span className={`small-bay ${state.spots === null ? 'unknown' : state.spots[index] ? 'busy' : 'free'}`}>{String(index + 1).padStart(2, '0')}</span><span>Puesto {String(index + 1).padStart(2, '0')}<strong>{state.spots === null ? 'Sin datos' : state.spots[index] ? 'Ocupado' : 'Disponible'}</strong></span></div>)}</div>
          </section>
          <aside className="side-panels">
            <section className="panel barriers-panel"><div className="panel-heading"><h2>Control de accesos</h2><span className="subtle-icon"><ShieldCheck size={17} /></span></div><Barrier direction="entry" state={state.barriers?.entry} /><Barrier direction="exit" state={state.barriers?.exit} /><div className="barrier-note"><FlaskConical size={14} /><span>Barreras ilustrativas. Preparadas para la próxima etapa del proyecto.</span></div></section>
            <section className="panel activity-panel" id="activity"><div className="panel-heading"><h2>Actividad reciente</h2><span className="event-count">{state.events.length}</span></div><div className="activity-list" aria-live="polite" aria-relevant="additions">{state.events.length === 0 ? <div className="empty-activity"><Activity size={28} strokeWidth={1.2} /><strong>Todo empieza con un cambio</strong><p>{demo ? 'Pulsa un puesto del plano y observa la actividad aquí.' : 'Los cambios reales de conexión y ocupación aparecerán aquí.'}</p></div> : state.events.map(event => <div className="activity-event" key={event.id}><span className={`event-icon ${event.kind}`}>{event.kind === 'connection' ? <Cable size={14} /> : event.kind === 'occupied' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}</span><div><strong>{event.message}</strong><span>{demo ? 'Simulación manual' : 'Evento de hardware'}</span></div><time dateTime={event.time}>{timeLabel(event.time)}</time></div>)}</div><div className="activity-footer"><span className="status-dot muted" />Solo eventos de esta sesión · máximo 30</div></section>
          </aside>
        </div>
        <section className="system-strip" id="system"><div className="system-title"><Cpu size={19} /><span>El sistema, de un vistazo</span></div><div><span>CONTROLADOR</span><strong>Arduino Uno</strong></div><div><span>CONEXIÓN</span><strong>{demo ? 'Simulación local' : socketStatus === 'online' ? 'Bridge disponible' : 'Bridge sin conexión'}</strong></div><div><span>ENTRADAS</span><strong>4 puestos · D2–D5</strong></div><details className="setup-details"><summary>Conectar hardware <ChevronRight size={14} /></summary><div><strong>De la maqueta a la pantalla</strong><p>Sube arduino/SmartParking/SmartParking.ino desde Arduino IDE. Cierra su monitor serial, configura ARDUINO_PORT en .env y ejecuta npm run dev:all.</p><p>Para hardware usa PUBLIC_DEMO_MODE=false. Para simular, cambia a true y reinicia Astro. En tablet o móvil, PUBLIC_WS_URL debe apuntar a la IP de esta computadora; habilita WS_HOST solo en una red de confianza.</p></div></details></section>
        <footer><span><SquareParking size={14} />Smart Parking <i /> Ingeniería que conecta.</span><span>Arduino + Astro <span className="footer-dot">·</span> Proyecto universitario</span></footer>
      </main>
    </div>
  </div>;
}
