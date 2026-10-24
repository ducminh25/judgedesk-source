#!/usr/bin/env python3
"""Exercise the actual AppRun wrapper, including hostile but inert env values."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parent.parent
if not __debug__:
    raise RuntimeError('AppRun regression checks require Python assertions')
with tempfile.TemporaryDirectory(prefix='jd-apprun-regression-') as temporary:
    root = Path(temporary)
    app = root / 'AppRun'
    app.write_text('#!/usr/bin/env bash\nexport LD_LIBRARY_PATH=/bundle/lib\nexport GTK_PATH=/bundle/gtk\nexec "$@"\n')
    subprocess.run([sys.executable, str(repo / 'scripts/prepare-linux-apprun.py'), str(root)], check=True)
    first = app.read_bytes()
    subprocess.run([sys.executable, str(repo / 'scripts/prepare-linux-apprun.py'), str(root)], check=True)
    assert first == app.read_bytes(), 'AppRun staging must be idempotent'
    environment = os.environ.copy()
    hostile = "host path:spaces;'\"$(touch SHOULD_NOT_EXIST)\nsecond line"
    environment['LD_LIBRARY_PATH'] = hostile
    environment['GTK_PATH'] = ''
    environment['PERLLIB'] = '/host/perl libraries'
    environment.pop('GST_PLUGIN_SYSTEM_PATH_1_0', None)
    environment.pop('GIO_MODULE_DIR', None)
    output = subprocess.check_output(['bash', str(app), '/usr/bin/env', '-0'], env=environment, cwd=root)
    values = dict(entry.split(b'=', 1) for entry in output.split(b'\0') if b'=' in entry)
    assert values[b'JUDGEDESK_HOST_LD_LIBRARY_PATH'] == hostile.encode()
    assert values[b'JUDGEDESK_HOST_LD_LIBRARY_PATH_SET'] == b'1'
    assert values[b'JUDGEDESK_HOST_GTK_PATH'] == b''
    assert values[b'JUDGEDESK_HOST_GTK_PATH_SET'] == b'1'
    assert values[b'JUDGEDESK_HOST_GIO_MODULE_DIR_SET'] == b'0'
    assert values[b'JUDGEDESK_HOST_PERLLIB'] == b'/host/perl libraries'
    assert values[b'JUDGEDESK_HOST_GST_PLUGIN_SYSTEM_PATH_1_0_SET'] == b'0'
    assert values[b'LD_LIBRARY_PATH'] == b'/bundle/lib', 'GUI environment must stay bundled'
    assert not (root / 'SHOULD_NOT_EXIST').exists()
print('AppRun host environment snapshot: PASS')
