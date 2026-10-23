import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'smart-parking-firmware-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function runHarness(mode: 'BUTTON_MODE' | 'FC51_MODE', scenario: string, config: string[] = []) {
  const harness = join(scratch, `${mode}.cpp`);
  const executable = join(scratch, mode);
  const sketch = resolve('arduino/SmartParking/SmartParking.ino');
  writeFileSync(harness, `#include <iostream>\n#include <string>\n#include <map>\nusing std::string; using std::cout; using byte=unsigned char;\n#define INPUT_PULLUP 2\n#define INPUT 0\n#define LOW 0\n#define HIGH 1\n#define OUTPUT 1\nunsigned long nowMs=0; std::map<int,int> pins; std::string incoming, line;\nstruct SerialType { void begin(int){} int available(){return incoming.size();} int read(){int c=incoming.front();incoming.erase(0,1);return c;} void print(const char*s){line+=s;} void print(char c){line+=c;} void println(const char*s){line+=s;cout<<line<<"\\n";line.clear();} }; SerialType Serial;\nvoid pinMode(int p,int){if(!pins.count(p))pins[p]=HIGH;} int digitalRead(int p){return pins[p];} unsigned long millis(){return nowMs;}\n#include "${sketch}"\nint servoAttachedPin=-1, servoLastAngle=-1, servoWriteCount=0;\nvoid sendCommand(const std::string &text){incoming=text+"\\n";while(!incoming.empty())loop();}\nvoid pressButton(int pin){pins[pin]=LOW;nowMs+=1;loop();nowMs+=50;loop();pins[pin]=HIGH;nowMs+=1;loop();nowMs+=50;loop();}\nint main(){${scenario}}\n`);
  execFileSync('g++', ['-std=c++11', '-Itests/fixtures', `-DINPUT_MODE=${mode}`, ...config, harness, '-o', executable], { stdio: 'pipe' });
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0, `harness failed: ${result.error ?? result.stderr}`);
  assert.equal(result.stderr, '');
  return result.stdout;
}

test('button firmware sync parser is exact, bounded, and preserves debounced independent toggles', () => {
  const output = runHarness('BUTTON_MODE', `setup(); incoming="SYNC\\n";loop(); incoming="BAD\\n";loop(); incoming="SYNCOVERFLOW\\n";loop(); incoming="SYNC\\r\\n";loop(); pins[2]=LOW;nowMs=1;loop();nowMs=20;pins[2]=HIGH;loop();nowMs=25;loop();pins[2]=LOW;nowMs=30;loop();nowMs=80;loop();pins[3]=LOW;nowMs=81;loop();nowMs=131;loop();pins[2]=HIGH;nowMs=132;loop();nowMs=182;loop();pins[2]=LOW;nowMs=183;loop();nowMs=233;loop();`);
  assert.equal(output, '{"spots":[false,false,false,false],"gate":"closed"}\n{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n{"spots":[false,false,false,false],"gate":"closed","error":"INVALID_COMMAND"}\n{"spots":[false,false,false,false],"gate":"closed","error":"INVALID_COMMAND"}\n{"spots":[false,false,false,false],"gate":"closed","ack":"SYNC"}\n{"spots":[true,false,false,false],"gate":"closed"}\n{"spots":[true,true,false,false],"gate":"closed"}\n{"spots":[false,true,false,false],"gate":"closed"}\n');
});

test('gate firmware attaches closed servo and confirms command only after settling', () => {
  const output = runHarness('BUTTON_MODE', `setup();incoming="GATE_OPEN nonce-1\\n";while(incoming.size())loop();nowMs=599;loop();nowMs=600;loop();`);
  assert.equal(output, '{"spots":[false,false,false,false],"gate":"closed"}\n{"spots":[false,false,false,false],"gate":"open","ack":"GATE_OPEN","requestId":"nonce-1"}\n');
});

test('startup uses D9 closed angle and malformed/oversized IDs leave servo untouched', () => {
  const tooLong = 'x'.repeat(49);
  const output = runHarness('BUTTON_MODE', `setup();cout<<"SERVO:"<<servoAttachedPin<<","<<servoLastAngle<<","<<servoWriteCount<<"\\n";incoming="GATE_CLOSE bad.id\\nGATE_OPEN ${tooLong}\\n";while(incoming.size())loop();incoming=std::string(90,'z')+"\\n";while(incoming.size())loop();cout<<"WRITES:"<<servoWriteCount<<"\\n";`);
  assert.match(output, /SERVO:9,0,1\n/);
  assert.match(output, /"error":"INVALID_COMMAND"/);
  assert.match(output, /WRITES:1\n/);
});

