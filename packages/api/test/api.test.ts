import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import * as api from '../src/index.js';

const field = 52435875175126190479447740508185965837690552500527637822603658699938581184512n;
const fieldJson = '52435875175126190479447740508185965837690552500527637822603658699938581184512';
const amount = 18446744073709551615n;
const amountJson = '18446744073709551615';
const hash28 = 'ab'.repeat(28);
const hash32 = 'cd'.repeat(32);
const config: api.PoolConfigView = {
  depositsPaused: false, minDeposit: 0n, maxDeposit: amount, poolCap: amount,
  depositFeeBps: 20, settleFeeBps: 30, crankFee: 100n,
};
const configJson = {
  depositsPaused: false, minDeposit: '0', maxDeposit: amountJson, poolCap: amountJson,
  depositFeeBps: 20, settleFeeBps: 30, crankFee: '100',
};
const pool: api.PoolView = {
  poolId: hash28, asset: 'lovelace', roots: [0n, field], size: 2, queue: [field],
  nullifierRoot: hash32, feesAccrued: amount, aspRoot: field, config,
  tip: { slot: 1000, hash: hash32 },
};
const poolJson = {
  poolId: hash28, asset: 'lovelace', roots: ['0', fieldJson], size: 2, queue: [fieldJson],
  nullifierRoot: hash32, feesAccrued: amountJson, aspRoot: fieldJson, config: configJson,
  tip: { slot: 1000, hash: hash32 },
};
const leaves: api.LeavesPage = { from: 1, leaves: [field], size: 2, root: field };
const aspLeaves: api.AspLeavesPage = { from: 0, leaves: [0n, field], root: field };
const deposit: api.DepositView = {
  txId: hash32, index: 0, gross: amount, precommitment: field, refundKeyHash: hash28,
  status: 'absorbed', value: amount, label: field, leafIndex: 1,
};
const depositJson = {
  txId: hash32, index: 0, gross: amountJson, precommitment: fieldJson, refundKeyHash: hash28,
  status: 'absorbed', value: amountJson, label: fieldJson, leafIndex: 1,
};
const nullifiers: api.NullifiersPage = { from: 0, nullifiers: [field] };
const payout: api.PayoutRequest = {
  address: 'addr1v8h6y7sl3hk2nhz2m8pmfv7zy6r38r3kz88kp99zv0c37cqzhjs4a', amount, datumHash: hash32,
};
const payoutJson = { address: payout.address, amount: amountJson, datumHash: hash32 };
const quote: api.Quote = {
  quoteId: 'quote-1', poolId: hash28, withdrawn: amount, protocolFee: 20n,
  relayerFee: 30n, relayerKeyHash: hash28, validUntil: 1800000000000,
};
const proof: api.ProofHex = { a: 'ab'.repeat(48), b: 'cd'.repeat(96), c: 'ef'.repeat(48) };
const publicInputs: api.SpendPublicInputs = {
  newCommitment: field, nullifierHash: field, withdrawn: amount, stateRoot: field, aspRoot: field, context: field,
};
const publicInputsJson = {
  newCommitment: fieldJson, nullifierHash: fieldJson, withdrawn: amountJson,
  stateRoot: fieldJson, aspRoot: fieldJson, context: fieldJson,
};
const intent: api.IntentRequest = { poolId: hash28, payouts: [payout], relayer: hash28, validUntil: quote.validUntil };
const intentJson = { poolId: hash28, payouts: [payoutJson], relayer: hash28, validUntil: quote.validUntil };
const settle: api.SettleRequest = { quoteId: quote.quoteId, proof, publicInputs, intent };
const submitted: api.SettleStatus = { id: 'settle /?#1', status: 'submitted', txHash: hash32, confirmations: 0, error: null };

function roundTrip<T>(name: string, value: T, toJson: (value: T) => unknown, fromJson: (value: unknown) => T, expected: unknown) {
  test(name, () => {
    assert.equal(typeof toJson, 'function', 'The wire encoder must be exported');
    assert.equal(typeof fromJson, 'function', 'The wire decoder must be exported');
    const json = JSON.parse(JSON.stringify(toJson(value))) as unknown;
    assert.deepEqual(json, expected);
    assert.deepEqual(fromJson(json), value);
  });
}

