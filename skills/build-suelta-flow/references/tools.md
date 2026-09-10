# Tool types

A tool is a capability the flow's LLM can invoke mid-conversation. Live
catalog with per-field metadata: `GET /api/me/tool-types` (`flows:read`) —
prefer it over this file when they disagree; gcal types are listed only when
the gcal integration is connected.

## Common tool shape

```jsonc
{
  "name": "consultar_disponibilidad",   // ^[a-zA-Z0-9_-]{1,64}$, unique per flow
  "description": "Cuándo hay citas libres",  // the LLM decides when to call based on this — write it well
  "type": "gcal_availability",
  "return_direct": false,               // true = tool output IS the reply, verbatim, no LLM rewrite
  "parameters": [                        // max 20; what the LLM fills in per call
    {"name":"date","type":"string","description":"Fecha YYYY-MM-DD","required":true}
  ],
  "transform": {"expression":"response.slots"},   // optional expr-lang post-processing
  "groundable": false,                  // see Grounding below
  "force_grounding": false
}
```

Parameter `type`: `string` | `number` | `boolean` | `object` (needs
`properties: [{name,type,description,required}]`) | `array` (needs
`items: {type,...}`).

Each type has exactly one config block (listed below). `id` is
server-assigned; omit it on create.

## The 11 types

### http_request — call an external API

```json
"http_config": {
  "url": "https://api.example.com/orders/{order_id}",
  "method": "GET",
  "headers": {"Accept": "application/json"},
  "body_template": "{\"id\": \"{order_id}\"}",
  "param_location": {"order_id": "path"}
}
```

Methods: GET/POST/PUT/PATCH/DELETE. `param_location` maps each parameter name
to `path` | `query` | `body`. Canonical example with parameters and a
transform: [assets/tool-http-request.json](../assets/tool-http-request.json).
Note: in test-chat this fires the REAL request.

**Authenticated endpoints.** If the business's API needs an auth header (an
API key, a bearer token), that value is the business's own secret and it does
not go through this conversation: don't ask for it, don't write it into
`headers`. Create the tool with only non-secret headers and tell the user to
add the auth header value themselves in the Suelta web app's flow editor;
until they do, expect the endpoint to answer 401/403 in test-chat. Prefer
endpoints that don't require a secret when the business has one.

### static_json — fixed data (price list, address, policies)

```json
"static_config": {"data": {"precios": {"corte": 25000, "barba": 15000}}}
```

Any JSON. The cheapest, most reliable way to give the flow facts. Prefer this
over stuffing facts into `instructions` when the data is structured. Usually
`groundable: true`.

### mute — silence the assistant for this conversation

```json
"mute_config": {"duration_minutes": 60}
```

Range 1–1440. Use when a human takes over ("un asesor te escribe ya").

### send_image — send a stored image

```json
"send_image_config": {"s3_key":"...","meta_media_id":"...","caption_mode":"fixed","caption":"Nuestra carta"}
```

`caption_mode`: `fixed` | `llm`. Asset must be uploaded first via
`POST /tools/image-upload`. In test-chat you get a presigned preview URL; no
real WhatsApp send.

### gcal_availability — compute free appointment slots

```json
"gcal_availability_config": {
  "duration_minutes": 30,
  "buffer_before_minutes": 10,
  "business_hours": {
    "tue": {"ranges": [{"from":"09:00","to":"18:00"}]},
    "sat": {"ranges": [{"from":"09:00","to":"13:00"}]}
  }
}
```

`duration_minutes` 1–1440 required (LLM may override per call);
`buffer_before_minutes` 0–120 optional; `business_hours` requires at least one
day — absent days produce no slots. Days: `mon|tue|wed|thu|fri|sat|sun`; a day
can hold multiple ranges (split shifts). Slots are computed server-side —
this is why availability answers don't hallucinate.

### gcal_create_event / gcal_find_event / gcal_update_event

```json
"gcal_config": {"calendar_id": "c_abc@group.calendar.google.com", "calendar_name": "Citas"}
```

Get `calendar_id` from `GET /integrations/gcal/calendars`. Default parameters
(summary, start/end ISO 8601 with timezone, event_id for update — update gets
`event_id` from a prior `gcal_find_event` call) are pre-defined by the
catalog; you rarely need custom ones. These touch the REAL calendar even from
test-chat — delete test events afterwards.

### handoff_message — escalate to a human

```json
"handoff_message_config": {
  "in_hours_message": "Ya te comunico con Sandra 👍",
  "out_of_hours_message": "Te escribimos apenas abramos (L-V 8am-6pm).",
  "also_mute_minutes": 120
}
```

### check_business_hours — "are we open right now?"

No config. Returns open/closed against the tenant's business-hours settings.
Good candidate for `force_grounding: true` so the model never guesses.

### end_enrollment — release an outbound-enrolled contact

```json
"end_enrollment_config": {"also_mute_minutes": 0}
```

Only meaningful on `audience:"enrolled"` flows. NOT return-direct: the tool
clears state; the LLM still writes the goodbye. Range 0–1440 (0 = no mute).

## Grounding flags

- `groundable: true` — for read-only, parameter-less tools whose output is a
  stable fact (catalog, address, schedule). The last successful output is
  replayed to the LLM every turn, so answers stay grounded without re-calling.
  Requires zero parameters.
- `force_grounding: true` — the model MUST consider this tool every turn
  before free-texting (first LLM call restricts tool choice to forced tools +
  an escape hatch). Use for grounding-critical topics: prices, availability,
  business hours.

## Transforms

`"transform": {"expression": "..."}` post-processes tool output before the LLM
sees it. Environment: `response` (tool output as parsed JSON, or raw string)
and `args` (the call's parameters). Examples:

```
response.available >= args.units
response.items[0].price * args.qty
let stock = response.warehouse.stock; stock > 0 ? "in_stock" : "out"
```

Dry-run without saving: `POST /tool-transforms/evaluate` with
`{"expression","response","args"}`.

## Gotchas

- `return_direct:true` sends the tool output verbatim as the WhatsApp reply.
  Only for pre-formatted, customer-facing strings.
- Tool `description` quality directly controls whether the LLM calls it at the
  right moments. Describe WHEN to use it, not what it is.
- Models sometimes narrate an action instead of calling the tool
  ("ya registré tus datos" without invoking handoff). For action-critical
  tools, add an explicit negative rule to `instructions` ("NEVER claim X
  happened without calling <tool> in that same turn") and verify in test-chat
  that the tool actually fires (`return_direct:true` output is the tell for
  handoff).
- Prefer fixed text in `instructions` or `static_json` for hours/prices the
  business wants stated exactly — models sometimes skip tool calls
  mid-conversation.
- Deleting a tool that the instructions mention by name leaves the LLM
  promising a capability it no longer has — keep instructions and tools in
  sync in the same draft.
