// Select BUTTON_MODE or FC51_MODE before uploading.
#define BUTTON_MODE 0
#define FC51_MODE 1
#ifndef INPUT_MODE
#define INPUT_MODE BUTTON_MODE
#endif

const byte spotPins[] = {2, 3, 4, 5};
const byte spotCount = 4;
const unsigned long debounceMs = 50;
bool occupied[spotCount] = {false, false, false, false};
int rawState[spotCount];
int stableState[spotCount];
unsigned long changedAt[spotCount];
char commandBuffer[4];
byte commandLength = 0;
bool commandInvalid = false;
const byte serialBytesPerLoop = 16;

void sendState() {
  Serial.print("{\"spots\":[");
  for (byte i = 0; i < spotCount; i++) {
    if (i) Serial.print(",");
    Serial.print(occupied[i] ? "true" : "false");
  }
  Serial.println("]}");
}

void setup() {
  Serial.begin(9600);
  for (byte i = 0; i < spotCount; i++) {
#if INPUT_MODE == BUTTON_MODE
    pinMode(spotPins[i], INPUT_PULLUP);
    rawState[i] = digitalRead(spotPins[i]);
    stableState[i] = rawState[i];
#else
    pinMode(spotPins[i], INPUT);
    rawState[i] = digitalRead(spotPins[i]);
    stableState[i] = rawState[i];
    occupied[i] = (rawState[i] == LOW);
#endif
    changedAt[i] = millis();
  }
  sendState();
}

void loop() {
  byte bytesRead = 0;
  while (Serial.available() > 0 && bytesRead < serialBytesPerLoop) {
    char character = Serial.read();
    bytesRead++;
    if (character == '\r') continue;
    if (character == '\n') {
      if (!commandInvalid && commandLength == 4 &&
          commandBuffer[0] == 'S' && commandBuffer[1] == 'Y' &&
          commandBuffer[2] == 'N' && commandBuffer[3] == 'C') {
        sendState();
      }
      commandLength = 0;
      commandInvalid = false;
    } else if (!commandInvalid) {
      if (commandLength < sizeof(commandBuffer)) {
        commandBuffer[commandLength++] = character;
      } else {
        commandInvalid = true;
      }
    }
  }
  unsigned long now = millis();
  bool changed = false;
  for (byte i = 0; i < spotCount; i++) {
    int reading = digitalRead(spotPins[i]);
    if (reading != rawState[i]) {
      rawState[i] = reading;
      changedAt[i] = now;
    }
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
  if (changed) sendState();
}
