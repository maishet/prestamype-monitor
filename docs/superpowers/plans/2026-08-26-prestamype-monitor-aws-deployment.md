# Prestamype Monitor AWS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the verified local monitor to AWS Lambda with delayed SQS scheduling, DynamoDB state, Telegram delivery, cost protection, and a controlled 24/7 rollout.

**Architecture:** AWS SAM defines one Node.js 22 Lambda, an encrypted standard SQS queue, a dead-letter queue, a provisioned-capacity DynamoDB table, a ten-minute EventBridge supervisor, seven-day logs, and minimal IAM. The handler schedules the next delayed SQS message before scanning, while DynamoDB locking and idempotency prevent duplicate work.

**Tech Stack:** AWS SAM/CloudFormation, Lambda Node.js 22 x86_64, SQS, DynamoDB, EventBridge Scheduler, Parameter Store, CloudWatch, AWS Budgets, Vitest.

## Global Constraints

- Complete and verify `2026-08-26-prestamype-monitor-application.md` first.
- Default AWS region is `sa-east-1` and application timezone is `America/Lima`.
- Use ZIP deployment and x86_64 Chromium; do not introduce a private container registry.
- Use one reserved Lambda concurrency, one SQS message per batch, and no NAT or VPC.
- Use AWS-owned encryption for SQS/DynamoDB and application-layer AES-GCM for session state.
- Do not place Telegram tokens, encryption keys, cookies, or session state in Git or CloudFormation outputs.
- Start disabled, perform one-shot tests, and require explicit activation after metric review.
- Every task ends in tests and a small commit.

---

## File Map

```text
template.yaml
samconfig.toml.example
src/
  adapters/dynamodb-repository.ts
  adapters/parameter-store.ts
  adapters/sqs-scheduler.ts
  notifications/telegram-client.ts
  runtime/cost-guard.ts
  runtime/errors.ts
  lambda/handler.ts
  lambda/supervisor.ts
scripts/
  bootstrap-parameters.ps1
  seed-blacklist.ps1
  invoke-once.ps1
  activate-monitor.ps1
  deactivate-monitor.ps1
tests/
  adapters/dynamodb-repository.test.ts
  adapters/sqs-scheduler.test.ts
  notifications/telegram-client.test.ts
  runtime/cost-guard.test.ts
  lambda/handler.test.ts
  lambda/supervisor.test.ts
  infrastructure/template.test.ts
docs/runbook.md
```

### Task 1: Implement DynamoDB state and locking

**Files:**
- Create: `src/adapters/dynamodb-repository.ts`
- Create: `tests/adapters/dynamodb-repository.test.ts`

**Interfaces:**
- Implements: `MonitorRepository` and session/config usage records.
- Produces: conditional lock, blacklist query, alert idempotency, opportunity persistence, and monthly usage counters.

- [x] **Step 1: Write failing AWS-command tests**

Mock `DynamoDBDocumentClient.send` and assert:

- `acquireLock` uses a conditional expression accepting absent or expired locks.
- `releaseLock` requires the same owner.
- Blacklist reads use `begins_with(PK, 'BLACKLIST#')` through a configured index or deterministic partition.
- Alert creation uses `attribute_not_exists(PK)`.
- Session ciphertext is returned without logging.

- [x] **Step 2: Run and observe failure**

Run: `npx vitest run tests/adapters/dynamodb-repository.test.ts`

- [x] **Step 3: Implement repository keys from the design spec**

Use a single table with `PK` and `SK`. Store blacklist records under `PK=BLACKLIST`, alert records under `PK=ALERT#<opportunity-id>`, config under `PK=CONFIG`, session under `PK=SESSION`, and usage under `PK=USAGE#<yyyy-mm>`. Use consistent reads for the lock and session only.

- [x] **Step 4: Add conditional-failure tests and commit**

Translate `ConditionalCheckFailedException` during lock acquisition into `false`; rethrow other errors after redaction.

Run: `npx vitest run tests/adapters/dynamodb-repository.test.ts` and `npm run typecheck`.

Commit: `git add src/adapters tests/adapters && git commit -m "feat: persist monitor state in DynamoDB"`

### Task 2: Implement secure configuration and Telegram delivery

**Files:**
- Create: `src/adapters/parameter-store.ts`
- Create: `src/notifications/telegram-client.ts`
- Create: `tests/notifications/telegram-client.test.ts`

**Interfaces:**
- Produces: `loadRuntimeSecrets(): Promise<RuntimeSecrets>` with cold-start caching.
- Implements: `Notifier.send(message)`.

- [x] **Step 1: Write failing Telegram tests**

Mock `fetch` and assert POST to `https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`, `parse_mode: 'HTML'`, and disabled link previews. Verify the token never appears in thrown messages.

- [x] **Step 2: Implement Parameter Store loading**

