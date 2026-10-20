# Serial bridge

The bridge translates newline-delimited Arduino JSON into read-only WebSocket snapshots. Run it with `node --import tsx bridge/server.ts`. It loads `.env` through Node's `loadEnvFile()` and does not require Astro to be running.

Configuration:

- `ARDUINO_PORT` (required): serial device path, for example `/dev/ttyUSB0`.
- `ARDUINO_BAUD_RATE` (default `9600`): integer baud rate from 1 through 4,000,000.
- `WS_PORT` (default `8080`): integer TCP port from 0 through 65535 (0 selects an ephemeral port).
- `WS_HOST` (default `127.0.0.1`): bind host. Keep the default for localhost-only access; explicitly set this to expose the bridge on another interface.

Arduino sends one JSON object per line, e.g. `{"spots":[false,true,false,true]}`. Each spot must be a boolean and the array must contain exactly four entries. Optional barriers have `entry` and `exit` values of `open`, `closed`, or `unknown`. Invalid lines and oversized frames are ignored. The bridge sends `SYNC\n` on each serial open and again after the board boot grace period, supporting boards that reset when the serial port opens.

WebSocket clients receive a `snapshot` immediately and after updates: `spots` is `null` until valid Arduino data arrives, `connected` reports current serial availability, and `updatedAt` identifies the last valid payload. The last spot state remains available while disconnected. Browsers are read-only; they cannot send writes to the bridge. Spot transition events are derived by clients only after an initial snapshot, never by the bridge from its initial unknown state.

The bridge tolerates a missing/disconnected Arduino without involving Astro's server lifecycle. After a serial error it quarantines the current descriptor, ignores its data/open events, and does not construct a replacement until close succeeds (a single bounded retry timer retries failed closes). Close callback and thrown errors include the configured device path. Shutdown cancels reconnect/boot/close-retry timers, closes serial and WebSocket resources, and reports a serial close failure rather than treating cleanup as successful; the executable exits nonzero on that failure. Do not open the Arduino port in Arduino IDE while the bridge owns it; only one process can use the serial device at a time.
