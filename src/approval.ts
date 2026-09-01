import { randomBytes } from 'node:crypto';

import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
} from '@modelcontextprotocol/server';
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';

import {
  confirmationPrompt,
  renderDetails,
  type ConfirmationDetail,
  type ConfirmationStore,
} from './confirm.js';

/**
 * Asking a person before something irreversible happens — on both protocol
 * revisions, from one handler.
 *
 * The question is *returned*, not pushed. On `2026-07-28` there is no
 * server→client request channel at all: the handler answers `input_required`,
 * the call ends, the person decides, and the client retries carrying the
 * answer. On a `2025-11-25` connection the SDK's legacy shim turns the same
 * return into the push it used to be.
 *
 * That is why this is not `elicitInput()`. That method throws outright on a
 * 2026-era request, and its companion `getClientCapabilities()` is empty on a
 * per-request instance behind a stateless gateway — so a server built on it
 * silently falls back to the weaker check exactly when it is behind a proxy,
 * which is when it matters most.
 */

export interface ApprovalRequest {
  /** What is about to happen, in server-side facts only. */
  what: string;
  /** Why it cannot be undone. */
  consequence: string;
  /**
   * Stable key for this exact operation on these exact targets.
   *
   * It binds both mechanisms: the fallback token, and the sealed state that
   * proves an answer belongs to the question it was given. Build it with
   * `setResourceKey` when the operation has a set of targets.
   */
  resourceKey: string;
  /** Token the caller supplied, if any. Only used on the fallback path. */
  token: string | undefined;
  /** Caller-chosen values, rendered on their own labelled lines. */
  details?: readonly ConfirmationDetail[];
  /** The tick-box label, e.g. `Send this message?`. */
  title?: string;
  /** The tick-box hint, e.g. `Tick to send it, leave it to cancel.`. */
  hint?: string;
  /** Names the tool in the fallback text. */
  toolName?: string;
  /** Appended to the fallback text, for a server that wants to say more. */
  fallbackNote?: string;
}

/**
 * What the caller should do next.
 *
 * `declined` is a verdict, not a finished error: the sentence a server wants
 * there differs ("Nothing was sent" against "Nothing was changed"), and the
 * error class belongs to whatever maps thrown errors to tool results in that
 * server. This library has no business owning either.
 */
export type ApprovalOutcome =
  | { decision: 'approved' }
  | { decision: 'declined' }
  | {
      decision: 'pending';
      result: CallToolResult | InputRequiredResult;
      /**
       * True when a token was supplied on the fallback path and did not match.
       *
       * Worth distinguishing from "nobody has been asked yet", even though both
       * end in another question: a rejected token means the call carried a
       * confirmation that was issued for *something else*, which is the exact
       * case the resource key exists to catch. Answering it with a fresh prompt
       * and no explanation is self-healing in the innocent case (an expired
       * token) and silent in the interesting one. A caller that wants to say so
       * reads this; one that does not can ignore it and re-ask.
       */
      tokenRejected: boolean;
    };

export interface ApprovalOptions {
  /** The server's own name, for the warning line of the fallback text. */
  server: string;
  /**
   * How long a half-answered call stays resumable. Default 15 minutes, which is
   * how long a person plausibly takes to read a dialog and come back.
   */
  ttlSeconds?: number;
  /**
   * The HMAC key for the sealed state. Default: 32 random bytes per process.
   *
   * A stdio server is spawned per session, so the process is the flow and a
   * per-process key is the right lifetime — when it ends there is nothing
   * half-finished left to resume. Supply your own only if more than one process
   * may serve the two halves of the same flow.
   */
  key?: Uint8Array;
}

/** The key under which the answer comes back. One question, one key. */
const CONFIRM_KEY = 'confirm';

/** What is asked, when a person can be asked at all. */
const schemaFor = (title: string, hint: string) => ({
  type: 'object' as const,
  properties: {
    [CONFIRM_KEY]: { type: 'boolean' as const, title, description: hint },
  },
  required: [CONFIRM_KEY],
});

export interface Approver {
  requestApproval(
    server: McpServer,
    ctx: ServerContext,
    confirmations: ConfirmationStore,
    request: ApprovalRequest
  ): Promise<ApprovalOutcome>;
}

/**
 * Builds the approver.
 *
 * It holds one thing across calls — the key that seals the request state — and
 * that is the only reason this is a factory rather than a free function.
 */
