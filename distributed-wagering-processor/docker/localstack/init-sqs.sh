#!/bin/sh
set -e

echo "Initializing LocalStack SQS FIFO queues for Distributed Wagering Processor..."

# 1. Create Dead Letter Queue (FIFO)
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "MessageRetentionPeriod": "1209600"
  }'

DLQ_ARN="arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo"

# 2. Create Main Wager Transactions Queue (FIFO) with RedrivePolicy to DLQ
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"ReceiveMessageWaitTimeSeconds\": \"5\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

# 3. Create Integration Events Outbox Destination Queue (FIFO)
awslocal sqs create-queue \
  --queue-name wagering-integration-events.fifo \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout": "30"
  }'

echo "SQS FIFO queues created:"
awslocal sqs list-queues
