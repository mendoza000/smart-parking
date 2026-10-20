# Smart Parking firmware

## Conexión y carga

Abre `SmartParking.ino` desde Arduino IDE, selecciona Arduino Uno y el puerto correspondiente y carga manualmente. Este proyecto no carga firmware automáticamente. Conecta un extremo de cada pulsador a D2, D3, D4 o D5 y el otro a GND; el firmware activa `INPUT_PULLUP`. No se necesitan resistencias externas.

El monitor serie usa 9600 baudios. Al arrancar envía el estado inicial; cada pulsación estable (flanco de bajada, después de 50 ms sin rebote) conmuta solo su plaza. Envía la línea exacta `SYNC` seguida de nueva línea para recibir el estado actual en JSON `{"spots":[false,false,false,false]}`; se ignoran los retornos de carro, comandos desconocidos y líneas que excedan el límite. El procesamiento serial está limitado a 16 bytes por iteración para no bloquear la lectura de entradas. La liberación no conmuta.

En Omarchy, identifica el dispositivo conectado con `ls /dev/ttyUSB* /dev/ttyACM*` o consulta `dmesg` justo después de conectar la placa. Cierra Arduino IDE/Monitor Serie antes de iniciar el bridge Node.js y viceversa: ambos no pueden abrir simultáneamente el mismo puerto.

## Modo FC-51 futuro

Compila definiendo `INPUT_MODE` como `FC51_MODE` (o cambia el valor predeterminado en el bloque `#ifndef`) para usar entradas activas en LOW: detección continua significa ocupado y ausencia de detección significa libre. Mantiene los mismos cuatro pines y contrato JSON. Verifica los niveles eléctricos del módulo antes de conectarlo. No se implementan comandos de servos.
