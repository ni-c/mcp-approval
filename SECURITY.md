# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/mcp-approval/security/advisories/new).
Do not open a public issue for an unpatched vulnerability.

Only the latest release and the current `main` branch receive security fixes.

## Trust model

This library exists to put a decision in front of a **person** before something
irreversible happens. Everything below follows from that being the point.

**The reply is attacker-controlled input.** On the `2026-07-28` revision the answer
arrives as ordinary request content on the retry — `inputResponses`, which the SDK
explicitly does not validate. Anything that can shape a tool call can shape that
object. So an accepted answer on its own grants nothing: the `requestState` is
HMAC-sealed (via the SDK's `createRequestStateCodec`), bound to the request method,
the authenticated caller where there is one, and the `resourceKey` — so approval of
one operation is not approval of another.

**A state that will not open grants nothing either.** It produces a fresh question
rather than an error. That is fail-_closed_ with respect to the decision and
fail-open with respect to the user's patience, which is the correct way round: the
likeliest cause is not an attack but a gateway that restarted the server while the
person was reading.

**The confirmation token is not a human-in-the-loop gate, and never was.** It is
returned inside a tool result, so the model reads it and can call again in the same
turn without anybody seeing the dialog. It proves the call was made twice with the
same arguments — enough to catch a widened target set by accident, not enough to
catch a model that was talked into the whole thing. It is the fallback for clients
that genuinely cannot be asked, and your documentation should say so plainly.

## What is deliberately not defended against

- **A client that lies about the person.** Nothing in the protocol lets a server
  verify that a human saw the dialog. If the client is compromised, the guarantee is
  gone; this library moves the decision to the client, it does not attest it.
- **A per-process key across processes.** The default key is 32 random bytes per
  process, which is right for a stdio server spawned per session. If two processes
  may serve the two halves of one flow, supply your own `key` — otherwise the second
  half simply asks again, which is safe but repetitive.
- **The content of `what`, `consequence` and `details`.** Those are your strings.
  Keep anything your server fetched from elsewhere out of the first two, and put
  caller-chosen values in `details`, where they are rendered under a disclaimer
  rather than inside the server's own sentence.
