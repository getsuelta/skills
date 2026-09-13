# Suelta API reference (flow lifecycle surface)

Base URL: `https://api.getsuelta.com`, fixed (use `SUELTA_API_URL` instead
only if that variable is set). All routes below are under `/api/me`.
Content type: `application/json` both ways.

Auth: bearer API key, sent for you by `scripts/api.mjs`, which reads the
per-machine credential stored by `scripts/login.mjs` — see the credential
rule in SKILL.md. Never build the header by hand, never resolve or print the
key.

```bash
node "$SKILL/scripts/api.mjs" <GET|POST|PUT|PATCH|DELETE> /<route> [--data @file.json | --data -]
```

Error contract: bodies are `{"error":"<code>", ...}`; `error` is always the
first field. One multi-field error exists: 402
`{"error":"payment_required","reason":"trial_exhausted"|"paid_period_expired","message":"<text for the user>","contact_whatsapp":"+57...","contact_url":"https://wa.me/...","allowance":500,"sent":500,"paid_until":null|"<RFC3339>"}`
on toggle-to-enabled, first publish, and messages/template when the account
is suspended for payment (see `GET /access`). `paid_until` is set only for
`paid_period_expired`. `message` for that reason reads "Tu asistente está
pausado: tu plan venció el DD/MM/AAAA. Escríbenos por WhatsApp para
renovarlo." and `contact_url` carries a renewal text.

An API key is valid over `/api/me/*` only. `full_access` is a wildcard over
the scope catalog; it never grants key management, WhatsApp channel
connect/disconnect, `tools/http-test`, or any `/api/dev|admin` route.

## Bootstrap

### GET /profile — scope: none

Who am I. Returns the tenant profile (plan, status). Use as a smoke test.

### GET /access — scope: settings:read

Whether the account may run right now. Source of truth for the trial and for
paid coverage.

```json
{
  "state": "not_applicable" | "trial" | "paid" | "suspended",
  "reason": null | "trial_exhausted" | "paid_period_expired",
  "trial": null | {"allowance": 500, "sent": 312, "remaining": 188, "status": "active" | "exhausted"},
  "trial_low": false,
  "paid_until": null | "2026-10-13T04:59:59Z",
  "contact_whatsapp": "+573207988419",
  "contact_url": "https://wa.me/573207988419?text=..."
}
```

- `not_applicable`: not a self-service trial account (managed, reseller, or
  created before the trial launched). `trial` is `null`.
- `trial`: free allowance running. The allowance is a lifetime bucket keyed
  by the WhatsApp number (it survives reconnecting the line on another
  account); only persisted agent messages count, never sandbox test-chat.
  `trial_low` is `true` with 10% or less left.
- `paid`: Suelta recorded a payment; `paid_until` is when coverage ends.
- `suspended`: allowance used up without payment, or coverage expired. The
  agent stops answering on WhatsApp (no notice to the contact), outbound
  templates, reminders and emoji triggers stop, and three calls answer 402
  `payment_required`: toggle with `{"enabled":true}`, the first publish of a
  never-published flow, and messages/template. Everything else keeps working,
  including create, draft, tools, test-chat, republishing a live flow,
  revert, canary, audience and turning a flow off. An unknown `reason` means
  the same as the known ones: payment required.
- `contact_url` is the prefilled WhatsApp link to Suelta; its text adapts to
  the state.

`GET /trial` still exists with the raw bucket, but read `/access`.

## Preflight

### GET /whatsapp/status — scope: settings:read

```json
{"connected": true, "phone_number": "+573001234567"}
```

`connected:false` → the line must be connected by the user in the web app
Dashboard (`/app`, button **Conectar WhatsApp**). `POST /whatsapp/connect` and
`DELETE /whatsapp/disconnect` reject API keys (403) by design.

### GET /integrations — scope: settings:read

```json
[{"id":"gcal","name":"Google Calendar","description":"...","connected":true,"email":"owner@gmail.com"}]
```

