# Conversation Platform — API Contract (Draft)

> **SUPERSEDED (2026-08-27).** Pre-implementation draft. None of the `/internal/conversations`, `/internal/tokens/delegate`, or `X-Hub-Signature`-verified `/whatsapp/webhook` endpoints described here exist — `routes/whatsapp.ts` is currently a no-op stub, and the real Telegram path (`routes/telegram.ts`) doesn't follow this internal-API shape at all. See `VIEWORA_ARCHITECTURE_AUDIT.md` (repo root) for what's real. Kept for historical context only.

Status: Draft

Purpose

This document defines the API surface for the Conversation Platform (S1). It focuses on the minimal external and internal endpoints required to: receive provider webhooks, normalize messages, persist session/media metadata, trigger processing, and receive processing-complete notifications. All request/response shapes are conceptual and must be validated against the `IncomingMessage` contract in `message-contract.md`.

Design principles

- Keep provider-specific traffic isolated to Adapter endpoints.
- Normalize messages as soon as possible and pass `IncomingMessage` to the ConversationEngine.
- All cross-service calls must be idempotent (use `client_event_id` or `provider_event_id`).
- Internal endpoints MUST be authenticated (API key / mTLS / signed JWT).

1. Public Adapter endpoints (provider → Conversation Platform)

- POST /whatsapp/webhook
  - Purpose: receive WhatsApp Cloud webhook events and acknowledge receipt.
  - Security: verify `X-Hub-Signature` (HMAC SHA256) using `WHATSAPP_APP_SECRET`.
  - Behaviour: adapter MUST return HTTP 200 within provider timeout for all valid events (even if processing happens async).
  - Request: Raw provider JSON (adapter extracts and then normalizes). Adapter persists `provider_event_id` then builds an `IncomingMessage` and calls `POST /internal/conversations/:sessionId/messages` (internal) or passes to ConversationEngine directly.
  - Response: `200 OK` with body `{ received: true }`.

- GET /whatsapp/health
  - Purpose: health check for Whatsapp adapter and R2/Supabase connectivity.
  - Response: `200 OK` `{ status: 'ok', r2: 'connected|unavailable', db: 'connected|unavailable' }`.

Notes:
- Other channel adapters (Telegram, Instagram, Messenger, WebChat) will expose equivalent routes under `/telegram/webhook`, `/instagram/webhook`, etc., but all adapters must normalize to `IncomingMessage` before handing to the engine.

2. Internal Conversation API (internal calls from Adapter → Engine and Processors → Platform)

- POST /internal/conversations
  - Purpose: Create or fetch a ConversationSession (idempotent). Useful when the adapter wants an explicit session before sending normalized messages.
  - Auth: internal API key or mTLS.
  - Request:
    ```json
    { "channel": "whatsapp", "sender_id": "+15551234567", "client_generated_id": "optional-id" }
    ```
  - Response:
    ```json
    { "session_id": "uuid-...", "created": true }
    ```

- POST /internal/conversations/:sessionId/messages
  - Purpose: Accept a normalized `IncomingMessage` (schema in `message-contract.md`) and append to the ConversationSession.
  - Auth: internal.
  - Request (example):
    ```json
    {
      "incoming_message": { /* IncomingMessage object */ },
      "client_event_id": "provider-event-123"
    }
    ```
  - Behaviour: dedupe on `client_event_id`/`provider_event_id`. Persist ConversationEvent. Invoke ConversationEngine to compute actions; persist session state changes.
  - Response:
    ```json
    { "handled": true, "session_state": "awaiting_media" }
    ```

- GET /internal/conversations/:sessionId
  - Purpose: Retrieve session state and context (auth-only, for debugging/admin UIs).

3. Processing trigger (Conversation Platform → Viewora Processing)

