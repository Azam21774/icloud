import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const compiledDir = await mkdtemp(join(tmpdir(), 'invite-ledger-caldav-'));
const compiledModule = join(compiledDir, 'icloud-caldav.mjs');
await build({
  entryPoints: [new URL('../src/lib/icloud-caldav.ts', import.meta.url).pathname],
  outfile: compiledModule,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { createICloudEvent } = await import(pathToFileURL(compiledModule).href);

const originalFetch = globalThis.fetch;

after(async () => {
  await rm(compiledDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function eventInput(overrides = {}) {
  return {
    eventUid: 'test-event@example.invalid',
    email: 'organizer@example.com',
    appPassword: 'not-a-real-password',
    calendarHref: 'https://p01-caldav.icloud.com/123/calendars/abc/',
    title: 'Test event',
    location: '',
    url: '',
    startAt: new Date('2030-01-01T10:00:00.000Z'),
    durationMinutes: 30,
    attendees: [{ email: 'guest@example.net', name: 'Guest' }],
    invitationMode: 'caldav-scheduling',
    ...overrides,
  };
}

test('counts scheduling as server-accepted only when the PUT returns Schedule-Tag', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(null, {
      status: 201,
      headers: { 'Schedule-Tag': '"server-version-1"' },
    });
  };

  const result = await createICloudEvent(eventInput());

  assert.equal(result.invitationAcceptedByServer, true);
  assert.equal(result.alreadyExists, false);
  assert.equal(request.init.method, 'PUT');
  const unfoldedBody = request.init.body.replace(/\r\n[ \t]/g, '');
  assert.match(unfoldedBody, /METHOD:REQUEST/);
  assert.match(unfoldedBody, /ATTENDEE[^:]*:mailto:guest@example\.net/);
  assert.doesNotMatch(unfoldedBody, /^DESCRIPTION:/m);
});

test('writes every invitee into one event in the same scheduling request', async () => {
  let requestCount = 0;
  let body = '';
  globalThis.fetch = async (_url, init) => {
    requestCount += 1;
    body = init.body;
    return new Response(null, {
      status: 201,
      headers: { 'Schedule-Tag': '"server-version-2"' },
    });
  };

  const attendees = [
    { email: 'first@example.net', name: 'First Guest' },
    { email: 'second@example.net', name: 'Second Guest' },
    { email: 'third@example.net', name: 'Third Guest' },
  ];
  const result = await createICloudEvent(eventInput({ attendees }));
  const unfoldedBody = body.replace(/\r\n[ \t]/g, '');
  const attendeeLines = unfoldedBody
    .split('\r\n')
    .filter((line) => line.startsWith('ATTENDEE'));

  assert.equal(requestCount, 1);
  assert.equal(attendeeLines.length, attendees.length);
  for (const attendee of attendees) {
    assert.match(unfoldedBody, new RegExp(`mailto:${attendee.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.equal(result.invitationAcceptedByServer, true);
});

test('includes the event note as an escaped calendar description', async () => {
  let body = '';
  globalThis.fetch = async (_url, init) => {
    body = init.body;
    return new Response(null, { status: 201 });
  };

  await createICloudEvent(
    eventInput({ description: 'Bring snacks, please;\ncheck in at the front desk' }),
  );
  const unfoldedBody = body.replace(/\r\n[ \t]/g, '');

  assert.match(
    unfoldedBody,
    /^DESCRIPTION:Bring snacks\\, please\\;\\ncheck in at the front desk$/m,
  );
});

test('records the calendar event without claiming scheduling when Schedule-Tag is absent', async () => {
  globalThis.fetch = async () => new Response(null, { status: 201 });

  const result = await createICloudEvent(eventInput());

  assert.equal(result.invitationAcceptedByServer, false);
  assert.equal(result.alreadyExists, false);
});

test('a verified event found after a retry does not claim the scheduling response', async () => {
  const requests = [];
  const existingEvent =
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:test-event@example.invalid\r\nATTENDEE:mailto:guest@example.net\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  globalThis.fetch = async (_url, init) => {
    requests.push(init.method);
    return init.method === 'PUT'
      ? new Response(null, { status: 412 })
      : new Response(existingEvent, { status: 200 });
  };

  const result = await createICloudEvent(eventInput());

  assert.deepEqual(requests, ['PUT', 'GET']);
  assert.equal(result.alreadyExists, true);
  assert.equal(result.invitationAcceptedByServer, false);
});

test('saves attendee details when scheduling capability is unavailable without claiming an invitation', async () => {
  let requestBody = '';
  globalThis.fetch = async (_url, init) => {
    requestBody = init.body;
    return new Response(null, { status: 201 });
  };

  const result = await createICloudEvent(
    eventInput({ invitationMode: 'calendar-only' }),
  );
  const unfoldedBody = requestBody.replace(/\r\n[ \t]/g, '');

  assert.match(unfoldedBody, /ATTENDEE[^:]*:mailto:guest@example\.net/);
  assert.doesNotMatch(unfoldedBody, /^METHOD:REQUEST$/m);
  assert.equal(result.invitationAcceptedByServer, false);
  assert.equal(result.alreadyExists, false);
});