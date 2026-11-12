// Minimal DVD-Video authoring (no menus): turns DVD-compliant MPEG-2 program
// streams written by `ffmpeg -f dvd` into a VIDEO_TS folder.
//
//  * One title set (VTS_01) holding one title per input, chapters every N minutes.
//  * VIDEO_TS.IFO has a First-Play PGC that starts title 1; each title's post
//    command jumps to the next title (the last one stops).
//  * ffmpeg writes empty NAV packs (PCI + DSI) at the start of every VOBU; we
//    fill them in (sector addresses, presentation times, cell/VOB ids, search
//    info, reference-picture end addresses, audio sync) like dvdauthor does.
//
// Layout references: libdvdread ifo_types.h / nav_types.h and the DVD-Video
// structures documented at dvd.sourceforge.net (mpucoder).
import fs from 'node:fs';
import path from 'node:path';

const SECTOR = 2048;
/** Each VOB file must stay below 1 GiB. */
export const MAX_VOB_SECTORS = 524272;

export interface DvdTitleSource {
  /** Program stream written by `ffmpeg ... -f dvd`. */
  vobPath: string;
  /** Seconds between automatic chapter marks (0 = only one chapter). */
  chapterInterval: number;
}

export interface DvdAuthorOptions {
  standard: 'pal' | 'ntsc';
  aspect: '16:9' | '4:3';
  /** Folder that will receive VIDEO_TS/ and AUDIO_TS/. */
  outDir: string;
  titles: DvdTitleSource[];
  /** ISO 639-1 language of the audio track, e.g. "en" (optional). */
  audioLang?: string;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
  /** Split VOB files after this many sectors (default just under 1 GiB; smaller values are for tests). */
  maxVobSectors?: number;
}

export interface Vobu {
  sector: number; // local sector inside the title's source file
  lastSector: number; // inclusive
  scr: number;
  sPts: number;
  ePts: number;
  seqEnd: boolean;
  refEnds: number[]; // local sectors where the 1st/2nd/3rd reference pictures end
  firstAudio: number; // local sector of the first audio pack, -1 if none
  hasVideo: boolean;
}

export interface ScannedTitle {
  sectors: number;
  vobus: Vobu[];
}

interface Cell {
  first: number; // vobu index (inclusive)
  last: number; // vobu index (inclusive)
}

/* ───────── helpers ───────── */

const PTS_PER_SEC = 90000;

function readPts(b: Buffer, o: number): number {
  return ((b[o] >> 1) & 0x07) * 2 ** 30 + ((b[o + 1] << 7) | (b[o + 2] >> 1)) * 2 ** 15 + ((b[o + 3] << 7) | (b[o + 4] >> 1));
}

function readScr(b: Buffer, o: number): number {
  // MPEG-2 pack header, SCR base (33 bits) starting at o+4
  const b4 = b[o + 4];
  const b5 = b[o + 5];
  const b6 = b[o + 6];
  const b7 = b[o + 7];
  const b8 = b[o + 8];
  return ((b4 >> 3) & 0x07) * 2 ** 30 + (b4 & 0x03) * 2 ** 28 + b5 * 2 ** 20 + ((b6 >> 3) & 0x1f) * 2 ** 15 + (b6 & 0x03) * 2 ** 13 + b7 * 2 ** 5 + ((b8 >> 3) & 0x1f);
}

const bcd = (n: number) => (((Math.floor(n / 10) % 10) << 4) | n % 10) & 0xff;

/** DVD time (BCD hh mm ss ff + frame-rate flag). */
export function dvdTime(seconds: number, ntsc: boolean): Buffer {
  const fps = ntsc ? 30 : 25;
  const totalFrames = Math.max(0, Math.round(seconds * (ntsc ? 30000 / 1001 : 25)));
  const f = totalFrames % fps;
  let s = Math.floor(totalFrames / fps);
  const h = Math.min(99, Math.floor(s / 3600));
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return Buffer.from([bcd(h), bcd(m), bcd(s), (ntsc ? 0xc0 : 0x40) | bcd(f)]);
}

function u32(b: Buffer, o: number, v: number): void {
  b.writeUInt32BE(v >>> 0, o);
}
function u16(b: Buffer, o: number, v: number): void {
  b.writeUInt16BE(v & 0xffff, o);
}

/* ───────── 1. scan a program stream into VOBUs ───────── */

