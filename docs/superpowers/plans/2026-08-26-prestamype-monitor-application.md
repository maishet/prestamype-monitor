# Prestamype Monitor Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and locally verify the read-only Prestamype monitor, including filtering, scoring, blacklist enforcement, safe browser navigation, session capture, and Telegram message generation.

**Architecture:** A TypeScript application separates deterministic domain logic from browser, persistence, and notification ports. Playwright extracts only visible Prestamype data; the orchestration service evaluates normalized opportunities and emits idempotent alert intents. AWS-specific adapters are deferred to the deployment plan.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Playwright Core, `@sparticuz/chromium`, AWS SDK v3 types, ESLint, Prettier.

## Global Constraints

- Use Node.js 22 and strict TypeScript with ES modules.
- Install dependencies with `--save-exact`; commit `package-lock.json`.
- Apply test-driven development: failing test, observed failure, minimal implementation, passing test, commit.
- Never log cookies, tokens, authorization headers, passwords, or decrypted session state.
- Never click investment, reservation, payment, or confirmation controls.
- Never solve CAPTCHA or retry 403/429 responses aggressively.
- Keep all monetary values as integer cents and rates as decimal percentage points.
- Treat the design spec at `docs/superpowers/specs/2026-08-26-prestamype-monitor-design.md` as authoritative.

---

## File Map

```text
package.json
package-lock.json
tsconfig.json
vitest.config.ts
eslint.config.js
.prettierignore
src/
  config/defaults.ts
  domain/types.ts
  domain/normalization.ts
  domain/blacklist.ts
  domain/scoring.ts
  domain/evaluate.ts
  application/ports.ts
  application/monitor.ts
  browser/errors.ts
  browser/parsers.ts
  browser/prestamype-client.ts
  notifications/telegram-message.ts
  security/session-crypto.ts
  cli/capture-session.ts
  cli/dry-run.ts
tests/
  fixtures/opportunities.html
  fixtures/opportunity-detail.html
  domain/blacklist.test.ts
  domain/scoring.test.ts
  domain/evaluate.test.ts
  browser/parsers.test.ts
  browser/prestamype-client.test.ts
  notifications/telegram-message.test.ts
  security/session-crypto.test.ts
  application/monitor.test.ts
```

### Task 1: Scaffold the strict TypeScript test project

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `.prettierignore`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Produces: `npm test`, `npm run typecheck`, `npm run lint`, and `npm run format:check` project commands.

- [x] **Step 1: Initialize the package and install exact dependencies**

Run:

```powershell
npm init -y
npm install --save-exact @aws-sdk/client-dynamodb @aws-sdk/client-sqs @aws-sdk/client-ssm @aws-sdk/lib-dynamodb @sparticuz/chromium cheerio playwright-core zod
npm install --save-dev --save-exact @eslint/js @types/aws-lambda @types/node eslint eslint-config-prettier playwright prettier typescript typescript-eslint vitest
```

- [x] **Step 2: Add scripts and ESM metadata to `package.json`**

```json
{
  "type": "module",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "auth:capture": "node --import tsx src/cli/capture-session.ts",
    "dry-run": "node --import tsx src/cli/dry-run.ts"
  }
}
```

Install the TypeScript runner used by the two scripts:

```powershell
npm install --save-dev --save-exact tsx
```

- [x] **Step 3: Create strict compiler and Vitest configuration**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node", "aws-lambda"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', coverage: { reporter: ['text', 'json-summary'] } },
});
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.aws-sam/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`.prettierignore`:

```text
.aws-sam/
node_modules/
docs/
```

- [x] **Step 4: Write and run the smoke test**

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('project', () => {
  it('runs tests', () => expect(true).toBe(true));
});
```

Run: `npm test`

Expected: one passing test.

- [x] **Step 5: Run static checks and commit**

Run: `npm run typecheck` and `npm run format:check`.

Commit: `git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.js .prettierignore tests/smoke.test.ts && git commit -m "build: scaffold TypeScript monitor"`

### Task 2: Define domain contracts and defaults

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/config/defaults.ts`
- Test: `tests/domain/evaluate.test.ts`

