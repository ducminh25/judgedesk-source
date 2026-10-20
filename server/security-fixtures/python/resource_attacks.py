import sys
import os
import threading
import time
import pathlib
import socket
import subprocess


mode = sys.argv[1]
if mode == "cpu-loop":
    value = 1
    while True:
        value = (value * 6364136223846793005 + 1) & ((1 << 64) - 1)
elif mode == "sleep-ms":
    time.sleep(int(sys.argv[2]) / 1000)
elif mode == "allocate-mib":
    allocation = bytearray(int(sys.argv[2]) * 1024 * 1024)
    for offset in range(0, len(allocation), 4096):
        allocation[offset] = 0x5A
    time.sleep(int(sys.argv[3]) / 1000)
elif mode == "output-bytes":
    remaining = int(sys.argv[2])
    chunk = b"X" * 4096
    while remaining:
        amount = min(remaining, len(chunk))
        sys.stdout.buffer.write(chunk[:amount])
        remaining -= amount
elif mode == "thread-bomb":
    hold = int(sys.argv[3]) / 1000
    threads = [threading.Thread(target=time.sleep, args=(hold,)) for _ in range(int(sys.argv[2]))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
elif mode == "read":
    try:
        pathlib.Path(sys.argv[2]).read_bytes()
        print("SECURITY_ESCAPE")
        raise SystemExit(0)
    except (OSError, PermissionError):
        raise SystemExit(13)
elif mode == "write":
    try:
        pathlib.Path(sys.argv[2]).write_text("SECURITY_ESCAPE", encoding="utf-8")
        print("SECURITY_ESCAPE")
        raise SystemExit(0)
    except (OSError, PermissionError):
        raise SystemExit(13)
elif mode == "deny-and-continue":
    protected_path = pathlib.Path(sys.argv[2])
    read_blocked = False
    write_blocked = False
    try:
        protected_path.read_bytes()
        print("SECURITY_ESCAPE read")
    except (OSError, PermissionError):
        read_blocked = True
    try:
        protected_path.write_text("SECURITY_ESCAPE", encoding="utf-8")
        print("SECURITY_ESCAPE write")
    except (OSError, PermissionError):
        write_blocked = True
    print("SAFE" if read_blocked and write_blocked else "UNSAFE")
elif mode == "network":
    try:
        with socket.create_connection(("1.1.1.1", 53), timeout=0.5):
            print("SECURITY_ESCAPE")
            raise SystemExit(0)
    except OSError:
        raise SystemExit(13)
elif mode == "subprocess":
    try:
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", "print('SECURITY_ESCAPE')"],
            capture_output=True,
            timeout=1,
            check=False,
        )
        if result.returncode == 0:
            print("SECURITY_ESCAPE")
            raise SystemExit(0)
        raise SystemExit(13)
    except (OSError, subprocess.SubprocessError):
        raise SystemExit(13)
elif mode == "exec":
    try:
        os.execve(sys.argv[2], [sys.argv[2]], {})
    except OSError as error:
        print(f"EXEC_ERRNO={error.errno}")
        raise SystemExit(13)
else:
    raise SystemExit(65)