const PIC_CLOSERS = new Set([0x00, 0xb3, 0xb7, 0xb8]);

export async function scanVob(file: string, signal?: AbortSignal, onProgress?: (p: number) => void): Promise<ScannedTitle> {
  const size = fs.statSync(file).size;
  if (size % SECTOR !== 0) throw new Error(`${path.basename(file)} is not sector aligned (not a DVD program stream)`);
  const totalSectors = size / SECTOR;
  const fd = fs.openSync(file, 'r');
  const vobus: Vobu[] = [];
  const chunkSectors = 512;
  const buf = Buffer.alloc(chunkSectors * SECTOR);

  let cur: Vobu | null = null;
  const maxPts = new Map<Vobu, number>();
  let videoPts: number[] = [];
  let es: { sector: number; data: Buffer }[] = [];

  const finish = (lastSector: number) => {
    if (!cur) return;
    cur.lastSector = lastSector;
    cur.hasVideo = videoPts.length > 0;
    cur.sPts = videoPts.length ? Math.min(...videoPts) : -1;
    maxPts.set(cur, videoPts.length ? Math.max(...videoPts) : -1);
    analyzePictures(cur, es);
    vobus.push(cur);
    cur = null;
    videoPts = [];
    es = [];
  };

  try {
    for (let base = 0; base < totalSectors; base += chunkSectors) {
      if (signal?.aborted) throw new Error('Canceled');
      const n = Math.min(chunkSectors, totalSectors - base);
      fs.readSync(fd, buf, 0, n * SECTOR, base * SECTOR);
      for (let i = 0; i < n; i++) {
        const s = base + i;
        const o = i * SECTOR;
        if (!(buf[o] === 0 && buf[o + 1] === 0 && buf[o + 2] === 1 && buf[o + 3] === 0xba)) {
          throw new Error(`Sector ${s} of ${path.basename(file)} has no pack header`);
        }
        const isNav =
          buf[o + 0x26] === 0 && buf[o + 0x27] === 0 && buf[o + 0x28] === 1 && buf[o + 0x29] === 0xbf && buf[o + 0x2c] === 0x00 &&
          buf[o + 0x400] === 0 && buf[o + 0x401] === 0 && buf[o + 0x402] === 1 && buf[o + 0x403] === 0xbf && buf[o + 0x406] === 0x01;
        if (isNav) {
          finish(s - 1);
          cur = { sector: s, lastSector: s, scr: readScr(buf, o), sPts: -1, ePts: -1, seqEnd: false, refEnds: [], firstAudio: -1, hasVideo: false };
          continue;
        }
        if (!cur) throw new Error(`${path.basename(file)} does not start with a navigation pack (was it written with -f dvd?)`);
        let p = o + 14 + (buf[o + 13] & 0x07);
        const end = o + SECTOR;
        while (p + 6 <= end) {
          if (!(buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1)) break;
          const id = buf[p + 3];
          const len = (buf[p + 4] << 8) | buf[p + 5];
          const next = p + 6 + len;
          if (id >= 0xe0 && id <= 0xef) {
            const flags = buf[p + 7];
            const hdr = buf[p + 8];
            if (flags & 0x80) videoPts.push(readPts(buf, p + 9));
            const start = p + 9 + hdr;
            if (next > start) es.push({ sector: s, data: Buffer.from(buf.subarray(start, Math.min(next, end))) });
          } else if (id === 0xbd) {
            const hdr = buf[p + 8];
            const sub = buf[p + 9 + hdr];
            if (sub >= 0x80 && sub <= 0xaf && cur.firstAudio < 0) cur.firstAudio = s;
          } else if (id >= 0xc0 && id <= 0xdf) {
            if (cur.firstAudio < 0) cur.firstAudio = s;
          }
          p = next;
        }
      }
      onProgress?.(Math.min(1, (base + n) / totalSectors));
    }
    finish(totalSectors - 1);
  } finally {
    fs.closeSync(fd);
  }

  if (!vobus.length) throw new Error(`${path.basename(file)} contains no navigation packs`);
  // end times: next VOBU's start, last one = last picture + one frame
  const frame = guessFrameDuration(vobus);
  for (let i = 0; i < vobus.length; i++) {
    const v = vobus[i];
    if (v.sPts < 0) v.sPts = i > 0 ? vobus[i - 1].ePts : 0;
  }
  for (let i = 0; i < vobus.length; i++) {
    const v = vobus[i];
    const nxt = vobus.slice(i + 1).find((x) => x.hasVideo);
    v.ePts = nxt ? nxt.sPts : Math.max(v.sPts, maxPts.get(v) ?? -1) + frame;
  }
  return { sectors: totalSectors, vobus };
}