**Interfaces:**
- Produces: `Opportunity`, `PaymentHistory`, `PortfolioSnapshot`, `Evaluation`, `MonitorConfig`, and `DEFAULT_CONFIG`.

- [x] **Step 1: Write a failing defaults test**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('DEFAULT_CONFIG', () => {
  it('accepts A+ through C and requires 15 percent annual return', () => {
    expect(DEFAULT_CONFIG.allowedRisks).toEqual(['A+', 'A', 'B', 'C']);
    expect(DEFAULT_CONFIG.minimumAnnualReturnPct).toBe(15);
    expect(DEFAULT_CONFIG.currency).toBe('PEN');
  });
});
```

- [x] **Step 2: Run the test and observe the missing module failure**

Run: `npx vitest run tests/domain/evaluate.test.ts`

Expected: FAIL because `defaults.ts` does not exist.

- [x] **Step 3: Create the domain types and defaults**

Define these exact shapes in `src/domain/types.ts`:

```ts
export type RiskGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'E';
export type Currency = 'PEN' | 'USD';

export interface PaymentHistory {
  totalAuctions: number;
  paidOnTime: number;
  paidLate: number;
  currentOnTime: number;
  overdue: number;
  averageDelayDays: number | null;
  delinquencyPct: number | null;
  historicalAmountCents: number | null;
}

export interface PartyIdentity {
  legalName: string;
  taxId: string | null;
}

export interface BlacklistEntry {
  taxId: string | null;
  normalizedName: string;
  reason: string;
  source: string;
  createdAt: string;
}

export interface Opportunity {
  id: string;
  url: string;
  supplier: PartyIdentity;
  debtor: PartyIdentity;
  risk: RiskGrade;
  currency: Currency;
  annualReturnPct: number;
  monthlyReturnPct: number | null;
  totalAmountCents: number;
  fundedAmountCents: number;
  remainingAmountCents: number;
  closesAt: string | null;
  dueAt: string | null;
  debtorHistory: PaymentHistory | null;
  supplierHistory: PaymentHistory | null;
  collectionProblem: boolean;
}

export interface PortfolioSnapshot {
  availableBalanceCents: number | null;
  activeTotalCents: number | null;
  exposureByTaxId: Readonly<Record<string, number>>;
}

export interface MonitorConfig {
  allowedRisks: readonly RiskGrade[];
  minimumAnnualReturnPct: number;
  currency: Currency;
  minimumInvestmentCents: number;
  highPriorityScore: number;
  reviewScore: number;
}

export interface Evaluation {
  decision: 'INVEST' | 'REVIEW' | 'IGNORE' | 'DO_NOT_INVEST';
  score: number;
  components: Readonly<Record<string, number>>;
  reasons: readonly string[];
  warnings: readonly string[];
}

export interface EncryptedSession {
  schemaVersion: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
}
```

Create `DEFAULT_CONFIG` with allowed risks `['A+', 'A', 'B', 'C']`, minimum annual return `15`, currency `PEN`, minimum investment `10000`, high priority `80`, and review `70`.

- [x] **Step 4: Run the focused test and all static checks**

Run: `npx vitest run tests/domain/evaluate.test.ts` and `npm run typecheck`.

Expected: PASS.

- [x] **Step 5: Commit**

Commit: `git add src tests && git commit -m "feat: define monitor domain contracts"`

### Task 3: Implement identity normalization and hard blacklist

**Files:**
- Create: `src/domain/normalization.ts`
- Create: `src/domain/blacklist.ts`
- Create: `tests/domain/blacklist.test.ts`

**Interfaces:**
- Produces: `normalizeLegalName(value: string): string`.
- Produces: `matchesBlacklist(opportunity, entries): BlacklistMatch | null`.

- [x] **Step 1: Write failing LERIBE tests**

```ts
import { describe, expect, it } from 'vitest';
import { matchesBlacklist } from '../../src/domain/blacklist.js';

