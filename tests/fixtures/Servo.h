#pragma once
extern int servoAttachedPin;
extern int servoLastAngle;
extern int servoWriteCount;
class Servo {
 public:
  void attach(int pin) { servoAttachedPin = pin; }
  void write(int angle) { servoLastAngle = angle; ++servoWriteCount; }
};
