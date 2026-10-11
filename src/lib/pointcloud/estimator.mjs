/** @typedef {{depth: Float32Array, width: number, height: number}} DepthPrediction */
/** @typedef {{phase: string, percent?: number}} Progress */

export class DepthEstimator {
  /** @param {() => Worker} createWorker */
  constructor(createWorker = () => new Worker(new URL('/pointcloud/depth-worker.mjs', window.location.origin), { type: 'module' })) {
    this.createWorker = createWorker;
    /** @type {Worker | null} */
    this.worker = null;
    /** @type {{id: number, resolve: (value: DepthPrediction) => void, reject: (error: unknown) => void, onProgress: (progress: Progress) => void, timer: ReturnType<typeof setTimeout>} | null} */
    this.pending = null;
    this.sequence = 0;
  }
  /**
   * @param {Uint8ClampedArray} rgba
   * @param {number} width
   * @param {number} height
   * @param {(progress: Progress) => void} onProgress
   * @returns {Promise<DepthPrediction>}
   */
  async estimate(rgba, width, height, onProgress = () => {}) {
    if (this.pending) throw new Error('Djupneberekninga er oppteken.');
    if (!this.worker) {
      try { this.worker = this.createWorker(); } catch { throw new Error('Denne nettlesaren kan ikkje berekne djupn.'); }
      this.worker.onmessage = event => {
        const pending = this.pending, data = event.data;
        if (!pending || pending.id !== data.id) return;
        if (data.type === 'progress') pending.onProgress(data);
        else if (data.type === 'result') this.finish(null, { depth: new Float32Array(data.depth), width: data.width, height: data.height });
        else if (data.type === 'error') { this.finish(new Error(data.message)); this.stopWorker(); }
      };
      this.worker.onerror = () => { this.finish(new Error('Djupneberekninga stoppa. Trykk Prøv igjen.')); this.stopWorker(); };
    }
    const worker = this.worker;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.finish(new Error('Djupneberekninga tok for lang tid. Prøv eit nytt bilete.')); this.stopWorker(); }, 180000);
      this.pending = { id, resolve, reject, onProgress, timer };
      try {
        // Transfer a dedicated image, preserving the captured photo for its original colours.
        const copy = new Uint8ClampedArray(rgba);
        worker.postMessage({ id, rgba: copy.buffer, width, height }, [copy.buffer]);
      } catch (error) { this.finish(error); this.stopWorker(); }
    });
  }
  /** @param {unknown} error @param {DepthPrediction} [result] */
  finish(error, result) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer); this.pending = null;
    if (error) pending.reject(error);
    else if (result) pending.resolve(result);
    else pending.reject(new Error('Manglar djupneresultat.'));
  }
  stopWorker() { this.worker?.terminate(); this.worker = null; }
  dispose() { this.finish(new DOMException('Kameraet vart lukka.', 'AbortError')); this.stopWorker(); }
}