roundTrip('SDK-02: pool config wire preserves large amounts', config, api.poolConfigViewToJson, api.poolConfigViewFromJson, configJson);
roundTrip('SDK-02: pool wire preserves field elements', pool, api.poolViewToJson, api.poolViewFromJson, poolJson);
roundTrip('SDK-02: leaves wire preserves order and root', leaves, api.leavesPageToJson, api.leavesPageFromJson,
  { from: 1, leaves: [fieldJson], size: 2, root: fieldJson });
roundTrip('SDK-02: ASP wire preserves removed labels', aspLeaves, api.aspLeavesPageToJson, api.aspLeavesPageFromJson,
  { from: 0, leaves: ['0', fieldJson], root: fieldJson });
roundTrip('SDK-01: deposit wire preserves recovery data', deposit, api.depositViewToJson, api.depositViewFromJson, depositJson);
roundTrip('SDK-01: nullifier wire preserves spent hashes', nullifiers, api.nullifiersPageToJson, api.nullifiersPageFromJson,
  { from: 0, nullifiers: [fieldJson] });
roundTrip('REL-01: payout wire preserves amount and datum', payout, api.payoutRequestToJson, api.payoutRequestFromJson, payoutJson);
roundTrip('REL-01: quote wire preserves fees and expiry', quote, api.quoteToJson, api.quoteFromJson,
  { ...quote, withdrawn: amountJson, protocolFee: '20', relayerFee: '30' });
roundTrip('REL-02: proof wire preserves compressed points', proof, api.proofHexToJson, api.proofHexFromJson, proof);
roundTrip('REL-02: public inputs wire preserves all six values', publicInputs, api.spendPublicInputsToJson, api.spendPublicInputsFromJson, publicInputsJson);
roundTrip('REL-02: intent wire preserves payouts', intent, api.intentRequestToJson, api.intentRequestFromJson, intentJson);
roundTrip('REL-02: settle request wire preserves proof and intent', settle, api.settleRequestToJson, api.settleRequestFromJson,
  { quoteId: quote.quoteId, proof, publicInputs: publicInputsJson, intent: intentJson });
roundTrip('REL-02: settle status wire preserves polling details', submitted, api.settleStatusToJson, api.settleStatusFromJson, submitted);

function badRequest(fieldName: string) {
  return (error: unknown) => {
    assert.ok(error instanceof api.ApiError);
    assert.equal(error.code, 'bad_request');
    assert.equal(error.status, 400);
    assert.ok(error.message.includes(fieldName), `Expected field ${fieldName}, got ${error.message}`);
    return true;
  };
}

test('SDK-02: malformed wire fields name the rejected field', () => {
  assert.equal(typeof api.poolViewFromJson, 'function');
  for (const value of ['-1', '1.5', '1e3', '', ' 1', '+1', 1, null]) {
    assert.throws(() => api.poolViewFromJson({ ...poolJson, aspRoot: value }), badRequest('aspRoot'));
  }
  for (const value of ['zz'.repeat(28), 'ab', hash28.toUpperCase()]) {
    assert.throws(() => api.poolViewFromJson({ ...poolJson, poolId: value }), badRequest('poolId'));
  }
  assert.throws(() => api.poolViewFromJson({ ...poolJson, roots: ['-1'] }), badRequest('roots[0]'));
  assert.throws(() => api.poolViewFromJson({ ...poolJson, tip: { slot: 1, hash: 'ab' } }), badRequest('tip.hash'));
  assert.throws(() => api.poolViewFromJson({ ...poolJson, size: 1.5 }), badRequest('size'));
  assert.throws(() => api.poolViewFromJson({ ...poolJson, config: { ...configJson, depositsPaused: 'false' } }), badRequest('config.depositsPaused'));
  assert.throws(() => api.settleRequestFromJson({ ...settle, publicInputs: publicInputsJson, intent: { ...intentJson, payouts: [{ ...payoutJson, datumHash: 'aa' }] } }), badRequest('intent.payouts[0].datumHash'));
  assert.throws(() => api.proofHexFromJson({ ...proof, b: 'aa'.repeat(48) }), badRequest('b'));
  assert.throws(() => api.depositViewFromJson({ ...depositJson, status: 'unknown' }), badRequest('status'));
});

