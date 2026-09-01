# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- #region changelog -->

## [0.1.0] - 2026-09-01

First release. Extracted from the confirmation-token store that had been copied
across fourteen MCP servers in four generations, and the elicitation gate that
two of them had, then rewritten so one handler serves both protocol revisions.

### Added

- `createApproval` — asks a person when the client can be asked, and falls back
  to the two-call token when it cannot. The capability is read from the
  request's `_meta` envelope first and the `initialize`-declared state second,
  one per era, so a per-request instance behind a stateless gateway is
  recognised for what it is instead of silently taking the weaker path.
- The question is a **return value** (`inputRequired`), not a push. On
  `2026-07-28` there is no server-to-client request channel at all; on
  `2025-11-25` the SDK's legacy shim turns the same return back into the push it
  used to be.
- `requestState` sealed with the SDK's `createRequestStateCodec` and bound to
  the resource key. The reply arrives as ordinary request content on the retry,
  which the SDK does not validate — so an accepted answer on its own is not
  enough. A state that will not open produces a fresh question rather than an
  error, because its likeliest cause is a gateway that put the server to sleep
  while the person was reading.
- `ConfirmationStore` — single-use tokens compared with `timingSafeEqual` over a
  SHA-256 digest (six of the fourteen copies still compared with `!==`), bounded
  at 100 pending entries, sweeping expired ones before evicting a live one.
- `setResourceKey`, so an approval for one set of targets is not an approval for
  another.
- `ConfirmationDetail` and `renderDetails` — caller-chosen values on their own
  labelled lines rather than inside the server's sentence.

<!-- #endregion changelog -->

[0.1.0]: https://github.com/ni-c/mcp-approval/releases/tag/v0.1.0
