# Auth Mapping — Delegated User JWT (Option A)

> **SUPERSEDED (2026-08-27).** This "delegated JWT" design (magic-link/OAuth onboarding, a `POST /internal/tokens/delegate` issuance endpoint) was never built. What actually shipped is simpler: `src/conversation/anonymousAuth.ts::ensureAnonymousIdentity()` mints/reuses a real Supabase **anonymous** session per `(channel, sender_id)` and persists its refresh token in `conversation_sessions` — the same primitive the web app's `useAnonymousAuth.ts` + `linkIdentity()` claim flow already uses. No delegated-token issuer, no magic links, no separate scopes. The still-open gap is a claim-bridge endpoint to hand that stored session to a claimer's browser — see `VIEWORA_ARCHITECTURE_AUDIT.md` (repo root, §11 and §23) for the real design. Kept for historical context only — do not build against this document.

Status: Draft (superseded)

This document records the chosen auth mapping for ConversationPlatform integrations: Delegated user JWTs (Option A). It describes token properties, onboarding flows, security controls, and an implementation checklist for Sprint 1.

1. Goal

Enable the ConversationPlatform (WhatsApp adapter) to perform user-scoped actions (`/spaces`, `/uploads/*`) as the correct Viewora user while preserving quotas, billing, and audit trails.

2. Token model (delegated JWT)

- Issuer: Viewora auth service (or dedicated delegation issuer)
- Subject: `user_id` (UUID)
- Audience: `viewora-api`
- Scopes (example): `spaces:create`, `uploads:write`, `uploads:read`
- TTL: 15 minutes — 1 hour (recommend 15m for high-risk operations)
- Signed with rotating RSA/EC keys; the API verifies signature and scope.

3. Onboarding / issuance flows (choose one)

- Magic-link (recommended UX)
  - ConversationPlatform asks for an email to link to the WhatsApp sender.
  - Viewora sends a magic link; user clicks to confirm ownership.
  - After confirmation, backend issues a delegated JWT and returns it to ConversationPlatform via a secure callback or polling endpoint.

- OAuth / Connect
  - Standard OAuth flow where ConversationPlatform obtains authorization for a `user_id` and exchanges a code for a delegated token.

- Invite / Lightweight account
  - Create a minimal user record for the WhatsApp sender; user claims account later. Use short-lived tokens for initial actions.

4. API usage pattern

1. Before performing any user-scoped action, ConversationPlatform ensures `ConversationSession.user_id` exists.
2. ConversationPlatform requests a delegated token for that `user_id` (or uses one cached with valid TTL).
3. Use `Authorization: Bearer <delegated_user_jwt>` on calls to `/spaces`, `/uploads/create-signed-url`, `/uploads/complete`.
4. Use `Idempotency-Key` / `client_event_id` to dedupe provider events.

5. Server-side token issuance endpoint (example)

- Path: `POST /internal/tokens/delegate`
- Auth: `Authorization: Bearer <INTERNAL_ADMIN_TOKEN>`
- Body: `{ user_id, session_id, scopes }`
- Response: `{ token, expires_in }`

6. Security & audit controls

- Only internal services may call the token issuance endpoint.
- Record `delegated_token_id`, `session_id`, `issued_by`, and `issued_at` to an audit log.
- Enforce scope checks at API entry points (e.g., `/uploads/complete` requires `uploads:write`).
- Short TTL, revoke list, and key rotation mandatory.

7. Rollout checklist (Sprint 1)

- [ ] Add `ConversationSession.user_id` persistence.
- [ ] Implement `POST /internal/tokens/delegate` (issue short-lived JWTs).
- [ ] Update ConversationPlatform onboarding to perform magic-link flow and fetch token.
- [ ] Update integration docs and sample client to use delegated JWT.
- [ ] Add monitoring/alerts for token issuance and suspicious activity.

8. Operational considerations

- Logging: include `session_id`, `client_event_id`, `user_id` on all on-behalf actions.
- Monitoring: track token issuance rates, errors, and unusual IPs.
- Cleanup: auto-expire unclaimed agent accounts and orphaned media placeholders.

9. Example curl (request delegated token, then use it)

Request delegated token (admin-internal call):

```
curl -X POST https://api.viewora.software/internal/tokens/delegate \
  -H "Authorization: Bearer <INTERNAL_ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user-uuid-123","session_id":"conv-xyz","scopes":["spaces:create","uploads:write"]}'
```

Use token to create signed url:

```
curl -X POST https://api.viewora.software/uploads/create-signed-url \
  -H "Authorization: Bearer <delegated_user_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"propertyId":"property-uuid-123","mediaType":"panorama","fileName":"img.jpg","contentType":"image/jpeg"}'
```

10. Next work I can do now

- Scaffold `POST /internal/tokens/delegate` endpoint (non-breaking, internal-only) and a small test harness.
- Add example magic-link frontend exchange stub in docs.

If you want me to implement the token-issuance scaffold now, say "scaffold token endpoint" and I'll add the code and register it in `src/index.ts`.