test('full occupancy rejects open without writes; close stays allowed and no timer closes the gate', () => {
  const output = runHarness('BUTTON_MODE', `
    setup();
    for(int pin=2;pin<=5;pin++) pressButton(pin);
    sendCommand("GATE_OPEN full-1");
    cout<<"FULL:"<<servoWriteCount<<"\\n";
    sendCommand("GATE_CLOSE close-full");
    pressButton(2);
    sendCommand("GATE_OPEN open-1");
    pressButton(2);
    nowMs+=600;loop();
    cout<<"OPEN:"<<servoWriteCount<<","<<servoLastAngle<<"\\n";
    nowMs+=5000;loop();sendCommand("SYNC");
    cout<<"MANUAL:"<<servoWriteCount<<","<<servoLastAngle<<"\\n";
    sendCommand("GATE_CLOSE close-1");
    nowMs+=599;loop();sendCommand("SYNC");
    nowMs+=1;loop();
    cout<<"CLOSE:"<<servoWriteCount<<","<<servoLastAngle<<"\\n";
  `);
  const state = (spots: boolean[], gate: string, metadata: Record<string, string> = {}) => JSON.stringify({ spots, gate, ...metadata });
  const full = [true, true, true, true];
  assert.equal(output, [
    state([false, false, false, false], 'closed'),
    state([true, false, false, false], 'closed'),
    state([true, true, false, false], 'closed'),
    state([true, true, true, false], 'closed'),
    state(full, 'closed'),
    state(full, 'closed', { ack: 'GATE_OPEN', requestId: 'full-1', error: 'PARKING_FULL' }),
    'FULL:1',
    state(full, 'closed', { ack: 'GATE_CLOSE', requestId: 'close-full' }),
    state([false, true, true, true], 'closed'),
    state(full, 'closed'),
    state(full, 'open', { ack: 'GATE_OPEN', requestId: 'open-1' }),
    'OPEN:2,90',
    state(full, 'open', { ack: 'SYNC' }),
    'MANUAL:2,90',
    state(full, 'open', { ack: 'SYNC' }),
    state(full, 'closed', { ack: 'GATE_CLOSE', requestId: 'close-1' }),
    'CLOSE:3,0',
    '',
  ].join('\n'));
});

test('pending motion preserves confirmed state, sync, nonce, and physical inputs while busy', () => {
  const id = 'N'.repeat(36);
  const output = runHarness('BUTTON_MODE', `setup();incoming="GATE_OPEN ${id}\\n";while(incoming.size())loop();incoming="SYNC\\nGATE_CLOSE close-busy\\n";while(incoming.size())loop();for(int p=2;p<=5;p++){pins[p]=LOW;nowMs+=1;loop();nowMs+=50;loop();pins[p]=HIGH;nowMs+=1;loop();}nowMs=600;loop();cout<<"WRITES:"<<servoWriteCount<<"\\n";`);
  assert.match(output, /"gate":"closed","ack":"SYNC"/);
  assert.match(output, /"gate":"closed","ack":"GATE_CLOSE","requestId":"close-busy","error":"GATE_BUSY"/);
  assert.ok(output.includes(`"gate":"open","ack":"GATE_OPEN","requestId":"${id}"`));
  assert.match(output, /"spots":\[true,true,true,true\],"gate":"open"/);
  assert.match(output, /WRITES:2\n/);
});

test('valid ID lengths and configured angles work; unsafe angle configuration fails compilation', () => {
  const id = 'a'.repeat(48);
  const output = runHarness('BUTTON_MODE', `
    setup();sendCommand("GATE_OPEN ${id}");nowMs=600;loop();
    cout<<"TARGET:"<<servoLastAngle<<"\\n";
    sendCommand("GATE_OPEN a");
    sendCommand("GATE_CLOSE");nowMs=1200;loop();
    cout<<"CLOSED:"<<servoWriteCount<<","<<servoLastAngle<<"\\n";
  `, ['-DGATE_CLOSED_ANGLE=10', '-DGATE_OPEN_ANGLE=80']);
  const spots = [false, false, false, false];
  assert.equal(output, [
    JSON.stringify({ spots, gate: 'closed' }),
    JSON.stringify({ spots, gate: 'open', ack: 'GATE_OPEN', requestId: id }),
    'TARGET:80',
    JSON.stringify({ spots, gate: 'open', ack: 'GATE_OPEN', requestId: 'a' }),
    JSON.stringify({ spots, gate: 'closed', ack: 'GATE_CLOSE' }),
    'CLOSED:3,10',
    '',
  ].join('\n'));
  assert.throws(() => runHarness('BUTTON_MODE', 'setup();', ['-DGATE_OPEN_ANGLE=91']), (error: unknown) => {
    const result = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    assert.equal(result.status, 1);
    assert.equal(result.stdout?.toString() ?? '', '');
    assert.match(result.stderr?.toString() ?? '', /mechanical limits/);
    return true;
  });
});

test('FC-51 mode reports initial LOW and continuous active-low detection and release', () => {
  const output = runHarness('FC51_MODE', `pins[2]=LOW;setup();pins[3]=LOW;nowMs=1;loop();nowMs=51;loop();pins[2]=HIGH;nowMs=52;loop();nowMs=102;loop();`);
  assert.equal(output, '{"spots":[true,false,false,false],"gate":"closed"}\n{"spots":[true,true,false,false],"gate":"closed"}\n{"spots":[false,true,false,false],"gate":"closed"}\n');
});