test('SDK-02: decimal fields reject trailing line terminators', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    assert.throws(() => api.poolViewFromJson({ ...poolJson, aspRoot: '1' + suffix }), badRequest('aspRoot'));
  }
});

test('REL-02: hex fields reject line terminators even at the correct length', () => {
  for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => api.poolViewFromJson({ ...poolJson, poolId: hash28.slice(0, -1) + suffix }), badRequest('poolId'));
    assert.throws(() => api.proofHexFromJson({ ...proof, a: proof.a.slice(0, -1) + suffix }), badRequest('a'));
  }
});

test('SDK-02: asset names reject trailing line terminators', () => {
  assert.throws(() => api.poolViewFromJson({ ...poolJson, asset: `${hash28}.ab\n` }), badRequest('asset'));
});

test('SDK-02: every wire shape requires all declared fields', () => {
  const shapes: Array<[(value: unknown) => unknown, Record<string, unknown>]> = [
    [api.poolConfigViewFromJson, configJson], [api.poolViewFromJson, poolJson],
    [api.leavesPageFromJson, { from: 1, leaves: [], size: 1, root: '0' }],
    [api.aspLeavesPageFromJson, { from: 0, leaves: [], root: '0' }],
    [api.depositViewFromJson, depositJson], [api.nullifiersPageFromJson, { from: 0, nullifiers: [] }],
    [api.payoutRequestFromJson, payoutJson],
    [api.quoteFromJson, { ...quote, withdrawn: amountJson, protocolFee: '20', relayerFee: '30' }],
    [api.proofHexFromJson, { ...proof }], [api.spendPublicInputsFromJson, publicInputsJson],
    [api.intentRequestFromJson, intentJson],
    [api.settleRequestFromJson, { quoteId: quote.quoteId, proof, publicInputs: publicInputsJson, intent: intentJson }],
    [api.settleStatusFromJson, { ...submitted }],
  ];
  for (const [decode, json] of shapes) {
    assert.equal(typeof decode, 'function');
    for (const key of Object.keys(json)) {
      const missing = { ...json };
      delete missing[key];
      assert.throws(() => decode(missing), badRequest(key));
    }
    assert.throws(() => decode(null), badRequest(''));
    assert.throws(() => decode([]), badRequest(''));
  }
});

test('SDK-01: nullable wire fields preserve null and deposit states', () => {
  assert.equal(typeof api.depositViewFromJson, 'function');
  for (const status of ['pending', 'refunded'] as const) {
    const value = { ...deposit, status, value: null, label: null, leafIndex: null };
    assert.deepEqual(api.depositViewFromJson(api.depositViewToJson(value)), value);
  }
  const nullablePayout = { ...payout, datumHash: null };
  assert.deepEqual(api.payoutRequestFromJson(api.payoutRequestToJson(nullablePayout)), nullablePayout);
  const nullableIntent = { ...intent, relayer: null };
  assert.deepEqual(api.intentRequestFromJson(api.intentRequestToJson(nullableIntent)), nullableIntent);
  for (const status of ['confirmed', 'failed'] as const) {
    const value = { ...submitted, status, confirmations: 3, error: 'settle failed' };
    assert.deepEqual(api.settleStatusFromJson(api.settleStatusToJson(value)), value);
  }
  const tokenPool = { ...pool, asset: `${hash28}.aabb` };
  assert.deepEqual(api.poolViewFromJson(api.poolViewToJson(tokenPool)), tokenPool);
});

test('REL-04: error wire preserves codes, messages, and HTTP status', () => {
  assert.equal(typeof api.ApiError, 'function');
  const cases: Array<[api.ErrorCode, number]> = [
    ['stale_root', 409], ['stale_asp_root', 409], ['nullifier_spent', 409], ['queue_full', 409],
    ['quote_expired', 409], ['invalid_proof', 400], ['intent_mismatch', 400],
    ['not_found', 404], ['bad_request', 400], ['internal', 500],
  ];
  for (const [code, status] of cases) {
    const error = new api.ApiError(code, 'Try again');
    assert.equal(error.status, status);
    assert.deepEqual(api.errorToJson(error), { error: { code, message: 'Try again' } });
    const decoded = api.errorFromJson(api.errorToJson(error), status);
    assert.ok(decoded instanceof api.ApiError);
    assert.equal(decoded.code, code);
    assert.equal(decoded.message, 'Try again');
    assert.equal(decoded.status, status);
  }
  assert.equal(api.errorFromJson({ error: { code: 'queue_full', message: 'Busy' } }, 400).status, 400);
  assert.throws(() => api.errorFromJson({ error: { code: 'unknown', message: 'Oops' } }), badRequest('code'));
  assert.throws(() => api.errorFromJson({ error: { code: 'internal' } }), badRequest('message'));
});

