---
title: Dashboard
description: Let people sign in with GitHub and manage their own resources, bookable hours and API keys.
sidebar:
  label: Dashboard
---

The server can serve a dashboard at `/dashboard`. Each person signs in with GitHub and gets a tenant
of their own (`github:<user id>`): their resources, hours, keys and bookings are theirs alone.

## Turn it on

1. **Create a GitHub OAuth app.** On GitHub: Settings → Developer settings → OAuth Apps → New OAuth
   App. Set the callback URL to `<SLOTLOCK_PUBLIC_URL>/dashboard/callback`, then generate a client
   secret.
2. **Set four variables** in `.env` (or the server's environment):

   | Variable | Value |
   | --- | --- |
   | `SLOTLOCK_GITHUB_CLIENT_ID` | The OAuth app's client id |
   | `SLOTLOCK_GITHUB_CLIENT_SECRET` | Its client secret |
   | `SLOTLOCK_SESSION_SECRET` | 32+ random characters: `openssl rand -hex 32` |
   | `SLOTLOCK_DASHBOARD_USERS` | GitHub user ids that may sign in, comma-separated (`gh api users/<login> --jq .id`), or `*` for anyone |

3. **Restart** with `docker compose up --detach`, then open `<SLOTLOCK_PUBLIC_URL>/dashboard`.

With all four empty, the default, the dashboard is off.

## What people can do

- Add up to 100 resources and set each one's weekly bookable hours.
- Create keys for their agents (read only, read and write, or Full), and rotate or revoke them.
- See the MCP and A2A addresses to give their agents.

## Assistant

Set `SLOTLOCK_ASSISTANT_SECRET` (32+ random characters) and the dashboard gains an **Assistant**
page: every member of an organization can ask in plain words ("what's free tomorrow on van-7?",
"book it for Ana") instead of clicking.

- **Each organization connects its own model** in Settings, Assistant. Only its owners can: the
  provider (Anthropic Messages API, or OpenAI-compatible for OpenAI, OpenRouter, vLLM, Ollama and
  LM Studio), the base URL (https, or http on `localhost`), the model name and the API key
  (optional for a local model). A URL on a local or private network address (loopback, private,
  link-local, CGNAT, unique-local, cloud metadata) is refused, as webhooks' are, unless the server
  sets `SLOTLOCK_ASSISTANT_PRIVATE_URLS=on` for a model on its own machine or network. **Test connection** makes one real request and checks for one
  correct tool call.
- **The organization's data is sent to the provider it configures**: members' messages, and the
  resources and bookings the assistant reads for them.
- The key is stored encrypted (AES-256-GCM) with the deployment's secret, and is never shown again:
  only that it is set, and its last four characters.
- **Reads run; writes wait for you.** The assistant looks things up at once. A booking, hold, change
  or cancellation appears as a card to **Approve** or **Dismiss**, and runs only when approved,
  once, under the same booking rules and limits as an agent. Activity names it
  `Assistant for @<login>`.
- It cannot touch API keys, webhooks, booking rules, pools or erasure.
- Up to 10 messages a minute per member; a conversation is kept for 2 hours.

## Before you go live

- Serve the dashboard on an origin of its own, such as `https://slotlock.example.com`, not as a path
  beside other apps: its cookies are host-wide.
- Removing someone from `SLOTLOCK_DASHBOARD_USERS` and restarting signs them out and stops every key
  in their tenant at once.
- Sessions last 12 hours. Keep the server's clock in sync with the database's.

[Security model](/docs/security/#dashboard-sign-in) says how sign-in, sessions and forms are
protected. To run the dashboard on Cloudflare Workers apart from the server, see
[the README](https://github.com/PILOTAAI/slotlock#dashboard-on-cloudflare-workers).
