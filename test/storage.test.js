const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Exercises the local-disk backend. The Vercel Blob branches need a real store
// and are covered by scripts/rotate-public-blobs.js running against staging.
delete process.env.BLOB_READ_WRITE_TOKEN;
const storage = require('../utils/storage');

const ORG = 'test-org-storage';

test.after(() => {
  fs.rmSync(path.join(storage.UPLOAD_ROOT, ORG), { recursive: true, force: true });
});

test('save returns an opaque org-scoped key, never a URL', async () => {
  const key = await storage.save(ORG, 'claims', Buffer.from('hello'), { originalName: 'note.pdf' });
  assert.ok(!storage.isRemote(key), 'key must not be a fetchable URL');
  assert.match(key, new RegExp(`^${ORG}/claims/\\d+-[0-9a-f]{12}\\.pdf$`));
});

test('the tenant id is the first path segment, so keys cannot collide across orgs', async () => {
  const a = await storage.save('org-a', 'claims', Buffer.from('a'), { fileName: 'same.pdf' });
  const b = await storage.save('org-b', 'claims', Buffer.from('b'), { fileName: 'same.pdf' });
  assert.notStrictEqual(a, b);
  assert.strictEqual(a.split('/')[0], 'org-a');
  assert.strictEqual(b.split('/')[0], 'org-b');
  fs.rmSync(path.join(storage.UPLOAD_ROOT, 'org-a'), { recursive: true, force: true });
  fs.rmSync(path.join(storage.UPLOAD_ROOT, 'org-b'), { recursive: true, force: true });
});

test('round-trips a buffer', async () => {
  const key = await storage.save(ORG, 'receipts', Buffer.from('payload'), { originalName: 'r.png' });
  assert.strictEqual((await storage.readBuffer(key)).toString(), 'payload');
  await storage.remove(key);
  assert.rejects(() => storage.readBuffer(key));
});

test('rejects traversal out of the upload root', async () => {
  await assert.rejects(() => storage.readBuffer('../../etc/passwd'), /Invalid file path/);
});

test('isRemote only matches legacy public URLs, not keys', () => {
  assert.ok(storage.isRemote('https://x.public.blob.vercel-storage.com/org/claims/1-a.pdf'));
  assert.ok(!storage.isRemote('org/claims/1-a.pdf'));
  assert.ok(!storage.isRemote(undefined));
});

test('presigned URLs are short-lived', () => {
  assert.ok(storage.PRESIGN_TTL_MS > 0);
  assert.ok(storage.PRESIGN_TTL_MS <= 300 * 1000, 'TTL must stay at or under 5 minutes');
});
