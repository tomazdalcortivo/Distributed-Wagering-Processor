# Distributed Wagering Processor — Jungle Gaming Challenge 🦧

Serviço financeiro distribuído para processamento de transações de apostas (*wagering*) de múltiplos provedores de jogos de cassino online, construído com **Bun 1.x**, **TypeScript (strict mode)**, **NestJS**, **MikroORM**, **PostgreSQL 16** e **AWS SQS (LocalStack)**.

---

## 1. Visão Geral das Garantias

- **Precisão Monetária Exata (`Money` & `Decimal`)**: Zero uso de `number`, `float` ou `double` para valores monetários. Toda aritmética opera sobre inteiros de escala fixa (`bigint` em centavos, escala 2) no domínio e `NUMERIC(20, 2)` no PostgreSQL via `DecimalStringType` customizado.
- **Concorrência por `walletId` em Múltiplas Instâncias**: Serialização por carteira via **Pessimistic Write Lock** (`SELECT ... FOR UPDATE` na linha da `wallet`) combinada com guarda de versão otimista (`UPDATE wallets ... WHERE id = ? AND version = ?`), permitindo processamento 100% paralelo entre carteiras distintas e zero *lost updates* em *hot wallets*.
- **Idempotência Persistente e Detecção de Conflito**: Garantia no banco (`UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`). Hash SHA-256 sobre JSON canônico RFC-8785 (chaves ordenadas). Replays idênticos retornam `idempotentReplay: true` com o `observedBalance` original; payloads divergentes com a mesma chave retornam `409 Conflict`.
- **Atomicidade SQL (Inbox + Wallet + Transaction + Ledger + Outbox)**: Toda mutação financeira ocorre em uma única transação ACID no PostgreSQL. Eventos de integração jamais são publicados antes do commit.
- **Invariantes Impostas no Schema do Banco (Constraints & Triggers)**:
  - `chk_wallets_balance_non_negative`: `CHECK (balance_amount >= 0.00)`
  - `chk_ledger_arithmetic_balance`: `CHECK ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount))`
  - `trg_wallet_ledger_entries_immutable`: Trigger PL/pgSQL que bloqueia `UPDATE` e `DELETE` na tabela `wallet_ledger_entries`.
  - `trg_wager_transactions_terminal_immutable`: Trigger PL/pgSQL que bloqueia qualquer alteração após a transação atingir estado terminal (`PROCESSED`, `REJECTED`, `FAILED`) e proíbe `DELETE`.
  - Índices parciais únicos `uq_wager_tx_single_processed_reversal_per_kind` e `uq_wager_tx_single_processed_reversal_any`: impedem dupla reversão (`REFUND`/`ROLLBACK`) de uma mesma transação referenciada.

---

## 2. Pré-requisitos e Setup Rápido

### Pré-requisitos
- **Bun** `>= 1.1.x`
- **Docker** e **Docker Compose**

### Passo a passo para rodar localmente

```bash
# 1. Copie o arquivo de variáveis de ambiente
cp .env.example .env

# 2. Suba o PostgreSQL 16 e o LocalStack (já provisiona as filas SQS FIFO e DLQ automaticamente)
docker compose up -d postgres localstack

# 3. Instale as dependências com Bun
bun install

# 4. Execute as migrations versionadas no PostgreSQL
bun run migration:up

# 5. Inicie a aplicação
bun run start
```

### Rodando Cluster com 3 Instâncias Simultâneas (Docker Compose)

Para subir o ambiente completo com **3 instâncias simultâneas** da aplicação (`app-1` na porta `3001`, `app-2` na porta `3002`, `app-3` na porta `3003`) compartilhando o mesmo PostgreSQL e consumindo concorrentemente do SQS/Outbox:

```bash
docker compose --profile cluster up --build -d
```

---

## 3. Comandos Disponíveis

