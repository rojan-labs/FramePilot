#!/bin/sh
# Builds the Fast engine's native helper (macOS only). The pack build copies the result to bin/.
set -eu
cd "$(dirname "$0")"
mkdir -p build
xcrun swiftc -O main.swift -o build/fp-vision-matte
