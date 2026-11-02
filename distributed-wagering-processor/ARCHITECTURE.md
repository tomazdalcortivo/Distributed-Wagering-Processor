# Architecture & Technical Decisions — Distributed Wagering Processor

Este documento detalha as escolhas arquiteturais, estratégias de concorrência, modelagem de banco de dados, taxonomia de falhas e *trade-offs* adotados na construção do **Distributed Wagering Processor**.

---

## 1. Arquitetura em Camadas e Isolamento do Domínio (DDD + Hexagonal)

O projeto adota **Domain-Driven Design (DDD)** combinado com **Ports & Adapters (Hexagonal Architecture)**:

1. **Domain Layer (`src/domain/`)**:
   - Contém `Money`, `Decimal`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage` e a hierarquia `IntegrationEvent<T>`.
   - **Zero acoplamento com frameworks**: nenhuma classe de domínio importa decorators do NestJS ou do MikroORM.
   - Construtores `private`/`protected` com factories explícitas (`create`/`open`/`from` para criação validada e `rehydrate` para reconstrução a partir do banco sem revalidar regras de transição).
2. **Application Layer (`src/application/`)**:
   - Orquestra as transações financeiras através de portas (`UnitOfWorkPort`, `EventPublisherPort`, `ProviderIdentityPort`, `MetricsPort`).
   - O caso de uso `ProcessWagerTransactionUseCase` é compartilhado integralmente entre o controller HTTP (`POST /wagering/transactions`), o consumidor SQS (`SqsWagerConsumerWorker`) e o worker de referências pendentes (`ReprocessPendingReferencesUseCase`).
3. **Infrastructure Layer (`src/infrastructure/`)**:
   - Mapeamento de persistência via `EntitySchema` do **MikroORM** (mantendo as entidades de domínio puras).
   - Workers assíncronos para consumo SQS, publicação do Transactional Outbox e resolução de `PENDING_REFERENCE`.
4. **Presentation Layer (`src/presentation/`)**:
   - Controllers HTTP finos, `ProviderAuthGuard` e `GlobalDomainExceptionFilter` com mapeamento determinístico de status HTTP.

---

## 2. Escolha do ORM e Mapeamento Exato de `Money`

### Por que MikroORM?
Escolhemos o **MikroORM (`@mikro-orm/postgresql`)** conforme preferência do desafio pelos seguintes motivos técnicos:
- Suporte de primeira classe a `EntitySchema` desacoplado de classes de domínio;
- Controle explícito de escopo transacional via `em.fork().transactional(...)`;
- Suporte nativo a `LockMode.PESSIMISTIC_WRITE` (`SELECT ... FOR UPDATE`) e execução direta de SQL parametrizado na mesma conexão transacional.

### Representação de `Money` sem Ponto Flutuante
- **Em memória (`src/domain/shared/decimal.ts` e `src/domain/value-objects/money.ts`)**:
  - `Decimal` valida a string de entrada via expressão regular estrita (`/^-?\d+\.\d{2}$/`), rejeitando `NaN`, `Infinity`, notação científica (`1e2`), espaços em branco, strings vazias, mais ou menos de 2 casas decimais e `-0.00`.
  - A parte inteira e a fração são convertidas diretamente para `bigint` representando centavos (`minorUnits = BigInt(whole) * 100n + BigInt(fraction)`). Nenhuma operação passa por `Number` ou `parseFloat`.
- **No PostgreSQL (`DecimalStringType`)**:
  - Armazenado como `NUMERIC(20, 2)` + `VARCHAR(3)` (`currency`).
  - O driver PostgreSQL (`pg`) e o `DecimalStringType` do MikroORM trafegam `NUMERIC(20, 2)` exclusivamente como `string` (`"25.00"`), reidratando `Money.rehydrate({ amount, currency })` sem jamais converter para `number`.

---

## 3. Estratégia de Concorrência e Controle de Lock por `walletId`

A unidade de concorrência é estritamente a `walletId`. Adotamos uma **estratégia híbrida de Pessimistic Row-Level Locking + Optimistic Version Check**:

1. **`SELECT ... FOR UPDATE` na linha da `Wallet` (`LockMode.PESSIMISTIC_WRITE`)**:
   - Toda operação financeira adquire um lock exclusivo de linha (`FOR UPDATE`) sobre `wallets WHERE id = :walletId` dentro da transação SQL.
   - **Por que Pessimistic Lock como mecanismo primário?** Em iGaming, uma *hot wallet* (jogador fazendo apostas rápidas ou recebendo múltiplos eventos simultâneos da mesma rodada) sofre contenção real. Com *optimistic locking* puro, 20 mensagens simultâneas gerariam 19 falhas de conflito e dezenas de *retries* em cascata. Com `SELECT ... FOR UPDATE` na linha da wallet, o PostgreSQL enfileira as operações daquela wallet em microssegundos e permite que carteiras de jogadores distintos rodem com **100% de paralelismo** (zero lock global).
2. **Guarda de Versão Otimista (`UPDATE wallets SET ... WHERE id = ? AND version = ?`)**:
   - Além do `FOR UPDATE`, o `updateWithVersion` verifica `version = expectedVersion` e incrementa `version` somente quando o saldo muda (Seção 6.2). Caso qualquer anomalia viole a versão esperada, lança `ConcurrencyConflictError`.
3. **Recuperação de Race Condition na Inserção de `idempotency_key`**:
   - Se 50 requisições idênticas chegam no mesmo milissegundo antes que a primeira transação comite, a primeira insere e as demais que baterem na constraint `uq_wager_tx_idempotency_key` (`SQLSTATE 23505`) capturam a violação de unicidade, abrem uma leitura limpa da transação vencedora já comitada, validam `matchesPayload(payloadHash)` e retornam o resultado original com `idempotentReplay: true`.

---

## 4. Garantias no Schema do Banco de Dados (Seção 5.9)

Todas as invariantes financeiras críticas são impostas diretamente pelo kernel do PostgreSQL na migration `Migration20261101000001_InitialWageringSchema`:

| Tabela | Constraint / Trigger | Garantia Imposta |
|---|---|---|
| `wallets` | `uq_wallets_player_currency UNIQUE (player_id, currency)` | No máximo 1 wallet por jogador e moeda |
| `wallets` | `chk_wallets_balance_non_negative CHECK (balance_amount >= 0.00)` | Saldo nunca fica negativo mesmo diante de bug de aplicação |
| `wager_transactions` | `uq_wager_tx_idempotency_key UNIQUE (idempotency_key)` | Idempotência persistente global |
| `wager_transactions` | `uq_wager_tx_provider_external_id UNIQUE (provider_id, external_transaction_id)` | Unicidade natural por provedor |
| `wager_transactions` | `uq_wager_tx_single_processed_reversal_any` (Partial Unique Index) | Impede que uma transação `PROCESSED` seja revertida duas vezes por `REFUND` ou `ROLLBACK` |
| `wager_transactions` | `trg_wager_transactions_terminal_immutable` (BEFORE UPDATE OR DELETE) | Impede qualquer mutação após `PROCESSED`, `REJECTED` ou `FAILED` e proíbe `DELETE` |
| `wallet_ledger_entries` | `uq_ledger_wallet_transaction` & `uq_ledger_transaction` | No máximo 1 lançamento de ledger por transação financeira |
| `wallet_ledger_entries` | `chk_ledger_arithmetic_balance` | Garante `balance_after = balance_before ± amount` no banco |
| `wallet_ledger_entries` | `trg_wallet_ledger_entries_immutable` (BEFORE UPDATE OR DELETE) | Torna o ledger estritamente *append-only* (imutável no SGBD) |

---

## 5. Máquina de Estados de `WagerTransaction` e Taxonomia de `FailureCode`

### Transições Válidas
```text
                  ┌──────────────────────┐
                  │       PENDING        │ (estado inicial em memória)
                  └──────────┬───────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       ▼                     ▼                     ▼
