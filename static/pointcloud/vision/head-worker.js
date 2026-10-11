/* MediaPipe runs only in this device's worker. Frames are never recorded. */
let detector;
importScripts("/pointcloud/vision/local-network.js");
self.exports = {};
importScripts("/pointcloud/vision/tasks-vision.js");

self.onmessage = async ({ data }) => {
  if (data.type === "init") {
    try {
      const vision = await self.exports.FilesetResolver.forVisionTasks("/pointcloud/vision/wasm");
      detector = await self.exports.FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "/pointcloud/vision/blaze-face-short-range.tflite", delegate: "CPU" },
        runningMode: "VIDEO", minDetectionConfidence: .65,
      });
      self.postMessage({ type: "ready" });
    } catch { self.postMessage({ type: "error" }); }
    return;
  }
  if (data.type !== "frame") return;
  const image = data.image;
  try {
    if (!detector) throw new Error("Detector unavailable");
    const detections = detector.detectForVideo(image, data.timestamp).detections;
    // Choose the nearest face. There is no identity matching or biometric store.
    const detection = detections.filter(face => face.boundingBox).sort((a, b) => b.boundingBox.width - a.boundingBox.width)[0];
    let face = null;
    if (detection) {
      const box = detection.boundingBox;
      const eyes = detection.keypoints?.slice(0, 2);
      face = {
        x: eyes?.length === 2 ? (eyes[0].x + eyes[1].x) / 2 : (box.originX + box.width / 2) / image.width,
        y: eyes?.length === 2 ? (eyes[0].y + eyes[1].y) / 2 : (box.originY + box.height / 2) / image.height,
        size: box.width / image.width,
      };
    }
    self.postMessage({ type: "face", face });
  } catch { self.postMessage({ type: "error" }); }
  finally { image.close(); }
};
