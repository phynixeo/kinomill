// Black bar detection ("remove black bars automatically") using ffmpeg cropdetect.
import type { Crop } from '../../../shared/types';
import { runCapture } from '../util';

/** Parse the last "crop=w:h:x:y" from cropdetect output. */
export function parseCropdetect(stderr: string): Crop | null {
  const re = /crop=(\d+):(\d+):(\d+):(\d+)/g;
  let m: RegExpExecArray | null;
  let last: Crop | null = null;
  while ((m = re.exec(stderr))) last = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  return last && last.w > 0 && last.h > 0 ? last : null;
}

/** Union of several detected boxes (keeps any area that was non-black in some sample). */
export function unionCrops(crops: Crop[], width: number, height: number): Crop | null {
  if (!crops.length) return null;
  let x1 = width;
  let y1 = height;
  let x2 = 0;
  let y2 = 0;
  for (const c of crops) {
    x1 = Math.min(x1, c.x);
    y1 = Math.min(y1, c.y);
    x2 = Math.max(x2, c.x + c.w);
    y2 = Math.max(y2, c.y + c.h);
  }
  x1 = Math.max(0, x1 + (x1 % 2));
  y1 = Math.max(0, y1 + (y1 % 2));
  x2 = Math.min(width, x2);
  y2 = Math.min(height, y2);
  let w = x2 - x1;
  let h = y2 - y1;
  w -= w % 2;
  h -= h % 2;
  if (w < width * 0.2 || h < height * 0.2) return null; // probably a dark scene, not bars
  if (w >= width - 4 && h >= height - 4) return null; // nothing worth cropping
  return { x: x1, y: y1, w, h };
}

export async function detectCrop(ffmpeg: string, file: string, duration: number, width: number, height: number, signal?: AbortSignal): Promise<Crop | null> {
  const points = duration > 4 ? [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f) => f * duration) : [0];
  const found: Crop[] = [];
  await Promise.all(
    points.map(async (t) => {
      if (signal?.aborted) return;
      const r = await runCapture(
        ffmpeg,
        ['-hide_banner', '-ss', t.toFixed(2), '-i', file, '-frames:v', '12', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-an', '-sn', '-f', 'null', '-'],
        { timeoutMs: 60000 },
      ).catch(() => null);
      const c = r ? parseCropdetect(r.stderr) : null;
      if (c) found.push(c);
    }),
  );
  if (signal?.aborted) throw new Error('canceled');
  return unionCrops(found, width, height);
}
