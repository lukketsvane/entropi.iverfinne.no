import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),packageRoot=path.dirname(require.resolve('@mediapipe/tasks-vision'));
const destination=path.resolve('static/pointcloud/vision');
await fs.mkdir(path.join(destination,'wasm'),{recursive:true});
await fs.copyFile(path.join(packageRoot,'vision_bundle.cjs'),path.join(destination,'tasks-vision.js'));
await fs.copyFile(path.join(packageRoot,'README.md'),path.join(destination,'MEDIAPIPE-README.md'));
for(const file of await fs.readdir(path.join(packageRoot,'wasm'))){
  if(file.endsWith('.js')||file.endsWith('.wasm'))await fs.copyFile(path.join(packageRoot,'wasm',file),path.join(destination,'wasm',file));
}
const model=path.join(destination,'blaze-face-short-range.tflite');
const expected='b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f';
let bytes=await fs.readFile(model).catch(()=>null);
if(!bytes||createHash('sha256').update(bytes).digest('hex')!==expected){
  const response=await fetch('https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Face model download failed: ${response.status}`);
  bytes=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Face model integrity check failed.');
  await fs.writeFile(model,bytes);
}
console.log('Prepared verified, self-hosted MediaPipe 0.10.32 for local head parallax.');
