import test from 'node:test';
import assert from 'node:assert/strict';
import { operationClass, readR2Usage, readWorkersUsage } from '../src/analytics.js';
import { CloudflareApi, CloudflareApiError } from '../src/api.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

function api(respond: (body: { query: string; variables: Record<string, string> }) => Response): { api: CloudflareApi; requests: Array<{ query: string; variables: Record<string, string> }> } {
  const requests: Array<{ query: string; variables: Record<string, string> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.cloudflare.com/client/v4/graphql');
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
    requests.push(body);
    return respond(body);
  };
  return { api: new CloudflareApi({ accessToken: async () => 'token', fetchImpl }), requests };
}

const group = (actionType: string, bucketName: string, requests: number, responseStatusCode = 200) => ({ sum: { requests }, dimensions: { actionType, bucketName, responseStatusCode } });
const sample = (bucketName: string, datetime: string, objectCount: number, payloadSize: number, metadataSize: number) => ({ max: { objectCount, payloadSize, metadataSize }, dimensions: { datetime, bucketName } });

test('operations are classed as Cloudflare prices them', () => {
  assert.equal(operationClass('PutObject'), 'A');
  assert.equal(operationClass('ListObjects'), 'A');
  assert.equal(operationClass('ListBuckets'), 'A');
  assert.equal(operationClass('GetObject'), 'B');
  assert.equal(operationClass('HeadBucket'), 'B');
  assert.equal(operationClass('DeleteObject'), 'free');
  assert.equal(operationClass('SomethingNew'), 'unclassified');
});

test('month-to-date usage splits the bucket from the account and ignores refused requests', async () => {
  // Shaped like what the live analytics returned on 2026-09-16.
  const { api: client, requests } = api(() => Response.json({
    data: { viewer: { accounts: [{
      operations: [
        group('PutObject', 'sillytavern-manager-backup', 480),
        group('GetObject', 'sillytavern-manager-backup', 11),
        group('GetObject', 'sillytavern-manager-backup', 7, 401),
        group('DeleteObject', 'sillytavern-manager-backup', 388),
        group('HeadBucket', 'devproxyvn', 44_367),
        group('ListBuckets', '', 10),
        group('RenameObject', 'devproxyvn', 2),
      ],
      storage: [
        sample('devproxyvn', '2026-09-16T12:00:00Z', 21_182, 9_345_632, 662_105),
        sample('sillytavern-manager-backup', '2026-09-16T12:30:00Z', 151, 5_000_000, 1_000),
        sample('sillytavern-manager-backup', '2026-09-16T11:30:00Z', 10, 100, 0),
        sample('lucyspeak', '2026-09-16T12:00:00Z', 0, 0, 0),
      ],
    }] } },
    errors: null,
  }));
  const report = await readR2Usage(client, ACCOUNT, 'sillytavern-manager-backup', new Date('2026-09-16T12:48:00Z'));
  assert.equal(report.periodStart, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(report.bucket, { name: 'sillytavern-manager-backup', storageBytes: 5_001_000, objectCount: 151, measuredAt: '2026-09-16T12:30:00Z', operations: { classA: 480, classB: 11, free: 388, unclassified: 0 } });
  assert.deepEqual(report.account.operations, { classA: 490, classB: 44_378, free: 388, unclassified: 2 });
  assert.equal(report.account.storageBytes, 9_345_632 + 662_105 + 5_001_000);
  assert.equal(report.account.objectCount, 21_182 + 151);
  assert.equal(report.account.measuredAt, '2026-09-16T12:30:00Z');
  assert.equal(requests[0]?.variables.account, ACCOUNT);
  assert.equal(requests[0]?.variables.storageSince, '2026-09-14T12:48:00.000Z');
});

test('a bucket with no samples has unknown storage, not zero', async () => {
  const { api: client } = api(() => Response.json({ data: { viewer: { accounts: [{ operations: [], storage: [] }] } }, errors: null }));
  const report = await readR2Usage(client, ACCOUNT, 'sillytavern-manager-backup', new Date('2026-09-16T00:00:00Z'));
  assert.equal(report.bucket.storageBytes, null);
  assert.equal(report.account.storageBytes, null);
});

test('GraphQL errors inside a 200 are failures, not an empty month', async () => {
  const { api: client } = api(() => Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] }));
  await assert.rejects(readR2Usage(client, ACCOUNT, 'b', new Date()), (error: unknown) => error instanceof CloudflareApiError && error.code === 'cloudflare_graphql_failed' && /not authorized/u.test(error.message));
  await assert.rejects(readR2Usage(client, '../x', 'b', new Date()), (error: unknown) => error instanceof CloudflareApiError && error.code === 'cloudflare_invalid_account');
});

const invocation = (scriptName: string, requests: number, errors = 0) => ({ sum: { requests, errors }, dimensions: { scriptName } });

test("today's Worker requests are counted per script and for the account together", async () => {
  const { api: client, requests } = api(() => Response.json({
    data: { viewer: { accounts: [{ invocations: [
      invocation('sillytavern', 18_400, 12),
      invocation('stm', 5_320),
      invocation('sillytavern-manager-backup', 610),
      // A script can come back more than once: the dimensions Cloudflare
      // groups by are not only the one asked for.
      invocation('stm', 180),
    ] }] } },
    errors: null,
  }));

  const report = await readWorkersUsage(client, ACCOUNT, new Date('2026-09-22T16:40:00Z'));

  // The allowance is per account, so the total is what matters; the split is
  // what says which Worker is spending it.
  assert.equal(report.requests, 24_510);
  assert.equal(report.errors, 12);
  assert.equal(report.freeTier.requestsPerDay, 100_000);
  assert.deepEqual(report.scripts, [
    { scriptName: 'sillytavern', requests: 18_400, errors: 12 },
    { scriptName: 'stm', requests: 5_500, errors: 0 },
    { scriptName: 'sillytavern-manager-backup', requests: 610, errors: 0 },
  ]);

  // Counted from midnight UTC, which is when Cloudflare resets the allowance -
  // not from midnight wherever the machine is. In Vietnam that boundary falls
  // at seven in the morning, and counting from local midnight would report
  // against yesterday's allowance for seven hours of every day.
  assert.equal(requests[0]?.variables.dayStart, '2026-09-22T00:00:00.000Z');
  assert.equal(report.dayStart, '2026-09-22T00:00:00.000Z');
});

test('an account whose Workers have answered nothing today reads as nothing, not as unknown', async () => {
  const { api: client } = api(() => Response.json({ data: { viewer: { accounts: [{ invocations: [] }] } }, errors: null }));
  const report = await readWorkersUsage(client, ACCOUNT, new Date('2026-09-22T00:04:00Z'));
  assert.equal(report.requests, 0);
  assert.deepEqual(report.scripts, []);
});

test('a refused Workers analytics query is an error rather than a usage of nothing', async () => {
  // A failed GraphQL query is still a 200 with `errors` beside `data`. Read as
  // success it would say the account has used nothing, which is the one wrong
  // answer here: it reads as room to spare on an account that may have none.
  const { api: client } = api(() => Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] }));
  await assert.rejects(
    readWorkersUsage(client, ACCOUNT, new Date('2026-09-22T10:00:00Z')),
    (error: unknown) => error instanceof CloudflareApiError && error.code === 'cloudflare_graphql_failed',
  );
});
