# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- #region changelog -->

## [Unreleased]

### Changed

- The fallback prompt returned with `decision: 'pending'` now carries
  `isError: true`. The operation was asked for and did not happen, which is what
  `isError` says, and the text still carries the token and how to use it.

  It is also what keeps the token path working on a tool that declares an
  `outputSchema`: the SDK requires such a tool to answer with
  `structuredContent` and validates it, skipping only errors and
  `input_required`. An unmarked prompt was rejected as an invalid result, so the
  caller was told the server was broken instead of being handed the token it
  asked for.

  A caller that distinguished the prompt from a refused token by `isError`
  alone now has to read the text, which is where the difference was always
  stated. `declined` and `rejected` are unaffected — those are sentences for a
  result the server builds, and the error type stays there.

## [0.7.1] - 2026-09-02

### Fixed

- `flatten` now removes C0/C1 controls, DEL, and the invisible and
  direction-changing formatting characters before collapsing whitespace.
  JavaScript's `\s` strips CR, LF, VT, LS, PS and the BOM and leaves ESC, BEL,
  NEL, the zero-width set and every BiDi override untouched — so a
  caller-supplied `details` value could still rewrite the sentence above it.
  `ESC[2K ESC[1A` erases the server's own description and prints a different one
  in its place; `U+202E` reverses the rest of the line with no escape sequence
  at all. The class is the one already used in calibreweb, imap, wikijs,
  woodpecker and mcp-hub; this was the one place in the family without it, and
  the one where it mattered most.

- `ConfirmationStore.issue` deletes before it sets, so a re-issued token moves
  to the end of the map. `Map.set` on an existing key keeps its original
  position, so a token re-issued below the cap kept the place of the one it
  replaced and was then evicted as "oldest" while genuinely older entries
  survived. Fail-closed in every case — the caller is asked to confirm again —
  but the eviction now means what its comment says.

### Changed

- `SECURITY.md` names a fourth thing this library does not defend against: the
  sealed state proves **binding**, not **freshness**. It carries no nonce,
  nothing is spent when it is verified, and the codec is stateless by design, so
  the same `requestState` and answer can be submitted again until they expire.
  The two-call token is the opposite and always was — that asymmetry is now
  written down and pinned by a test on both sides.

  It is not a way around the person: whoever can replay a state received the
  `input_required` and is therefore the client, which is already the first item
  on that list. It does mean **at-most-once is not guaranteed on the dialog
  path**, so anything irreversible or non-idempotent has to be made idempotent
  by the server. A redeemed-state set here would be per-process and would fail
  _open_ on a restart or a second process — exactly where it would have been
  needed.

- `ttlSeconds` is documented as what it is: the lifetime of the sealed state,
  not of the two-call token. The token's lifetime lives on the
  `ConfirmationStore` the server constructs and passes in, which this library
  never sees. Lowering `ttlSeconds` and expecting both to move left the fallback
  at the store's five-minute default — on the path that runs behind a stateless
  gateway.

## [0.7.0] - 2026-09-01

### Added

- `elicitation` on `ApprovalOptions`, defaulting to `true`. `false` makes a
  server take the fallback path even for a client that could be asked — a
  scheduled job, a test harness, a client whose dialog interrupts something.

  It is deliberately not an escape hatch: `false` is the **two-call token**, not
  "no confirmation". There is no option in this library that lets a guarded call
  through unannounced, and adding one would make the sentence every server in
  this family prints about itself untrue.

### Changed

- The default fallback note now says _which_ of the two reasons applies. It
  claimed "this client cannot ask the user directly" unconditionally, which is
  false when the operator switched the dialog off: the client could have been
  asked and was not. With `elicitation: false` it names the server instead —
  "`imap-mcp` was started with the approval dialog switched off, so nobody was
  asked."

  That is also the first use of `options.server`. It has been declared and
  documented as "for the warning line of the fallback text" since 0.1.0 and was
  never read; every consumer passed it believing it did something.

## [0.6.0] - 2026-09-01

### Removed

- `tokenParam`, added in 0.5.0 and 0.5.1. It let a server whose schema spells
  the parameter differently — `confirmToken` rather than `confirm_token` — have
  the prompt follow it. That is the wrong direction: this library defines the
  convention, and an option that makes a deviation comfortable is how the
  deviation survives. The one server that had it was standardised instead.

  A server whose parameter is not `confirm_token` should rename it. The prompt
  is a sentence a model acts on, and a fleet that words it identically is worth
  more than a knob.

## [0.5.1] - 2026-09-01

### Fixed

- Nothing in the library: 0.5.0 was tagged but never published, because its
  release failed on the coverage gate — the branch added below was reachable
  only through `confirmationPrompt` and not through `requestApproval`. There is
  a test for it now. Use this version; 0.5.0 does not exist on npm.

## [0.5.0] - 2026-09-01

### Added

- `tokenParam` on the prompt and on `ApprovalRequest`, defaulting to
  `confirm_token`. The fallback sentence tells a model what to send, so it has
  to name the parameter the server's schema actually declares — a server that
  spells it `confirmToken` was being told to pass an argument it rejects, which
  is a prompt that cannot be acted on. Found while migrating exactly such a
  server.

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
