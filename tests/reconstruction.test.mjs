import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reconstructionFrames, downloadSplats, MAX_FRAMES, ARTIFACT_CHUNK} from '../src/lib/pointcloud/reconstruct.mjs';
import {reconstructionProxy} from '../src/lib/server/reconstruction.mjs';

const token = 'test-private-token-must-never-reach-phone';
const env = {GAUSS_BACKEND_URL: 'https://shadow.example', GAUSS_BACKEND_TOKEN: token};
const id = 'capture01234567';
const frame = (value) => ({width: 12, height: 12, data: new Uint8ClampedArray(12 * 12 * 4).fill(value)});

test('held capture retains bounded distinct camera views and both ends, rather than one stitched image', () => {
  const frames = Array.from({length: 32}, (_, i) => frame(i * 6));
  const selected = reconstructionFrames(frames);
  assert.equal(selected.length, MAX_FRAMES); assert.equal(selected[0], frames[0]); assert.equal(selected.at(-1), frames.at(-1));
  assert.equal(new Set(selected).size, selected.length);
  assert.equal(reconstructionFrames([frame(100), frame(101), frame(100)]).length, 1);
  assert.equal(reconstructionFrames([]).length, 0);
});

test('Shadow health is authenticated server-side and distinguishes genuine Gaussian readiness', async () => {
  const proxy = reconstructionProxy({env, request: async (url, init) => {
    assert.equal(String(url), 'https://shadow.example/api/reconstruct/health');
    assert.equal(init.headers.get('Authorization'), `Bearer ${token}`);
    return Response.json({ready: true, representation: 'gaussian-splats', models: ['Apple SHARP']});
  }});
  const response = await proxy.health(); assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes(token), false);
  const depthOnly = reconstructionProxy({env, request: async () => Response.json({ready: true, representation: 'pointcloud'})});
  assert.equal((await depthOnly.health()).status, 503);
  const offline = reconstructionProxy({env, request: async () => {throw new Error('offline');}});
  assert.equal((await offline.health()).status, 503);
});

test('capture upload preserves individual views and rejects cross-origin or oversized submissions', async () => {
  let called = 0;
  const proxy = reconstructionProxy({env, request: async (_, init) => {
    called++; assert.equal(init.body.getAll('images').length, 2);
    assert.equal(init.headers.get('Authorization'), `Bearer ${token}`);
    return Response.json({id, status: 'queued'});
  }});
  const form = new FormData();
  form.append('images', new Blob(['camera one'], {type: 'image/jpeg'}), 'one.jpg');
  form.append('images', new Blob(['camera two'], {type: 'image/jpeg'}), 'two.jpg');
  const incoming = (headers) => new Request('https://entropi.iverfinne.no/api/reconstruct/jobs', {method: 'POST', body: form, headers});
  const good = await proxy.create(incoming({Origin: 'https://entropi.iverfinne.no'}));
  assert.equal(good.status, 202); assert.equal((await good.json()).id, id);
  assert.equal((await proxy.create(incoming({Origin: 'https://other.example'}))).status, 403);
  assert.equal((await proxy.create(incoming({'Content-Length': '4500000'}))).status, 413); assert.equal(called, 1);
});

test('large true Gaussian artifact downloads through bounded Vercel responses and verifies SHA-256', async () => {
  const bytes = new Uint8Array(ARTIFACT_CHUNK + 32); bytes.fill(91);
  bytes[bytes.length - 1] = 23;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ranges = [];
  const proxy = reconstructionProxy({env, request: async (_, init) => {
    const range = init.headers.get('Range'); ranges.push(range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    const part = bytes.slice(start, end + 1);
    return new Response(part, {status: 206, headers: {'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(part.length)}});
  }});
  const result = await downloadSplats(id, bytes.length, hash, new AbortController().signal, (url, init) => proxy.artifact(id, new Request(`https://entropi.iverfinne.no${url}`, init)));
  assert.deepEqual(result, bytes); assert.equal(ranges.length, 2);
  assert.deepEqual(ranges, [`bytes=0-${ARTIFACT_CHUNK - 1}`, `bytes=${ARTIFACT_CHUNK}-${bytes.length - 1}`]);
});

test('artifact relay refuses unbounded responses, corrupt ranges, path injection and oversized ranges', async () => {
  let called = 0;
  const proxy = reconstructionProxy({env, request: async () => { called++; return new Response(new Uint8Array(32)); }});
  const incoming = range => new Request('https://entropi.iverfinne.no/api/reconstruct/jobs/id/artifact', {headers: range ? {Range: range} : {}});
  assert.equal((await proxy.artifact(id, incoming())).status, 416);
  assert.equal((await proxy.artifact(id, incoming('bytes=0-3000000'))).status, 416);
  assert.equal((await proxy.artifact('../../secret', incoming('bytes=0-31'))).status, 400);
  assert.equal((await proxy.artifact(id, incoming('bytes=0-31'))).status, 502); assert.equal(called, 1);
});

test('client never renders a truncated or checksum-invalid Gaussian file', async () => {
  const signal = new AbortController().signal;
  const truncated = async () => new Response(new Uint8Array(16), {status: 206, headers: {'Content-Range': 'bytes 0-31/32'}});
  await assert.rejects(downloadSplats(id, 32, 'a'.repeat(64), signal, truncated), /ufullstendig/);
  const corrupt = async () => new Response(new Uint8Array(32), {status: 206, headers: {'Content-Range': 'bytes 0-31/32'}});
  await assert.rejects(downloadSplats(id, 32, 'a'.repeat(64), signal, corrupt), /skadd/);
  await assert.rejects(downloadSplats(id, 31, 'a'.repeat(64), signal, corrupt), /ugyldig/);
});