const entries = [{ taxId: '20517854523', normalizedName: 'CORPORACION LERIBE SAC', reason: 'Cobranza administrativa I' }];

describe('matchesBlacklist', () => {
  it('matches LERIBE by RUC', () => {
    expect(matchesBlacklist({ taxId: '20517854523', legalName: 'Otro texto' }, entries)?.reason)
      .toBe('Cobranza administrativa I');
  });

  it('matches LERIBE by normalized legal name', () => {
    expect(matchesBlacklist({ taxId: null, legalName: 'Corporación Leribe S.A.C.' }, entries)).not.toBeNull();
  });
});
```

- [x] **Step 2: Run and observe failure**

Run: `npx vitest run tests/domain/blacklist.test.ts`

Expected: FAIL because the blacklist module is missing.

- [x] **Step 3: Implement deterministic normalization and matching**

`normalizeLegalName` must apply Unicode NFD, remove combining marks, uppercase, replace punctuation with spaces, normalize `S.A.C.`/`SAC`, and collapse whitespace. `matchesBlacklist` must prefer exact tax ID, then normalized name, and return the matched entry without fuzzy matching.

- [x] **Step 4: Add supplier-or-debtor coverage and rerun**

Add a test proving a helper named `findOpportunityBlacklistMatch` checks both parties and reports the role `supplier` or `debtor`.

Run: `npx vitest run tests/domain/blacklist.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

Commit: `git add src/domain tests/domain && git commit -m "feat: enforce permanent counterparty blacklist"`

### Task 4: Implement transparent scoring and hard-gate evaluation

**Files:**
- Create: `src/domain/scoring.ts`
- Create: `src/domain/evaluate.ts`
- Create: `tests/domain/scoring.test.ts`
- Modify: `tests/domain/evaluate.test.ts`

**Interfaces:**
- Consumes: domain types, defaults, and blacklist matching.
- Produces: `scoreOpportunity(opportunity, portfolio): ScoreBreakdown`.
- Produces: `evaluateOpportunity(input): Evaluation`.

- [x] **Step 1: Write failing scoring boundary tests**

Cover these exact expectations:

```ts
it('awards return points from 5 at 15 percent to 15 at 20 percent', () => {
  expect(scoreReturn(15)).toBe(5);
  expect(scoreReturn(17.5)).toBe(10);
  expect(scoreReturn(20)).toBe(15);
  expect(scoreReturn(25)).toBe(15);
});

it.each([['A+', 10], ['A', 10], ['B', 8], ['C', 6]] as const)(
  'scores risk %s as %i', (risk, expected) => expect(scoreRisk(risk)).toBe(expected),
);
```

- [x] **Step 2: Run and observe missing exports**

Run: `npx vitest run tests/domain/scoring.test.ts`

- [x] **Step 3: Implement component formulas**

Use these bounded formulas:

- Return: `clamp(5 + ((annualPct - 15) / 5) * 10, 0, 15)`.
- Risk: A+/A `10`, B `8`, C `6`, other `0`.
- Term: up to 90 days `5`, 91–120 `4`, 121–180 `2`, longer/unknown `0`.
- Debtor history: on-time ratio up to `18`, low delinquency up to `6`, low average delay up to `6`; missing history `4/30`.
- Supplier history: on-time ratio up to `14`, low average delay up to `6`; missing history `3/20`.
- Experience: auction count logarithmically capped at `10` plus historical amount capped at `5`.
- Concentration: projected exposure below 40% `5`, below 65% `3`, below 85% `1`, otherwise `0`; unknown portfolio `2`.

Round only the final total to one decimal place and keep every component within its declared maximum.

- [x] **Step 4: Write failing hard-gate tests**

Add cases proving:

