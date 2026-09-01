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
  /**
   * A token was supplied on the fallback path and did not match.
   *
   * Its own verdict rather than another question, because the two are not the
   * same thing to say. A rejected token means the call carried a confirmation
   * issued for *something else* — the exact case the resource key exists to
   * catch — and answering it with a fresh prompt is self-healing when the token
   * merely expired and silent when it is not.
   *
   * `reason` is the sentence to show. The caller still owns the error type: a
   * server that maps thrown domain errors to tool results should raise its own
   * with this text, which is why this is not a finished error result.
   */
  | { decision: 'rejected'; reason: string }
  | { decision: 'pending'; result: CallToolResult | InputRequiredResult };

export interface ApprovalOptions {
  /**
   * The server's own name. Named in the fallback text when the dialog was
   * switched off, so a log or a transcript says *which* server did not ask.
   */
  server: string;
  /**
   * Whether a client that could be asked is asked at all. Default `true`.
   *
   * `false` is not "no confirmation": it takes the same path a client that
   * cannot show a dialog takes, which is the two-call token. There is no
   * setting in this library that lets a guarded call through unannounced.
   *
   * It exists for the deployments where a dialog is the wrong shape rather
   * than an unwanted one — a scheduled job, a test harness, a client whose
   * dialog interrupts something. The fallback text says which of the two
   * reasons applies, because "this client cannot ask" would be a lie here.
   */
  elicitation?: boolean;
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
  const elicitation = options.elicitation ?? true;
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

      if (elicitation && canAsk(server, ctx)) {
        return { decision: 'pending', result: await ask(ctx, request) };
      }

      if (confirmations.consume(request.resourceKey, request.token)) {
        return { decision: 'approved' };
      }
      // A token that was sent and did not match gets the reason, not a new
      // prompt. `consume` has already run, so this cannot be reached by a
      // token that was simply spent correctly.
      if (request.token !== undefined) {
        return {
          decision: 'rejected',
          reason:
            'The confirmation token is invalid, expired, or was issued for ' +
            `different arguments. Call ${request.toolName ?? 'this tool'} ` +
            'again without a token to get a new one.',
        };
      }

      // Two different reasons end up on the same path, and the sentence has to
      // say which one it was. "This client cannot ask the user directly" is
      // simply false when the operator switched the dialog off — the client
      // could have been asked and was not, which is a fact about the
      // deployment that only the server's own name places.
      const note =
        request.fallbackNote ??
        (elicitation
          ? 'Note: this client cannot ask the user directly, so this check ' +
            'only proves the call was made twice with the same arguments. A ' +
            'human should read the lines above before you continue.'
          : `Note: ${options.server} was started with the approval dialog ` +
            'switched off, so nobody was asked. This check only proves the ' +
            'call was made twice with the same arguments. A human should read ' +
            'the lines above before you continue.');
      return {
        decision: 'pending',
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
