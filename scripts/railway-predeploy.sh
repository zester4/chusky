#!/bin/sh
set -eu

node dist/migrate-auth.js
echo "Running Chusky durable-state migrations."
node dist/migrate-durable-state.js
