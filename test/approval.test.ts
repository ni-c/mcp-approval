import { describe, expect, it } from 'vitest';

import { ConfirmationStore } from '../src/index.js';
import {
  ACCEPTED,
  buildServer,
  connectLegacy,
  connectModern,
  textOf,
  tokenOf,
} from './harness.js';

const build = (key?: Uint8Array) =>
  buildServer({
    store: new ConfirmationStore(),
    ...(key === undefined ? {} : { key }),
  });

/** The same server with the dialog switched off by the operator. */
const buildSilent = () =>
  buildServer({ store: new ConfirmationStore(), elicitation: false });

describe('on the 2026-07-28 revision', () => {
  // Here the question is a RETURN value: the call ends, the person decides, and
  // the client retries carrying the answer. Which means the answer arrives as
  // ordinary request content -- attacker-controlled input, in the SDK's own
  // words.

  it('asks, then acts once the answer comes back with the state it minted', async () => {
    const built = build();
    const client = await connectModern(built);

    const asked = await client.call({ ids: ['a', 'b'] });
    expect(asked.resultType).toBe('input_required');
    expect(asked.requestState).toBeTruthy();
    expect(asked.inputRequests?.confirm?.params.message).toContain(
      'cannot be recovered'
    );
    expect(built.deleted).toHaveLength(0);

    const done = await client.call(
      { ids: ['a', 'b'] },
      { inputResponses: ACCEPTED, requestState: asked.requestState }
    );
    expect(done.resultType).not.toBe('input_required');
    expect(built.deleted).toEqual([['a', 'b']]);
    await client.close();
  });

  it('proves binding but not freshness: a state can be presented twice', async () => {
    // Pinned deliberately, because the token path has the opposite property
    // ("spends the token, so a replay asks again") and the difference between
    // the two used to be an accident nobody had written down.
    //
    // The state is a proof this server hands out, not a secret it keeps: no
    // nonce, nothing spent on verify, a stateless codec. So the same answer
    // replays until it expires. That is not a way past the person — whoever can
    // replay it received the input_required, so they are the client, and a
    // compromised client is already out of scope. What it does mean is that
    // at-most-once is the *server's* job for anything irreversible, which is
    // what SECURITY.md now says.
    const built = build();
    const client = await connectModern(built);

    const asked = await client.call({ ids: ['a'] });
    const answer = {
      inputResponses: ACCEPTED,
      requestState: asked.requestState,
    };

    await client.call({ ids: ['a'] }, answer);
    await client.call({ ids: ['a'] }, answer);
    expect(built.deleted).toEqual([['a'], ['a']]);
    await client.close();
  });

  it('carries the caller-chosen values on their own lines', async () => {
    const built = build();
    const client = await connectModern(built);
    const asked = await client.call({ ids: ['Invoices — approved by IT'] });
    const message = asked.inputRequests?.confirm?.params.message ?? '';
    expect(message).toContain('supplied by the caller, not by this server');
    expect(message).toMatch(/^ {2}Ids: Invoices — approved by IT$/m);
    await client.close();
  });

  it('does nothing when the box was left unticked', async () => {
    const built = build();
    const client = await connectModern(built);
    const asked = await client.call({ ids: ['a'] });
    const done = await client.call(
      { ids: ['a'] },
      {
        inputResponses: {
          confirm: { action: 'accept', content: { confirm: false } },
        },
        requestState: asked.requestState,
      }
    );
    expect(textOf(done)).toContain('declined');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('does nothing when the person declined or cancelled', async () => {
    for (const action of ['decline', 'cancel']) {
      const built = build();
      const client = await connectModern(built);
      const asked = await client.call({ ids: ['a'] });
      const done = await client.call(
        { ids: ['a'] },
        {
          inputResponses: { confirm: { action } },
          requestState: asked.requestState,
        }
      );
      expect(textOf(done), action).toContain('declined');
      expect(built.deleted, action).toHaveLength(0);
      await client.close();
    }
  });

  it('asks again rather than acting when the answer carries no state', async () => {
    // The whole point of asking a human: without a seal this bare object would
    // be all it took, and anything that can shape a tool call can produce it.
    const built = build();
    const client = await connectModern(built);
    await client.call({ ids: ['a'] });
    const again = await client.call(
      { ids: ['a'] },
      { inputResponses: ACCEPTED }
    );
    expect(again.resultType).toBe('input_required');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('asks again when the state was not minted here', async () => {
    const built = build();
    const client = await connectModern(built);
    const asked = await client.call({ ids: ['a'] });
    const forged = `${asked.requestState?.slice(0, -4)}AAAA`;
    const again = await client.call(
      { ids: ['a'] },
      { inputResponses: ACCEPTED, requestState: forged }
    );
    expect(again.resultType).toBe('input_required');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('asks again when the state belongs to a different operation', async () => {
    // The seal names the exact targets that were approved. Approval of one set
    // is not approval of another — the model chooses the second list.
    const built = build();
    const client = await connectModern(built);
    const asked = await client.call({ ids: ['a'] });
    const again = await client.call(
      { ids: ['a', 'b'] },
      { inputResponses: ACCEPTED, requestState: asked.requestState }
    );
    expect(again.resultType).toBe('input_required');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('asks again when a state from another process is presented', async () => {
    // A per-process key is the right lifetime for a stdio server, and this is
    // what it costs: a gateway that restarted the child between the two legs
    // gets a second dialog rather than an error nobody can act on.
    const first = build();
    const clientA = await connectModern(first);
    const asked = await clientA.call({ ids: ['a'] });
    await clientA.close();

    const second = build();
    const clientB = await connectModern(second);
    const again = await clientB.call(
      { ids: ['a'] },
      { inputResponses: ACCEPTED, requestState: asked.requestState }
    );
    expect(again.resultType).toBe('input_required');
    expect(second.deleted).toHaveLength(0);
    await clientB.close();
  });

  it('accepts a state minted by another process with the same key', async () => {
    // The counterpart: a deployment that really does serve the two legs from
    // different processes supplies its own key, and the flow survives.
    const key = new Uint8Array(32).fill(7);
    const first = build(key);
    const clientA = await connectModern(first);
    const asked = await clientA.call({ ids: ['a'] });
    await clientA.close();

    const second = build(key);
    const clientB = await connectModern(second);
    const done = await clientB.call(
      { ids: ['a'] },
      { inputResponses: ACCEPTED, requestState: asked.requestState }
    );
    expect(done.resultType).not.toBe('input_required');
    expect(second.deleted).toEqual([['a']]);
    await clientB.close();
  });

  it('supplies its own wording when the caller gives none', async () => {
    // A minimal caller passes no title, hint, details or tool name. What it
    // gets then is API surface, not an accident.
    const built = build();
    const client = await connectModern(built);
    const asked = await client.call({ id: 'x' }, {}, 'archive_thing');
    const schema = asked.inputRequests?.confirm?.params.requestedSchema as {
      properties: { confirm: { title: string; description: string } };
    };
    expect(schema.properties.confirm.title).toBe('Proceed?');
    expect(schema.properties.confirm.description).toContain(
      'leave it to cancel'
    );
    expect(asked.inputRequests?.confirm?.params.message).not.toContain(
      'supplied by the caller'
    );
    await client.close();
  });

  it('never offers the token to a client it can ask properly', async () => {
    // The token is the weaker mechanism — the model can satisfy it on its own.
    // Where a real dialog is available it must not be handed an alternative.
    const built = build();
    const client = await connectModern(built);
    const asked = await client.call({ ids: ['a'] });
    expect(JSON.stringify(asked)).not.toContain('confirm_token');
    await client.close();
  });
});

describe('on the 2025-11-25 revision', () => {
  // The same handler, no branch of its own: the SDK's legacy shim turns the
  // `inputRequired` return into the server-to-client request it used to be.

  it('asks through the shim and acts on an accept', async () => {
    const built = build();
    const client = await connectLegacy(built, 'accept');
    const done = await client.call({ ids: ['a'] });
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toContain('cannot be recovered');
    expect(built.deleted).toEqual([['a']]);
    expect(textOf(done)).toContain('deleted a');
    await client.close();
  });

  it('does nothing on a decline or a cancel', async () => {
    for (const behaviour of ['decline', 'cancel'] as const) {
      const built = build();
      const client = await connectLegacy(built, behaviour);
      const done = await client.call({ ids: ['a'] });
      expect(built.deleted, behaviour).toHaveLength(0);
      expect(textOf(done), behaviour).toContain('declined');
      await client.close();
    }
  });
});

describe('a client that cannot be asked at all', () => {
  // What a stateless gateway looks like from here: a per-request instance that
  // never saw an initialize holds no capabilities, so nobody can be asked and
  // the token is the honest fallback rather than a downgrade.

  it('falls back to the two-call token', async () => {
    const built = build();
    const client = await connectLegacy(built);
    const first = await client.call({ ids: ['a'] });
    expect(textOf(first)).toContain('confirm_token=');
    expect(textOf(first)).toContain('cannot ask the user directly');
    expect(built.deleted).toHaveLength(0);
    // The prompt is an error result: the deletion was asked for and did not
    // happen. It is also what lets a tool with an `outputSchema` take this
    // path at all — the SDK skips output validation for an error and rejects
    // an unmarked result that carries no `structuredContent`.
    expect(first.isError).toBe(true);

    const done = await client.call({
      ids: ['a'],
      confirm_token: tokenOf(first),
    });
    expect(built.deleted).toEqual([['a']]);
    expect(textOf(done)).toContain('deleted a');
    expect(done.isError).toBeUndefined();
    await client.close();
  });

  it('falls back with generic wording when the caller named no tool', async () => {
    const built = build();
    const client = await connectLegacy(built);
    const first = await client.call({ id: 'x' }, 'archive_thing');
    expect(textOf(first)).toContain('call this tool again');
    expect(textOf(first)).not.toContain('supplied by the caller');
    const done = await client.call(
      { id: 'x', confirm_token: tokenOf(first) },
      'archive_thing'
    );
    expect(built.archived).toEqual(['x']);
    expect(textOf(done)).toContain('archived x');
    await client.close();
  });

  it('refuses a token issued for a different set of targets', async () => {
    const built = build();
    const client = await connectLegacy(built);
    const first = await client.call({ ids: ['a'] });
    const second = await client.call({
      ids: ['a', 'b'],
      confirm_token: tokenOf(first),
    });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('issued for different arguments');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('refuses a supplied token with the reason, rather than asking again', async () => {
    // Both answers end in a new question, and the caller is entitled to know
    // which one it is: a rejected token means the call carried a confirmation
    // issued for something else — the case the resource key exists to catch.
    // Answering it with a fresh prompt and nothing else is self-healing when
    // the token merely expired, and silent when it is not.
    const built = build();
    const client = await connectLegacy(built);
    const first = await client.call({ ids: ['a'] });
    const second = await client.call({
      ids: ['a', 'b'],
      confirm_token: tokenOf(first),
    });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('invalid, expired, or was issued for');
    expect(textOf(second)).toContain('delete_things again without a token');

    // The ordinary first call carries a token and says how to use it, which is
    // the half that makes the distinction worth having. Both results are
    // `isError` — neither call did what was asked — so the distinction lives in
    // the text, which is where a caller reads it anyway.
    const fresh = await client.call({ ids: ['c'] });
    expect(textOf(fresh)).toContain('confirm_token=');
    expect(textOf(fresh)).not.toContain('invalid, expired');
    await client.close();
  });

  it('falls back to "this tool" in the refusal when no tool was named', async () => {
    // The same generic wording the prompt uses. A caller that supplies no tool
    // name gets a sentence that still reads, rather than "call undefined".
    const built = build();
    const client = await connectLegacy(built);
    await client.call({ id: 'x' }, 'archive_thing');
    const wrong = await client.call(
      { id: 'y', confirm_token: 'deadbeef' },
      'archive_thing'
    );
    expect(textOf(wrong)).toContain('Call this tool again without a token');
    await client.close();
  });

  it('spends the token, so a replay asks again', async () => {
    const built = build();
    const client = await connectLegacy(built);
    const first = await client.call({ ids: ['a'] });
    const token = tokenOf(first);
    await client.call({ ids: ['a'], confirm_token: token });
    const replay = await client.call({ ids: ['a'], confirm_token: token });
    expect(replay.isError).toBe(true);
    expect(textOf(replay)).toContain('invalid, expired');
    expect(built.deleted).toEqual([['a']]);
    await client.close();
  });
});

describe('a client that could be asked, with the dialog switched off', () => {
  // `elicitation: false` is not "no confirmation". It takes the same path a
  // client that cannot show a dialog takes, so every assertion of the group
  // above has to hold here too — against a client that declares the capability
  // and would have answered.

  it('falls back to the two-call token instead of asking', async () => {
    const built = buildSilent();
    const client = await connectLegacy(built, 'accept');
    const first = await client.call({ ids: ['a'] });
    expect(client.prompts).toHaveLength(0);
    expect(textOf(first)).toContain('confirm_token=');
    expect(built.deleted).toHaveLength(0);

    const done = await client.call({
      ids: ['a'],
      confirm_token: tokenOf(first),
    });
    expect(client.prompts).toHaveLength(0);
    expect(built.deleted).toEqual([['a']]);
    expect(textOf(done)).toContain('deleted a');
    await client.close();
  });

  it('names the deployment rather than blaming the client', async () => {
    // The reason matters to whoever reads the transcript: "this client cannot
    // ask" would send them to the client, and the client is fine.
    const built = buildSilent();
    const client = await connectLegacy(built, 'accept');
    const first = await client.call({ ids: ['a'] });
    expect(textOf(first)).toContain(
      'thing-mcp was started with the approval dialog switched off'
    );
    expect(textOf(first)).not.toContain('cannot ask the user directly');
    await client.close();
  });

  it('still refuses a token issued for different arguments', async () => {
    const built = buildSilent();
    const client = await connectLegacy(built, 'accept');
    const first = await client.call({ ids: ['a'] });
    const second = await client.call({
      ids: ['a', 'b'],
      confirm_token: tokenOf(first),
    });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain('issued for different arguments');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('still spends the token, so a replay asks again', async () => {
    const built = buildSilent();
    const client = await connectLegacy(built, 'accept');
    const first = await client.call({ ids: ['a'] });
    const token = tokenOf(first);
    await client.call({ ids: ['a'], confirm_token: token });
    const replay = await client.call({ ids: ['a'], confirm_token: token });
    expect(replay.isError).toBe(true);
    expect(built.deleted).toEqual([['a']]);
    await client.close();
  });

  it('returns the token on 2026-07-28 too, rather than input_required', async () => {
    // The era decides how a question is carried, not whether one is asked. If
    // the switch only worked on the legacy path, the servers behind a modern
    // gateway would keep prompting with the operator believing otherwise.
    const built = buildSilent();
    const client = await connectModern(built);
    const first = await client.call({ ids: ['a'] });
    expect(first.resultType).not.toBe('input_required');
    expect(textOf(first)).toContain('confirm_token=');

    const done = await client.call({
      ids: ['a'],
      confirm_token: tokenOf(first),
    });
    expect(built.deleted).toEqual([['a']]);
    await client.close();
    expect(textOf(done)).toContain('deleted a');
  });

  it('is the only thing that changed: the same client is asked by default', async () => {
    // The counter-check. Without it "switchable" is a claim about a flag, not
    // about behaviour — both directions have to be shown against one client.
    const built = build();
    const client = await connectLegacy(built, 'accept');
    const done = await client.call({ ids: ['a'] });
    expect(client.prompts).toHaveLength(1);
    expect(textOf(done)).not.toContain('confirm_token=');
    expect(built.deleted).toEqual([['a']]);
    await client.close();
  });
});
