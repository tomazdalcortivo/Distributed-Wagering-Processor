#!/bin/sh
set -e

echo "Starting PostgreSQL 16 and LocalStack SQS containers..."

if docker compose version >/dev/null 2>&1; then
  echo "Using 'docker compose' (v2 plugin)..."
  docker compose up -d postgres localstack
elif command -v docker-compose >/dev/null 2>&1; then
  echo "Using 'docker-compose' (v1 standalone)..."
  docker-compose up -d postgres localstack
else
  echo "Neither 'docker compose' nor 'docker-compose' found; falling back to direct 'docker run'..."

  docker network inspect jungle-wagering-net >/dev/null 2>&1 || docker network create jungle-wagering-net

  if ! docker ps -a --format '{{.Names}}' | grep -q '^jungle-wagering-postgres$'; then
    docker run -d \
      --name jungle-wagering-postgres \
      --network jungle-wagering-net \
      -e POSTGRES_USER=jungle \
      -e POSTGRES_PASSWORD=jungle_secret \
      -e POSTGRES_DB=jungle_wagering \
      -p 5432:5432 \
      postgres:16-alpine \
      postgres -c max_connections=200 -c shared_buffers=256MB
  else
    docker start jungle-wagering-postgres >/dev/null 2>&1 || true
  fi

  if ! docker ps -a --format '{{.Names}}' | grep -q '^jungle-wagering-localstack$'; then
    docker run -d \
      --name jungle-wagering-localstack \
      --network jungle-wagering-net \
      -e SERVICES=sqs \
      -e AWS_DEFAULT_REGION=us-east-1 \
      -e EAGER_SERVICE_LOADING=1 \
      -p 4566:4566 \
      -v "$(pwd)/docker/localstack/init-sqs.sh:/etc/localstack/init/ready.d/init-sqs.sh:ro" \
      localstack/localstack:3.7
  else
    docker start jungle-wagering-localstack >/dev/null 2>&1 || true
  fi
fi

echo "Waiting for PostgreSQL (port 5432) to be ready..."
ATTEMPTS=0
until docker exec jungle-wagering-postgres pg_isready -U jungle -d jungle_wagering >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 30 ]; then
    echo "PostgreSQL did not become ready in time."
    exit 1
  fi
  sleep 1
done
echo "PostgreSQL is ready!"

echo "Waiting for LocalStack SQS (port 4566) to be ready..."
ATTEMPTS=0
until docker exec jungle-wagering-localstack awslocal sqs list-queues >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 30 ]; then
    echo "LocalStack did not become ready in time."
    exit 1
  fi
  sleep 1
done

# Ensure SQS queues are initialized
docker exec jungle-wagering-localstack sh /etc/localstack/init/ready.d/init-sqs.sh >/dev/null 2>&1 || true
echo "LocalStack SQS queues are ready!"