test('SDK-02: indexer HTTP client covers every route and query', async (t) => {
  assert.equal(typeof api.serveJson, 'function');
  const slots: Array<number | undefined> = [];
  const fake: api.IndexerApi = {
    async getPool() { return pool; },
    async getLeaves(from, limit) { assert.deepEqual([from, limit], [1, 5]); return leaves; },
    async getAspLeaves(from, limit) { assert.deepEqual([from, limit], [0, 6]); return aspLeaves; },
    async getDeposits(fromSlot) { slots.push(fromSlot); return [deposit]; },
    async getNullifiers(from, limit) { assert.deepEqual([from, limit], [0, 7]); return nullifiers; },
  };
  const server = await api.serveJson(api.indexerRoutes(fake), 0);
  t.after(() => server.close());
  const paths: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    return fetch(input, init);
  };
  const client = new api.IndexerClient(`${server.url}/`, fetchImpl);
  assert.deepEqual(await client.getPool(), pool);
  assert.deepEqual(await client.getLeaves(1, 5), leaves);
  assert.deepEqual(await client.getAspLeaves(0, 6), aspLeaves);
  assert.deepEqual(await client.getDeposits(), [deposit]);
  assert.deepEqual(await client.getDeposits(0), [deposit]);
  assert.deepEqual(await client.getDeposits(25), [deposit]);
  assert.deepEqual(await client.getNullifiers(0, 7), nullifiers);
  assert.deepEqual(slots, [undefined, 0, 25]);
  assert.deepEqual(paths, ['/v1/pool', '/v1/leaves?from=1&limit=5', '/v1/asp/leaves?from=0&limit=6',
    '/v1/deposits', '/v1/deposits?fromSlot=0', '/v1/deposits?fromSlot=25', '/v1/nullifiers?from=0&limit=7']);
  assert.equal(new URL(server.url).hostname, '127.0.0.1');
  assert.ok(server.port > 0);
});

test('REL-01 REL-02: relayer HTTP client preserves requests and SPEC responses', async (t) => {
  assert.equal(typeof api.serveJson, 'function');
  const confirmed: api.SettleStatus = { ...submitted, status: 'confirmed', confirmations: 4 };
  const fake: api.RelayerApi = {
    async getPool() { return pool; },
    async quote(payouts) { assert.deepEqual(payouts, [payout]); return quote; },
    async settle(value) { assert.deepEqual(value, settle); return submitted; },
    async getSettle(id) { assert.equal(id, submitted.id); return confirmed; },
  };
  const server = await api.serveJson(api.relayerRoutes(fake), 0);
  t.after(() => server.close());
  const responses: Array<{ path: string; method: string; status: number; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    responses.push({ path: new URL(String(input)).pathname, method: init?.method ?? 'GET',
      status: response.status, body: await response.clone().json() });
    return response;
  };
  const client = new api.RelayerClient(server.url, fetchImpl);
  assert.deepEqual(await client.getPool(), pool);
  assert.deepEqual(await client.quote([payout]), quote);
  assert.deepEqual(await client.settle(settle), submitted);
  assert.deepEqual(await client.getSettle(submitted.id), confirmed);
  assert.deepEqual(responses.map(({ path, method, status }) => ({ path, method, status })), [
    { path: '/v1/pool', method: 'GET', status: 200 },
    { path: '/v1/quote', method: 'POST', status: 200 },
    { path: '/v1/settle', method: 'POST', status: 202 },
    { path: '/v1/settle/settle%20%2F%3F%231', method: 'GET', status: 200 },
  ]);
  assert.deepEqual(responses[2]?.body, { id: submitted.id, status: 'submitted', txHash: hash32 });
});