function guessFrameDuration(vobus: Vobu[]): number {
  // GOP of 15 frames at 25 fps = 0.6 s; 18 frames at 29.97 = 0.6006 s
  const withVideo = vobus.filter((v) => v.hasVideo);
  if (withVideo.length >= 2) {
    const gop = withVideo[1].sPts - withVideo[0].sPts;
    if (Math.abs(gop - 15 * 3600) < 200) return 3600;
    if (Math.abs(gop - 18 * 3003) < 200) return 3003;
  }
  return 3600;
}

/** Find where the first three reference (I/P) pictures of a VOBU end and whether it has a sequence end. */
function analyzePictures(v: Vobu, chunks: { sector: number; data: Buffer }[]): void {
  if (!chunks.length) return;
  const all = Buffer.concat(chunks.map((c) => c.data));
  const offs: number[] = [];
  let acc = 0;
  for (const c of chunks) {
    offs.push(acc);
    acc += c.data.length;
  }
  const sectorAt = (pos: number): number => {
    let lo = 0;
    let hi = offs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return chunks[lo].sector;
  };
  const marker = Buffer.from([0, 0, 1]);
  let open: { type: number } | null = null;
  let i = all.indexOf(marker, 0);
  while (i >= 0 && i + 3 < all.length) {
    const code = all[i + 3];
    if (PIC_CLOSERS.has(code)) {
      if (open) {
        if ((open.type === 1 || open.type === 2) && v.refEnds.length < 3) v.refEnds.push(sectorAt(Math.max(0, i - 1)));
        open = null;
      }
      if (code === 0x00 && i + 5 < all.length) open = { type: (all[i + 5] >> 3) & 0x07 };
      if (code === 0xb7) v.seqEnd = true;
    }
    i = all.indexOf(marker, i + 3);
  }
  if (open && (open.type === 1 || open.type === 2) && v.refEnds.length < 3) v.refEnds.push(chunks[chunks.length - 1].sector);
}

/* ───────── 2. cells (chapters) ───────── */

export function makeCells(vobus: Vobu[], interval: number): Cell[] {
  const cells: Cell[] = [];
  let first = 0;
  const t0 = vobus[0].sPts;
  const total = (vobus[vobus.length - 1].ePts - t0) / PTS_PER_SEC;
  if (interval > 0) {
    let k = 1;
    for (let i = 1; i < vobus.length; i++) {
      const t = (vobus[i].sPts - t0) / PTS_PER_SEC;
      // don't create a tiny last chapter
      if (t >= k * interval && total - t > Math.min(30, interval / 4) && vobus[i].hasVideo) {
        cells.push({ first, last: i - 1 });
        first = i;
        while (t >= k * interval) k++;
        if (cells.length >= 98) break; // max 99 chapters per title
      }
    }
  }
  cells.push({ first, last: vobus.length - 1 });
  return cells;
}

/* ───────── 3. author ───────── */

interface TitleLayout {
  base: number; // first VTS-relative sector of this title
  scan: ScannedTitle;
  cells: Cell[];
}

export interface AuthorResult {
  videoTsDir: string;
  titles: { chapters: number; duration: number; sectors: number }[];
  vobFiles: string[];
  totalBytes: number;
}

