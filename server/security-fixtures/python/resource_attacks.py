import sys
import threading
import time


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
else:
    raise SystemExit(65)
