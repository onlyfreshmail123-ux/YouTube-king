#!/bin/bash

set -e

echo "======================================"
echo "Starting BGUTIL PO Token Provider..."
echo "======================================"

node /opt/bgutil-ytdlp-pot-provider/server/build/main.js &

BGUTIL_PID=$!

sleep 3

if ! kill -0 "$BGUTIL_PID" 2>/dev/null; then
    echo "ERROR: BGUTIL provider failed to start."
    exit 1
fi

echo "BGUTIL provider started successfully."
echo "Provider PID: $BGUTIL_PID"
echo "Provider URL: http://127.0.0.1:4416"

echo "======================================"
echo "Starting YouTube backend..."
echo "======================================"

exec node /app/index.js