Read three named parameters supplied by environment variables: Telegram token, Telegram chat ID, and base64 session key. Use `WithDecryption: true`, validate the key decodes to 32 bytes, and cache only inside the warm Lambda process.

- [x] **Step 3: Implement Telegram delivery and bounded retries**

Retry network errors and HTTP 429/5xx at most twice using the server-provided `retry_after` capped at five seconds. Do not retry other 4xx responses. Redact the bot token from every error.

- [x] **Step 4: Run and commit**

Run: `npx vitest run tests/notifications/telegram-client.test.ts` and `npm run typecheck`.

Commit: `git add src/adapters src/notifications tests/notifications && git commit -m "feat: load secrets and send Telegram alerts"`

### Task 3: Implement delayed SQS chaining and the cost guard

**Files:**
- Create: `src/adapters/sqs-scheduler.ts`
- Create: `src/runtime/cost-guard.ts`
- Create: `tests/adapters/sqs-scheduler.test.ts`
- Create: `tests/runtime/cost-guard.test.ts`

**Interfaces:**
- Produces: `scheduleNextScan(random): Promise<{ delaySeconds: number }>`.
- Produces: `assessMonthlyUsage(usage, limits): CostDecision`.

- [x] **Step 1: Write failing delay tests**

Assert `DelaySeconds` is an integer from 75 through 105 inclusive, message body contains only `{ "kind": "scan", "schemaVersion": 1 }`, and no session or token data is included.

- [x] **Step 2: Implement SQS scheduling**

Use one `SendMessageCommand`. Persist `next_scan_at` only after SQS accepts the message. Make the delay generator injectable for deterministic tests.

- [x] **Step 3: Write failing cost tests**

Cover usage below 70% (`CONTINUE`), 70–87.49% (`WARN`), 87.5% or higher (`PAUSE`), and 31,000 scans (`PAUSE`). Calculate projected GB-seconds as `invocations * configuredMemoryGb * averageDurationSeconds`.

- [x] **Step 4: Implement and run tests**

Run: `npx vitest run tests/adapters/sqs-scheduler.test.ts tests/runtime/cost-guard.test.ts` and `npm run typecheck`.

- [x] **Step 5: Commit**

Commit: `git add src/adapters src/runtime tests && git commit -m "feat: schedule scans and guard free-tier usage"`

### Task 4: Build Lambda scan and supervisor handlers

**Files:**
- Create: `src/lambda/handler.ts`
- Create: `src/lambda/supervisor.ts`
- Create: `src/runtime/errors.ts`
- Create: `tests/lambda/handler.test.ts`
- Create: `tests/lambda/supervisor.test.ts`

**Interfaces:**
- Produces: `handler(event, context): Promise<void>`.
- Produces: `runSupervisor(dependencies, now): Promise<SupervisorResult>`.

- [x] **Step 1: Write a failing scan-handler sequence test**

Assert the handler loads config, exits immediately when disabled/paused, checks cost, schedules the next SQS message, decrypts session, constructs the browser client, and calls `runMonitor`. Scheduling must occur before browser navigation.

- [x] **Step 2: Implement scan handling and typed errors**

Map `SessionExpiredError` and `SessionChallengeError` to indefinite pause; map `RateLimitError` to 6-hour, then 24-hour, then manual pauses; map `PageStructureError` to pause plus diagnostic alert. Store only error class, redacted message, timestamp, and request ID.

- [x] **Step 3: Write and implement supervisor tests**

If enabled and `next_scan_at` is more than three minutes old with no active lock, send one immediate SQS scan. Otherwise do nothing. Use an idempotency marker so repeated ten-minute supervisor events do not create a flood.

- [x] **Step 4: Verify finally blocks and duplicate delivery**

Test SQS redelivery with the same message ID, lock contention, notifier failure, and a Lambda deadline with fewer than three seconds remaining.

- [x] **Step 5: Run and commit**

Run: `npx vitest run tests/lambda` and `npm test`.

Commit: `git add src/lambda src/runtime tests/lambda && git commit -m "feat: run and supervise Lambda monitor"`

### Task 5: Define least-privilege AWS SAM infrastructure

**Files:**
- Create: `template.yaml`
- Create: `samconfig.toml.example`
- Create: `tests/infrastructure/template.test.ts`

**Interfaces:**
- Produces: deployable `sam build` and `sam deploy --guided` stack.

- [ ] **Step 1: Write failing template assertions**

Parse YAML and assert:

- Runtime `nodejs22.x`, architecture `x86_64`, memory `1024`, timeout `30`, reserved concurrency `1`.
- SQS batch size `1`, visibility timeout at least `120`, encrypted queue, and DLQ.
- DynamoDB provisioned capacity `1` read and `1` write; omit paid continuous backups in the zero-cost baseline.
- EventBridge supervisor every ten minutes.
- Log retention seven days.
- No VPC, NAT, public HTTP API, Secrets Manager, or plaintext secret parameters.
- IAM actions are resource-scoped to the created table, queues, and named SSM parameters.

