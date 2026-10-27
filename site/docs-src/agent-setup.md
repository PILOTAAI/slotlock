---
title: Set up with a coding agent
description: Paste one prompt into Claude Code, Cursor or Codex and let it set Slotlock up for your project, then prove it works.
sidebar:
  label: Set up with a coding agent
---

Copy this prompt into your coding agent, in your project's directory. It reads the docs from this
site, asks you how you want to run Slotlock, and proves the result works with a real booking and a
refused double booking.

<!-- agent-setup-prompt -->

[Download it as Markdown](/slotlock-setup-prompt.md) to keep it in your repository, for example in
`AGENTS.md` or `CLAUDE.md`.

## What your agent can read

| File | What |
| --- | --- |
| [`/llms.txt`](/llms.txt) | An index of every page, for an agent deciding what to read |
| [`/llms-full.txt`](/llms-full.txt) | Every page in one file |
| `/docs/<page>.md` | Any page as Markdown: add `.md` to its URL, such as [`/docs/quickstart.md`](/docs/quickstart.md) |
| [`/openapi.json`](/openapi.json) | The REST API, OpenAPI 3.1 |
| [`/slotlock.postman_collection.json`](/slotlock.postman_collection.json) | The same API as a Postman collection |
