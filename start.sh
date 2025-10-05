#!/bin/sh
set -e

# Ensure /data directory exists and is writable
mkdir -p /data/tmp

# Start the application
exec bun run src/index.ts
