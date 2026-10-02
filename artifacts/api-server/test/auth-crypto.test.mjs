import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const compiledDir = await mkdtemp(join(tmpdir(), 'event-system-auth-crypto-'));
const compiledModule = join(compiledDir, 'auth-crypto.mjs');
await build({
  entryPoints: [new URL('../src/lib/auth-crypto.ts', import.meta.url).pathname],
  outfile: compiledModule,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { hashPassword, verifyPassword, generateTemporaryPassword, isValidUsername, normalizeUsername, hashSessionToken } =
  await import(pathToFileURL(compiledModule).href);

after(async () => {
  await rm(compiledDir, { recursive: true, force: true });
});

test('password hashes are salted and verify only the matching password', async () => {
  const firstHash = await hashPassword('a-long-test-password-123');
  const secondHash = await hashPassword('a-long-test-password-123');

  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword('a-long-test-password-123', firstHash), true);
  assert.equal(await verifyPassword('wrong-password', firstHash), false);
});

test('malformed or unsupported password hashes fail closed', async () => {
  assert.equal(await verifyPassword('password', 'not-a-valid-hash'), false);
  assert.equal(await verifyPassword('password', 'scrypt$1$1$1$c2FsdA$a2V5'), false);
});

test('generated temporary passwords have high-entropy URL-safe values that verify through the password hash', async () => {
  const password = generateTemporaryPassword();

  assert.match(password, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(password, generateTemporaryPassword());
  assert.equal(await verifyPassword(password, await hashPassword(password)), true);
});

test('username normalization and validation are consistent', () => {
  assert.equal(normalizeUsername('  Event.Owner  '), 'event.owner');
  assert.equal(isValidUsername('event-owner_1'), true);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('not allowed'), false);
});

test('session tokens are stored as a non-reversible digest', () => {
  const token = 'sample-session-token';
  const digest = hashSessionToken(token);

  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, token);
  assert.equal(hashSessionToken(token), digest);
});