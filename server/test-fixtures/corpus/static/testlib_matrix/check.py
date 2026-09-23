import sys
with open(sys.argv[1], 'r') as f:
    code = f.read().strip()
if code == '0':
    print('ok')
    sys.exit(0)
elif code == '1':
    print('wrong answer')
    sys.exit(1)
elif code == '2':
    print('presentation error')
    sys.exit(2)
elif code == '7':
    print('points 0.5')
    sys.exit(7)
else:
    print('checker crashed')
    sys.exit(3)