export async function authorDvd(opts: DvdAuthorOptions): Promise<AuthorResult> {
  const ntsc = opts.standard === 'ntsc';
  if (!opts.titles.length) throw new Error('No titles to author');
  if (opts.titles.length > 99) throw new Error('A DVD can hold at most 99 titles');

  // scan (first 40 % of progress)
  const layouts: TitleLayout[] = [];
  let base = 0;
  for (let t = 0; t < opts.titles.length; t++) {
    const scan = await scanVob(opts.titles[t].vobPath, opts.signal, (p) => opts.onProgress?.(((t + p) / opts.titles.length) * 0.4));
    const cells = makeCells(scan.vobus, opts.titles[t].chapterInterval);
    layouts.push({ base, scan, cells });
    base += scan.sectors;
  }
  const vobSectors = base;

  const videoTs = path.join(opts.outDir, 'VIDEO_TS');
  fs.mkdirSync(videoTs, { recursive: true });
  fs.mkdirSync(path.join(opts.outDir, 'AUDIO_TS'), { recursive: true });
  for (const f of fs.readdirSync(videoTs)) fs.rmSync(path.join(videoTs, f), { force: true });

  // write patched VOBs (40 % → 95 %)
  const vobFiles = await writeVobs(layouts, videoTs, ntsc, opts, (p) => opts.onProgress?.(0.4 + p * 0.55));

  // IFOs
  const vts = buildVtsIfo(layouts, ntsc, opts, vobSectors);
  fs.writeFileSync(path.join(videoTs, 'VTS_01_0.IFO'), vts);
  fs.writeFileSync(path.join(videoTs, 'VTS_01_0.BUP'), vts);
  const vmg = buildVmgIfo(layouts, ntsc, opts, vts.length / SECTOR, vobSectors);
  fs.writeFileSync(path.join(videoTs, 'VIDEO_TS.IFO'), vmg);
  fs.writeFileSync(path.join(videoTs, 'VIDEO_TS.BUP'), vmg);
  opts.onProgress?.(1);

  return {
    videoTsDir: videoTs,
    titles: layouts.map((l) => ({
      chapters: l.cells.length,
      duration: (l.scan.vobus[l.scan.vobus.length - 1].ePts - l.scan.vobus[0].sPts) / PTS_PER_SEC,
      sectors: l.scan.sectors,
    })),
    vobFiles,
    totalBytes: (vobSectors + 2 * (vts.length / SECTOR) + 2 * (vmg.length / SECTOR)) * SECTOR,
  };
}

/* ───────── NAV pack patching ───────── */

const FWD = [240, 120, 60, 20, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]; // half seconds
const END_OF_CELL = 0x3fffffff;

function patchNav(sec: Buffer, o: number, L: TitleLayout, titleIdx: number, vi: number, ntsc: boolean): void {
  const vobus = L.scan.vobus;
  const v = vobus[vi];
  const cellIdx = L.cells.findIndex((c) => vi >= c.first && vi <= c.last);
  const cell = L.cells[cellIdx];
  const cellStart = vobus[cell.first].sPts;
  const lbn = L.base + v.sector;
  const eltm = dvdTime(Math.max(0, v.sPts - cellStart) / PTS_PER_SEC, ntsc);

  // ── PCI (data starts at 0x2D)
  sec.fill(0, o + 0x2d, o + 0x400);
  u32(sec, o + 0x2d, lbn); // nv_pck_lbn
  u32(sec, o + 0x39, v.sPts); // vobu_s_ptm
  u32(sec, o + 0x3d, v.ePts); // vobu_e_ptm
  u32(sec, o + 0x41, v.seqEnd ? v.ePts : 0); // vobu_se_e_ptm
  eltm.copy(sec, o + 0x45); // e_eltm

  // ── DSI (data starts at 0x407)
  sec.fill(0, o + 0x407, o + SECTOR);
  u32(sec, o + 0x407, v.scr); // nv_pck_scr
  u32(sec, o + 0x40b, lbn); // nv_pck_lbn
  u32(sec, o + 0x40f, v.lastSector - v.sector); // vobu_ea
  for (let k = 0; k < 3; k++) u32(sec, o + 0x413 + k * 4, v.refEnds[k] !== undefined ? v.refEnds[k] - v.sector : 0);
  u16(sec, o + 0x41f, titleIdx + 1); // vobu_vob_idn
  sec[o + 0x422] = cellIdx + 1; // vobu_c_idn
  eltm.copy(sec, o + 0x423); // c_eltm
  // sml_pbi: VOB start / end presentation times
  u32(sec, o + 0x427 + 12, vobus[0].sPts);
  u32(sec, o + 0x427 + 16, vobus[vobus.length - 1].ePts);
  // vobu_sri (search information), restricted to the current cell
  const sri = o + 0x4f1;
  const rel = (k: number) => (0x80000000 | (Math.abs(vobus[k].sector - v.sector) & 0x3fffffff)) >>> 0;
  u32(sec, sri, vi < cell.last ? rel(vi + 1) : END_OF_CELL); // next_video
  FWD.forEach((half, j) => {
    const target = v.sPts + half * 45000;
    let found = -1;
    for (let k = vi + 1; k <= cell.last; k++) {
      if (vobus[k].sPts >= target) {
        found = k;
        break;
      }
    }
    u32(sec, sri + 4 + j * 4, found >= 0 ? rel(found) : END_OF_CELL);
  });
  u32(sec, sri + 80, vi < cell.last ? rel(vi + 1) : END_OF_CELL); // next_vobu
  u32(sec, sri + 84, vi > cell.first ? rel(vi - 1) : END_OF_CELL); // prev_vobu
  const BWD = [...FWD].reverse();
  BWD.forEach((half, j) => {
    const target = v.sPts - half * 45000;
    let found = -1;
    for (let k = vi - 1; k >= cell.first; k--) {
      if (vobus[k].sPts <= target) {
        found = k;
        break;
      }
    }
    u32(sec, sri + 88 + j * 4, found >= 0 ? rel(found) : END_OF_CELL);
  });
  u32(sec, sri + 164, vi > cell.first ? rel(vi - 1) : END_OF_CELL); // prev_video
  // synci: first audio pack of stream 0
  u16(sec, o + 0x599, v.firstAudio >= 0 ? v.firstAudio - v.sector : 0x3fff);
}

