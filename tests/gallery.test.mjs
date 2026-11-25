import test from 'node:test';
import assert from 'node:assert/strict';
import { createGallery } from '../src/lib/gallery.mjs';
import { memoryIndexedDB } from './helpers/indexeddb.mjs';

const item = (preset = 1) => ({ width: 4, height: 2, mask: Uint8Array.from([0, 0, 1, 0, 0, 0, 0, 1]), depth: Uint16Array.from({ length: 6 }, (_, i) => i * 13107),
  depthWidth: 3, depthHeight: 2, recipe: { preset, position: .25, width: 1.5 } });

test('developed images are kept with depth, mask and expression, newest first', async () => {
  const gallery = createGallery(memoryIndexedDB());
  const first = await gallery.save(item(0), new Blob(['first']));
  await new Promise(done => setTimeout(done, 2));
  const second = await gallery.save(item(4), new Blob(['second']));
  const entries = await gallery.list();
  assert.deepEqual(entries.map(entry => entry.id), [second, first]);
  assert.equal(await entries[0].thumbnail.text(), 'second');
  const stored = await gallery.get(first);
  assert.deepEqual({ ...stored, id: undefined }, { ...item(0), id: undefined });
  assert.ok(stored.depth instanceof Uint16Array && stored.mask instanceof Uint8Array);
  assert.equal(await gallery.get('missing'), undefined);
});

test('a changed expression updates the stored recipe and thumbnail without touching the depth', async () => {
  const gallery = createGallery(memoryIndexedDB());
  const id = await gallery.save(item(), new Blob(['before']));
  await gallery.update(id, { preset: 3, position: -.5, width: .5 }, new Blob(['after']));
  const stored = await gallery.get(id), [entry] = await gallery.list();
  assert.deepEqual(stored.recipe, { preset: 3, position: -.5, width: .5 });
  assert.deepEqual(stored.depth, item().depth);
  assert.equal(await entry.thumbnail.text(), 'after');
  await gallery.update(id, { preset: 0, position: 0, width: 1 }, null);
  assert.equal(await (await gallery.list())[0].thumbnail.text(), 'after');
});

test('a browser without IndexedDB reports that the gallery is unavailable', async () => {
  await assert.rejects(createGallery(undefined).list(), /Lokal lagring/);
});

test('a deleted image leaves both the grid index and its depth', async () => {
  const gallery = createGallery(memoryIndexedDB());
  const kept = await gallery.save(item(0), new Blob(['kept'])), removed = await gallery.save(item(1), new Blob(['removed']));
  await gallery.remove(removed);
  assert.deepEqual((await gallery.list()).map(entry => entry.id), [kept]);
  assert.equal(await gallery.get(removed), undefined); assert.ok(await gallery.get(kept));
});
