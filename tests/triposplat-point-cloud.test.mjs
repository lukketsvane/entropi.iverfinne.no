import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSplatPointCloud, SPLAT_RECORD_BYTES } from '../static/triposplat-point-cloud.js';

function splat(points) {
	const buffer = new ArrayBuffer(points.length * SPLAT_RECORD_BYTES);
	const view = new DataView(buffer);
	points.forEach((p, i) => {
		const at = i * SPLAT_RECORD_BYTES;
		view.setFloat32(at, p.x, true);
		view.setFloat32(at + 4, p.y, true);
		view.setFloat32(at + 8, p.z, true);
		view.setUint8(at + 24, p.r ?? 255);
		view.setUint8(at + 25, p.g ?? 0);
		view.setUint8(at + 26, p.b ?? 0);
		view.setUint8(at + 27, p.a ?? 255);
	});
	return buffer;
}

test('decodes coloured XYZ centres rather than Gaussian scales or rotations', () => {
	const data = decodeSplatPointCloud(splat([
		{x:-1,y:0,z:0,r:255,g:0,b:0},
		{x:1,y:0,z:0,r:0,g:128,b:255}
	]));
	assert.equal(data.count, 2);
	assert.equal(data.total, 2);
	assert.ok(Math.abs(data.positions[0] + 1.2) < 1e-5);
	assert.ok(Math.abs(data.positions[3] - 1.2) < 1e-5);
	assert.deepEqual(Array.from(data.colors.slice(0,3)), [1,0,0]);
	assert.ok(Math.abs(data.colors[4] - 128/255) < 1e-6);
	assert.equal(data.colors[5], 1);
});

test('skips invisible and invalid points', () => {
	const data = decodeSplatPointCloud(splat([
		{x:1,y:2,z:3,a:255},
		{x:2,y:3,z:4,a:0},
		{x:Infinity,y:0,z:0,a:255}
	]));
	assert.equal(data.count, 1);
	assert.equal(data.total, 3);
});

test('respects mobile point budget', () => {
	const points = Array.from({length:5000},(_,i)=>({x:i/1000,y:i%3,z:0}));
	const data = decodeSplatPointCloud(splat(points),200);
	assert.ok(data.count <= 200);
	assert.equal(data.total, 5000);
});

test('rejects truncated, empty and mismatched buffers', () => {
	assert.throws(() => decodeSplatPointCloud(new ArrayBuffer(0)));
	assert.throws(() => decodeSplatPointCloud(new ArrayBuffer(33)));
	assert.throws(() => decodeSplatPointCloud(new Uint8Array(32)));
	assert.throws(() => decodeSplatPointCloud(new ArrayBuffer(32),0));
});
