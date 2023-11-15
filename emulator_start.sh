#!/bin/sh

set -e

cd ./functions/
npm run build

cd ./../
firebase emulators:start --import=./.emulator-data --export-on-exit