┌──────────────┐   ┌───────────────────┐   ┌──────────────┐
│  PROCESSED   │   │ PENDING_REFERENCE │   │   REJECTED   │
│  (terminal)  │   │  (aguardando ref) │   │  (terminal)  │
└──────────────┘   └─────────┬─────────┘   └──────────────┘
                             │
                ┌────────────┴────────────┐
                ▼                         ▼
         ┌──────────────┐          ┌──────────────┐
         │  PROCESSED   │          │   REJECTED   │
         │  (terminal)  │          │  (terminal)  │
         └──────────────┘          └──────────────┘
```
*(O estado terminal `FAILED` é reservado para falhas permanentes auditáveis de infraestrutura).*

### Taxonomia de `FailureCode` e Mapeamento HTTP

| `FailureCode` / Erro | Quando Ocorre | Status HTTP | Ação Recomendada ao Provedor |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` com valor maior que o saldo disponível da wallet | `422 Unprocessable Entity` | Não reenviar; informar jogador de saldo insuficiente |
| `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` | `ROLLBACK` de `WIN`/`REFUND` deixaria o saldo da wallet negativo (Regra 7.9) | `422 Unprocessable Entity` | Não reenviar; acionar auditoria/tratamento operacional |
| `REFERENCE_ALREADY_REVERSED` | A transação referenciada já foi revertida por outro `REFUND` ou `ROLLBACK` `PROCESSED` | `422 Unprocessable Entity` | Não reenviar |
| `REFERENCE_NOT_PROCESSED` | A transação referenciada terminou em `REJECTED` ou `FAILED` | `422 Unprocessable Entity` | Não reenviar |
| `INVALID_REFERENCE_KIND` | `REFUND` apontando para algo diferente de `BET`, ou `ROLLBACK` apontando para `LOSS` | `422 Unprocessable Entity` | Corrigir integração |
| `REFERENCE_CONTEXT_MISMATCH` | Referência pertence a outro `playerId`, `walletId`, `currency`, `providerId` ou `roundId` | `422 Unprocessable Entity` | Corrigir payload |
| `REFERENCE_AMOUNT_MISMATCH` | Valor do `REFUND`/`ROLLBACK` difere do valor da referência | `422 Unprocessable Entity` | Corrigir payload |
| `REFERENCE_NOT_FOUND_TIMEOUT` | `PENDING_REFERENCE` excedeu limite de tentativas (8) ou TTL (120s) sem a referência chegar | `422 Unprocessable Entity` (via evento Outbox) | Verificar se a aposta original foi enviada |
| `CURRENCY_MISMATCH` / `WALLET_OWNERSHIP_MISMATCH` | Moeda ou `playerId` da operação diverge da `Wallet` | `422 Unprocessable Entity` | Corrigir payload |
| `IDEMPOTENCY_PAYLOAD_CONFLICT` | Mesma `Idempotency-Key` enviada com payload de negócio diferente | `409 Conflict` | Bug no gerador de chaves do provedor; usar nova key |
| `DUPLICATE_WALLET` | Tentativa de criar segunda wallet para mesmo `playerId + currency` | `409 Conflict` | Consultar wallet existente |
| `INVALID_MONEY` / `INVALID_TRANSACTION_CONTRACT` | Payload malformado, escala != 2 casas, valor negativo ou header ausente | `400 Bad Request` | Corrigir contrato JSON |
| `TRANSIENT_INFRASTRUCTURE_ERROR` | Falha transitória de conexão, timeout ou deadlock | `503 Service Unavailable` | Reenviar com a **mesma** `Idempotency-Key` e backoff |

