#!/bin/zsh
cd ~/workspace/pc-work-monitor
exec node_modules/.bin/tsx scripts/daemon.ts >> data/daemon.log 2>&1