async function writeVobs(layouts: TitleLayout[], dir: string, ntsc: boolean, opts: DvdAuthorOptions, onProgress: (p: number) => void): Promise<string[]> {
  const total = layouts.reduce((s, l) => s + l.scan.sectors, 0);
  const files: string[] = [];
  let outFd = -1;
  let outSectors = 0;
  let fileNo = 0;
  const maxSectors = opts.maxVobSectors ?? MAX_VOB_SECTORS;
  const openNext = () => {
    if (outFd >= 0) fs.closeSync(outFd);
    fileNo++;
    if (fileNo > 9) throw new Error('Too much video for one DVD title set');
    const f = path.join(dir, `VTS_01_${fileNo}.VOB`);
    files.push(f);
    outFd = fs.openSync(f, 'w');
    outSectors = 0;
  };
  openNext();
  const chunk = 512;
  const buf = Buffer.alloc(chunk * SECTOR);
  let done = 0;
  try {
    for (let t = 0; t < layouts.length; t++) {
      const L = layouts[t];
      const navIndex = new Map<number, number>();
      L.scan.vobus.forEach((v, i) => navIndex.set(v.sector, i));
      const inFd = fs.openSync(opts.titles[t].vobPath, 'r');
      try {
        for (let s = 0; s < L.scan.sectors; s += chunk) {
          if (opts.signal?.aborted) throw new Error('Canceled');
          const n = Math.min(chunk, L.scan.sectors - s);
          fs.readSync(inFd, buf, 0, n * SECTOR, s * SECTOR);
          for (let i = 0; i < n; i++) {
            const vi = navIndex.get(s + i);
            if (vi !== undefined) patchNav(buf, i * SECTOR, L, t, vi, ntsc);
          }
          // write, splitting VOB files at the 1 GiB limit
          let written = 0;
          while (written < n) {
            if (outSectors >= maxSectors) openNext();
            const take = Math.min(n - written, maxSectors - outSectors);
            fs.writeSync(outFd, buf, written * SECTOR, take * SECTOR);
            written += take;
            outSectors += take;
          }
          done += n;
          onProgress(done / total);
        }
      } finally {
        fs.closeSync(inFd);
      }
    }
  } finally {
    if (outFd >= 0) fs.closeSync(outFd);
  }
  return files;
}

/* ───────── IFO writing ───────── */

function videoAttr(opts: DvdAuthorOptions): Buffer {
  const pal = opts.standard === 'pal';
  const wide = opts.aspect === '16:9';
  // mpeg2 | format | aspect | permitted display formats (16:9 → letterbox only, 4:3 → n/a)
  const b0 = (1 << 6) | ((pal ? 1 : 0) << 4) | ((wide ? 3 : 0) << 2) | (wide ? 2 : 3);
  return Buffer.from([b0, 0x00]);
}

function audioAttr(lang?: string): Buffer {
  const b = Buffer.alloc(8);
  const hasLang = !!lang && /^[a-z]{2}$/i.test(lang);
  b[0] = (0 << 5) | ((hasLang ? 1 : 0) << 2); // AC-3, language present
  b[1] = (3 << 6) | (0 << 4) | 1; // DRC, 48 kHz, 2 channels
  if (hasLang) {
    b[2] = lang!.toLowerCase().charCodeAt(0);
    b[3] = lang!.toLowerCase().charCodeAt(1);
  }
  return b;
}

