import type { IncomingMessage } from 'node:http';
import { ApiError } from './types.js';
import type { IndexerApi, PayoutRequest, RelayerApi, SettleRequest } from './types.js';
import {
  aspLeavesPageFromJson, aspLeavesPageToJson, depositViewFromJson, depositViewToJson,
  errorFromJson, errorToJson, leavesPageFromJson, leavesPageToJson,
  nullifiersPageFromJson, nullifiersPageToJson, payoutRequestFromJson, payoutRequestToJson,
  poolViewFromJson, poolViewToJson, quoteFromJson, quoteToJson,
  settleRequestFromJson, settleRequestToJson, settleStatusFromJson, settleStatusToJson,
} from './wire.js';

class JsonClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  protected async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(this.baseUrl + path, {
      method, headers: body === undefined ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ApiError('internal', 'The server returned invalid JSON');
    }
    if (!response.ok) {
      let error: ApiError;
      try {
        error = errorFromJson(value, response.status);
      } catch {
        throw new ApiError('internal', 'The server returned an invalid error response');
      }
      throw error;
    }
    return value;
  }

  async getPool() {
    return poolViewFromJson(await this.request('GET', '/v1/pool'));
  }
}

export class IndexerClient extends JsonClient implements IndexerApi {
  async getLeaves(from: number, limit: number) {
    return leavesPageFromJson(await this.request('GET', `/v1/leaves?${new URLSearchParams({ from: String(from), limit: String(limit) })}`));
  }

  async getAspLeaves(from: number, limit: number) {
    return aspLeavesPageFromJson(await this.request('GET', `/v1/asp/leaves?${new URLSearchParams({ from: String(from), limit: String(limit) })}`));
  }

  async getDeposits(fromSlot?: number) {
    const query = fromSlot === undefined ? '' : `?${new URLSearchParams({ fromSlot: String(fromSlot) })}`;
    const value = await this.request('GET', `/v1/deposits${query}`);
    if (!Array.isArray(value)) throw new ApiError('bad_request', 'deposits: expected an array');
    return value.map((item: unknown, index) => depositViewFromJson(item, `deposits[${index}]`));
  }

  async getNullifiers(from: number, limit: number) {
    return nullifiersPageFromJson(await this.request('GET', `/v1/nullifiers?${new URLSearchParams({ from: String(from), limit: String(limit) })}`));
  }
}

export class RelayerClient extends JsonClient implements RelayerApi {
  async quote(payouts: PayoutRequest[]) {
    return quoteFromJson(await this.request('POST', '/v1/quote', { payouts: payouts.map(payoutRequestToJson) }));
  }

  async settle(request: SettleRequest) {
    const value = bodyObject(await this.request('POST', '/v1/settle', settleRequestToJson(request)));
    if (value.status !== 'submitted') throw new ApiError('bad_request', 'status: expected submitted');
    // SPEC 8.8 omits polling fields from the accepted response.
    return settleStatusFromJson({ ...value, confirmations: 0, error: null });
  }

  async getSettle(id: string) {
    return settleStatusFromJson(await this.request('GET', `/v1/settle/${encodeURIComponent(id)}`));
  }
}

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handle(request: { params: Record<string, string>; query: URLSearchParams; body: unknown }): Promise<unknown> | unknown;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('bad_request', 'body: expected an object');
  }
  return value as Record<string, unknown>;
}

function queryInteger(query: URLSearchParams, name: string, positive = false): number {
  const values = query.getAll(name);
  const value = values[0];
  if (values.length !== 1 || value === undefined || !/^[0-9]+$/.test(value)
    || !Number.isSafeInteger(Number(value)) || (positive && Number(value) === 0)) {
    throw new ApiError('bad_request', `${name}: expected ${positive ? 'a positive' : 'a non-negative'} safe integer`);
  }
  return Number(value);
}

