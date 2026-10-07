# Manda Money API

Standalone backend replacement for the current Google Apps Script API. This
project has its own Git repository and deployment lifecycle, separate from
the Vue frontend. It uses Node.js, TypeScript, Fastify, and MongoDB.

## Local development

1. Use Node.js 20 or later.
2. Run `npm install` from this directory.
3. Copy `.env.example` to `.env` and set a development MongoDB URI. Do not
   commit `.env`; keep credentials in the hosting provider's secret settings
   outside local development.
4. Run `npm run dev`.
5. Check `GET /health/live` for process liveness and `GET /health/ready` for
   database connectivity.

`MONGODB_URI` is required to start the server. `TRUST_PROXY` defaults to
`false`. Enable it only after verifying that the hosting proxy safely
overwrites forwarded client IP headers; otherwise clients could spoof their
IP and bypass rate limiting.

Local development uses the separate `mandamoney_test` database by default.
The `npm run seed:test` command refuses to run unless that exact database is
selected and `NODE_ENV` is not production, except when the explicit
`ALLOW_TEST_SEED=true` deployment flag is set. It creates synthetic accounts,
categories, two sample purchases, and reciprocal test balances; it does not
copy data from the spreadsheet or production. The flag cannot override the
database-name check.

Test login: phone `00000000001`, birthday `01/01/1990`. A second synthetic
account is available with phone `00000000002` and the same test birthday.
These credentials exist only in `mandamoney_test`.

## Hosted test API

[`render.yaml`](./render.yaml) defines a separate Render Free Web Service for
the test API. It is intentionally **not** a production service: Render's free
web instances sleep when idle and have monthly usage limits. The blueprint
uses `mandamoney_test`, creates only synthetic fixtures before deploy, and
prompts for `MONGODB_URI` and `LEGACY_AUTH_PEPPER` instead of storing secrets
plus the optional provider URLs instead of storing secrets in Git. For
stronger separation, create an Atlas database user restricted to
`mandamoney_test`; do not reuse production database credentials. Seeding runs
in the build command because Render Free does not provide a separate pre-deploy
command.

After the API repository is available to Render, create the service from its
Blueprint and provide the requested secrets. Once deployed, use the service's
HTTPS URL plus `/api/v1` as the frontend Actions secret
`VITE_MANDAMONEY_TEST_API_URL`. The frontend repository workflow then serves
that build from `/test/`. The production Actions secret
`VITE_MANDAMONEY_API_URL` must point to a distinct, already-operational
production API. Both APIs must allow the GitHub Pages origin
`https://emanoel-alves.github.io` in `CORS_ORIGINS`.

## Authentication

The frontend preserves the current login flow: users enter their phone and
birthday at `POST /api/v1/auth/login`. The API compares a keyed verifier
produced during import; it never stores the birthday itself. Configure
`LEGACY_AUTH_PEPPER` as a random secret of at least 32 characters both when
importing the CSV data and on the API host. Login is rate limited.

Sessions are random bearer tokens stored only as SHA-256 hashes, expire after
seven days, and can be revoked with `POST /api/v1/auth/logout`. Authentication
requests have an additional per-IP rate limit. Keep `LEGACY_AUTH_PEPPER`
in the API host's secret settings and never expose it to the Vue build.

## API contract

The versioned contract is in [`openapi.yaml`](./openapi.yaml). Money sent over
the new API is represented as integer `valueCents`/`amountCents` values.
Existing spreadsheet IDs are preserved as `legacyId` during import.

This deployment models one household per database: every authenticated
household member can read the complete household item list and member list,
matching the former shared spreadsheet. Financial balances, payment actions,
and disputes remain scoped to the authenticated user. Do not place multiple
households in one database; add and enforce `householdId` on every document
before supporting multiple homes in a deployment.

