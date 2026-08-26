# IncomingMessage Specification — Normalized Message Contract

> **PARTIALLY SUPERSEDED (2026-08-27).** The core idea (a normalized `IncomingMessage` shape adapters must produce) is real and matches what `src/adapters/telegram/normalizer.ts` and `src/conversation/types.ts` actually implement — but treat the exact field list here as aspirational, not verified, until checked against `types.ts` directly. See `VIEWORA_ARCHITECTURE_AUDIT.md` (repo root).

Status: Draft

Purpose

Define a single, normalized `IncomingMessage` schema that every channel adapter (WhatsApp, Telegram, Instagram, Messenger, Web Chat) must produce before handing messages to the Conversation Engine. The engine should only depend on this schema.

Design principles

- Channel-agnostic: adapters must translate provider-specific payloads into this common shape.
- Minimal & strict: required fields should be small and validated; optional fields carry provider-specific extras.
- Idempotent: include provider event ids for dedupe.

Normalized schema (conceptual)

Required fields

- `id` (string): unique id for this normalized message (UUID or adapter-generated id).
- `channel` (string): one of `whatsapp|telegram|instagram|messenger|webchat`.
- `provider_event_id` (string): original provider event id for deduplication.
- `message_id` (string | null): provider message id (if available).
- `sender` (object): identity of sender
  - `id` (string): provider-specific sender id (phone number, chat id)
  - `display_name` (string | null)
  - `profile` (object | null) — provider metadata (optional)
- `timestamp` (string, ISO8601): when the provider recorded the event.
- `type` (string): `text|image|video|audio|document|location|contact|button|list|unknown`.
- `payload` (any): normalized payload depending on `type`:
  - `text`: { `text`: string }
  - `image`: { `provider_media_id`: string, `caption`?: string, `filename`?: string }
  - `video`: { `provider_media_id`: string, `caption`?: string }
  - `audio`: { `provider_media_id`: string }
  - `document`: { `provider_media_id`: string, `filename`?: string }
  - `location`: { `latitude`: number, `longitude`: number }
  - `contact`: { `vcard`?: string, `phone`?: string, `name`?: string }
  - `button`: { `id`: string, `text`: string }
  - `list`: { `id`: string, `title`: string }

Optional fields

- `context` (object): adapter-provided metadata (raw provider payload, headers, signature verification result).
- `channel_metadata` (object): provider-specific structured data (e.g., quick_reply metadata, interactive types).

Reply model (what the Conversation Engine expects to produce)

The engine should emit `OutgoingMessage` objects that the adapter transforms to provider-specific send formats. OutgoingMessage fields (conceptual):

- `to` (sender.id)
- `type` (text|image|template|button|list|interactive)
- `payload` (structured per type)

Media attachments

- Adapters must preserve provider `provider_media_id` in `payload` for media messages. When the Conversation Platform needs the binary, the adapter is responsible for fetching the binary from the provider (using configured tokens) and then uploading to R2.

Interactive controls

- `button`: captured as `{ id, text }` in `payload`. Adapter must map provider-specific button ids and labels into this shape.
- `list`: captured as `{ id, title }`.

Validation rules

- Required fields (`id`, `channel`, `provider_event_id`, `sender.id`, `timestamp`, `type`, `payload`) must be present and typed.
- For media types, `provider_media_id` is required in `payload`.
- `timestamp` must be parsed into a valid ISO8601 timestamp; adapters should prefer provider timestamps over local receipt times.

Examples

- WhatsApp text

```json
{
  "id": "uuid-1234",
  "channel": "whatsapp",
  "provider_event_id": "wamid.HBgL...",
  "message_id": "wamid.GBC...",
  "sender": { "id": "+15551234567", "display_name": "Peter" },
  "timestamp": "2026-08-04T10:00:00Z",
  "type": "text",
  "payload": { "text": "Hi" }
}
```

- WhatsApp image

```json
{
  "id": "uuid-2345",
  "channel": "whatsapp",
  "provider_event_id": "wamid.HBgL...",
  "message_id": "wamid.GBC...",
  "sender": { "id": "+15551234567" },
  "timestamp": "2026-08-04T10:01:00Z",
  "type": "image",
  "payload": { "provider_media_id": "1234567890", "caption": "Living room" }
}
```

Mapping guidelines (per platform)

- WhatsApp (Meta)
  - provider_event_id: `entry.id` + `changes[].value.metadata.message_id` (or `message.id` when present).
  - provider_media_id: `media.id` returned by Meta; adapter must use the Media endpoint to fetch binary.

- Telegram
  - provider_event_id: `update_id` + `message.message_id`.
  - provider_media_id: `file_id`; adapter calls `getFile` to fetch the path and download.

- Instagram / Messenger
  - Similar mapping to Meta/WhatsApp shape (Meta family events); adapter extracts `media.id` and provider event id.

- Web Chat (browser widget)
  - provider_event_id: adapter-generated unique event id from widget (must be stable across retries).
  - media: widget upload returns a temporary URL or stream; adapter must upload to R2.

Notes on multi-channel compatibility

- The Conversation Engine MUST only accept `IncomingMessage` instances — adapters perform all provider-specific logic (auth, signature verification, media fetch). This prevents cross-channel branching in business logic.

Security and deduplication

- Each `IncomingMessage` must carry `provider_event_id` and `message_id` when available. Conversation Platform must persist these ids to dedupe duplicate deliveries.

Versioning

- The contract must be versioned. Add `schema_version` at the top-level to allow non-breaking extensions later.