export function indexerRoutes(api: IndexerApi): Route[] {
  return [
    { method: 'GET', path: '/v1/pool', handle: async () => poolViewToJson(await api.getPool()) },
    { method: 'GET', path: '/v1/leaves', handle: async ({ query }) =>
      leavesPageToJson(await api.getLeaves(queryInteger(query, 'from'), queryInteger(query, 'limit', true))) },
    { method: 'GET', path: '/v1/asp/leaves', handle: async ({ query }) =>
      aspLeavesPageToJson(await api.getAspLeaves(queryInteger(query, 'from'), queryInteger(query, 'limit', true))) },
    { method: 'GET', path: '/v1/deposits', handle: async ({ query }) =>
      (await api.getDeposits(query.has('fromSlot') ? queryInteger(query, 'fromSlot') : undefined)).map(depositViewToJson) },
    { method: 'GET', path: '/v1/nullifiers', handle: async ({ query }) =>
      nullifiersPageToJson(await api.getNullifiers(queryInteger(query, 'from'), queryInteger(query, 'limit', true))) },
  ];
}

export function relayerRoutes(api: RelayerApi): Route[] {
  return [
    { method: 'GET', path: '/v1/pool', handle: async () => poolViewToJson(await api.getPool()) },
    { method: 'POST', path: '/v1/quote', handle: async ({ body }) => {
      const value = bodyObject(body);
      if (!Array.isArray(value.payouts)) throw new ApiError('bad_request', 'payouts: expected an array');
      const payouts = value.payouts.map((item: unknown, index) => payoutRequestFromJson(item, `payouts[${index}]`));
      return quoteToJson(await api.quote(payouts));
    } },
    { method: 'POST', path: '/v1/settle', handle: async ({ body }) => {
      const status = await api.settle(settleRequestFromJson(body));
      return { id: status.id, status: status.status, txHash: status.txHash };
    } },
    { method: 'GET', path: '/v1/settle/:id', handle: async ({ params }) => settleStatusToJson(await api.getSettle(params.id!)) },
  ];
}

const maxBodyBytes = 1024 * 1024;

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    const tooLarge = () => {
      rejected = true;
      chunks = [];
      reject(new ApiError('bad_request', 'body: exceeds the 1 MiB limit'));
      // Drain the request so the error response can reach the client.
      request.resume();
    };
    request.on('error', () => reject(new ApiError('bad_request', 'body: could not read request')));
    request.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > maxBodyBytes) return tooLarge();
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      if (bytes === 0 && request.method !== 'POST') return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new ApiError('bad_request', 'body: expected valid JSON'));
      }
    });
    if (Number(request.headers['content-length']) > maxBodyBytes) tooLarge();
  });
}

function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i]!;
    const value = actual[i]!;
    if (part.startsWith(':') && value !== '') {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        throw new ApiError('bad_request', `${part.slice(1)}: invalid URL encoding`);
      }
    } else if (part !== value) {
      return undefined;
    }
  }
  return params;
}

/** Serves JSON on loopback. POST /v1/settle answers 202 as required by SPEC 8.8. */
export async function serveJson(routes: Route[], port: number): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') {
      request.resume();
      response.writeHead(204).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let matched: { route: Route; params: Record<string, string> } | undefined;
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const params = matchPath(route.path, url.pathname);
        if (params) { matched = { route, params }; break; }
      }
      if (!matched) throw new ApiError('not_found', 'Route not found');
      const body = await readBody(request);
      const value = await matched.route.handle({ params: matched.params, query: url.searchParams, body });
      const json = JSON.stringify(value ?? null);
      response.writeHead(request.method === 'POST' && matched.route.path === '/v1/settle' ? 202 : 200).end(json);
    } catch (error) {
      request.resume();
      const failure = error instanceof ApiError ? error : new ApiError('internal', 'Internal server error');
      response.writeHead(failure.status).end(JSON.stringify(errorToJson(failure)));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The JSON server has no TCP address');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`, port: address.port,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        // Close keep-alive and incomplete requests so shutdown cannot hang.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