Implemented finance routes include bootstrap, cursor-paginated item reads,
idempotent item batches, balances and balance details, payment requests and
confirmation, dispute submission and resolution, reciprocal offsets, and
pending notifications. `GET /api/v1/household/users` returns the registered
members of this single household. Items keep the authenticated registrant in
`buyerId`; the registrant does not have to participate in the split. Other
participants marked in `paidDirectlyBy` are excluded from resulting balances.
The authenticated `/api/v1/shopping-list` GET and POST routes manage shared
household shopping needs; `DELETE /api/v1/shopping-list/{itemId}` removes an
item after purchase.
Categories are stored in their own MongoDB collection;
`GET /api/v1/categories` is public for the current legacy frontend, and
authenticated users can add a category with `POST /api/v1/categories`.
Product-to-category associations are stored in `productCategoryMappings`.
The authenticated `GET /api/v1/categories/product-mappings?products=...`
looks up known products, and `POST /api/v1/categories/product-mappings`
persists a user's category selection for future purchases. Product names are
normalized for matching; no category heuristics are maintained in the
frontend.
Categories imported from purchase records retain their display colors.
All finance and item-import routes require a bearer session.
Each state-changing finance request requires an `Idempotency-Key` header; the
same key and request replay the original response for seven days, while reuse
for another request is rejected.

The NFC-e QR reader decodes the code in the browser and the API directly
queries the official Ceará SEFAZ NFC-e endpoint. It accepts QR URLs hosted at
`nfce.sefaz.ce.gov.br` whose access key is for Ceará (state code `23`); other
states are reported as unsupported. The API posts only the validated QR
parameters to the fixed SEFAZ endpoint, parses the returned receipt data, and
does not need an Apps Script URL. The Ceará endpoint currently requires HTTP,
so the QR payload is not encrypted in transit to that government host.
Receipt photos are submitted by the authenticated API directly to Gemini
using the server-side `GEMINI_API_KEY`; the browser never receives the key.
The default model is `gemini-3.6-flash`, with `gemini-2.5-flash` as a fallback;
both can be changed with `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL`. The API
validates and normalizes extracted products, discards raw model text, retries
rate-limit/transient responses, and tries the fallback model if the primary
model fails or cannot identify valid items. Configure a Gemini API key
separately on each API deployment. Receipt images are sent to Google's Gemini
API for processing.

Every multi-document finance write uses MongoDB transactions. The selected
Atlas deployment must support transactions (a replica set/sharded cluster);
operations fail instead of falling back to non-atomic writes. Conditional state
updates, a partial unique index for one pending balance per directed pair, and
idempotency records protect concurrent retries. Validate the actual Atlas
cluster and concurrent requests in staging before launch.

Run `npm run test:atlas` only against a development/test database configured
in the API `.env`. It uses UUID-scoped temporary users, items, balances, and
requests in the configured database, verifies idempotent writes and
concurrent offsets, and deletes only records bearing those generated IDs in a
`finally` cleanup. Do not run it against production.

## Legacy CSV import (development only)

Put the six original exports in a local directory using these filenames:
`Usuarios.csv`, `Compras_Itens.csv`, `Saldos.csv`, `Saldo_Itens.csv`,
`Pagamentos.csv`, and `Contestacoes.csv`. Keep the backup outside Git and do
not send it to a production database. The importer trims header whitespace
(including the trailing space present in the original `Pago_Direto_Por`
header), validates references and statuses, preserves legacy IDs, and stores
only an HMAC verifier for each legacy birthday; birthday values are never
written to MongoDB or included in the report. Item categories are also
upserted into the `categories` collection by normalized name, so re-running
the import does not create duplicates.

Start with a validation-only dry run; it does not connect to MongoDB or require
`LEGACY_AUTH_PEPPER`:

```sh
npm run import:legacy -- "C:\path\to\csv-backup"
```

Review the aggregate counts/totals and any issue locations (`file`, row,
column, and error code). The command aborts before writes if it finds any
invalid records. Only after confirming that `.env` points to the development
Atlas database, rerun explicitly with `--apply`; all collection upserts then
run in one MongoDB transaction, and repeated imports by the same legacy IDs are
safe:

```sh
npm run import:legacy -- "C:\path\to\csv-backup" --apply
```

`--apply` is refused when `NODE_ENV=production`. The importer never edits or
deletes spreadsheet/CSV data. Run comparisons against the source backup before
using the imported database for staging.
Set a private `LEGACY_AUTH_PEPPER` of at least 32 characters in the API `.env`
before using `--apply`.