- POST /internal/processing/trigger
  - Purpose: Ask the existing backend to process a newly uploaded raw R2 object into viewer assets and scenes.
  - Auth: internal (API key / signed JWT / mTLS).
  - Request payload:
    ```json
    {
      "property_id": "uuid",
      "r2_key": "properties/{property_id}/source/{uuid}.jpg",
      "media_type": "PHOTO|PANORAMA|VIDEO|FLOOR_PLAN|DOCUMENT",
      "source": "conversation_platform",
      "client_event_id": "provider-event-123"
    }
    ```
  - Response: `202 Accepted` with `{ "job_id": "..." }` or `200 OK` with processing status.
  - Idempotency: backend must dedupe by `client_event_id` and `r2_key`.

4. Processing-complete notification (Processing → Conversation Platform)

- POST /internal/conversations/:sessionId/processing-complete
  - Purpose: Sent by the processing pipeline to inform the Conversation Platform that processing completed and a `tour_url` is available.
  - Auth: internal.
  - Request payload:
    ```json
    {
      "property_id": "uuid",
      "tour_id": "uuid",
      "tour_url": "https://app.viewora.software/p/slug",
      "processed_media_ids": ["uuid", ...]
    }
    ```
  - Behaviour: Conversation Platform persists event, updates `ConversationSession` state to `completed`, and sends outbound `OutgoingMessage` via the Adapter to the user with `tour_url`.
  - Response: `200 OK`.

5. Admin/Debug Endpoints (auth-only)

- GET /internal/conversations/:sessionId/events
  - Returns paginated `ConversationEvent` rows for debugging.

- POST /internal/conversations/:sessionId/send-test
  - Sends a test `OutgoingMessage` to the session sender using adapter send helper (auth-only).

6. Message formats (short reference)

- IncomingMessage: see `docs/architecture/message-contract.md` (canonical schema). Adapters MUST validate and supply `provider_event_id` and `message_id` when available.

- OutgoingMessage (engine → adapter)
  - Minimal conceptual shape:
    ```json
    {
      "to": "+15551234567",
      "type": "text|image|interactive",
      "payload": { /* per-type */ },
      "client_event_id": "internal-id-123"
    }
    ```
  - Adapter transforms `OutgoingMessage` into provider-specific send requests.

7. Security

- Public adapter endpoints must verify provider signatures (HMAC or provider-specific verification).
- Internal endpoints must require authentication (API key, signed JWT, or mTLS). For S1, an API key with strict secrets rotation is acceptable; for production, prefer mTLS or signed JWTs.

8. Idempotency

- All endpoints that cause side effects must accept an idempotency key (prefer `client_event_id` from provider) and be deduped server-side.
- ConversationPlatform must persist `provider_event_id` on `ConversationEvent` to avoid double-processing.

9. Error handling and response codes

- 200 OK — success (sync flows where applicable).
- 202 Accepted — accepted for async processing (e.g., processing trigger).
- 400 Bad Request — invalid payload.
- 401 Unauthorized — auth failure.
- 409 Conflict — idempotency conflict (if request repeated with different payload).
- 500 Internal Server Error — transient errors.

10. Examples

- Example adapter flow: WhatsApp webhook (high-level)

1. WhatsApp sends webhook to `/whatsapp/webhook`.
2. Adapter verifies signature. Adapter extracts provider event id and builds `IncomingMessage`.
3. Adapter calls `POST /internal/conversations` (if session absent) and obtains `session_id`.
4. Adapter calls `POST /internal/conversations/:sessionId/messages` with `IncomingMessage`.
5. Conversation Engine instructs adapter/orchestrator to fetch media and call `POST /internal/processing/trigger`.

11. Versioning and compatibility

- API must be versioned when changes are breaking. Start with `v1` in the URL or internal routing if you expect incompatible changes later.

12. Next steps

- Review and approve this API contract. After approval, I will produce a detailed API OpenAPI-style contract and then map existing backend endpoints (`src/routes/uploads.ts`, `src/routes/spaces.ts`) to the `processing/trigger` contract for integration.
