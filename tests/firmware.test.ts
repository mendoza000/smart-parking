import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'smart-parking-firmware-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function runHarness(mode: 'BUTTON_MODE' | 'FC51_MODE', scenario: string) {
  const harness = join(scratch, `${mode}.cpp`);
  const executable = join(scratch, mode);
  const sketch = resolve('arduino/SmartParking/SmartParking.ino');
  writeFileSync(harness, `#include <iostream>\n#include <string>\n#include <map>\nusing std::string; using std::cout; using byte=unsigned char;\n#define INPUT_PULLUP 2\n#define INPUT 0\n#define LOW 0\n#define HIGH 1\n#define OUTPUT 1\nunsigned long nowMs=0; std::map<int,int> pins; std::string incoming, line;\nstruct SerialType { void begin(int){} int available(){return incoming.size();} int read(){int c=incoming.front();incoming.erase(0,1);return c;} void print(const char*s){line+=s;} void print(char c){line+=c;} void println(const char*s){line+=s;cout<<line<<"\\n";line.clear();} }; SerialType Serial;\nvoid pinMode(int p,int){if(!pins.count(p))pins[p]=HIGH;} int digitalRead(int p){return pins[p];} unsigned long millis(){return nowMs;}\n#include "${sketch}"\nint main(){${scenario}}\n`);
  execFileSync('g++', ['-std=c++17', `-DINPUT_MODE=${mode}`, harness, '-o', executable], { stdio: 'pipe' });
  return execFileSync(executable, [], { encoding: 'utf8' });
}

test('button firmware sync parser is exact, bounded, and preserves debounced independent toggles', () => {
  const output = runHarness('BUTTON_MODE', `setup(); incoming="SYNC\\n";loop(); incoming="BAD\\n";loop(); incoming="SYNCOVERFLOW\\n";loop(); incoming="SYNC\\r\\n";loop(); pins[2]=LOW;nowMs=1;loop();nowMs=20;pins[2]=HIGH;loop();nowMs=25;loop();pins[2]=LOW;nowMs=30;loop();nowMs=80;loop();pins[3]=LOW;nowMs=81;loop();nowMs=131;loop();pins[2]=HIGH;nowMs=132;loop();nowMs=182;loop();pins[2]=LOW;nowMs=183;loop();nowMs=233;loop();`);
  assert.equal(output, '{"spots":[false,false,false,false]}\n{"spots":[false,false,false,false]}\n{"spots":[false,false,false,false]}\n{"spots":[true,false,false,false]}\n{"spots":[true,true,false,false]}\n{"spots":[false,true,false,false]}\n');
});

test('FC-51 mode reports initial LOW and continuous active-low detection and release', () => {
  const output = runHarness('FC51_MODE', `pins[2]=LOW;setup();pins[3]=LOW;nowMs=1;loop();nowMs=51;loop();pins[2]=HIGH;nowMs=52;loop();nowMs=102;loop();`);
  assert.equal(output, '{"spots":[true,false,false,false]}\n{"spots":[true,true,false,false]}\n{"spots":[false,true,false,false]}\n');
});