- 14.99% is ignored and 15% passes the return gate.
- Risk D and E are ignored.
- USD is ignored.
- Remaining amount below S/100 is ignored.
- Any LERIBE match returns `DO_NOT_INVEST` regardless of a theoretical score above 80.
- `collectionProblem: true` returns `DO_NOT_INVEST`.
- Score 80 returns `INVEST`, score 70–79.9 returns `REVIEW`, and lower scores return `IGNORE`.

- [x] **Step 5: Implement `evaluateOpportunity` and run the suite**

Return hard-gate reasons before scoring. Preserve all blacklist and collection reasons in `warnings`.

Run: `npx vitest run tests/domain/scoring.test.ts tests/domain/evaluate.test.ts` and `npm run typecheck`.

Expected: PASS.

- [x] **Step 6: Commit**

Commit: `git add src/domain tests/domain && git commit -m "feat: score and evaluate Prestamype opportunities"`

### Task 5: Format concise Telegram recommendations

**Files:**
- Create: `src/notifications/telegram-message.ts`
- Create: `tests/notifications/telegram-message.test.ts`

**Interfaces:**
- Produces: `formatOpportunityAlert(opportunity, evaluation, portfolio, detectedAt): string`.
- Produces: `formatTechnicalAlert(event): string`.

- [x] **Step 1: Write failing message tests**

Assert that a high-priority message includes `🔴 OPORTUNIDAD ALTA`, company, risk, annual return, score, remaining amount, Lima timestamp, reasons, warnings, and direct URL. Add a S/0 test expecting `Saldo disponible: S/0.00` and `Sin liquidez disponible; no ejecutar inversión`.

- [x] **Step 2: Run and observe failure**

Run: `npx vitest run tests/notifications/telegram-message.test.ts`

- [x] **Step 3: Implement HTML-safe Telegram formatting**

Use Telegram HTML tags only after escaping `&`, `<`, and `>`. Keep messages below 4,000 characters. Use `Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' })` and `America/Lima` timestamps.

- [x] **Step 4: Add technical alert cases**

Cover `SESSION_EXPIRED`, `CAPTCHA`, `RATE_LIMIT`, `DOM_CHANGED`, `COST_PAUSE`, and `RECOVERED`. Technical messages must not contain raw exception objects or request headers.

- [x] **Step 5: Run and commit**

Run: `npx vitest run tests/notifications/telegram-message.test.ts` and `npm run typecheck`.

Commit: `git add src/notifications tests/notifications && git commit -m "feat: format Telegram opportunity alerts"`

### Task 6: Parse sanitized opportunity HTML fixtures

**Files:**
- Create: `src/browser/parsers.ts`
- Create: `src/browser/errors.ts`
- Create: `tests/fixtures/opportunities.html`
- Create: `tests/fixtures/opportunity-detail.html`
- Create: `tests/browser/parsers.test.ts`

**Interfaces:**
- Produces: `parseOpportunityCards(html: string): OpportunitySummary[]`.
- Produces: `parseOpportunityDetail(html: string, summary): Opportunity`.

- [x] **Step 1: Create minimal sanitized fixtures**

The list fixture must contain cards for A at 16%, C at 20%, D at 21%, and B at 14.9%. The detail fixture must contain pagador and proveedor histories with totals, on-time counts, late counts, current counts, delinquency, average delay, total amount, funded amount, remaining amount, and dates. Use invented company names and no cookies or account data.

- [x] **Step 2: Write failing parser tests**

Assert exact typed values, integer cents, decimal percentages, stable IDs from the opportunity link, and `null` for absent optional values. Assert that malformed essential fields produce a typed `PageStructureError` rather than guessed data.

- [x] **Step 3: Run and observe failure**

Run: `npx vitest run tests/browser/parsers.test.ts`

- [x] **Step 4: Implement parsers with explicit selector alternatives**

