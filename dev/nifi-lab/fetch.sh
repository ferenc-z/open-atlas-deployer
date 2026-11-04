#!/usr/bin/env bash
# Download everything the lab needs into $LAB/downloads (~3.6 GB, resumable).
# Run in the background:  nohup ./fetch.sh > ~/nifi-lab/fetch.log 2>&1 &
# Then check the Apache files against their .sha512 (done at the end).
set -u
LAB="${LAB:-$HOME/nifi-lab}"
mkdir -p "$LAB/downloads"; cd "$LAB/downloads"
A=https://archive.apache.org/dist
J=https://api.adoptium.net/v3/binary/latest
dl() { wget -q -c -O "$1" "$2" && echo "OK $1" || echo "FAIL $1"; }
dl jdk11.tar.gz $J/11/ga/linux/x64/jdk/hotspot/normal/eclipse &
dl jdk21.tar.gz $J/21/ga/linux/x64/jdk/hotspot/normal/eclipse &
dl zookeeper-3.8.4.tar.gz $A/zookeeper/zookeeper-3.8.4/apache-zookeeper-3.8.4-bin.tar.gz &
dl nifi-toolkit-1.28.1.zip $A/nifi/1.28.1/nifi-toolkit-1.28.1-bin.zip &
dl nifi-2.0.0.zip $A/nifi/2.0.0/nifi-2.0.0-bin.zip &
dl nifi-2.5.0.zip $A/nifi/2.5.0/nifi-2.5.0-bin.zip &
dl nifi-1.12.1.tar.gz $A/nifi/1.12.1/nifi-1.12.1-bin.tar.gz &
wait
check() { # local-file remote-path
  local want; want=$(curl -sf "$A/$2.sha512" | grep -oE '[0-9a-f]{128}' | head -1)
  local got; got=$(sha512sum "$1" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$got" ] && echo "SHA512 OK $1" || echo "SHA512 BAD $1"
}
check zookeeper-3.8.4.tar.gz zookeeper/zookeeper-3.8.4/apache-zookeeper-3.8.4-bin.tar.gz
check nifi-toolkit-1.28.1.zip nifi/1.28.1/nifi-toolkit-1.28.1-bin.zip
check nifi-2.0.0.zip nifi/2.0.0/nifi-2.0.0-bin.zip
check nifi-2.5.0.zip nifi/2.5.0/nifi-2.5.0-bin.zip
check nifi-1.12.1.tar.gz nifi/1.12.1/nifi-1.12.1-bin.tar.gz
echo ALLDONE