### GET /integrations/gcal/verify — scope: settings:read

Live check against Google (refreshes the token):
`{"connected":true,"email":"...","events_this_week":[...]}`.

### POST /integrations/gcal/connect — scope: settings:write

No body. Returns `{"auth_url":"https://accounts.google.com/o/oauth2/..."}`.
Exists, but do NOT use it from this skill: send the user to
**https://app.getsuelta.com/app/integrations** to connect Google Calendar in
the web app instead, then poll `/integrations/gcal/verify`.

### GET /integrations/gcal/calendars — scope: settings:read

`{"calendars":[{"id":"c_abc@group.calendar.google.com","name":"Citas","primary":false}]}`

### DELETE /integrations/gcal — scope: settings:write

Revokes and deletes the stored token. Destructive; confirm with the user.

## Flows

The flow JSON object (fields you send on create; server assigns `id`,
`user_id`, timestamps; `enabled` is forced to `false` on create):

```jsonc
{
  "name": "Citas Barbería",             // required
  "description": "Agenda citas",
  "instructions": "system prompt...",    // required
  "model": "gpt-5.6-luna",               // required; OpenAI only: prefix gpt-|o1-|o3-|o4-
  "min_confidence": 85,                  // 0-100; defaults to 85 if omitted
  "operating_hours": {                   // optional; omit = always active
    "days": ["mon","tue","wed","thu","fri"],
    "from": "08:00", "to": "18:00"
  },
  "tools": [ /* see references/tools.md */ ]
}
```

Read-only response fields: `enabled`, `is_default`, `audience`,
`canary_config`, `published_at` (absent/zero = never published),
`publish_note`, `created_at`, `updated_at`.

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/flows` | flows:read | List all flows for the tenant |
| POST | `/flows` | flows:write | Create (born disabled) |
| GET | `/flows/{id}` | flows:read | Active version |
| DELETE | `/flows/{id}` | flows:publish | Cascade: flow + draft + all versions. Works on live flows. Confirm first. |

Plan gate: create/read-one/draft/tools/test-chat need an active plan OR
(`onboarding` + WhatsApp connected). List is always allowed.

## Draft lifecycle

Draft body = the versioned fields ONLY (whole-object upsert):

```json
{
  "name": "...", "description": "...", "instructions": "...",
  "model": "...", "min_confidence": 85,
  "operating_hours": {"days":["mon"],"from":"08:00","to":"18:00"},
  "tools": []
}
```

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/flows/{id}/draft` | flows:read | 404 `{"error":"no hay borrador"}`-style when none exists — that's normal |
| PUT | `/flows/{id}/draft` | flows:write | Validates like a full flow save |
| DELETE | `/flows/{id}/draft` | flows:write | Discard pending edits; idempotent |
| POST | `/flows/{id}/draft/tools` | flows:write | Body = one tool object; auto-seeds draft from active if absent |
| PUT | `/flows/{id}/draft/tools/{toolID}` | flows:write | Whole-tool replace |
| DELETE | `/flows/{id}/draft/tools/{toolID}` | flows:write | |
| GET | `/flows/{id}/versions` | flows:read | `{"current":{...},"history":[...]}`; history newest-first, max 5 |
| POST | `/flows/{id}/publish` | flows:publish + active plan | Body `{"note":"..."}` optional. Promotes draft; or self-publishes a never-published flow (sets `enabled:true`) |
| POST | `/flows/{id}/versions/{publishedAt}/revert` | flows:publish + active plan | `publishedAt` = RFC3339 from `history[].published_at`, URL-encoded |

## Test-chat (sandbox)

### POST /flows/{id}/test-chat — scope: flows:write

```json
{
  "messages": [{"role":"contact","content":"hola"},{"role":"agent","content":"¡Hola!"}],
  "user_message": "quiero una cita",
  "contact_phone": "+573001112233"
}
```

