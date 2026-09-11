# Flow lifecycle: drafts, versions, publish, revert, plan gates

## The two halves of a flow

**Versioned fields** — participate in draft → publish → history:
`name`, `description`, `instructions`, `model`, `min_confidence`,
`operating_hours`, `tools`.

**Live fields** — edited directly on the active flow, effective immediately,
never captured in a draft or snapshot:

| Field | Endpoint |
|---|---|
| `enabled` | `PATCH /flows/{id}/toggle` |
| `canary_config` | `PATCH /flows/{id}/canary` |
| `audience` | `PATCH /flows/{id}/audience` |

Consequence: a draft body containing `enabled` or `canary_config` doesn't
error — those keys are simply ignored. Don't rely on them round-tripping.

## State machine

```
POST /flows            → active config exists, enabled:false, never published
POST /flows/{id}/publish (no draft, never published)
                       → SELF-PUBLISH: current config becomes v1, enabled:true  ← only path to enabled:true
PUT  /flows/{id}/draft → pending draft alongside the active version
POST /flows/{id}/publish (draft exists)
                       → draft becomes active, old active archived to history, draft deleted
POST /flows/{id}/versions/{ts}/revert
                       → snapshot becomes active, replaced version archived
PATCH /flows/{id}/toggle {"enabled":false}
                       → paused (config intact); {"enabled":true} re-enables (only if ever published)
DELETE /flows/{id}     → flow + draft + entire history gone (works on live flows)
```

Publish and revert are atomic server-side transactions — real traffic never
sees a half-applied config.

## Rules that surprise people

- `POST /flows` forces `enabled:false` no matter what you send.
- `publish` on a published flow with no draft → 400 (nothing to promote).
- `publish` racing another first-publish → 409 `flow already published`; the
  flow is live, just re-read it.
- `toggle {"enabled":true}` on a never-published flow → 400
  `flow must be published before it can be enabled`. First activation must go
  through `publish`.
- History holds the **5** most recent snapshots; older ones are pruned.
- The `note` you pass on publish labels the INCOMING version. In
  `GET /versions`, each history row carries the note that version originally
  went live with.
- `revert` needs the exact `published_at` RFC3339 string from
  `history[]`, URL-encoded (e.g. `2026-07-23T15%3A04%3A05.123456789Z`).
- Test-chat composes draft-over-active: with a draft present you are testing
  the draft; delete the draft to test the active config again.

## Serving rules (who actually gets the flow)

An inbound WhatsApp message is served by a flow only if ALL of:

1. `enabled: true`
2. within `operating_hours` (absent = always)
3. `audience` matches the contact (`all`; `saved` = in the tenant's contacts;
   `not_saved` = not in them; `enrolled` = ONLY via outbound enrollment pin —
   never via normal dispatch)
4. `canary_config` admits the contact (absent = everyone; `percent` is a
   sticky per-contact-per-day assignment; `allowlist` matches E.164 phones)

An enrolled contact (see outbound-enrollment.md) PINS its flow, bypassing
operating hours, canary, and the router — the business initiated that
conversation, so it is always attended.

## Recommended rollout sequence

1. Publish with a descriptive note.
2. Immediately set `{"mode":"allowlist","allowlist_phones":["+57<owner>"]}` —
   the owner tries it on the real line first.
3. Move to `{"mode":"percent","percent_quota":10}` → observe
   (`GET /agent-events`, `GET /metrics/summary`) → 50 → clear (`{}`).
4. Anything wrong → `revert` to the previous version (instant), then fix the
   draft calmly.

## Plan gates (independent of scopes)

| Tier | Routes | Requirement |
|---|---|---|
| Flow work & spend | create, draft CRUD, draft tools, test-chat, tool-types, instantiate, image-upload, transforms, publish, revert, toggle, canary, audience, messages, contacts, metrics, events, settings | plan other than `onboarding` (self-service, managed, reseller) and status `active` |
| Always | profile, whatsapp status, integrations, flow-templates list | any plan |

`403 {"error":"plan_required"}` = the tenant is still on the `onboarding`
plan. The only way out is the web app: connect WhatsApp on the Dashboard
(`/app`), then store the OpenAI key at `/app/onboarding` — the backend
verifies the key and switches the plan to self-service in that same step.
There is no API call for this and nothing to wait for from Suelta on the
self-service path. `403 {"error":"account_blocked"}` = Suelta blocked the
account; send the user to support.

Test-chat has no message cap; each turn spends the tenant's own OpenAI key.