| Comando | Descrição |
|---|---|
| `bun run start` | Inicia o servidor HTTP e os workers de background (SQS Consumer, Outbox Publisher, Pending Reference Worker) |
| `bun run start:dev` | Inicia em modo watch para desenvolvimento |
| `bun run typecheck` | Valida a tipagem TypeScript em modo estrito (`tsc --noEmit`) |
| `bun run migration:up` | Aplica as migrations pendentes no PostgreSQL |
| `bun run migration:down` | Reverte a última migration aplicada (reversibilidade total) |
| `bun test` | Executa toda a suíte de testes (unidade + integração + concorrência) |
| `bun run test:unit` | Executa os testes de unidade puros do domínio (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `CanonicalJson`) |
| `bun run test:integration` | Executa os testes de integração contra PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | Executa os 8 cenários obrigatórios de concorrência e recuperação de falhas |
| `bun run test:load` | Executa o benchmark de carga e contenção (*hot wallets*) com relatório de RPS, latências p50/p95/p99 e reconciliação |

---

## 4. Endpoints HTTP e Exemplos

### 4.1 Criar Wallet (`POST /wallets`)

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

### 4.2 Submeter Transação de Aposta (`POST /wagering/transactions`)

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

### 4.3 Consultas e Reconciliação

- `GET /wallets/:walletId` — Consulta saldo atual e versão da wallet.
- `GET /wallets/:walletId/ledger?cursor=...&limit=50` — Lista entradas imutáveis do ledger com cursor opaco estável (`base64url`).
- `GET /wagering/transactions/:transactionId` — Busca transação por ID interno.
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId` — Busca transação por chave natural do provedor.
- `POST /wallets/:walletId/reconciliation` — Reconstrói o saldo a partir de todo o histórico do ledger e verifica consistência com o saldo materializado.
- `GET /health/live` e `GET /health/ready` — Health checks abertos (sem autenticação).
- `GET /metrics` — Snapshot JSON das métricas operacionais e percentis de latência.

---

## 5. Estrutura de Diretórios

```text
├── docker/
│   └── localstack/
│       └── init-sqs.sh                 # Provisionamento automático das filas SQS FIFO e DLQ
├── src/
│   ├── domain/                         # Camada de Domínio Pura (zero dependências de NestJS/ORM)
│   │   ├── entities/                   # Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage
│   │   ├── events/                     # IntegrationEvent<T> e subclasses concretas
│   │   ├── shared/                     # Decimal (BigInt), FailureCode, DomainErrors, CanonicalJSON
│   │   └── value-objects/              # Money (imutável, escala fixa 2)
│   ├── application/                    # Casos de Uso e Portas (Interfaces)
│   │   ├── ports/                      # UnitOfWorkPort, ProviderIdentityPort, EventPublisherPort, MetricsPort
│   │   └── use-cases/                  # CreateWallet, ProcessWagerTransaction, ReprocessPendingReferences, ReconcileWallet, Queries
│   ├── infrastructure/                 # Adaptadores Técnicos
│   │   ├── auth/                       # ConfigurableProviderIdentityAdapter (NoOp + OIDC JWT)
│   │   ├── database/                   # MikroORM EntitySchemas, DecimalStringType, UnitOfWork, Migrations
│   │   ├── messaging/                  # SqsWagerConsumerWorker, TransactionalOutboxWorker, PendingReferenceWorker
│   │   └── observability/              # StructuredLogger (JSON + redaction) e MetricsService
│   ├── presentation/                   # Camada HTTP (Controllers, ExceptionFilter, AuthGuard)
│   ├── app.module.ts
│   └── main.ts
├── test/
│   ├── unit/                           # Testes de unidade do domínio
│   ├── integration/                    # Testes de integração com PostgreSQL e LocalStack reais
│   ├── concurrency/                    # Os 8 cenários obrigatórios de concorrência e crash recovery
│   └── load/                           # Benchmark de carga (bun run test:load)
├── ARCHITECTURE.md                     # Decisões arquiteturais, trade-offs e justificativas detalhadas
├── docker-compose.yml
├── Dockerfile
└── package.json
```