export function createApproval(options: ApprovalOptions): Approver {
  /**
   * Integrity for the state that rides through the client and comes back.
   *
   * `inputResponses` on re-entry is attacker-controlled input; the SDK says so
   * and validates none of it. Without a seal, an accepted answer could simply
   * be asserted by anything that can shape a tool call, and asking a human
   * would be a formality. The spec makes protecting this a MUST wherever the
   * state decides an authorization, which is exactly what it does here.
   */
  const codec = createRequestStateCodec<{ key: string }>({
    key: options.key ?? randomBytes(32),
    ttlSeconds: options.ttlSeconds ?? 900,
    // Both halves of "this state belongs to this call": the method it was
    // minted under and, where there is one, the authenticated caller.
    bind: (ctx) =>
      `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ''}`,
  });

  /** Whether this server minted that state, for this exact operation. */
  const mintedHere = async (
    state: string,
    ctx: ServerContext,
    request: ApprovalRequest
  ): Promise<boolean> => {
    try {
      const payload = await codec.verify(state, ctx);
      return payload.key === request.resourceKey;
    } catch {
      // The reason is a fixed opaque code by design and says nothing worth
      // logging; what matters is that an unproven state grants nothing.
      return false;
    }
  };

  /**
   * What the person said, if this round carries their reply at all.
   *
   * `none` covers two situations that want the same treatment: nobody has been
   * asked yet, and a reply arrived that this server cannot prove it asked for.
   * Re-asking is right for both — the alternative for the second is an error
   * code nobody can act on, and its likeliest cause is innocent (a gateway put
   * the server to sleep while the person was reading).
   */
  const readAnswer = async (
    ctx: ServerContext,
    request: ApprovalRequest
  ): Promise<'approved' | 'declined' | 'none'> => {
    const responses = ctx.mcpReq.inputResponses;
    if (!responses || !(CONFIRM_KEY in responses)) return 'none';

    const state = ctx.mcpReq.requestState<string>();
    if (typeof state !== 'string' || !(await mintedHere(state, ctx, request)))
      return 'none';

    // Anything but an accept — declined, cancelled, malformed — is a no. Only a
    // ticked box is a yes.
    const content = acceptedContent(responses, CONFIRM_KEY) as
      { confirm?: unknown } | undefined;
    if (content === undefined) return 'declined';
    return content.confirm === true ? 'approved' : 'declined';
  };

  const ask = async (
    ctx: ServerContext,
    request: ApprovalRequest
  ): Promise<InputRequiredResult> =>
    inputRequired({
      inputRequests: {
        [CONFIRM_KEY]: inputRequired.elicit({
          // Server-side facts only. It is rendered to a human, but it is
          // composed here — and caller-chosen values go through renderDetails
          // rather than into the sentence, so none of it is a place to hide an
          // instruction.
          message:
            `${request.what}\n\n${request.consequence}` +
            renderDetails(request.details ?? []),
          requestedSchema: schemaFor(
            request.title ?? 'Proceed?',
            request.hint ?? 'Tick to allow this operation, leave it to cancel.'
          ),
        }),
      },
      requestState: await codec.mint({ key: request.resourceKey }, ctx),
    });

  return {
    async requestApproval(server, ctx, confirmations, request) {
      const answer = await readAnswer(ctx, request);
      if (answer === 'approved') return { decision: 'approved' };
      if (answer === 'declined') return { decision: 'declined' };

      if (canAsk(server, ctx)) {
        // The dialog path never sees a token, so nothing was rejected here.
        return {
          decision: 'pending',
          result: await ask(ctx, request),
          tokenRejected: false,
        };
      }

      if (confirmations.consume(request.resourceKey, request.token)) {
        return { decision: 'approved' };
      }
      const note =
        request.fallbackNote ??
        'Note: this client cannot ask the user directly, so this check only ' +
          'proves the call was made twice with the same arguments. A human ' +
          'should read the lines above before you continue.';
      return {
        decision: 'pending',
        tokenRejected: request.token !== undefined,
        result: {
          content: [
            {
              type: 'text',
              text: `${confirmationPrompt({
                what: request.what,
                consequence: request.consequence,
                token: confirmations.issue(request.resourceKey),
                ttlMinutes: confirmations.ttlMinutes,
                ...(request.details === undefined
                  ? {}
                  : { details: request.details }),
                ...(request.toolName === undefined
                  ? {}
                  : { toolName: request.toolName }),
              })}\n\n${note}`,
            },
          ],
        },
      };
    },
  };
}

/**
 * Whether this caller can be asked anything at all.
 *
 * Two places to look, one per era. On `2026-07-28` the capabilities ride the
 * request's own `_meta` envelope, which is what lets a stateless gateway speak
 * for the client it is currently serving. On a `2025-11-25` connection they
 * were declared once at `initialize`. A per-request legacy instance behind a
 * stateless proxy has neither, and correctly reports that nobody can be asked.
 */
export function canAsk(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    { elicitation?: unknown } | undefined;
  if (declared?.elicitation !== undefined) return true;
  return server.server.getClientCapabilities()?.elicitation !== undefined;
}