- [ ] **Step 2: Create the SAM template**

Use `AWS::Serverless::Function` with esbuild metadata targeting `es2022`. Include `@sparticuz/chromium` and `playwright-core` in the ZIP artifact, while excluding local full Playwright browser downloads.

- [ ] **Step 3: Add stack outputs without secrets**

Output function name, table name, queue URL, and region only. Do not output parameter values, session records, tokens, or encryption keys.

- [ ] **Step 4: Validate locally**

Run:

```powershell
npx vitest run tests/infrastructure/template.test.ts
sam validate --lint
sam build --use-container
```

Expected: all commands exit zero and the ZIP remains below Lambda limits.

- [ ] **Step 5: Commit**

Commit: `git add template.yaml samconfig.toml.example tests/infrastructure && git commit -m "infra: define free-tier AWS monitor stack"`

### Task 6: Add safe bootstrap and operational scripts

**Files:**
- Create: `scripts/bootstrap-parameters.ps1`
- Create: `scripts/seed-blacklist.ps1`
- Create: `scripts/invoke-once.ps1`
- Create: `scripts/activate-monitor.ps1`
- Create: `scripts/deactivate-monitor.ps1`
- Create: `docs/runbook.md`

**Interfaces:**
- Produces: explicit operator commands that do not echo secrets.

- [ ] **Step 1: Implement parameter bootstrap**

Prompt securely for the Telegram bot token and chat ID, generate a 32-byte random session key locally, and write standard SecureString parameters. Never accept secrets as command-line arguments and never print their values.

- [ ] **Step 2: Implement immutable initial blacklist seeding**

Write LERIBE records for normalized name `CORPORACION LERIBE SAC` and RUC `20517854523`, reason `Cobranza administrativa I`, source `manual-initial`, and current timestamp. Make reruns idempotent and never remove existing entries.

- [ ] **Step 3: Implement one-shot, activation, and deactivation scripts**

`invoke-once.ps1` sends one scan message without enabling chaining. `activate-monitor.ps1` requires the user to type `ACTIVAR` before setting enabled state and sending the first delayed message. `deactivate-monitor.ps1` immediately sets disabled state without deleting data.

- [ ] **Step 4: Write the runbook**

Document account setup, `sa-east-1`, billing alert email, SAM deployment, parameters, session capture, test message, one-shot scan, activation, pause reasons, reauthentication, cost review, rollback, and complete teardown resource list.

- [ ] **Step 5: Run PowerShell syntax checks and commit**

Run each script with its documented `-WhatIf` or validation mode. Confirm none writes or prints secrets during validation.

Commit: `git add scripts docs/runbook.md && git commit -m "ops: add safe AWS monitor runbook"`

### Task 7: Perform controlled deployment and 24-hour verification

**Files:**
- Modify: `docs/runbook.md`
- Create locally but do not commit: `.env.local`

**Interfaces:**
- Produces: a deployed but initially disabled AWS stack, then a verified 24/7 monitor.

- [ ] **Step 1: Run the complete local gate**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
sam validate --lint
sam build --use-container
```

Expected: every command exits zero.

- [ ] **Step 2: Deploy disabled with the user present**

Run `sam deploy --guided` in `sa-east-1`. Configure a USD 1 billing alert email. Confirm the stack exposes no public endpoint and monitor config remains disabled.

- [ ] **Step 3: Bootstrap Telegram and encrypted session**

Create parameters without displaying secrets, seed LERIBE, capture the Prestamype session through the visible local browser, and send a standalone Telegram test message.

- [ ] **Step 4: Execute one read-only scan**

Run `scripts/invoke-once.ps1`. Verify logs contain no secrets, no forbidden locator was clicked, opportunity parsing is correct, and no duplicate message is generated.

- [ ] **Step 5: Activate for two hours and inspect metrics**

After explicit user confirmation, run `scripts/activate-monitor.ps1`. Inspect average/max duration, max memory, invocation count, SQS age, errors, Prestamype responses, Telegram delivery, and projected GB-seconds. Deactivate immediately for CAPTCHA, 403, 429, DOM mismatch, or projected paid usage.

- [ ] **Step 6: Continue to 24 hours and record measured limits**

If the two-hour gate is clean, continue to 24 hours. Record measured average duration, p95 duration, maximum memory, scans per hour, estimated monthly Lambda GB-seconds, SQS operations, and projected cost in the runbook.

- [ ] **Step 7: Final verification and commit**

Rerun the complete local gate, inspect `git status`, verify no `.env.local`, session, token, or AWS credential file is tracked, and commit only the redacted runbook measurements.

Commit: `git add docs/runbook.md && git commit -m "docs: record controlled AWS rollout results"`
