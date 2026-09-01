# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- #region changelog -->

## [0.4.0] - 2026-09-01

### Added

- A fourth verdict, `{ decision: 'rejected', reason }`, replacing the
  `tokenRejected` flag that 0.3.0 put on `pending`. A token that was supplied
  and did not match is not another question — nobody is being asked anything,
  the call is being refused — so it reads better as its own verdict, and the
  `else` branch of a consumer that only handles three cases now cannot quietly
  swallow it.

  The library supplies the sentence, so every server refuses in the same words;
  the error _type_ stays with the caller, the same split `declined` already
  uses. `reason` names the tool where `toolName` was given and says "this tool"
  where it was not.

### Removed

- `tokenRejected` on the `pending` outcome, added in 0.3.0 and superseded above
  before anything depended on it.

## [0.3.0] - 2026-09-01

### Added

- A fourth verdict, `{ decision: 'rejected', reason }`, for a token that was
  supplied on the fallback path and did not match. Previously that answered
  with a fresh prompt, which is self-healing when the token merely expired and
  silent when it is not — a rejected token means the call carried a
  confirmation issued for _something else_, which is the exact case the
  resource key exists to catch.

  The library supplies the sentence so every server says the same thing; the
  caller still owns the error type, which is why this is a verdict rather than
  a finished error result. Found by migrating a server whose own guard drew
  this distinction and would have lost it.

  **Handle it**: a consumer that only checks `approved`/`declined`/`pending`
  will fall through to whatever its `else` does. `reason` names the tool when
  `toolName` was given and says "this tool" when it was not.

## [0.2.0] - 2026-09-01

### Fixed

- `renderDetails` now flattens each caller-chosen value to one line and caps it
  at 200 characters. Giving the value its own labelled line was never the whole
  defence: a value containing a newline can begin a _further_ line, and what it
  writes there reads like a fresh instruction underneath the question — at which
  point the question is no longer what anybody is answering. A value long enough
  to push the question out of view does the same thing by volume.

  Found while migrating a server that had this protection in its own copy and
  would have lost it. Its reasoning is now the library's.

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