const align = (n: number) => Math.ceil(n / SECTOR) * SECTOR;

function cmdJumpVtsTt(ttn: number): Buffer {
  return Buffer.from([0x30, 0x03, 0, 0, 0, ttn, 0, 0]);
}
function cmdJumpTt(ttn: number): Buffer {
  return Buffer.from([0x30, 0x02, 0, 0, 0, ttn, 0, 0]);
}
const CMD_EXIT = Buffer.from([0x30, 0x01, 0, 0, 0, 0, 0, 0]);

/** Default 16-colour subpicture palette (Y Cr Cb). */
const PALETTE = [
  0x108080, 0xeb8080, 0x51f05a, 0x2a6ef0, 0x907f22, 0xd292a6, 0x6edd48, 0xa9a29b, 0x808080, 0x5c8080, 0xc08080, 0x316e71, 0x9e3a7c, 0x4ab45c, 0xc8a050, 0x10b0b0,
];

function buildPgc(opts: { pre: Buffer[]; post: Buffer[]; cells?: { playback: Buffer; vobId: number; cellNr: number }[]; playbackTime?: Buffer; audio: boolean }): Buffer {
  const cells = opts.cells ?? [];
  const nCmds = opts.pre.length + opts.post.length;
  const cmdSize = 8 + 8 * nCmds;
  const progSize = cells.length ? cells.length + (cells.length % 2) : 0;
  const size = 236 + cmdSize + progSize + 24 * cells.length + 4 * cells.length;
  const b = Buffer.alloc(size);
  b[2] = cells.length; // programs (one per cell / chapter)
  b[3] = cells.length; // cells
  (opts.playbackTime ?? Buffer.alloc(4)).copy(b, 4);
  if (opts.audio) u16(b, 12, 0x8000); // audio stream 0 available → decoding stream 0
  PALETTE.forEach((c, i) => u32(b, 0xa4 + i * 4, c));
  let off = 236;
  u16(b, 0xe4, off); // command table
  u16(b, off, opts.pre.length);
  u16(b, off + 2, opts.post.length);
  u16(b, off + 4, 0);
  u16(b, off + 6, cmdSize - 1);
  [...opts.pre, ...opts.post].forEach((c, i) => c.copy(b, off + 8 + i * 8));
  off += cmdSize;
  if (cells.length) {
    u16(b, 0xe6, off); // program map
    cells.forEach((_, i) => (b[off + i] = i + 1));
    off += progSize;
    u16(b, 0xe8, off); // cell playback
    cells.forEach((c, i) => c.playback.copy(b, off + i * 24));
    off += 24 * cells.length;
    u16(b, 0xea, off); // cell position
    cells.forEach((c, i) => {
      u16(b, off + i * 4, c.vobId);
      b[off + i * 4 + 3] = c.cellNr;
    });
  }
  return b;
}

