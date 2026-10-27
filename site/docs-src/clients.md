---
title: Language clients
description: Slotlock's REST API from Python, Go, Rust, Java and .NET, one method per operation, each tested against a real server in CI.
sidebar:
  label: Language clients
---

Every client covers the whole [REST API](/docs/api/): the agent tools and the application API, one
method per operation. Each is generated from the server's OpenAPI document and published at
Slotlock's version, {{version}}.

<div class="lang-grid">
<a class="lang-card" href="#python"><span class="lang-name">Python</span><code>pip install slotlock</code><span class="lang-meta">Python 3.10+, no dependencies</span></a>
<a class="lang-card" href="#go"><span class="lang-name">Go</span><code>go get github.com/PILOTAAI/slotlock/clients/go</code><span class="lang-meta">Go 1.22+, no dependencies</span></a>
<a class="lang-card" href="#rust"><span class="lang-name">Rust</span><code>cargo add slotlock</code><span class="lang-meta">Rust 1.85+</span></a>
<a class="lang-card" href="#java"><span class="lang-name">Java</span><code>io.pylota:slotlock:{{version}}</code><span class="lang-meta">Java 17+, no dependencies</span></a>
<a class="lang-card" href="#net"><span class="lang-name">.NET</span><code>dotnet add package Slotlock.Client</code><span class="lang-meta">.NET 8 or 10, no dependencies</span></a>
<a class="lang-card" href="/docs/library/"><span class="lang-name">TypeScript</span><code>npm install slotlock</code><span class="lang-meta">The library itself, no server needed</span></a>
</div>

## Before you start

Each client takes your server's URL and an API key. The agent tools need `read` or `write`; the
application API (resources, holds, reservations) needs `admin`:

```sh
slotlock key create "Booking site" --scope read,write,admin
```

A refusal carries the HTTP status and the server's code: `409 overlap` when the window is taken,
`403 forbidden` for a key without the scope, `428 confirmation_required` for a write waiting on a
person, and `retry_after` with a `429`.

## Python

<!-- include clients/python/README.md snippet -->

## Go

<!-- include clients/go/README.md snippet -->

## Rust

<!-- include clients/rust/README.md snippet -->

## Java

<!-- include clients/java/README.md snippet -->

## .NET

<!-- include clients/dotnet/README.md snippet -->

## Another language

Generate a client from [`openapi.json`](/openapi.json) with any OpenAPI 3.1 generator, or import it
into Postman, Insomnia or Bruno: see [Import it](/docs/api/#import-it).
