import sys
with open(sys.argv[1], 'r') as f:
  x = int(f.read().strip())
print(x)
sys.stdout.flush()
y = int(input())
print('ok')
sys.exit(0 if y == x * 2 else 1)
