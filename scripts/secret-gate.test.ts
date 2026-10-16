import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The gate is a plain Node script with no type declarations.
import { findSecrets, isClientSecretFile } from './secret-gate.mjs';

// Built at run time, so this file does not trip the gate it tests.
const SECRET = `GOCSPX-${'a1B2_c3-'.repeat(3)}abcd`;
const ACCESS = `ya29.${'A0b'.repeat(10)}`;
const REFRESH = `1//0${'gXy'.repeat(15)}`;

test('Google secrets and tokens are found wherever they sit in a file', () => {
  assert.deepEqual(findSecrets(`{"web":{"client_secret":"${SECRET}"}}`), ['Google OAuth client secret']);
  assert.deepEqual(findSecrets(`Authorization: Bearer ${ACCESS}`), ['Google access token']);
  assert.deepEqual(findSecrets(`refresh_token=${REFRESH}\n`), ['Google refresh token']);
});

test('ordinary text, the client ID and the broker\'s test values pass', () => {
  assert.deepEqual(findSecrets('GOOGLE_CLIENT_ID: 123456789012-abc.apps.googleusercontent.com'), []);
  assert.deepEqual(findSecrets("client_secret: 'test-only-secret', refresh_token: '1/refresh-token-value'"), []);
  assert.deepEqual(findSecrets('GOCSPX-short'), []);
});

test('the downloaded client file is refused by its name', () => {
  assert.equal(isClientSecretFile('client_secret_123456789012-abc.apps.googleusercontent.com.json'), true);
  assert.equal(isClientSecretFile('deploy\\oauth-relay\\client_secret_x.json'), true);
  assert.equal(isClientSecretFile('packages/gdrive/src/client.ts'), false);
});