function buildVtsIfo(layouts: TitleLayout[], ntsc: boolean, opts: DvdAuthorOptions, vobSectors: number): Buffer {
  const T = layouts.length;

  // ── VTS_PTT_SRPT
  const pttCounts = layouts.map((l) => l.cells.length);
  const pttSize = 8 + 4 * T + 4 * pttCounts.reduce((a, b) => a + b, 0);
  const ptt = Buffer.alloc(align(pttSize));
  u16(ptt, 0, T);
  u32(ptt, 4, pttSize - 1);
  let p = 8 + 4 * T;
  layouts.forEach((l, t) => {
    u32(ptt, 8 + 4 * t, p);
    l.cells.forEach((_, j) => {
      u16(ptt, p, t + 1); // pgcn
      u16(ptt, p + 2, j + 1); // pgn
      p += 4;
    });
  });

  // ── VTS_PGCIT
  const pgcs = layouts.map((l, t) => {
    const v = l.scan.vobus;
    const cells = l.cells.map((c, j) => {
      const pb = Buffer.alloc(24);
      pb[0] = j === 0 ? 0x02 : 0x08; // first cell: STC discontinuity; others: seamless
      dvdTime((v[c.last].ePts - v[c.first].sPts) / PTS_PER_SEC, ntsc).copy(pb, 4);
      u32(pb, 8, l.base + v[c.first].sector);
      u32(pb, 12, 0);
      u32(pb, 16, l.base + v[c.last].sector);
      u32(pb, 20, l.base + v[c.last].lastSector);
      return { playback: pb, vobId: t + 1, cellNr: j + 1 };
    });
    return buildPgc({
      pre: [],
      post: [t < T - 1 ? cmdJumpVtsTt(t + 2) : CMD_EXIT],
      cells,
      playbackTime: dvdTime((v[v.length - 1].ePts - v[0].sPts) / PTS_PER_SEC, ntsc),
      audio: true,
    });
  });
  const pgcitSize = 8 + 8 * T + pgcs.reduce((a, b) => a + b.length, 0);
  const pgcit = Buffer.alloc(align(pgcitSize));
  u16(pgcit, 0, T);
  u32(pgcit, 4, pgcitSize - 1);
  p = 8 + 8 * T;
  pgcs.forEach((pg, t) => {
    pgcit[8 + 8 * t] = 0x80 | (t + 1); // entry PGC of title t+1
    u32(pgcit, 8 + 8 * t + 4, p);
    pg.copy(pgcit, p);
    p += pg.length;
  });

  // ── VTS_TMAPT (time map for time search)
  const maps = layouts.map((l) => {
    const v = l.scan.vobus;
    const dur = (v[v.length - 1].ePts - v[0].sPts) / PTS_PER_SEC;
    const tmu = Math.max(1, Math.ceil(dur / 2048));
    const entries: number[] = [];
    for (let k = 1; k * tmu < dur; k++) {
      const target = v[0].sPts + k * tmu * PTS_PER_SEC;
      let idx = 0;
      for (let i = 0; i < v.length && v[i].sPts <= target; i++) idx = i;
      entries.push(l.base + v[idx].sector);
    }
    const b = Buffer.alloc(4 + 4 * entries.length);
    b[0] = tmu;
    u16(b, 2, entries.length);
    entries.forEach((e, i) => u32(b, 4 + 4 * i, e));
    return b;
  });
  const tmapSize = 8 + 4 * T + maps.reduce((a, b) => a + b.length, 0);
  const tmapt = Buffer.alloc(align(tmapSize));
  u16(tmapt, 0, T);
  u32(tmapt, 4, tmapSize - 1);
  p = 8 + 4 * T;
  maps.forEach((m, t) => {
    u32(tmapt, 8 + 4 * t, p);
    m.copy(tmapt, p);
    p += m.length;
  });

  // ── VTS_C_ADT
  const allCells = layouts.flatMap((l, t) =>
    l.cells.map((c, j) => ({ vob: t + 1, cell: j + 1, start: l.base + l.scan.vobus[c.first].sector, last: l.base + l.scan.vobus[c.last].lastSector })),
  );
  const cadtSize = 8 + 12 * allCells.length;
  const cadt = Buffer.alloc(align(cadtSize));
  u16(cadt, 0, T);
  u32(cadt, 4, cadtSize - 1);
  allCells.forEach((c, i) => {
    const o = 8 + 12 * i;
    u16(cadt, o, c.vob);
    cadt[o + 2] = c.cell;
    u32(cadt, o + 4, c.start);
    u32(cadt, o + 8, c.last);
  });

  // ── VTS_VOBU_ADMAP
  const vobuSectors = layouts.flatMap((l) => l.scan.vobus.map((v) => l.base + v.sector));
  const admapSize = 4 + 4 * vobuSectors.length;
  const admap = Buffer.alloc(align(admapSize));
  u32(admap, 0, admapSize - 1);
  vobuSectors.forEach((s, i) => u32(admap, 4 + 4 * i, s));

  // ── VTSI_MAT
  const mat = Buffer.alloc(SECTOR);
  const tables = [ptt, pgcit, tmapt, cadt, admap];
  let sector = 1;
  const at: number[] = [];
  for (const tb of tables) {
    at.push(sector);
    sector += tb.length / SECTOR;
  }
  const ifoSectors = sector;
  mat.write('DVDVIDEO-VTS', 0, 'ascii');
  u32(mat, 0x0c, 2 * ifoSectors + vobSectors - 1); // vts_last_sector
  u32(mat, 0x1c, ifoSectors - 1); // vtsi_last_sector
  mat[0x21] = 0x11; // spec version 1.1
  u32(mat, 0x80, 0x3d7); // vtsi_last_byte
  u32(mat, 0xc0, 0); // no menu VOB
  u32(mat, 0xc4, ifoSectors); // title VOBs start right after the IFO
  u32(mat, 0xc8, at[0]);
  u32(mat, 0xcc, at[1]);
  u32(mat, 0xd0, 0);
  u32(mat, 0xd4, at[2]);
  u32(mat, 0xd8, 0);
  u32(mat, 0xdc, 0);
  u32(mat, 0xe0, at[3]);
  u32(mat, 0xe4, at[4]);
  videoAttr(opts).copy(mat, 0x100); // menu video attributes (no menu, but keep consistent)
  videoAttr(opts).copy(mat, 0x200);
  mat[0x203] = 1; // one audio stream
  audioAttr(opts.audioLang).copy(mat, 0x204);
  mat[0x255] = 0; // no subpictures

  return Buffer.concat([mat, ...tables]);
}

