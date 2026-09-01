import {
  Client,
  InMemoryTransport,
  withInputRequired,
} from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import {
  ConfirmationStore,
  createApproval,
  setResourceKey,
} from '../src/index.js';

/**
 * A server with one guarded tool, so both eras can be driven against the same
 * handler — which is the claim this library makes.
 */
export function buildServer(options: {
  store: ConfirmationStore;
  key?: Uint8Array;
}): {
  server: McpServer;
  deleted: string[][];
  archived: string[];
} {
  const deleted: string[][] = [];
  const archived: string[] = [];
  const approval = createApproval({
    server: 'thing-mcp',
    ...(options.key === undefined ? {} : { key: options.key }),
  });
  const server = new McpServer({ name: 'thing-mcp', version: '0.0.0' });

  server.registerTool(
    'delete_things',
    {
      title: 'Delete things',
      description: 'Deletes things after asking.',
      inputSchema: z.object({
        ids: z.array(z.string()),
        confirm_token: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ ids, confirm_token }, ctx) => {
      const outcome = await approval.requestApproval(
        server,
        ctx,
        options.store,
        {
          what: `delete ${ids.length} thing(s)`,
          consequence: 'They cannot be recovered.',
          resourceKey: setResourceKey('delete_things', ids),
          token: confirm_token,
          details: [{ label: 'Ids', value: ids.join(', ') }],
          title: 'Delete them?',
          hint: 'Tick to delete, leave to cancel.',
          toolName: 'delete_things',
        }
      );
      if (outcome.decision === 'declined') {
        return {
          content: [{ type: 'text', text: 'declined; nothing was deleted' }],
          isError: true,
        };
      }
      // A rejected token is its own verdict, and the library supplies the
      // sentence; what stays here is the error type, which is this server's.
      if (outcome.decision === 'rejected') {
        return {
          content: [{ type: 'text', text: outcome.reason }],
          isError: true,
        };
      }
      if (outcome.decision === 'pending') return outcome.result;
      deleted.push(ids);
      return { content: [{ type: 'text', text: `deleted ${ids.join(', ')}` }] };
    }
  );

  // A second tool that supplies nothing optional: no title, no hint, no
  // details, no tool name. That is what a minimal caller looks like, and the
  // defaults it gets are API surface like everything else.
  server.registerTool(
    'archive_thing',
    {
      title: 'Archive a thing',
      description: 'Archives a thing after asking.',
      inputSchema: z.object({
        id: z.string(),
        confirm_token: z.string().optional(),
      }),
    },
    async ({ id, confirm_token }, ctx) => {
      const outcome = await approval.requestApproval(
        server,
        ctx,
        options.store,
        {
          what: `archive ${id}`,
          consequence: 'It leaves the active list.',
          resourceKey: `archive:${id}`,
          token: confirm_token,
          // Spelled the way a server with a camelCase schema would, so the
          // fallback sentence has to follow it rather than say confirm_token.
          tokenParam: 'confirmToken',
        }
      );
      if (outcome.decision === 'rejected') {
        return {
          content: [{ type: 'text', text: outcome.reason }],
          isError: true,
        };
      }
      if (outcome.decision === 'declined') {
        return { content: [{ type: 'text', text: 'declined' }], isError: true };
      }
      if (outcome.decision === 'pending') return outcome.result;
      archived.push(id);
      return { content: [{ type: 'text', text: `archived ${id}` }] };
    }
  );

  return { server, deleted, archived };
}

/** Enough of a result to tell a question from an answer. */
export interface View {
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<
    string,
    { params: { message: string; requestedSchema?: unknown } }
  >;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * The server on `2026-07-28`, with the round trip left to the test.
 *
 * `serveStdio` owns the era decision — a hand-wired transport pins the
 * connection to 2025 whatever the client offers. `autoFulfill: false` keeps the
 * client from answering on the user's behalf, so a test can hand back exactly
 * what it wants: the right answer, no state, or somebody else's.
 */
export async function connectModern(built: { server: McpServer }): Promise<{
  call(
    args: Record<string, unknown>,
    extra?: Record<string, unknown>,
    tool?: string
  ): Promise<View>;
  close(): Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => built.server, { transport: serverTransport });
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
    }
  );
  await client.connect(clientTransport);
  return {
    call: async (args, extra = {}, tool = 'delete_things') =>
      (await client.request(
        {
          method: 'tools/call',
          params: { name: tool, arguments: args, ...extra },
        },
        withInputRequired(CallToolResultSchema),
        { allowInputRequired: true }
      )) as View,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

export type ElicitBehaviour = 'accept' | 'decline' | 'cancel';

/**
 * The server on `2025-11-25`, where the SDK's legacy shim turns the same
 * `inputRequired` return into the push it used to be.
 *
 * `elicit: undefined` is the third case that matters: a client that declares no
 * elicitation capability at all, which is what a stateless gateway looks like
 * from here — and the one where the token fallback has to take over.
 */
export async function connectLegacy(
  built: { server: McpServer },
  elicit?: ElicitBehaviour
): Promise<{
  call(args: Record<string, unknown>, tool?: string): Promise<View>;
  prompts: string[];
  close(): Promise<void>;
}> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      prompts.push((request.params as { message?: string }).message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await Promise.all([
    client.connect(clientTransport),
    built.server.connect(serverTransport),
  ]);
  return {
    call: async (args, tool = 'delete_things') =>
      (await client.callTool({ name: tool, arguments: args })) as View,
    prompts,
    close: async () => {
      await client.close();
    },
  };
}

export const textOf = (view: View): string =>
  (view.content ?? [])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('\n');

export const tokenOf = (view: View): string => {
  // Either spelling: the two tools here declare the parameter differently on
  // purpose, so that the prompt is forced to follow the schema rather than a
  // constant.
  const match = /confirm_?[Tt]oken="([0-9a-f]+)"/.exec(textOf(view));
  if (!match) throw new Error(`no token in: ${textOf(view).slice(0, 200)}`);
  return match[1] as string;
};

export const ACCEPTED = {
  confirm: { action: 'accept', content: { confirm: true } },
};
