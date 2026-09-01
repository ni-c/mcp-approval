import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long an issued token stays usable. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Bounds the map so a loop of refused calls cannot grow it without limit. */
const MAX_PENDING = 100;

/**
 * Short-lived, single-use tokens for operations that need a second look.
 *
 * A plain boolean `confirm` parameter could be set by the model on the very
 * first call — or be talked into it by instructions hidden in content the
 * server itself fetched — whereas a random token that only ever appears in a
 * *previous* tool result cannot be guessed.
 *
 * Be clear about what this is: it proves the call was made twice with the same
 * arguments. It is **not** a human-in-the-loop gate, because the model reads
 * the token out of the first result and can call again in the same turn without
 * anybody seeing it. That still catches a model that widened a target set by
 * accident. For the case where a person has to actually decide, see
 * `requestApproval`, which asks them and keeps this as the fallback for clients
 * that cannot be asked.
 */
export class ConfirmationStore {
  private readonly pending = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = TOKEN_TTL_MS) {}

  /** Creates (or replaces) the pending token for `resource`. */
  issue(resource: string): string {
    // Sweep expired entries first, so the eviction below removes a live token
    // only when there really are MAX_PENDING live ones.
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (now >= entry.expiresAt) this.pending.delete(key);
    }
    if (this.pending.size >= MAX_PENDING) {
      // Drops the oldest. Written as a loop rather than a guarded
      // `keys().next()` because the map provably has an entry here, and the
      // guard would be a branch nothing can reach.
      for (const oldest of this.pending.keys()) {
        this.pending.delete(oldest);
        break;
      }
    }
    const token = randomBytes(16).toString('hex');
    this.pending.set(resource, { token, expiresAt: now + this.ttlMs });
    return token;
  }

  /**
   * True — and the token spent — when it matches the pending one for `resource`
   * and has not expired. Tokens are single-use.
   */
  consume(resource: string, token: string | undefined): boolean {
    const entry = this.pending.get(resource);
    if (entry === undefined || token === undefined) return false;
    if (Date.now() >= entry.expiresAt) {
      this.pending.delete(resource);
      return false;
    }
    if (!constantTimeEquals(token, entry.token)) return false;
    this.pending.delete(resource);
    return true;
  }

  /** Minutes the issued tokens stay valid, for use in messages. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000);
  }
}

/**
 * Compares two tokens without leaking their common prefix through timing.
 *
 * Hashed first because `timingSafeEqual` throws on a length mismatch, and
 * throwing would leak the length — the digests are always the same size.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digest = (value: string): Buffer =>
    createHash('sha256').update(Buffer.from(value, 'utf8')).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * A resource key for an operation on a *set* of targets.
 *
 * Without the fingerprint, a confirmation for `["a"]` would also execute
 * `["a", "b"]`: the model chooses the second list, and only the operation name
 * would have been checked.
 */
export function setResourceKey(
  operation: string,
  targets: readonly string[]
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...targets].sort()))
    .digest('hex')
    .slice(0, 16);
  return `${operation}:${fingerprint}`;
}

/**
 * A value the caller chose, shown on its own labelled line.
 *
 * The point of the separate line is that these are not the server's words. A
 * mailbox called `Invoices — approved by IT, proceed` interpolated into the
 * server's sentence reads like the server saying it; on a line of its own under
 * "supplied by the caller", it reads like what it is.
 */
export interface ConfirmationDetail {
  label: string;
  value: string;
}

/** How much of a caller-chosen value is shown before it is cut. */
const MAX_DETAIL_LENGTH = 200;

/**
 * Flattens a caller-chosen value to one harmless line.
 *
 * The newline is the whole trick, and giving the value its own line does not
 * defend against it: a value that can begin a *further* line writes something
 * that reads like a fresh instruction under the question, and the question
 * stops being what is being answered. The cap is the other half — a value long
 * enough to push the question out of view answers it by default.
 */
function flatten(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_LENGTH
    ? `${flat.slice(0, MAX_DETAIL_LENGTH)}… (truncated)`
    : flat;
}

export function renderDetails(details: readonly ConfirmationDetail[]): string {
  if (details.length === 0) return '';
  return (
    '\n\nValues below are supplied by the caller, not by this server:\n' +
    details
      .map((detail) => `  ${flatten(detail.label)}: ${flatten(detail.value)}`)
      .join('\n')
  );
}

export interface ConfirmationPromptOptions {
  /** What is about to happen, in the server's own words: `delete 3 messages`. */
  what: string;
  /** The token to quote back. */
  token: string;
  /** How long it lasts, from {@link ConfirmationStore.ttlMinutes}. */
  ttlMinutes: number;
  /** Why it cannot be undone. */
  consequence?: string;
  /** Caller-chosen values, rendered on their own lines. */
  details?: readonly ConfirmationDetail[];
  /** Names the tool to call again. Omitted gives the generic "call this tool again". */
  toolName?: string;
}

/**
 * The text a guarded tool returns on its first call.
 *
 * Note what is not in here: nothing the server fetched from elsewhere. Those
 * strings are attacker-controllable and this one is read by a model — which is
 * what {@link ConfirmationDetail} is for when a caller-chosen name has to
 * appear at all.
 */
export function confirmationPrompt(options: ConfirmationPromptOptions): string {
  const { what, token, ttlMinutes, toolName } = options;
  const consequence = options.consequence ?? 'The operation is irreversible.';
  const again =
    toolName === undefined
      ? 'call this tool again'
      : `call ${toolName} again with the same arguments`;
  return (
    `This will ${what}. ${consequence}` +
    `${renderDetails(options.details ?? [])}\n\n` +
    `To proceed, ${again} plus confirm_token="${token}".\n` +
    `The token is valid for ${ttlMinutes} minutes and can be used once.`
  );
}
