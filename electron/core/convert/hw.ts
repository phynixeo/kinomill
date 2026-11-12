// Detects which GPU encoders actually work on this PC (listing in `ffmpeg -encoders`
// is not enough: NVENC/QSV/AMF are compiled in but need matching hardware + drivers).
import { runCapture } from '../util';

export const HW_CANDIDATES = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_amf', 'hevc_amf', 'av1_amf'];

export async function detectHwEncoders(ffmpeg: string): Promise<string[]> {
  let listed: string[] = [];
  try {
    const r = await runCapture(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 20000 });
    listed = HW_CANDIDATES.filter((e) => new RegExp(`\\s${e}\\s`).test(r.stdout));
  } catch {
    return [];
  }
  const ok: string[] = [];
  // test one at a time: some drivers dislike many simultaneous sessions
  for (const enc of listed) {
    try {
      const r = await runCapture(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.4', '-frames:v', '6', '-pix_fmt', enc.endsWith('_qsv') ? 'nv12' : 'yuv420p', '-c:v', enc, '-f', 'null', '-'],
        { timeoutMs: 20000 },
      );
      if (r.code === 0) ok.push(enc);
    } catch {
      /* not usable */
    }
  }
  return ok;
}
