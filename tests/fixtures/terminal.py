"""Exercise the installed terminal APIs through a real POSIX pseudo-terminal."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

ANSI_RE = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 72, 0, 0))
# `--cancel` drives the scenario where the harness is rebuilt while a run is in
# flight, so the run must still be cancellable afterwards.
cancel_mode = sys.argv[1:2] == ['--cancel']
command = sys.argv[2:] if cancel_mode else sys.argv[1:]
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env={**os.environ, 'TERM': 'xterm-256color'})
output = bytearray()

def wait_for(*needles):
    """Wait for any of the needles. Matching is case-insensitive and ignores
    ANSI escapes, so the same wait works for 'Cancelled' and 'AbortError'."""
    deadline = time.monotonic() + 12
    targets = [n.lower().encode() for n in needles]
    while time.monotonic() < deadline:
        haystack = ANSI_RE.sub(b'', output).lower()
        if any(t in haystack for t in targets):
            return
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            data = os.read(master, 65536)
            output.extend(data)
        if child.poll() is not None:
            break
    raise RuntimeError('TUI did not reach ' + '/'.join(needles) + '\n' + output.decode(errors='replace')[-4000:])

try:
    if cancel_mode:
        wait_for('/help commands')
        os.write(master, b'work please\r')
        wait_for('Running')
        # Alt+. cycles the reasoning effort, which rebuilds the harness while the
        # run is in flight. Ctrl+C must still cancel that run.
        os.write(master, b'\x1b.')
        time.sleep(0.5)
        os.write(master, b'\x03')
        # 'cancelled' and 'abort' cannot appear in the static chrome, which
        # reads 'Ctrl+C cancel' - matching the bare word would match the
        # footer long before Ctrl+C is pressed.
        wait_for('cancelled', 'abort')
        os.write(master, b'/exit\r')
        child.wait(timeout=15)
        print(json.dumps({'code': child.returncode, 'cancelled': True}))
    else:
        wait_for('/help commands')
        os.write(master, b'/status\r')
        wait_for('Session tokens 0')
        # Resize the actual terminal while the UI is live.
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 48, 0, 0))
        child.send_signal(__import__('signal').SIGWINCH)
        os.write(master, b'create ui.txt\r')
        wait_for('Allow write_file?')
        os.write(master, b'y\r')
        wait_for('Created by TUI.')
        time.sleep(0.1)
        os.write(master, b'/exit\r')
        child.wait(timeout=5)
        while select.select([master], [], [], 0)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output.extend(data)
        raw_restored = bool(termios.tcgetattr(slave)[3] & termios.ICANON)
        print(json.dumps({'code': child.returncode, 'entered': b'\x1b[?1049h' in output,
                          'restored': output.endswith(b'\x1b[?25h\x1b[?1049l'), 'canonical': raw_restored}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    os.close(slave)