test('REL-04: clients preserve service errors and the server hides unexpected errors', async (t) => {
  assert.equal(typeof api.serveJson, 'function');
  const server = await api.serveJson([
    { method: 'GET', path: '/v1/pool', handle() { throw new api.ApiError('stale_root', 'Prove again'); } },
    { method: 'POST', path: '/v1/quote', async handle() { throw new Error('private diagnostic detail'); } },
  ], 0);
  t.after(() => server.close());
  for (const client of [new api.IndexerClient(server.url), new api.RelayerClient(server.url)]) {
    await assert.rejects(client.getPool(), (error: unknown) => {
      assert.ok(error instanceof api.ApiError);
      assert.equal(error.code, 'stale_root');
      assert.equal(error.status, 409);
      assert.equal(error.message, 'Prove again');
      return true;
    });
  }
  await assert.rejects(new api.RelayerClient(server.url).quote([payout]), (error: unknown) => {
    assert.ok(error instanceof api.ApiError);
    assert.equal(error.code, 'internal');
    assert.equal(error.status, 500);
    assert.ok(!error.message.includes('private diagnostic detail'));
    return true;
  });
  const response = await fetch(`${server.url}/v1/quote`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('private diagnostic detail'));
});

test('REL-03: HTTP rejects unknown paths, invalid JSON, and bodies over one MiB', async (t) => {
  assert.equal(typeof api.serveJson, 'function');
  const server = await api.serveJson([{ method: 'POST', path: '/echo', handle: ({ body }) => body }], 0);
  t.after(() => server.close());
  const missing = await fetch(`${server.url}/missing`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: { code: string } }).error.code, 'not_found');
  for (const body of ['not JSON', '', '"' + 'x'.repeat(1024 * 1024 - 1) + '"']) {
    const response = await fetch(`${server.url}/echo`, { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'bad_request');
  }
  const exact = '"' + 'x'.repeat(1024 * 1024 - 2) + '"';
  const accepted = await fetch(`${server.url}/echo`, { method: 'POST', body: exact });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), exact);

  // No Content-Length header: the streamed byte count must enforce the same limit.
  const streamed = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(`${server.url}/echo`, { method: 'POST' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write('"');
    req.write('é'.repeat(524288));
    req.end('"');
  });
  assert.equal(streamed.status, 400);
  assert.equal((JSON.parse(streamed.body) as { error: { code: string } }).error.code, 'bad_request');
});

test('SDK-02 REL-03: route adapters reject malformed queries and request shapes', async (t) => {
  assert.equal(typeof api.serveJson, 'function');
  const unexpected = async (): Promise<never> => { throw new Error('Malformed input reached service'); };
  const server = await api.serveJson([
    ...api.indexerRoutes({ getPool: unexpected, getLeaves: unexpected, getAspLeaves: unexpected,
      getDeposits: unexpected, getNullifiers: unexpected }),
    ...api.relayerRoutes({ getPool: unexpected, quote: unexpected, settle: unexpected, getSettle: unexpected }),
  ], 0);
  t.after(() => server.close());
  for (const path of ['/v1/leaves?from=-1&limit=2', '/v1/leaves?from=0&limit=0', '/v1/leaves?from=0',
    '/v1/asp/leaves?from=0.5&limit=2', '/v1/nullifiers?from=0&limit=1e3', '/v1/deposits?fromSlot=',
    '/v1/deposits?fromSlot=9007199254740992', '/v1/leaves?from=0&from=1&limit=2', '/v1/settle/%ZZ',
    '/v1/leaves?from=1%0A&limit=2']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'bad_request');
  }
  for (const [path, body] of [['/v1/quote', {}], ['/v1/quote', { payouts: 'bad' }],
    ['/v1/quote', { payouts: [{ ...payoutJson, amount: '-1' }] }], ['/v1/settle', {}]]) {
    const response = await fetch(server.url + path, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'bad_request');
  }
});

test('SDK-02: JSON server answers browser preflight and closes cleanly', async () => {
  assert.equal(typeof api.serveJson, 'function');
  const server = await api.serveJson([{ method: 'GET', path: '/v1/pool', handle: () => poolJson }], 0);
  try {
    const preflight = await fetch(`${server.url}/v1/pool`, { method: 'OPTIONS', headers: {
      Origin: 'https://demo.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /content-type|\*/i);
    const response = await fetch(`${server.url}/v1/pool`);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    await response.json();
  } finally {
    await server.close();
  }
  await assert.rejects(fetch(`${server.url}/v1/pool`));
});