Use pure Cheerio functions over serialized HTML so tests do not start Chromium. Centralize selectors in a `PRESTAMYPE_SELECTORS` constant. Define `PageStructureError` in `src/browser/errors.ts`. Parse Peruvian number formats by removing currency text and thousands separators before converting to cents.

- [x] **Step 5: Run and commit**

Run: `npx vitest run tests/browser/parsers.test.ts` and `npm run typecheck`.

Commit: `git add src/browser tests/browser tests/fixtures && git commit -m "feat: parse visible Prestamype opportunity data"`

### Task 7: Build the safe Playwright client

**Files:**
- Create: `src/application/ports.ts`
- Create: `src/browser/prestamype-client.ts`
- Create: `tests/browser/prestamype-client.test.ts`

**Interfaces:**
- Produces: `OpportunitySource` port with `getPortfolio()` and `listEligibleOpportunities(config)`.
- Produces: `PrestamypeClient` implementing `OpportunitySource`.

- [x] **Step 1: Define ports and write a failing route-policy test**

Ports:

```ts
export interface OpportunitySource {
  getPortfolio(): Promise<PortfolioSnapshot>;
  listEligibleOpportunities(config: MonitorConfig, knownFingerprints: Readonly<Record<string, string>>): Promise<Opportunity[]>;
  close(): Promise<void>;
}

export interface MonitorRepository {
  acquireLock(owner: string, ttlEpochSeconds: number): Promise<boolean>;
  releaseLock(owner: string): Promise<void>;
  getBlacklist(): Promise<readonly BlacklistEntry[]>;
  getOpportunityFingerprints(): Promise<Readonly<Record<string, string>>>;
  hasAlert(alertKey: string): Promise<boolean>;
  saveOpportunity(opportunity: Opportunity, evaluation: Evaluation): Promise<void>;
  markAlerted(alertKey: string): Promise<void>;
}

export interface Notifier { send(message: string): Promise<void>; }

export interface SessionStore { saveEncryptedSession(payload: EncryptedSession): Promise<void>; }
```

Test that `shouldBlockResource('image')`, `font`, `media`, and known analytics hosts return true, while `document`, `script`, `xhr`, and Prestamype hosts remain allowed.

- [x] **Step 2: Run and observe failure**

Run: `npx vitest run tests/browser/prestamype-client.test.ts`

- [x] **Step 3: Implement browser launch and safety policy**

Launch one headless Chromium browser with one context, Spanish locale, Lima timezone, fixed viewport, supplied storage state, and no stealth/CAPTCHA plugins. Abort images, fonts, media, analytics, and ads. Set navigation timeout to 12 seconds and total scan deadline to 25 seconds.

- [x] **Step 4: Implement visible navigation flow**

Navigate to `/app/inversionista/oportunidades`, verify authenticated page markers, select **Retorno mayor**, restrict risk to A+/A/B/C when the visible UI supports it, and stop parsing once sorted returns are below 15%. Compare visible card fingerprints with the repository cache and open details sequentially only for new or materially changed candidates.

Explicitly reject any locator whose accessible name matches `/invertir|reservar|pagar|confirmar/i`. The client must expose no method capable of clicking those controls.

- [x] **Step 5: Add defensive-condition tests**

Mock Playwright boundaries and prove that CAPTCHA raises `SessionChallengeError`, login redirect raises `SessionExpiredError`, 403/429 raises `RateLimitError`, and missing sort confirmation raises `PageStructureError`.

- [x] **Step 6: Run and commit**

Run: `npx vitest run tests/browser/prestamype-client.test.ts` and `npm run typecheck`.

Commit: `git add src/application src/browser tests/browser && git commit -m "feat: add conservative Prestamype browser client"`

### Task 8: Orchestrate locking, evaluation, idempotency, and alerts

**Files:**
- Create: `src/application/monitor.ts`
- Create: `tests/application/monitor.test.ts`

**Interfaces:**
- Produces: `runMonitor(dependencies, input): Promise<MonitorRunResult>`.

