#!/bin/sh
set -e

if docker compose version >/dev/null 2>&1; then
  docker compose down -v
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose down -v
else
  docker rm -f jungle-wagering-postgres jungle-wagering-localstack >/dev/null 2>&1 || true
  docker network rm jungle-wagering-net >/dev/null 2>&1 || true
fi

echo "Infrastructure stopped and cleaned up."
