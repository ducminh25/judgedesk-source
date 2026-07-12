#!/bin/bash
set -e

echo "Installing isolate for OS-level sandboxing in Cloud Mode..."

# Require root
if [ "$EUID" -ne 0 ]
  then echo "Please run as root"
  exit
fi

apt-get update
apt-get install -y gcc g++ make git libcap-dev

cd /tmp
git clone https://github.com/ioi/isolate.clj.git isolate || git clone https://github.com/ioi/isolate.git isolate
cd isolate
make isolate
make install

# Configure isolate to allow some processes and default settings
echo "box0:100000:100000" > /etc/isolate

echo "isolate installed successfully!"
