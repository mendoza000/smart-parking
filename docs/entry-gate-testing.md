# Probar la barrera de entrada

La barrera usa el SG90 en **D9**. Los cuatro puestos siguen siendo botones en **D2–D5**; no se necesita un quinto botón. El cierre es manual: llenar el estacionamiento o esperar no cierra la barrera.

## 1. Preparar la maqueta

1. Prueba inicialmente sin carga mecánica y con espacio para mover el brazo.
2. Conecta la señal del servo a D9. Usa alimentación regulada de 5 V adecuada para el servo y une su GND con GND del Arduino. D9 solo lleva la señal, no alimenta el motor.
3. Evita alimentar una carga mecánica desde el USB: una caída de tensión puede reiniciar el Uno y parecer un fallo de comunicación.
4. Los botones conectan cada pin D2–D5 a GND; el firmware usa `INPUT_PULLUP` y antirrebote.

El SG90 no comunica su posición real. La confirmación indica que el firmware aplicó el objetivo y terminó el intervalo de asentamiento, **no** que un sensor haya detectado un movimiento correcto o una barrera libre de obstáculos.

## 2. Subir el firmware manualmente

1. Detén el bridge con Ctrl+C antes de abrir el puerto desde Arduino IDE.
2. Abre `arduino/SmartParking/SmartParking.ino`, no el sketch independiente que abría y cerraba cada dos segundos.
3. Selecciona **Arduino Uno** y el puerto USB correcto, normalmente `/dev/ttyUSB0`. Instala la biblioteca **Servo** desde el gestor de bibliotecas si el IDE no encuentra `Servo.h`.
4. Revisa `GATE_CLOSED_ANGLE` (0), `GATE_OPEN_ANGLE` (90), `GATE_MIN_ANGLE`/`GATE_MAX_ANGLE` (0–90) y `GATE_SETTLE_MS` (600). Ajusta la calibración sin forzar los topes físicos; una configuración fuera de los límites declarados no compila.
5. Compila y sube desde el IDE. Este repositorio no realiza cargas automáticas.
6. Cierra Monitor Serie y Plotter Serie antes de volver a iniciar el bridge. Nunca abras el puerto simultáneamente desde IDE y Node.

Al arrancar, el firmware aplica el objetivo cerrado. Reabrir el puerto puede producir el reinicio normal por DTR del Uno y restablecer sus variables; el bridge no abre/cierra USB por cada navegador u orden, ni intenta ocultar ese comportamiento del hardware.

## 3. Probar desde el dashboard

Configura hardware con la plantilla pública `config.example` y tu archivo local `.env`: `PUBLIC_DEMO_MODE=false`, puerto correcto y 9600 baudios. Inicia:

```bash
npm run dev:all
# Alternativa si usas Bun:
bun run dev:all
```

Abre `http://localhost:4321`. Espera la sincronización del Arduino; una conexión USB abierta por sí sola no habilita movimientos. Firmware antiguo sin soporte de barrera puede seguir mostrando los puestos, pero no habilita estos controles.

1. Con al menos un puesto libre y barrera cerrada, pulsa **Abrir barrera**.
2. Debe aparecer la espera de confirmación y bloquearse una segunda maniobra. La posición visual no cambia solo por el clic.
3. Cuando llega la confirmación de Arduino, la barrera de entrada cambia a abierta y el plano lo representa. La barrera de salida sigue siendo demostración.
4. Pulsa los cuatro botones para ocupar todas las plazas. Abrir debe quedar bloqueado; **Cerrar barrera** sigue disponible si la barrera está abierta.
5. Espera unos segundos: no debe cerrarse automáticamente. Pulsa **Cerrar barrera** y comprueba que el cambio visual espera otra confirmación.
6. En una prueba sin carga, desconecta USB: los controles deben quedar deshabilitados y la última lectura identificada como anterior. Reconecta, espera la sincronización y comprueba el estado informado por Arduino. No se reenvía automáticamente una maniobra interrumpida.

En modo simulación, los cuatro puestos mantienen sus controles locales. Los controles del servo físico están deshabilitados y no se inventan confirmaciones de Arduino.

## 4. Comprobar la protección dentro de Arduino

Detén el bridge y abre Monitor Serie a 9600 baudios con final de línea nueva. El posible reinicio al abrir el puerto vuelve a inicializar la maqueta; ocupa de nuevo los puestos antes de probar aforo.

```text
SYNC
GATE_OPEN manual-1
GATE_CLOSE manual-2
```

`SYNC` devuelve el estado sin mover el servo. Las órdenes de barrera también admiten la forma sin identificador, `GATE_OPEN` y `GATE_CLOSE`.

Ejemplo de confirmación, tras el intervalo de movimiento:

```json
{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"manual-1"}
```

Para comprobar que la protección no depende del frontend:

- Con la barrera cerrada y los cuatro puestos ocupados, envía `GATE_OPEN manual-full`: debe responder `PARKING_FULL` manteniendo puestos, barrera y objetivo del servo.
- Con puestos libres, abre la barrera; ocupa después los cuatro. Debe permanecer abierta hasta recibir `GATE_CLOSE`.
- Envía dos maniobras distintas seguidas durante el asentamiento: la segunda recibe `GATE_BUSY`.
- Envía `SYNC` o pulsa botones durante el movimiento: los puestos siguen respondiendo y la orden pendiente conserva su identificador.

No confundas una respuesta de rechazo con una confirmación de movimiento. Los errores incluyen el estado anterior y no autorizan una actualización optimista.

## 5. Comprobar el WebSocket

El navegador envía JSON estructurado, nunca texto serial arbitrario:

```json
{"type":"gate-command","requestId":"browser-1","action":"open"}
```

El bridge valida el origen, formato, aforo, sincronización y exclusión de una maniobra pendiente. Genera otro identificador para el cable serial y correlaciona el ACK del firmware. Una respuesta tardía no puede confirmar una orden nueva; un timeout no provoca reintentos automáticos de movimiento.

La respuesta al navegador usa `type: "gate-result"` y su `requestId` original. El estado visual procede del snapshot confirmado, no de la solicitud. Consulta [el contrato y los códigos de error](entry-gate-protocol.md).

### Orígenes y red local

Por defecto solo pueden enviar órdenes las páginas de `http://localhost:4321` y `http://127.0.0.1:4321`. `WS_ALLOWED_ORIGINS` permite configurar una lista de orígenes HTTP(S) exactos. Los clientes de solo lectura siguen pudiendo recibir snapshots sin enviar órdenes.

**La validación de Origin no es autenticación.** Un cliente no navegador puede declarar un Origin permitido. Mantén el bridge en loopback por defecto y no expongas este control a Internet o redes no confiables. Para una tablet en una red de confianza debes configurar explícitamente la dirección WebSocket, la interfaz de escucha y el origen del dashboard; no uses comodines como sustituto de control de acceso.

## 6. Verificación automática y límites

```bash
npm test
npm run check
npm run build
```

Las pruebas usan serial simulado, WebSockets locales, un arnés de firmware C++11 con stub de Servo y un puerto virtual propio para la regresión de latencia de Node 26. No abren el Arduino real ni cargan firmware. Necesitan `g++`; el test nativo de puerto virtual en Linux usa Python 3.

Las comprobaciones del navegador se ejecutan con WebSocket interceptado, sin enviar órdenes al hardware. Un test automatizado no prueba la fuente de alimentación, los límites mecánicos ni la posición física. La compilación y carga AVR y la prueba final de la maqueta corresponden a los pasos manuales del IDE.
