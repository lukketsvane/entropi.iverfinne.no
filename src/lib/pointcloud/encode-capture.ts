type Pixels = {data: Uint8ClampedArray; width: number; height: number};

async function jpeg(frame: Pixels, quality: number, edge: number): Promise<Blob> {
  const source = document.createElement('canvas');
  source.width = frame.width; source.height = frame.height;
  const context = source.getContext('2d');
  if (!context) throw new Error('Kunne ikkje lese kamerabiletet.');
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  let canvas = source;
  const scale = Math.min(1, edge / Math.max(frame.width, frame.height));
  if (scale < 1) {
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(frame.width * scale));
    canvas.height = Math.max(1, Math.round(frame.height * scale));
    const resized = canvas.getContext('2d');
    if (!resized) throw new Error('Kunne ikkje lese kamerabiletet.');
    resized.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  try {
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error('Kunne ikkje klargjere biletet.')), 'image/jpeg', quality);
    });
  } finally {
    source.width = source.height = 1;
    canvas.width = canvas.height = 1;
  }
}

export async function encodeCapture(frames: Pixels[], maxUpload: number, encode = jpeg): Promise<Blob[]> {
  const edge = Math.max(...frames.map(frame => Math.max(frame.width, frame.height)));
  const edges = [...new Set([edge, 960, 800, 640, 504].filter(value => value <= edge))];
  for (const size of edges) for (const quality of [.86, .72, .55]) {
    const images: Blob[] = [];
    let total = 0;
    for (const frame of frames) {
      const image = await encode(frame, quality, size);
      total += image.size;
      if (total > maxUpload - 100_000) break;
      images.push(image);
    }
    if (images.length === frames.length) return images;
  }
  throw new Error('Kamerabileta er for store.');
}
