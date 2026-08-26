# Architecture Consistency Review

> **SUPERSEDED (2026-08-27).** This review reconciled the drafts below it (`whatsapp-bot.md`, `domain-model.md`, `integration-contract.md`, `message-contract.md`) with each other, but the actual implementation diverged from all of them — it took a simpler path (see `auth-mapping.md`'s superseded-notice) rather than the glossary/endpoints recommended here. See `VIEWORA_ARCHITECTURE_AUDIT.md` (repo root) for what's actually built. Kept for historical context only.

Status: Draft

Reviewed documents

- `whatsapp-bot.md`
- `domain-model.md`
- `integration-contract.md`
- `message-contract.md`

Reviewer role: Principal Software Architect

Purpose

This review reconciles the four architecture documents and produces a single source-of-truth analysis to prevent divergence before designing the database and API contracts. It highlights inconsistencies, conflicting terminology, missing concepts, SRP violations, circular dependencies, and recommended changes.

1. Executive summary

The documents present a strong, multi-channel conversation platform vision and correctly separate concerns between adapters, normalization, conversation logic, storage and processing. However, terminology is inconsistent across files (Property vs Space, sessions vs conversation_sessions, media vs property_media) and some responsibilities are duplicated or underspecified (where idempotency state is stored, who is responsible for triggering processing, and what exactly adapters may do). Before any DB schema or API contract is authored we must unify terminology, finalize the Normalized Message Contract as the single source-of-truth for adapters, and explicitly pin down the C2C (conversation ↔ processing) handoff (endpoint names, authentication, and idempotency keys). Implementing these fixes is low effort and will significantly reduce rework later.

2. Inconsistencies between documents

- Naming of primary business object
  - `whatsapp-bot.md` and `domain-model.md` use `Property` (and refer to `properties`), while some earlier repo routes use `spaces` and code comments mention `properties`/`property_type`. The repo already uses `properties` in SQL/RPC naming; documents must converge on one canonical term.

- Session/table naming
  - `whatsapp-bot.md` and the review initially suggested `whatsapp_sessions` vs the later guidance to prefer `conversation_sessions`. The domain model names `ConversationSession`. Documents must pick one canonical name and use it consistently.

- Media entity naming
  - Documents alternate between `PropertyMedia`, `media`, and `whatsapp_media` — these should be reconciled to `property_media` (domain-level) with an adapter-level `conversation_media` or `incoming_media` concept if needed.

- Processing trigger and hook names
  - `integration-contract.md` proposes `POST /internal/processing/trigger` as an example; `whatsapp-bot.md` earlier referenced existing `uploads`/`spaces` endpoints without a concrete mapping. The integration contract must reference the exact internal endpoint names (or mark them as TBD) and the final document must be updated when exact routes are chosen.

- Responsibility for media binary upload
  - `whatsapp-bot.md` and `integration-contract.md` both state the adapter uploads to R2; `message-contract.md` says adapter is responsible for fetching binary and uploading to R2. This is consistent, but the boundary (adapter vs conversation service) should be explicit: adapter should fetch and hand binary to conversation service or upload directly to R2 using plugin client; pick one and document the decision.

3. Conflicting terminology

List of terms that currently conflict or overlap across documents and recommended canonical term:

- Space vs Property
  - Use: `Property` (domain model) — canonical resource representing a real estate asset.

- Media vs PropertyMedia vs whatsapp_media
  - Use: `PropertyMedia` (domain-level). For conversation-uploaded assets, use `ConversationMedia` transient concept until attached to a `PropertyMedia` record.

- Session vs ConversationSession vs sessions
  - Use: `ConversationSession` for domain object; table naming may be `conversation_sessions`.

- ConversationEvent vs ConversationMessage vs events
  - Use: `ConversationEvent` for append-only audit entries (inbound/outbound messages + state transitions).

- Conversation Engine vs Orchestrator vs Adapter
  - Use: `Adapter` for provider-specific I/O, `Normalizer` for mapping to `IncomingMessage`, `ConversationEngine` for pure state machine/business decisions, and `Orchestrator` for the component that performs side effects (persist, call processing trigger, send messages). Keep these distinct.

4. Missing concepts

- Idempotency store
  - Documents mention dedupe and `provider_event_id`, but there is no explicit design for where provider event ids are persisted and how dedupe windows are configured.

- Authentication & authorization for internal cross-service calls
  - `integration-contract.md` recommends auth but doesn't define mechanism (API key, signed JWT, mTLS); pick an approach and make it consistent.

- Error states and compensating actions
  - More detail required for persistent failures, human-in-the-loop escalation, and state transitions (e.g., `failed_upload` → manual retry flow).

- Monitoring / observability minimal requirements
  - Health checks, queue depth, failed media counts and concurrency limits are noted but not defined to allow operational readiness for S1.

- Provider event schema / canonical id
  - Need a signed or canonical `provider_event_id` strategy (concatenate provider name + event id) and retention policy.

5. Duplicate responsibilities

- Orchestration vs n8n
  - Both documents suggest orchestration responsibilities; earlier architecture left n8n as an optional orchestrator. For S1, keep orchestration inside the Conversation Platform and reserve n8n for non-core automations to avoid duplication.

- Media upload responsibilities
  - Adapter and ConversationPlatform both claim to upload media. Decide whether the Adapter uploads directly to R2 (recommended) or passes binary to Orchestrator to upload — do not duplicate.

6. Components that violate Single Responsibility Principle

- Fastify route handlers containing business logic
  - Ensure route modules delegate to service layers; Fastify should be responsible only for routing, validation, and request/response concerns.

- Plugins doing both client initialization and business utility
  - Keep plugins minimal: initialize S3/R2 client, Supabase client, Redis client. Move higher-level logic to service modules.

- ConversationEngine blending state machine + network side-effects
  - Keep pure state transition logic inside a testable module; side-effects (persist, send, trigger) should be performed by an Orchestrator that calls repositories and adapter send helpers.

7. Circular dependencies

- Potential circularity between ConversationEngine and Processing system
  - If ConversationEngine synchronously calls Processing and Processing calls back into ConversationPlatform synchronously, a tight circularity exists. Instead, enforce async interactions: ConversationPlatform triggers processing and Processing later posts a processing-complete webhook or updates DB which ConversationPlatform subscribes to.

- Adapter ↔ ConversationEngine ↔ Processing ↔ Adapter
  - Acceptable if communications are via well-defined async interfaces (HTTP + webhook) with dedupe keys, but avoid in-process circular RPC calls.

8. Places where business logic leaks into adapters

- Media type decisions and processing triggers
  - Some docs allow adapters to decide `media_type` and call processing triggers. The decision whether media should be a `PHOTO` vs `PANORAMA` should be part of Normalizer rules but validated by ConversationEngine/orchestrator rather than left to adapter heuristics.

- Property draft creation
  - Avoid allowing adapters to create domain entities directly; the adapter should hand normalized message to ConversationEngine which then calls Repository / Domain services to create a `Property` draft.

9. Confirm whether the architecture supports future channels

Yes — with caveats. The conditional for cross-channel compatibility is strict enforcement of the Normalized `IncomingMessage` contract (`message-contract.md`) and strict SRP separation: adapters only perform provider-specific I/O and normalization; ConversationEngine uses the normalized model only. If adapters conform to the contract and the Normalizer is authoritative, adding Telegram/Instagram/Messenger/WebChat will not require changes to business logic.

However, to guarantee this:

- The Normalized schema must be exhaustive for interactive controls and media types (the `message-contract.md` is currently a good start and should be locked as the canonical contract).  
- Tests and adapter conformance checks should be created to validate adapters produce valid `IncomingMessage` instances.

10. Glossary of approved terminology (single source-of-truth)

Use these exact names across all documents and code:

- `Property` — domain resource representing a real estate asset (table: `properties` or `properties` logical name; prefer `properties`).
- `PropertyMedia` — media owned by a Property (table: `property_media`).
- `ConversationSession` — conversation instance and state for a particular sender (table: `conversation_sessions`).
- `ConversationEvent` — append-only audit/log entry for messages and state transitions (table: `conversation_events`).
- `IncomingMessage` — normalized cross-channel message schema (see `message-contract.md`).
- `Adapter` — provider-specific component that receives webhooks and sends messages.
- `Normalizer` — component that maps provider payload → `IncomingMessage`.
- `ConversationEngine` — pure state machine and business decision module.
- `Orchestrator` — component that executes side-effects (persisting state, calling processing trigger, sending messages). Keep Orchestrator thin and testable.
- `ProcessingPipeline` — existing Viewora media processing stack that turns raw uploads into viewer assets and Tours.
- `R2` — Cloudflare R2 object storage.

11. Recommended changes before DB / API design

Make the following changes and re-run the review before generating ERD or API contracts:

1. Unify terminology: adopt the approved glossary above and update all four documents to use the canonical names.
2. Lock the `IncomingMessage` schema as the single source-of-truth and add a short conformance checklist for adapters (required fields + validation rules).
3. Decide and document the exact processing trigger endpoint (map to existing `uploads` or `processing` routes in the codebase) or mark as `TBD` with a task and owner. Include expected payload and authentication mechanism.
4. Explicitly define where provider `provider_event_id` and related dedupe metadata are persisted (e.g., `conversation_events` table) and the dedupe retention policy.
5. Move any business logic out of adapters and Fastify route handlers into pure service modules: `Normalizer`, `ConversationEngine`, `Orchestrator`, `Repositories`.
6. Remove n8n from the core S1 path and document it as an out-of-band automation platform for non-core flows.
7. Define minimal failure/retry semantics for media fetch, R2 upload, and processing trigger (attempt counts and backoff policy).
8. Create an ADR folder and at least three ADRs for the decisions above (term naming, normalization contract, processing trigger/auth method). Add these ADRs to the repository.

12. Next steps (operational)

- Apply the glossary and naming changes across `whatsapp-bot.md`, `domain-model.md`, `integration-contract.md`, `message-contract.md` and regenerate this review to ensure consistency.
- After documents are reconciled, produce a conceptual ERD (no SQL), then an API contract and a folder structure scaffold.
- Maintain an ADR log under `docs/architecture/adr/` for each major decision.

End of review.
