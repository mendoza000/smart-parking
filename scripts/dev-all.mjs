import { spawn } from 'node:child_process';

const children = new Set();
const processGroups = new Set();
let stopping = false;
let failed = false;
let resolveDone;

const done = new Promise((resolve) => { resolveDone = resolve; });

function finishIfStopped() {
  if (stopping && children.size === 0) resolveDone();
}

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform === 'win32') child.kill(signal);
    } catch (error) {
      console.error(`Unable to stop child process: ${error.message}`);
      failed = true;
    }
  }
  for (const groupId of processGroups) {
    try {
      if (process.platform !== 'win32') process.kill(-groupId, signal);
    } catch (error) {
      if ((error && typeof error === 'object' && 'code' in error && error.code !== 'ESRCH')) {
        console.error(`Unable to stop child process: ${error.message}`);
        failed = true;
      }
    }
  }
  finishIfStopped();
}

function start(name, args) {
  let child;
  try {
    child = spawn('npm', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    console.error(`${name} failed to start: ${error.message}`);
    failed = true;
    stop();
    return;
  }
  children.add(child);
  if (process.platform !== 'win32' && child.pid) processGroups.add(child.pid);
  child.once('error', (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    failed = true;
    stop();
  });
  child.once('close', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`${name} exited (${signal ?? code ?? 'unknown'}); stopping the other service`);
      failed = true;
      stop();
    }
    finishIfStopped();
  });
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
start('Astro', ['run', 'dev', '--', '--host', '0.0.0.0']);
start('Bridge', ['run', 'dev:bridge']);
if (children.size === 0) stop();
await done;
process.exitCode = failed ? 1 : 0;
