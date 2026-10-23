# Firmware Smart Parking

## Conexión y carga manual

Abre `SmartParking.ino` en Arduino IDE, selecciona Arduino Uno y el puerto y realiza la carga manual. Instala la biblioteca **Servo** desde el Library Manager si Arduino IDE no la incluye. El proyecto no abre el puerto ni carga firmware automáticamente.

Conecta los cuatro pulsadores entre D2–D5 y GND (`INPUT_PULLUP`, sin resistencias externas). Conecta el servo de señal a D9. Alimenta el SG90 con una fuente adecuada para su corriente de arranque y une el GND de esa fuente con el GND del Arduino; no dependas de la alimentación USB/placa si el servo demanda más corriente. Comprueba la tensión/polaridad antes de conectar.

## Calibración y confirmación

`GATE_CLOSED_ANGLE` y `GATE_OPEN_ANGLE` son configurables en compilación (por defecto 0° y 90°); `GATE_MIN_ANGLE`/`GATE_MAX_ANGLE` fijan los límites mecánicos permitidos (por defecto 0°–90°), y una configuración fuera de esos límites falla al compilar. Verifica cuidadosamente el recorrido mecánico sin forzar topes y ajusta los ángulos/límites para el montaje real. `GATE_SETTLE_MS` configura el tiempo no bloqueante de asentamiento (600 ms por defecto).

El servo SG90 no aporta realimentación de posición. El ACK posterior al asentamiento confirma que el firmware aplicó el objetivo y esperó ese intervalo; **no confirma movimiento físico libre de obstáculos**.

## Protocolo serie y controles

Serie a 9600 baudios. Cada JSON incluye cuatro `spots` y la barrera confirmada. Al arrancar y al cambiar un botón se emite estado sin ACK. Envía `SYNC\n` para consultar; `GATE_OPEN\n` y `GATE_CLOSE\n` son comandos manuales, o añade un identificador seguro, por ejemplo `GATE_OPEN wire-1\n`. El ACK de movimiento incluye `ack` y, si se suministró, `requestId`. Errores como `PARKING_FULL`, `GATE_BUSY` y `INVALID_COMMAND` conservan estado/ocupación.

La apertura solo se acepta si hay al menos una plaza libre; el cierre se permite aunque todas estén ocupadas. Los cuatro botones siguen conmutando de forma independiente tras 50 ms estables, también durante el movimiento. Se procesa como máximo 16 bytes de serie por iteración. La barrera no se cierra automáticamente al ocuparse una plaza ni por temporizador: el cierre es manual.

Prueba desde el monitor serie (9600 baudios, envío de nueva línea): `SYNC`, `GATE_OPEN test-1`, espera al ACK de asentamiento, y `GATE_CLOSE test-2`. No mantengas simultáneamente abierto el monitor serie y el bridge: comparten el puerto.

## Modo FC-51

Define `INPUT_MODE` como `FC51_MODE` para entradas activas LOW: detección significa ocupado y ausencia significa libre. Verifica niveles eléctricos del módulo antes de conectarlo; el control de servo/serie permanece disponible.
