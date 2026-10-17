#!/bin/sh
set -eu

node dist/migrate-auth.js
node dist/migrate-durable-state.js
