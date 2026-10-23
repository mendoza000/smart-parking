# Entry gate protocol

The WebSocket command is a strict JSON object with exactly these fields:

```json
{"type":"gate-command","requestId":"browser-1","action":"open"}
{"type":"gate-command","requestId":"browser-1","action":"close"}
```

`requestId` is 1–48 ASCII letters, digits, underscores, or hyphens. Unknown actions, extra keys, empty/oversized IDs, and malformed objects are invalid. The bridge translates commands to `GATE_OPEN <id>\n` or `GATE_CLOSE <id>\n`; synchronization remains `SYNC\n`.

Results have type `gate-result`. A confirmation includes a safe request ID and confirmed gate (`open` or `closed`), with no error. A rejection includes a known error code; request and gate may be null when no particular request/state applies. Known codes are `INVALID_COMMAND`, `ORIGIN_NOT_ALLOWED`, `ARDUINO_DISCONNECTED`, `NOT_SYNCHRONIZED`, `PARKING_FULL`, `GATE_BUSY`, `SERIAL_WRITE_FAILED`, `ACK_TIMEOUT`, and `FIRMWARE_REJECTED`.

Legacy snapshots retain their required `type`, `spots`, `connected`, `updatedAt`, and `barriers` fields. New snapshots may add `gate` (`open`, `closed`, or null), `gateReady` (boolean), and `gatePending` (`open`, `close`, or null). Readiness true requires a known gate. Legacy Arduino JSON containing four booleans in `spots` and optional `barriers` remains accepted. New Arduino messages may include `gate`; ACK metadata uses `ack` values `SYNC`, `GATE_OPEN`, or `GATE_CLOSE`, optional safe `requestId`, and optional `error` values `PARKING_FULL`, `GATE_BUSY`, or `INVALID_COMMAND`. ACK/error/request ID metadata is valid only alongside a known gate. Invalid values are rejected, never coerced.

The reported gate is firmware-confirmed target state after its configured settling interval. An SG90 has no physical position feedback, so this protocol does not prove the arm moved unobstructed. Rejections do not change the confirmed gate; opening with all four spots occupied must be rejected, while closing remains allowed.
