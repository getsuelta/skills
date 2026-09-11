# Suelta Agent Skills

[Agent Skills](https://agentskills.io) that let AI coding agents — Claude
Code, Cursor, Codex, and any other skills-compatible agent — operate
[Suelta](https://getsuelta.com) in natural language: build, test, and publish
WhatsApp AI assistants on a business's real WhatsApp line.

## Install

```bash
npx skills add getsuelta/skills -g
```

Then open your agent (for Claude Code, type `claude`) and ask for your
assistant in plain language. The first time, the skill opens your browser so
you can authorize this machine on Suelta — one click, no keys to copy, no
environment variables.

## Requirements

- Node 18+ (you already have it if `npx` worked).
- A Suelta account on the self-service plan: sign in with Google at
  https://app.getsuelta.com, connect the WhatsApp line, and store your OpenAI
  key at `/app/onboarding`. The skill walks the user through any step that
  is missing.

## Skills

| Skill | What it does |
|---|---|
| [`build-suelta-flow`](skills/build-suelta-flow/SKILL.md) | Full assistant lifecycle: preflight checks (WhatsApp line, Google Calendar), flow creation and configuration, tools, sandbox test conversations, publish, version revert, gradual rollout (canary), audience targeting, and outbound sends with flow enrollment. |

## Try it

After installing, ask your agent things like:

> "Créame un asistente de citas para mi barbería en Suelta: atiende de martes
> a sábado, cita de 30 minutos, y pruébalo antes de publicar."

> "Cambia la despedida del flow 'Atención Patitas', pruébalo en sandbox y
> publícalo al 10% de los contactos."

The skill makes the agent verify prerequisites first (WhatsApp connected,
calendar linked), test every change in Suelta's sandbox before going live,
and ask for your confirmation before anything that touches real traffic or
spends money.

## Safety model

Authorizing a machine mints a per-machine API key that is stored locally
(`~/.config/suelta/credentials.json`, mode 0600) and never shown to the user
or the agent. It appears in **Settings → Llaves de API** like any other key
and can be revoked there; revocation takes effect on the very next request.
No key can create or revoke other keys, connect or disconnect the WhatsApp
line, or reach admin surfaces — those stay in the web app, with the account
owner.

## License

MIT
