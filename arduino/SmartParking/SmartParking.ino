// Select BUTTON_MODE or FC51_MODE before uploading.
#define BUTTON_MODE 0
#define FC51_MODE 1
#ifndef INPUT_MODE
#define INPUT_MODE BUTTON_MODE
#endif

#include <Servo.h>
#include <string.h>

#ifndef GATE_CLOSED_ANGLE
#define GATE_CLOSED_ANGLE 0
#endif
#ifndef GATE_OPEN_ANGLE
#define GATE_OPEN_ANGLE 90
#endif
#ifndef GATE_MIN_ANGLE
#define GATE_MIN_ANGLE 0
#endif
#ifndef GATE_MAX_ANGLE
#define GATE_MAX_ANGLE 90
#endif
#ifndef GATE_SETTLE_MS
#define GATE_SETTLE_MS 600UL
#endif
#if GATE_MIN_ANGLE < 0 || GATE_MAX_ANGLE > 180 || GATE_MIN_ANGLE > GATE_MAX_ANGLE || \
    GATE_CLOSED_ANGLE < GATE_MIN_ANGLE || GATE_CLOSED_ANGLE > GATE_MAX_ANGLE || \
    GATE_OPEN_ANGLE < GATE_MIN_ANGLE || GATE_OPEN_ANGLE > GATE_MAX_ANGLE
#error "Gate servo angles must remain within configured mechanical limits (0..180)."
#endif

const byte spotPins[] = {2, 3, 4, 5};
const byte spotCount = 4;
const unsigned long debounceMs = 50;
bool occupied[spotCount] = {false, false, false, false};
int rawState[spotCount];
int stableState[spotCount];
unsigned long changedAt[spotCount];
const byte serialBytesPerLoop = 16;
char commandBuffer[64];
byte commandLength = 0;
bool commandInvalid = false;
Servo gateServo;
bool gateOpen = false;
bool gateMoving = false;
bool targetOpen = false;
unsigned long gateStartedAt = 0;
char pendingAck[11];
char pendingRequestId[49];

void sendState(const char *ack = 0, const char *requestId = 0, const char *error = 0) {
  Serial.print("{\"spots\":[");
  for (byte i = 0; i < spotCount; i++) {
    if (i) Serial.print(",");
    Serial.print(occupied[i] ? "true" : "false");
  }
  Serial.print("],\"gate\":\"");
  Serial.print(gateOpen ? "open" : "closed");
  Serial.print("\"");
  if (ack) { Serial.print(",\"ack\":\""); Serial.print(ack); Serial.print("\""); }
  if (requestId) { Serial.print(",\"requestId\":\""); Serial.print(requestId); Serial.print("\""); }
  if (error) { Serial.print(",\"error\":\""); Serial.print(error); Serial.print("\""); }
  Serial.println("}");
}

bool validId(const char *value) {
  byte length = 0;
  while (value[length]) {
    char c = value[length];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '-')) return false;
    if (++length > 48) return false;
  }
  return length > 0;
}

void rejectCommand(const char *ack, const char *requestId, const char *error) {
  sendState(ack, requestId, error);
}

void processCommand() {
  commandBuffer[commandLength] = 0;
  char *id = 0;
  char *space = commandBuffer;
  while (*space && *space != ' ') ++space;
  if (*space) {
    *space++ = 0;
    if (!*space || strchr(space, ' ') || !validId(space)) {
      rejectCommand(0, 0, "INVALID_COMMAND"); return;
    }
    id = space;
  }
  if (strcmp(commandBuffer, "SYNC") == 0 && !id) { sendState("SYNC"); return; }
  bool opening = strcmp(commandBuffer, "GATE_OPEN") == 0;
  bool closing = strcmp(commandBuffer, "GATE_CLOSE") == 0;
  if (!opening && !closing) { rejectCommand(0, 0, "INVALID_COMMAND"); return; }
  const char *ack = opening ? "GATE_OPEN" : "GATE_CLOSE";
  if (gateMoving) { rejectCommand(ack, id, "GATE_BUSY"); return; }
  if (opening) {
    bool available = false;
    for (byte i = 0; i < spotCount; ++i) if (!occupied[i]) available = true;
    if (!available) { rejectCommand(ack, id, "PARKING_FULL"); return; }
  }
  bool alreadyTarget = gateOpen == opening;
  if (alreadyTarget) { sendState(ack, id); return; }
  targetOpen = opening;
  gateMoving = true;
  gateStartedAt = millis();
  strncpy(pendingAck, ack, sizeof(pendingAck) - 1);
  pendingAck[sizeof(pendingAck) - 1] = 0;
  if (id) strncpy(pendingRequestId, id, sizeof(pendingRequestId) - 1);
  else pendingRequestId[0] = 0;
  pendingRequestId[sizeof(pendingRequestId) - 1] = 0;
  gateServo.write(opening ? GATE_OPEN_ANGLE : GATE_CLOSED_ANGLE);
}

void setup() {
  Serial.begin(9600);
  gateServo.attach(9);
  gateServo.write(GATE_CLOSED_ANGLE);
  for (byte i = 0; i < spotCount; i++) {
#if INPUT_MODE == BUTTON_MODE
    pinMode(spotPins[i], INPUT_PULLUP);
#else
    pinMode(spotPins[i], INPUT);
#endif
    rawState[i] = digitalRead(spotPins[i]);
    stableState[i] = rawState[i];
#if INPUT_MODE == FC51_MODE
    occupied[i] = rawState[i] == LOW;
#endif
    changedAt[i] = millis();
  }
  sendState();
}

void loop() {
  unsigned long now = millis();
  bool changed = false;
  for (byte i = 0; i < spotCount; i++) {
    int reading = digitalRead(spotPins[i]);
    if (reading != rawState[i]) { rawState[i] = reading; changedAt[i] = now; }
    if (rawState[i] != stableState[i] && now - changedAt[i] >= debounceMs) {
      stableState[i] = rawState[i];
#if INPUT_MODE == BUTTON_MODE
      if (stableState[i] == LOW) { occupied[i] = !occupied[i]; changed = true; }
#else
      bool detected = stableState[i] == LOW;
      if (occupied[i] != detected) { occupied[i] = detected; changed = true; }
#endif
    }
  }
  bool settled = gateMoving && now - gateStartedAt >= GATE_SETTLE_MS;
  if (settled) {
    gateOpen = targetOpen;
    gateMoving = false;
    sendState(pendingAck, pendingRequestId[0] ? pendingRequestId : 0);
  } else if (changed) sendState();

  byte bytesRead = 0;
  while (Serial.available() > 0 && bytesRead < serialBytesPerLoop) {
    char character = Serial.read();
    ++bytesRead;
    if (character == '\r') continue;
    if (character == '\n') {
      if (commandInvalid) rejectCommand(0, 0, "INVALID_COMMAND");
      else processCommand();
      commandLength = 0;
      commandInvalid = false;
    } else if (!commandInvalid) {
      if (commandLength < sizeof(commandBuffer) - 1) commandBuffer[commandLength++] = character;
      else commandInvalid = true;
    }
  }
}
