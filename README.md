# Smart Parking

Panel IoT para visualizar cuatro puestos de estacionamiento con un dashboard Astro, una conexión WebSocket y un puente serial opcional para Arduino.

## Requisitos

- Node.js `>=22.22.0` y npm.
- Un navegador moderno.
- Para ejecutar los tests del firmware: `g++` disponible en PATH (se compila un arnés local, no se carga nada a la placa).
- Para el modo hardware: Arduino conectado por USB y acceso normal del usuario al dispositivo serial.

## Instalación

Desde la raíz del proyecto:

```sh
npm install
cp config.example .env
```

La plantilla pública se entrega como `config.example` (nombre alternativo autorizado porque la política de herramientas bloquea `.env.example`). Edita `.env` según el dispositivo y el modo que quieras usar. Los valores iniciales son:

```dotenv
ARDUINO_PORT=/dev/ttyUSB0
ARDUINO_BAUD_RATE=9600
WS_PORT=8080
WS_HOST=127.0.0.1
PUBLIC_WS_URL=ws://localhost:8080
PUBLIC_DEMO_MODE=false
```

`PUBLIC_DEMO_MODE=true` habilita la demostración local sin Arduino. No conecta datos simulados al bridge de hardware. Reinicia Astro tras cambiar variables `PUBLIC_*`.

## Ejecución

```sh
npm run dev          # Astro en localhost:4321
npm run dev:bridge   # Bridge serial y WebSocket en WS_HOST:WS_PORT
npm run dev:all      # Astro (0.0.0.0:4321) y bridge en primer plano
```

`npm run dev:all` detiene ambos procesos si uno termina y reenvía SIGINT/SIGTERM al cerrar. El bridge puede arrancar sin Arduino presente y reintenta la conexión serial.

Comprobaciones y build:

```sh
npm run check
npm test
npm run build
```

## Conectar Arduino

1. Conecta la placa por USB y abre `arduino/SmartParking/SmartParking.ino` en Arduino IDE. Sigue la [guía de cableado y firmware](arduino/SmartParking/README.md), selecciona Arduino Uno y sube el archivo manualmente. Cierra el monitor serial antes de arrancar el bridge. Identifica el puerto estable del dispositivo; no asumas que siempre será `/dev/ttyUSB0`.
2. En Omarchy/Linux, consulta enlaces persistentes con `ls -l /dev/serial/by-id/`. Si no existen, revisa `ls -l /dev/ttyUSB* /dev/ttyACM*` y correlaciona la placa con `dmesg` después de conectarla.
3. Configura `ARDUINO_PORT` con el enlace `/dev/serial/by-id/...` recomendado, y ajusta `ARDUINO_BAUD_RATE` si el firmware utiliza otro baud rate.
4. Ejecuta `npm run dev:bridge`, o `npm run dev:all` para iniciar también Astro.

No cambies permisos del dispositivo automáticamente. Si el usuario actual no tiene acceso, resuelve el acceso mediante la configuración administrada por el sistema antes de iniciar el bridge. No abras el mismo puerto simultáneamente en Arduino IDE (monitor serial) y Node.js: solo un proceso debe poseer el puerto.

## Red local y seguridad

Astro en `npm run dev:all` escucha en todas las interfaces para que otros dispositivos de la LAN puedan cargar la interfaz. El bridge escucha por defecto solo en `127.0.0.1`; por ello `PUBLIC_WS_URL=ws://localhost:8080` funciona cuando el navegador y el bridge corren en el mismo equipo. Si un navegador de otro dispositivo debe conectarse directamente al bridge, establece `WS_HOST=0.0.0.0` y `PUBLIC_WS_URL=ws://<IP-del-equipo>:8080`. Limita ese acceso a una red de confianza: el WebSocket no tiene autenticación ni cifrado y no debe exponerse a Internet o redes no confiables.

## Documentación

- [Cableado, carga manual y cambio a FC-51](arduino/SmartParking/README.md).
- [Contrato serial/WebSocket y reconexión](docs/bridge.md).
- [Estados, simulación y actividad del dashboard](docs/dashboard.md).

La compilación de producción queda en `dist/`; ejecútala con `npm run preview`. El bridge sigue siendo un proceso independiente. Para producir una versión de demostración usa `PUBLIC_DEMO_MODE=true npm run build`; para hardware usa `PUBLIC_DEMO_MODE=false npm run build`. Cambiar el modo no modifica firmware ni reescribe los estados físicos.
