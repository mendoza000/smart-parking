import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
const adapterPath = process.env.SERIAL_ADAPTER_MODULE ?? '../bridge/serial-port.ts';
const { CompatibleSerialPort } = await import(adapterPath.startsWith('.') ? new URL(adapterPath, import.meta.url).href : adapterPath) as typeof import('../bridge/serial-port.ts');
const supported = process.platform === 'linux';

test('native serial PTY delivers a delayed frame promptly and closes cleanly', { skip: !supported, timeout: 5000 }, async () => {
  const child: ChildProcessWithoutNullStreams = spawn('python3', ['tests/fixtures/serial-device.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  let port: InstanceType<typeof CompatibleSerialPort> | undefined;
  const frames: Array<{ spots: boolean[]; sentAtNs: string }> = [];
  try {
    const [path] = await Promise.race([
      once(stdout, 'line') as Promise<[string]>,
      once(child, 'exit').then(([code]) => { throw new Error(`PTY fixture exited before path (${code}): ${stderr}`); }),
    ]);
    assert.match(path, /^\/dev\/pts\//);
    port = new CompatibleSerialPort({ path, baudRate: 9600, autoOpen: false });
    let pending = '';
    const received = new Promise<number>((resolve, reject) => {
      const failSafe = setTimeout(() => reject(new Error('serial data event did not arrive within 1000ms')), 1000);
      port!.on('data', (chunk: Buffer) => {
        pending += chunk.toString();
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const parsed = JSON.parse(line) as { spots: boolean[]; sentAtNs: string };
            frames.push(parsed);
            if (frames.length === 1) {
              clearTimeout(failSafe);
              resolve(Number(process.hrtime.bigint() - BigInt(parsed.sentAtNs)) / 1e6);
            }
          } catch (error) { clearTimeout(failSafe); reject(error); }
        }
      });
      port!.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => port!.open((error) => error ? reject(error) : resolve()));
    child.stdin.write('SEND\n');
    const latencyMs = await received;
    assert.deepEqual(frames[0]?.spots, [true, false, true, false]);
    assert.match(frames[0]?.sentAtNs ?? '', /^\d+$/);
    assert.ok(latencyMs < 250, `native serial delivery took ${latencyMs.toFixed(1)}ms`);
    await new Promise<void>((resolve, reject) => port!.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(frames.length, 1, 'no further complete frames after public close');
  } finally {
    if (port?.isOpen) await new Promise<void>((resolve) => port!.close(() => resolve()));
    child.stdin.destroy();
    child.kill();
    stdout.close();
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
});