function buildVmgIfo(layouts: TitleLayout[], ntsc: boolean, opts: DvdAuthorOptions, vtsIfoSectors: number, vobSectors: number): Buffer {
  const T = layouts.length;
  const vmgIfoSectors = 3;
  const vmgLastSector = 2 * vmgIfoSectors - 1;

  // First-Play PGC: start title 1
  const fp = buildPgc({ pre: [cmdJumpTt(1)], post: [], audio: false });

  const mat = Buffer.alloc(SECTOR);
  mat.write('DVDVIDEO-VMG', 0, 'ascii');
  u32(mat, 0x0c, vmgLastSector);
  u32(mat, 0x1c, vmgIfoSectors - 1);
  mat[0x21] = 0x11;
  u32(mat, 0x22, 0); // vmg_category: region free
  u16(mat, 0x26, 1); // volumes
  u16(mat, 0x28, 1); // this volume
  mat[0x2a] = 1; // side
  u16(mat, 0x3e, 1); // title sets
  mat.write('KINOMILL'.padEnd(32, ' '), 0x40, 'ascii');
  u32(mat, 0x80, 0x400 + fp.length - 1); // vmgi_last_byte
  u32(mat, 0x84, 0x400); // first play PGC
  u32(mat, 0xc0, 0); // no menu VOB
  u32(mat, 0xc4, 1); // TT_SRPT
  u32(mat, 0xc8, 0);
  u32(mat, 0xcc, 0);
  u32(mat, 0xd0, 2); // VTS_ATRT
  videoAttr(opts).copy(mat, 0x100);
  fp.copy(mat, 0x400);

  // TT_SRPT
  const tt = Buffer.alloc(SECTOR);
  u16(tt, 0, T);
  u32(tt, 4, 8 + 12 * T - 1);
  layouts.forEach((l, t) => {
    const o = 8 + 12 * t;
    tt[o] = 0x14; // jump/link/call in pre/post commands and title domain
    tt[o + 1] = 1; // angles
    u16(tt, o + 2, l.cells.length); // chapters
    u16(tt, o + 4, 0); // parental mask
    tt[o + 6] = 1; // title set 1
    tt[o + 7] = t + 1; // title number inside the title set
    u32(tt, o + 8, vmgLastSector + 1); // VTS start sector (relative to VIDEO_TS.IFO)
  });

  // VTS_ATRT
  const atrt = Buffer.alloc(SECTOR);
  const attrLen = 0x308;
  u16(atrt, 0, 1);
  u32(atrt, 4, 8 + 4 + attrLen - 1);
  u32(atrt, 8, 12);
  const a = 12;
  u32(atrt, a, attrLen - 1);
  u32(atrt, a + 4, 0);
  videoAttr(opts).copy(atrt, a + 8);
  videoAttr(opts).copy(atrt, a + 264);
  atrt[a + 267] = 1;
  audioAttr(opts.audioLang).copy(atrt, a + 268);

  void vtsIfoSectors;
  void vobSectors;
  void ntsc;
  return Buffer.concat([mat, tt, atrt]);
}

/** Total VOB bytes that fit on a disc after leaving room for IFOs and the file system. */
export function discCapacityBytes(size: 'dvd5' | 'dvd9'): number {
  return size === 'dvd9' ? 8_500_000_000 : 4_700_000_000;
}
