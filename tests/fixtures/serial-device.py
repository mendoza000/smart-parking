#!/usr/bin/env python3
"""Owned PTY serial fixture: print slave path, then emit one delayed JSON frame on command."""
import json
import os
import select
import sys
import time

master, slave = os.openpty()
try:
    path = os.ttyname(slave)
    os.close(slave)
    slave = -1
    print(path, flush=True)
    command = sys.stdin.buffer.readline()
    if command.strip() != b'SEND':
        raise RuntimeError('expected SEND command')
    time.sleep(0.05)
    sent_at_ns = time.monotonic_ns()
    frame = json.dumps({'spots': [True, False, True, False], 'sentAtNs': str(sent_at_ns)}) + '\n'
    os.write(master, frame.encode())
    # Do not write stdout after the serial frame; Node stdout callbacks could mask the issue.
    select.select([], [], [], 2)
finally:
    os.close(master)
    if slave >= 0:
        os.close(slave)
