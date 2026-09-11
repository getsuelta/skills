# Error catalog: symptom → cause → fix

Errors are JSON `{"error": "<message>"}` unless noted. Validation messages
name the failing field: `{"error":"<field>: <reason>"}` (some messages are in
Spanish — Suelta serves LATAM businesses).

## Auth (any route)

| Symptom | Cause | Fix |
|---|---|---|
| 401, plain-text body `unauthorized` | Missing/malformed Bearer, unknown key id, wrong secret, revoked, or expired — deliberately indistinguishable (no oracle) | Don't retry. Don't inspect or print the key. Tell the user to re-export a valid `SUELTA_API_KEY` in their shell, minting a fresh one in the web app (**Settings → Llaves de API**) if needed |
| 403 `{"error":"forbidden","missing_scope":"flows:publish"}` | Key valid but lacks that scope | The user creates a key including the named scope in the web app and re-exports it themselves. Keys cannot be edited — mint a new one (max 3 active per tenant) |
| 403 `{"error":"forbidden"}` with NO `missing_scope` | Route requires the owner's web app session: `/api-keys/*`, `POST /whatsapp/connect`, `DELETE /whatsapp/disconnect`, `POST /tools/http-test` | Not automatable by design. Send the user to the web app |
| 403 `{"error":"plan_required"}` | Plan gate (see flow-lifecycle.md): the tenant is still on the `onboarding` plan | Not automatable. The user finishes onboarding in the web app: connect WhatsApp (`/app`), then store their OpenAI key at `/app/onboarding`, which switches the plan to self-service. Then retry |
| 403 `{"error":"account_blocked"}` | Suelta blocked the account | Stop; send the user to support |

## Flow CRUD & drafts

| Symptom | Cause | Fix |
|---|---|---|
| 404 `{"error":"flow not found"}` | Bad id, or the flow belongs to another tenant (indistinguishable on purpose) | `GET /flows` and re-match |
| 404 on `GET /flows/{id}/draft` | No pending draft — a normal state, not an error | Treat as "no edits pending" |
| 400 `{"error":"name: required"}` (and similar `field: reason`) | Validation. Common ones: `instructions: required`, `model: unknown or unsupported`, `min_confidence: must be 0-100`, `operating_hours.from: invalid time`, `tool.name: invalid`, `tool.transform.expression: <compile error>` | Fix the named field. Model must start with `gpt-`, `o1-`, `o3-`, or `o4-` (OpenAI only) |
| 422 on flow create | BYOK tenant has no OpenAI key stored | Send the user to the web app (**Configuración → Claves de API de LLM**, `/app/settings`) to store their OpenAI key themselves. Never take a provider key through the conversation |
| 400 mentioning tools limit / parameters limit | Max 20 parameters per tool | Trim parameters |

## Publish / versions / go-live

| Symptom | Cause | Fix |
|---|---|---|
| 400 on publish (no draft, already published) | Nothing to promote | Make an edit (creates a draft) first |
| 409 `flow already published` | Lost a self-publish race | Re-read the flow; it is live. Not a failure |
| 404 `flow version not found` on revert | `publishedAt` doesn't match a history row, or wasn't URL-encoded | `GET /versions`, copy `history[].published_at` exactly, URL-encode it |
| 400 `flow must be published before it can be enabled` | `toggle {"enabled":true}` on a never-published flow | Use `POST /publish` (self-publish) instead |
| 400 on canary | `percent_quota` outside 1–100, bad `mode`, or malformed phones | `percent` needs `percent_quota`; `allowlist` needs E.164 `allowlist_phones` with `+` |
| 400 `audience: invalid` | Value not in `all`/`saved`/`not_saved`/`enrolled` | Use one of the four |

## Test-chat

| Symptom | Cause | Fix |
|---|---|---|
| 400 `contact_phone: required` / `contact_phone: invalid` | Missing or non-E.164 phone | Any valid `+<country><number>` test number |
| 400 empty `user_message` | `user_message` is required | Provide the turn's message |
| 502 `{"error":"llm_provider_error","provider":"openai","provider_code":429,"detail":"..."}` | The tenant's own OpenAI key was rejected upstream — `detail` carries OpenAI's message (invalid key, insufficient quota, spending cap, outage) | Not a Suelta bug and not retryable until fixed at the provider: the user resolves it in their OpenAI console (https://platform.openai.com/settings/organization/billing) or swaps the key themselves in the web app (**Configuración → Claves de API de LLM**) |
| 500 `error al procesar mensaje`-style | Agent runtime failure other than an LLM provider error (tool exploding, infra) | Try once more; if it persists, report route + body (minus the key) to the user; inspect `GET /agent-events` if the flow is live |

## Messages (POST /messages/template)

| Symptom | Cause | Fix |
|---|---|---|
| 400 `{"error":"validación fallida","fields":[{"field":"...","reason":"..."}]}` | Local validation; each entry names field + reason (max 30 params, no empty/multiline params, template name `^[a-z0-9_]{1,512}$`, approved template, param count matches) | Fix every listed field |
| 400 `número de destino inválido` | `to` present but not normalizable to E.164 | Send `+<country><number>` |
| 200 with `"enrolled":false` and `enroll_error` | Send succeeded, enrollment failed (e.g. target flow not `enrolled`/enabled/published) | Message WAS sent (and billed). Fix the flow, don't blindly resend |

## Integrations

| Symptom | Cause | Fix |
|---|---|---|
| `connected:false` after user says they finished OAuth | Consent not completed, or wrong Google account | Have them redo the connection at https://app.getsuelta.com/app/integrations (check the Google account) |
| `verify` returns `connected:true` but `events_this_week: []` | Token fine; calendar simply has no events (or a transient Google API error was swallowed) | Not an error |
| gcal tools missing from `GET /tool-types` | gcal not connected | Run the calendar preflight |

## General

| Symptom | Cause | Fix |
|---|---|---|
| 500 `{"error":"internal"}` or Spanish `error al ...` | Server-side failure | Retry once; if it persists, report to the user with the exact route + body (minus the key) |
| Timeouts | Server cold start or LLM latency (test-chat can take 10–30 s) | Use a generous client timeout (60 s) for test-chat |
