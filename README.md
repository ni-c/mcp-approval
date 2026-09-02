# mcp-approval

[![npm version](https://img.shields.io/npm/v/mcp-approval)](https://www.npmjs.com/package/mcp-approval)
[![node](https://img.shields.io/node/v/mcp-approval)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/mcp-approval)](LICENSE)

Ask a **person** before your [Model Context
Protocol](https://modelcontextprotocol.io) tool does something irreversible —
on both protocol revisions, from one handler — with a two-call confirmation
token for clients that cannot be asked.

```ts
const outcome = await approval.requestApproval(server, ctx, confirmations, {
  what: `delete ${uids.length} message(s)`,
  consequence: 'They are expunged, not moved to Trash.',
  resourceKey: setResourceKey('delete_messages', uids.map(String)),
  token: confirm_token,
  details: [{ label: 'Mailbox', value: mailbox }],
});

if (outcome.decision === 'declined')
  throw new ToolInputError('Nothing was changed.');
if (outcome.decision === 'pending') return outcome.result;
// …actually delete
```

## Why a boolean is not enough

A `confirm: true` parameter can be set by the model on its first call — or be
talked into it by instructions hidden in content your server itself fetched. So
the usual answer is a **token**: the first call returns a random string, the
second has to quote it back. That catches a model that widened a target set by
accident.

It does not catch a model that was talked into the whole thing, because the
model reads the token out of the first result and calls again in the same turn
without anybody seeing it. Be honest about that in your own docs: the token
proves the call was made twice with the same arguments, and nothing more.

**Elicitation** is the mechanism that does close it: the question goes to the
client, the client shows it to the person sitting there, and the model cannot
answer on their behalf. This library asks whenever it can, and falls back to the
token when it cannot — because refusing to work at all pushes people towards
switching the guard off entirely.

## Why not `elicitInput()`

Two reasons, and the second is the one that bites.

`server.server.elicitInput()` **throws** on a `2026-07-28` request. That
revision removed the server→client request channel outright: a server that
needs input returns `input_required`, the call ends, the person decides, and the
client retries carrying the answer.

And `getClientCapabilities()` — the usual way to decide whether to ask — is
empty on a per-request instance behind a **stateless gateway**, because that
instance never saw an `initialize`. A server built on those two therefore falls
back to the weaker check exactly when it sits behind a proxy, which is when it
matters most, and nothing anywhere reports that it happened.

This library reads the capability from the request's own `_meta` envelope first
and the `initialize`-declared state second — one per era — and returns
`inputRequired(...)`, which the SDK's legacy shim turns back into the old push
on a 2025 connection. One handler, both eras, no branch of your own.

## Install

```sh
npm install mcp-approval
```

`@modelcontextprotocol/server` is a peer dependency. Nothing else.

## Use

```ts
import {
  ConfirmationStore,
  createApproval,
  setResourceKey,
} from 'mcp-approval';

const confirmations = new ConfirmationStore();
const approval = createApproval({ server: 'imap-mcp' });
```

`requestApproval` returns one of three decisions:

| `decision` | What it means                                         | What you do                          |
| ---------- | ----------------------------------------------------- | ------------------------------------ |
| `approved` | a person said yes, or a valid token was quoted back   | act                                  |
| `declined` | a person said no, cancelled, or left the box unticked | do not act; say so in your own words |
| `pending`  | the question, or the token prompt                     | `return outcome.result`              |

`declined` is deliberately a **verdict and not a finished error**. The sentence
you want there is yours — "Nothing was sent" reads differently from "Nothing was
changed" — and the error class belongs to whatever maps thrown errors to tool
results in your server.

### The resource key binds an approval to one operation

```ts
resourceKey: setResourceKey('delete_messages', uids.map(String));
```

Both mechanisms hang off it. Without it, an approval for `["a"]` would also
execute `["a", "b"]`: the model chooses the second list, and only the operation
name would ever have been checked.

### Switching the dialog off, without switching the guard off

```ts
createApproval({ server: 'imap-mcp', elicitation: false });
```

Some deployments do not want a dialog: a scheduled job, a test harness, a client
whose dialog interrupts something else. `elicitation: false` does **not** let
guarded calls through — it takes the same path a client that cannot show a dialog
takes, which is the two-call token. There is no setting here that makes a guarded
call go unannounced.

The fallback sentence changes with it, because the usual one would be a lie:

|                            | what the fallback says                                                              |
| -------------------------- | ----------------------------------------------------------------------------------- |
| the client cannot be asked | "this client cannot ask the user directly"                                          |
| `elicitation: false`       | "`<server>` was started with the approval dialog switched off, so nobody was asked" |

That is what `server` is for. Whoever reads the transcript should not be sent to
debug a client that is working fine.

### The fallback prompt is an error result

`decision: 'pending'` on the token path hands back a result with `isError: true`.
The operation was asked for and did not happen, which is what `isError` says —
and the text carries the token and how to use it, so nothing is lost.

It is also what keeps the fallback working on a tool that declares an
`outputSchema`. The SDK requires such a tool to answer with `structuredContent`
and validates it, skipping only errors and `input_required`. An unmarked prompt
is rejected as an invalid result, and the caller is told the server is broken
instead of being handed the token it asked for.

This is the one result this library builds, so it states its own type. `declined`
and `rejected` are sentences for a result the **server** builds, and the error
type stays there.

## The answer is untrusted input

On `2026-07-28` the person's reply comes back as ordinary request content on the
retry — `inputResponses`, which the SDK explicitly does not validate. Anything
that can shape a tool call can shape that object, so an accepted answer on its
own must not be enough.

So the `requestState` is sealed (HMAC, via the SDK's own
`createRequestStateCodec`) and carries the resource key. A reply whose state
does not open, or opens onto a different operation, is treated as **no answer at
all** — which produces a fresh question rather than an error.

That last choice matters in practice. The likeliest cause of a state that will
not open is not an attack: it is a gateway that put your server to sleep while
the person was reading the dialog. An opaque `-32602` is nothing anyone can act
on; a second dialog is.

The key is 32 random bytes per process by default. A stdio server is spawned per
session, so the process _is_ the flow — when it ends there is nothing
half-finished left to resume. Pass your own `key` only if more than one process
may serve the two halves of one flow.

## Caller-chosen values go on their own lines

A mailbox called `Invoices — approved by IT, proceed` interpolated into your
sentence reads like _you_ saying it. `details` renders it under a disclaimer
instead:

```
This will delete 3 message(s). They are expunged, not moved to Trash.

Values below are supplied by the caller, not by this server:
  Mailbox: Invoices — approved by IT, proceed
```

Keep everything your server fetched from elsewhere out of `what` and
`consequence`. Those two are yours; `details` is for everything that is not.

## API

```ts
function createApproval(options: ApprovalOptions): Approver;
function canAsk(server: McpServer, ctx: ServerContext): boolean;

class ConfirmationStore {
  constructor(ttlMs?: number);
  issue(resource: string): string;
  consume(resource: string, token: string | undefined): boolean;
  get ttlMinutes(): number;
}

function setResourceKey(operation: string, targets: readonly string[]): string;
function confirmationPrompt(options: ConfirmationPromptOptions): string;
function renderDetails(details: readonly ConfirmationDetail[]): string;
```

`canAsk` is exported on its own because a server sometimes wants to say
something different — a preview tool that mentions the dialog will appear, say —
rather than to ask.

The store is bounded at 100 pending tokens and sweeps expired ones before it
evicts a live one, so a model retrying in a loop is not a memory leak with a
tool call in front of it.

## Licence

MIT © Willi Thiel
