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

    const done = await client.call({
      ids: ['a'],
      confirm_token: tokenOf(first),
    });
    expect(built.deleted).toEqual([['a']]);
    expect(textOf(done)).toContain('deleted a');
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
    expect(textOf(second)).toContain('confirm_token=');
    expect(built.deleted).toHaveLength(0);
    await client.close();
  });

  it('spends the token, so a replay asks again', async () => {
    const built = build();
    const client = await connectLegacy(built);
    const first = await client.call({ ids: ['a'] });
    const token = tokenOf(first);
    await client.call({ ids: ['a'], confirm_token: token });
    const replay = await client.call({ ids: ['a'], confirm_token: token });
    expect(textOf(replay)).toContain('confirm_token=');
    expect(built.deleted).toEqual([['a']]);
    await client.close();
  });
});