- [x] **Step 1: Write a failing happy-path orchestration test**

Use in-memory fakes and assert this order: acquire lock, load blacklist, load portfolio, list candidates, evaluate, save opportunity, send alert, mark alert, close browser, release lock.

- [x] **Step 2: Run and observe failure**

Run: `npx vitest run tests/application/monitor.test.ts`

- [x] **Step 3: Implement the minimal orchestration**

Generate a material alert key from opportunity ID plus normalized risk, return, remaining amount, due date, and evaluation decision. Do not send `IGNORE` results. Send `DO_NOT_INVEST` only when a new blacklist/collection conflict is detected, not on every scan.

- [x] **Step 4: Add failure and idempotency tests**

Cover lock unavailable, duplicate alert, notifier failure, browser failure, and repository failure. In every case, assert `close()` and `releaseLock()` run in `finally`. Assert no partial financial recommendation is sent after parser or structure errors.

- [x] **Step 5: Run and commit**

Run: `npx vitest run tests/application/monitor.test.ts` and `npm test`.

Commit: `git add src/application tests/application && git commit -m "feat: orchestrate idempotent opportunity monitoring"`

### Task 9: Encrypt and capture the authenticated session locally

**Files:**
- Create: `src/security/session-crypto.ts`
- Create: `src/cli/capture-session.ts`
- Create: `tests/security/session-crypto.test.ts`

**Interfaces:**
- Produces: `encryptSession(storageState, key): EncryptedSession`.
- Produces: `decryptSession(payload, key): BrowserContextOptions['storageState']`.

- [ ] **Step 1: Write failing cryptography tests**

Assert AES-256-GCM round trip, unique IVs for identical input, rejection after ciphertext modification, and rejection of keys not exactly 32 bytes.

- [ ] **Step 2: Run and observe failure**

Run: `npx vitest run tests/security/session-crypto.test.ts`

- [ ] **Step 3: Implement session encryption**

Serialize storage state as UTF-8 JSON. Return base64 `iv`, `ciphertext`, and `authTag` plus schema version `1`. Never accept a caller-provided IV.

- [ ] **Step 4: Implement the capture CLI**

Open a visible local Playwright browser, navigate to Prestamype, print `Inicia sesión manualmente y vuelve aquí`, wait for the authenticated opportunities marker, capture `context.storageState()`, encrypt it, and write it through an injected `SessionStore`. Never request the password on stdin and never print the state.

- [ ] **Step 5: Run and commit**

Run: `npx vitest run tests/security/session-crypto.test.ts`, `npm run typecheck`, and `npm run lint`.

Commit: `git add src/security src/cli tests/security && git commit -m "feat: capture encrypted Prestamype session"`

### Task 10: Add a local dry-run and complete application verification

**Files:**
- Create: `src/cli/dry-run.ts`
- Create: `tests/application/dry-run.test.ts`
- Create: `README.md`

**Interfaces:**
- Produces: `npm run dry-run -- --fixture` with no network.
- Produces: `npm run dry-run -- --live` requiring explicit local session configuration.

- [ ] **Step 1: Write a failing fixture dry-run test**

Assert the command evaluates sanitized fixtures, outputs only a redacted recommendation summary, does not invoke Telegram, and exits zero.

- [ ] **Step 2: Implement fixture and live modes**

Fixture mode uses local HTML. Live mode opens the authenticated page read-only and prints prospective Telegram messages prefixed with `[NO ENVIADO]`. Require `--live`; never make live access the default.

- [ ] **Step 3: Document local commands and safety boundaries**

Document installation, test commands, session capture, fixture dry-run, live dry-run, redaction policy, and the fact that no investment actions exist.

- [ ] **Step 4: Run the full verification gate**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
npm run dry-run -- --fixture
```

Expected: all commands exit zero and no secret-like values appear in output.

- [ ] **Step 5: Commit**

Commit: `git add . && git commit -m "test: verify local Prestamype monitor workflow"`