---

## 6. Cálculo do `payloadHash` Canônico

Para garantir que diferenças de formatação JSON ou ordem de propriedades não causem falsos conflitos de idempotência:
1. Extraímos apenas os campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money: { amount, currency }`, e opcionalmente `referenceExternalTransactionId`). Metadados de transporte e headers ficam de fora.
2. Serializamos com `toCanonicalJson` (`src/domain/shared/canonical-json.ts`), que ordena recursivamente todas as chaves de objetos em ordem lexicográfica (estilo RFC-8785).
3. Calculamos o digest `SHA-256` em hexadecimal.

---

## 7. Referências Fora de Ordem (`PENDING_REFERENCE`), Inbox e Outbox

### 7.1 `PENDING_REFERENCE` (Seção 7.1)
Quando um `REFUND` ou `ROLLBACK` chega antes da transação referenciada:
1. A transação é persistida com status `PENDING_REFERENCE`, `retry_count = 1` e `next_retry_at = now + 1000ms`, e o evento `WagerTransactionPendingReference` é gravado na Outbox (HTTP retorna `202 Accepted`).
2. O `PendingReferenceWorker` faz *polling* periódico usando `SELECT ... FOR UPDATE SKIP LOCKED` para permitir múltiplas instâncias sem colisão.
3. A cada tentativa sem encontrar a referência, agenda backoff exponencial (`1s, 2s, 4s, 8s, 16s, 32s, 64s`).
4. Ao atingir `PENDING_REF_MAX_ATTEMPTS` (default `8`) ou `PENDING_REF_TTL_MS` (default `120000ms`), a transação é transicionada para `REJECTED` com `FailureCode.ReferenceNotFoundTimeout` e publica `WagerTransactionRejected` na Outbox.

### 7.2 Transactional Outbox Multi-Publisher (`SELECT ... FOR UPDATE SKIP LOCKED`)
- Os eventos (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`) são inseridos na tabela `outbox_messages` dentro da **mesma transação SQL** da operação financeira.
- O `TransactionalOutboxWorker` reivindica lotes pendentes com `FOR UPDATE SKIP LOCKED`, publica na fila SQS FIFO `wagering-integration-events.fifo` usando `aggregateId` (`walletId`) como `MessageGroupId` e `eventId` como `MessageDeduplicationId`, e marca `published_at`.
- Se o processo morrer após o commit do banco e antes de publicar no SQS, qualquer outra instância reivindica e publica o registro no ciclo seguinte.

