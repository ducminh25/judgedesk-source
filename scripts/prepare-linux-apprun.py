#!/usr/bin/env python3
"""Capture the host environment before linuxdeploy changes it for the GUI."""
import argparse
import json
from pathlib import Path


def prepare(appdir):
    apprun = appdir / 'AppRun'
    if apprun.is_symlink() or not apprun.is_file():
        raise ValueError('Expected a regular AppRun script')
    source = apprun.read_text()
    marker = '# JudgeDesk host environment snapshot v1'
    if marker in source:
        return
    if not source.startswith('#!') or 'bash' not in source.splitlines()[0]:
        raise ValueError('Expected the linuxdeploy bash AppRun wrapper')
    keys = json.loads((Path(__file__).resolve().parent.parent / 'shared/linux-host-environment.json').read_text())
    if len(set(keys)) != len(keys) or not all(key.replace('_', '').isalnum() and key.isupper() for key in keys):
        raise ValueError('Invalid host environment contract')
    prefix = marker + '\nfor jd_host_key in ' + ' '.join(keys) + '; do\n'
    prefix += '''  jd_host_saved="JUDGEDESK_HOST_${jd_host_key}"
  if [[ -v $jd_host_key ]]; then
    printf -v "$jd_host_saved" '%s' "${!jd_host_key}"
    export "$jd_host_saved" "${jd_host_saved}_SET=1"
  else
    unset "$jd_host_saved"
    export "${jd_host_saved}_SET=0"
  fi
done
unset jd_host_key jd_host_saved
export JUDGEDESK_HOST_ENV_VERSION=1
'''
    shebang, rest = source.split('\n', 1)
    temporary = apprun.with_name('AppRun.judgedesk-stage')
    try:
        temporary.write_text(shebang + '\n' + prefix + rest)
        temporary.chmod(apprun.stat().st_mode)
        temporary.replace(apprun)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('appdir', type=Path)
    prepare(parser.parse_args().appdir)
