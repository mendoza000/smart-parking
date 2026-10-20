import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const orchestrator = join(process.cwd(), 'scripts/dev-all.mjs');
const options = { timeout: 9_000 };
type Pids = { service: number; grandchild: number };

async function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (status.slice(status.lastIndexOf(') ') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForServices(statePath: string, child: ChildProcess) {
  const paths = [`${statePath}.astro`, `${statePath}.bridge`];
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    try { return await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as Pids)); }
    catch { /* Wait for both shim processes to report their PIDs. */ }
    if (child.exitCode !== null) throw new Error(`orchestrator exited early: ${child.exitCode}`);
    await delay(25);
  }
  throw new Error('timed out waiting for fake npm children');
}

async function waitForDeath(pids: number[]) {
  const end = Date.now() + 2_000;
  while (Date.now() < end) {
    const alive = await Promise.all(pids.map(isAlive));
    if (alive.every((value) => !value)) return;
    await delay(25);
  }
  const alivePids = [];
  for (const pid of pids) if (await isAlive(pid)) alivePids.push(pid);
  throw new Error(`processes still alive: ${alivePids.join(', ')}`);
}

async function runWithFakeNpm(failAstro: boolean, verify: (statePath: string, child: ChildProcess) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'smart-parking-dev-all-'));
  const statePath = join(directory, 'pids');
  const shim = join(directory, 'npm');
  const source = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const service = args.includes('dev:bridge') ? 'bridge' : 'astro';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.env.FAKE_STATE + '.' + service, JSON.stringify({ service: process.pid, grandchild: grandchild.pid }));
if (service === 'astro' && process.env.FAKE_FAIL === '1') setTimeout(() => process.exit(23), 150);
setInterval(() => {}, 1000);
`;
  let child: ChildProcess | undefined;
  try {
    await writeFile(shim, source);
    await chmod(shim, 0o755);
    child = spawn(process.execPath, [orchestrator], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`, FAKE_STATE: statePath, FAKE_FAIL: failAstro ? '1' : '0' },
      stdio: 'ignore',
    });
    await verify(statePath, child);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`dev:all ${signal} stops child process trees with exit 0`, options, async () => {
    if (process.platform === 'win32') return;
    await runWithFakeNpm(false, async (statePath, child) => {
      let pids: Pids[] = [];
      try {
        pids = await waitForServices(statePath, child);
        child.kill(signal);
        const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        if (code !== 0) throw new Error(`expected exit 0 after ${signal}, got ${code}`);
        await waitForDeath(pids.flatMap(({ service, grandchild }) => [service, grandchild]));
      } finally {
        for (const { service, grandchild } of pids) for (const pid of [service, grandchild]) if (await isAlive(pid)) process.kill(pid, 'SIGKILL');
      }
    });
  });
}

test('dev:all service failure stops both process trees and exits nonzero', options, async () => {
  if (process.platform === 'win32') return;
  await runWithFakeNpm(true, async (statePath, child) => {
    let pids: Pids[] = [];
    try {
      pids = await waitForServices(statePath, child);
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      if (code !== 1) throw new Error(`expected exit 1 after service failure, got ${code}`);
      await waitForDeath(pids.flatMap(({ service, grandchild }) => [service, grandchild]));
    } finally {
      for (const { service, grandchild } of pids) for (const pid of [service, grandchild]) if (await isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