`role` is `"contact"` (the customer) or `"agent"` (the assistant). `messages`
may be `[]` for the first turn. `contact_phone` required (400 without it).

```json
{"response":"¡Claro! ¿Para qué día...","return_direct":false,
 "media":[{"type":"image","url":"https://...presigned...","caption":"..."}]}
```

Uses the draft if one exists, else the active config. Ephemeral: nothing
persisted, no WhatsApp side-effects (image sends are previewed via 5-minute
presigned URLs). CAUTION: `http_request` tools fire real HTTP calls and gcal
tools touch the real calendar.

## Going live

| Method | Path | Scope | Body |
|---|---|---|---|
| PATCH | `/flows/{id}/toggle` | flows:publish + active plan | `{"enabled":true\|false}`. Enabling a never-published flow → 400; use publish. |
| PATCH | `/flows/{id}/canary` | flows:publish + active plan | `{"mode":"percent","percent_quota":1-100}` or `{"mode":"allowlist","allowlist_phones":["+57..."]}`. Empty body clears (full traffic). Percent assignment is sticky per contact per day. |
| PATCH | `/flows/{id}/audience` | flows:publish + active plan | `{"audience":"all"\|"saved"\|"not_saved"\|"enrolled"}`. `saved`/`not_saved` = contact is/isn't in the tenant's contact list. `enrolled` = served ONLY via outbound enrollment (see references/outbound-enrollment.md). |

## Tool utilities

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/tool-types` | flows:read | Catalog of tool types with per-field config metadata. gcal types appear only when gcal is connected. |
| POST | `/tool-transforms/evaluate` | flows:write | `{"expression":"...","response":{...},"args":{...}}` — dry-run an expr-lang transform |
| POST | `/tools/image-upload` | flows:write | Upload a `send_image` asset. Consumes billable Meta media quota — confirm with the user. |
| POST | `/tools/http-test` | — | NOT available to keys (SSRF boundary). Test HTTP tools via test-chat instead. |

## Flow templates

| Method | Path | Scope |
|---|---|---|
| GET | `/flow-templates` | none |
| POST | `/flow-templates/{templateID}/instantiate` | flows:write |

Instantiate persists a new (disabled) flow from a catalog template — same
effect as `POST /flows`.

## LLM keys (BYOK tenants)

Self-service tenants bring their own OpenAI key; flow create returns 422 if
none is stored. Only OpenAI is supported for self-service flows.

| Method | Path | Scope | Body |
|---|---|---|---|
| GET | `/llm-keys` | settings:read | → `{"openai_api_key":"sk-...masked"\|null, ...}` — masked; use it only to check that an OpenAI key is present (ignore any other provider field) |

Storing a provider key is **out of scope for this skill**. `PUT /llm-keys`
exists, but a provider key is the user's own third-party secret: it must not
travel through an agent conversation. Send the user to the web app
(**Configuración → Claves de API de LLM**, at `/app/settings`) to enter it
themselves, the same way WhatsApp connect and Google Calendar consent are
handled. Note this is a different section from **Llaves de API** on the same
page, which is where Suelta's own API keys are minted.

## Outbound messages

`POST /messages/template` — scope `messages:send` + active plan. Spends real
money. Full contract in
[outbound-enrollment.md](outbound-enrollment.md).

## Observability (optional, for diagnosing a live flow)

| Method | Path | Scope |
|---|---|---|
| GET | `/agent-events?from=YYYY-MM-DD&to=YYYY-MM-DD[&flow_id=][&event_type=]` | events:read (`contact_phone` redacted without contacts:read) |
| GET | `/conversations/{id}` | events:read |
| GET | `/metrics/summary`, `/metrics/{name}` | metrics:read |

Max 20-day range on agent-events. Event types: `tool_success`, `tool_error`,
`llm_error`, `loop_max_iterations`, `tool_not_found`,
`repeated_response_suppressed`.
