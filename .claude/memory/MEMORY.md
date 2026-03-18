# Viewora Backend Memory
**Last Updated:** 2026-03-18

## What This Is
Fastify TypeScript API server. The trusted rules engine for Viewora.
Handles: Paystack billing, upload signing, publish checks, plan enforcement, quota checks, analytics ingestion, lead submission.

## Deployment
- Platform: **Railway** (Nixpacks, Node 22)
- URL: `api.viewora.software`
- `.node-version`: `22`
- `railway.json` buildCommand: `npm run build` (Nixpacks runs `npm ci` separately)
- Start command: `node dist/index.js`
- Health check: `GET /health` → `{ status: 'ok', service: 'Viewora API' }`

## Tech Stack
- Node 22 + TypeScript (`tsc` build → `dist/`)
- **Fastify 5** + `@fastify/cors` + `@fastify/jwt`
- **@supabase/supabase-js** — Supabase service role client (bypasses RLS)
- **@aws-sdk/client-s3** + `@aws-sdk/s3-request-presigner` — R2 presigned URLs
- **axios** — Paystack API calls
- **zod** — installed (validation not yet fully applied to all routes)

## Required Env Vars (set in Railway Dashboard)
```
SUPABASE_URL              Supabase project URL
SUPABASE_SERVICE_KEY      service_role key (NOT anon key)
SUPABASE_JWT_SECRET       JWT Secret from Supabase → Settings → API
R2_ACCOUNT_ID             Cloudflare account ID
R2_BUCKET_NAME            viewora-tours
R2_ACCESS_KEY_ID          R2 API token access key
R2_SECRET_ACCESS_KEY      R2 API token secret
PAYSTACK_SECRET_KEY       sk_live_... from Paystack Dashboard
FRONTEND_URL              https://viewora.software
CORS_ORIGIN               https://viewora.software,https://viewora.vercel.app
PORT                      3000
MEDIA_DOMAIN              https://media.viewora.software
```
Startup fails fast (process.exit 1) if any required var is missing.

## Project Structure
```
src/
  index.ts              Fastify instance, plugins, routes, startup validation
  plugins/
    auth.ts             fastify.authenticate decorator — verifies Supabase JWT
    supabase.ts         fastify.supabase decorator — service role client
    s3.ts               fastify.s3 decorator — R2 S3 client
  routes/
    properties.ts       CRUD + publish/unpublish
    billing.ts          Paystack init, webhook, subscription-status
    uploads.ts          Presigned URL generation + upload completion
    leads.ts            Public lead submit + authenticated lead fetch
    analytics.ts        View increment (public) + summary (auth)
  utils/
    quotas.ts           checkUserQuota(), canCreateProperty(), checkStorageQuota(), checkFileSizeLimit(), isValidFileType()
```

## Route Map
```
GET  /health                              → public, health check

POST /properties                          → auth, create property
GET  /properties/by-slug/:slug            → public, fetch published property
PATCH /properties/:id                     → auth, update property metadata
DELETE /properties/:id                    → auth, delete property
POST /properties/:id/publish              → auth, publish/unpublish with all checks

POST /billing/initialize-paystack         → auth, create Paystack transaction
POST /billing/webhook/paystack            → public (no auth, HMAC verified)
GET  /billing/subscription-status         → auth, current plan + subscription
GET  /billing/plans                       → public, list all plans

POST /uploads/create-signed-url           → auth, R2 presigned PUT URL
POST /uploads/complete                    → auth, save media record after upload

POST /leads                               → public, submit lead
GET  /leads                               → auth, all leads for user's properties
GET  /leads/property/:id                  → auth, leads for specific property

POST /analytics/view                      → public, increment daily view counter
GET  /analytics/summary                   → auth, all analytics for user's properties
GET  /analytics/summary/:id               → auth, analytics for one property (30d)
```

## Quota Logic (`src/utils/quotas.ts`)
`checkUserQuota()` returns `QuotaContext`:
- `canWrite: true` → statuses: active, trialing, trial
- `isGrace: true` → statuses: grace_period, past_due (reads OK, writes blocked)
- Automatically detects expired grace period (grace_period_ends_at < now → expired)
- Falls back to **Free plan** if no subscription row exists
- `checkFileSizeLimit(plan, fileSize)` — enforces `plan.max_upload_bytes` per file
- `checkStorageQuota(...)` — enforces `plan.max_storage_bytes` cumulative

## Auth Pattern
Every authenticated route uses `{ preHandler: [fastify.authenticate] }`.
`request.user` contains the Supabase JWT payload: `user.sub` = user UUID.

Public routes (analytics, lead submit, health, plans) have NO auth hook.
Paystack webhook has NO auth hook but validates HMAC signature instead.

## R2 Path Structure
```
users/{userId}/properties/{propertyId}/panorama/{timestamp}.jpg
users/{userId}/properties/{propertyId}/gallery/{timestamp}.jpg
users/{userId}/properties/{propertyId}/thumb/{timestamp}.jpg
users/{userId}/branding/{timestamp}.png
users/{userId}/qr/{propertyId}.png
```

## Subscription Status Values (full set)
trial | trialing | active | past_due | grace_period | expired | canceled | unpaid | pending_payment

Grace period behavior:
- public content stays live
- uploads blocked
- new publishing blocked
- after `grace_period_ends_at` passes → expired, properties should be auto-unpublished (not yet automated)

## Known Gaps / Future Work
- Zod validation not fully applied to all route bodies (currently uses `as any` in some places)
- No `/properties` GET list endpoint (Nuxt Nitro handles this; Fastify handles writes)
- No rate limiting on public analytics/leads endpoints
- `subscription.disable` webhook → moves to `past_due`, not yet to `grace_period` automatically
- Grace period auto-unpublish not implemented (would need a cron or scheduled job)

## CI/CD
- `.github/workflows/build.yml` — Node 22, `npm ci` + `npm run build`
- Railway auto-deploys on push to `main`
- GitHub repo: `peter2valid/viewora-backend`
