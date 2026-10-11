/**
 * Standard 32-byte Gaussian .splat records -> colourised point centres.
 *
 * 0..11: xyz float32 LE; 12..23: scales; 24..27: RGBA;
 * 28..31: quaternion. We intentionally ignore Gaussian scale/rotation:
 * this view is a genuine POINT CLOUD, not a splat renderer.
 */
export const SPLAT_RECORD_BYTES = 32;
export const MAX_SPLAT_BYTES = 96 * 1024 * 1024;
export const DEFAULT_POINT_BUDGET = 220_000;

export function decodeSplatPointCloud(buffer, maxPoints = DEFAULT_POINT_BUDGET) {
	if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0 ||
		buffer.byteLength > MAX_SPLAT_BYTES ||
		buffer.byteLength % SPLAT_RECORD_BYTES !== 0) {
		throw new Error('Invalid or oversized TripoSplat file.');
	}
	if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 400_000) {
		throw new Error('Invalid point budget.');
	}

	const total = buffer.byteLength / SPLAT_RECORD_BYTES;
	const step = Math.max(1, Math.ceil(total / maxPoints));
	const capacity = Math.ceil(total / step);
	const positions = new Float32Array(capacity * 3);
	const colors = new Float32Array(capacity * 3);
	const view = new DataView(buffer);
	let count = 0;
	for (let i = 0; i < total; i += step) {
		const offset = i * SPLAT_RECORD_BYTES;
		const x = view.getFloat32(offset, true);
		const y = view.getFloat32(offset + 4, true);
		const z = view.getFloat32(offset + 8, true);
		const alpha = view.getUint8(offset + 27);
		if (![x, y, z].every(Number.isFinite) ||
			Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1e5 || alpha < 16) continue;
		const k = count * 3;
		positions[k] = x;
		positions[k + 1] = y;
		positions[k + 2] = z;
		colors[k] = view.getUint8(offset + 24) / 255;
		colors[k + 1] = view.getUint8(offset + 25) / 255;
		colors[k + 2] = view.getUint8(offset + 26) / 255;
		count++;
	}
	if (!count) throw new Error('TripoSplat returned no visible 3D points.');

	const raw = positions.subarray(0, count * 3);
	const samples = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
	for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) {
		samples[axis][i] = raw[i * 3 + axis];
	}
	const low = [], high = [];
	for (const values of samples) {
		values.sort();
		low.push(values[Math.floor((count - 1) * 0.01)]);
		high.push(values[Math.ceil((count - 1) * 0.99)]);
	}
	const center = low.map((value, i) => (value + high[i]) * 0.5);
	const span = Math.max(...low.map((value, i) => high[i] - value), 1e-5);
	const scale = 2.4 / span;
	// Remove a few extremely distant reconstruction outliers before framing.
	let kept = 0;
	for (let i = 0; i < count; i++) {
		const x = (raw[i * 3] - center[0]) * scale;
		const y = (raw[i * 3 + 1] - center[1]) * scale;
		const z = (raw[i * 3 + 2] - center[2]) * scale;
		if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 4) continue;
		const to = kept * 3, from = i * 3;
		raw[to] = x;
		raw[to + 1] = y;
		raw[to + 2] = z;
		colors[to] = colors[from];
		colors[to + 1] = colors[from + 1];
		colors[to + 2] = colors[from + 2];
		kept++;
	}
	if (!kept) throw new Error('TripoSplat returned no usable 3D points.');
	return {
		positions: raw.subarray(0, kept * 3),
		colors: colors.subarray(0, kept * 3),
		count: kept,
		total
	};
}
