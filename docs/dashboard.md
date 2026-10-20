# Estado del dashboard

- `PUBLIC_DEMO_MODE=true`: estado local del navegador. Cada puesto funciona como botón; no se abre WebSocket ni se envían estados ficticios al bridge.
- `PUBLIC_DEMO_MODE=false`: estado de hardware de solo lectura. Las métricas empiezan sin datos hasta recibir el primer snapshot válido.
- Tras desconexión se conserva la última lectura con una indicación explícita de que no está en vivo.
- La primera lectura establece una referencia, no inventa eventos de ocupación anteriores. Los cambios posteriores generan eventos; repetir el mismo estado no los duplica.
- La actividad conserva los últimos 30 eventos de esta sesión de navegador; no hay base de datos ni historial persistente.
- Las barreras muestran `Demo` mientras no lleguen estados reales. El firmware actual no controla servos.
- Cambiar variables públicas exige reiniciar Astro y, para producción, reconstruir el sitio.

`tests/dashboard.test.ts` comprueba aislamiento, transiciones, retención y límites. `tests/browser-check.mjs` es una función para `playwright-cli run-code --filename=tests/browser-check.mjs`, no un script de Node autónomo. Requiere un build de simulación servido en `127.0.0.1:4321` y una sesión abierta de Playwright; comprueba interacción y capturas responsive.