### 7.3 Consumidor SQS, Inbox Persistente e Graceful Shutdown (`SIGTERM`)
- Cada mensagem recebida de `wager-transactions.fifo` é deduplicada na tabela `inbox_messages` pela chave composta `(consumer_name, message_id)` dentro da mesma transação SQL.
- O `DeleteMessageCommand` (`ack`) no SQS só é chamado **após** o commit da transação SQL. Se o worker morrer entre o commit e o ack, a reentrega do SQS bate na `inbox_messages` (`isProcessed() === true`) e faz ack imediato sem duplicar débito/crédito.
- No recebimento de `SIGTERM` (`OnModuleDestroy`), o worker interrompe novas leituras, aguarda até 5s pelas mensagens em andamento e executa `ChangeMessageVisibilityCommand(VisibilityTimeout: 0)` nas mensagens restantes para devolvê-las imediatamente a outras instâncias.

---

## 8. Autenticação — Ponto de Extensão e Desenho OIDC (Seção 2)

Conforme permitido na Seção 2 para priorizar correção financeira, concorrência e idempotência no timebox:
- Deixamos o ponto de extensão explícito através da porta `ProviderIdentityPort` (`src/application/ports/provider-identity.port.ts`), do adaptador `ConfigurableProviderIdentityAdapter` (`src/infrastructure/auth/provider-identity.adapter.ts`) e do guard global `ProviderAuthGuard` (`src/presentation/http/guards/provider-auth.guard.ts`).
- Os endpoints `/health/live`, `/health/ready` e `/metrics` usam o decorator `@Public()` e nunca exigem autenticação.
- Por padrão (`AUTH_MODE=noop`), o adaptador opera em modo *pass-through* para facilitar a execução imediata dos testes automatizados.
- Quando configurado com `AUTH_MODE=oidc-jwt`, o adaptador valida tokens Bearer JWT emitidos por um Identity Provider externo (**Keycloak** ou **Zitadel**) via *Client Credentials Flow* (M2M OAuth2/OIDC), extraindo `sub`, `scope` e `provider_id`/`azp`. Em produção, o adaptador verifica a assinatura criptográfica via JWKS endpoint do Keycloak/Zitadel e valida que o `provider_id` do token corresponde ao `providerId` do payload submetido.

---

## 9. Limitações Conhecidas e Evoluções para Produção

1. **Particionamento e Retenção de Tabelas de Alto Volume**: Em produção com milhares de apostas por segundo, `wallet_ledger_entries`, `wager_transactions`, `inbox_messages` e `outbox_messages` crescerão rapidamente. A evolução natural é particionar `outbox_messages` e `inbox_messages` por faixa de data (com *drop partition* de mensagens já processadas há mais de 30 dias) e usar *table partitioning* em `wallet_ledger_entries` por hash de `wallet_id`.
2. **Outbox via CDC / Listen-Notify**: O *polling* de 500ms com `FOR UPDATE SKIP LOCKED` é extremamente simples, resiliente e seguro para múltiplas instâncias, mas adiciona uma pequena latência de até 500ms na publicação. Para reduzir a latência de publicação para `< 10ms`, pode-se combinar `LISTEN/NOTIFY` do PostgreSQL ou Debezium CDC mantendo o *polling* como fallback.
