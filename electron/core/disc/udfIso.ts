// Writes a UDF 1.02 + ISO 9660 "bridge" image — the format DVD-Video discs use.
// Unlike generic ISO tools, file data is laid out exactly in the order given,
// which DVD players require (VIDEO_TS.IFO, VIDEO_TS.BUP, VTS_01_0.IFO,
// VTS_01_1.VOB …, VTS_01_0.BUP, all contiguous).
// References: ECMA-119 (ISO 9660), ECMA-167 + OSTA UDF 1.02.
import fs from 'node:fs';
import path from 'node:path';

const S = 2048;

export interface IsoFile {
  /** Name inside the image (ISO 9660 level 1 compatible, e.g. "VIDEO_TS.IFO"). */
  name: string;
  /** Source file on disk. */
  source: string;
}

export interface IsoDir {
  name: string;
  files: IsoFile[]; // file data is written in this order
  dirs: IsoDir[];
}

export interface IsoOptions {
  volumeLabel: string;
  root: IsoDir;
  out: string;
  onProgress?: (p: number) => void;
  signal?: AbortSignal;
}

/* ───────── low level helpers ───────── */

const crcTable = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

export function crc16(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ crcTable[((crc >> 8) ^ b) & 0xff]) & 0xffff;
  return crc;
}

/** Fill in a UDF descriptor tag (first 16 bytes of `d`). */
function tag(d: Buffer, id: number, location: number, crcLen = d.length - 16, serial = 1): Buffer {
  d.writeUInt16LE(id, 0);
  d.writeUInt16LE(2, 2); // descriptor version (NSR02)
  d[5] = 0;
  d.writeUInt16LE(serial, 6);
  d.writeUInt16LE(crc16(d.subarray(16, 16 + crcLen)), 8);
  d.writeUInt16LE(crcLen, 10);
  d.writeUInt32LE(location >>> 0, 12);
  let sum = 0;
  for (let i = 0; i < 16; i++) if (i !== 4) sum += d[i];
  d[4] = sum & 0xff;
  return d;
}

function charspec(d: Buffer, o: number): void {
  d[o] = 0;
  d.write('OSTA Compressed Unicode', o + 1, 'ascii');
}

/** Fixed-length dstring in 8-bit compressed unicode. */
function dstring(d: Buffer, o: number, len: number, s: string): void {
  const txt = s.slice(0, len - 2);
  if (!txt.length) return;
  d[o] = 8;
  d.write(txt, o + 1, 'latin1');
  d[o + len - 1] = txt.length + 1;
}

function regid(d: Buffer, o: number, ident: string, suffix: number[] = []): void {
  d[o] = 0;
  d.write(ident, o + 1, 'ascii');
  suffix.forEach((b, i) => (d[o + 24 + i] = b));
}

const UDF_REV = [0x02, 0x01]; // 0x0102 little endian
const DOMAIN = (d: Buffer, o: number) => regid(d, o, '*OSTA UDF Compliant', [...UDF_REV, 0x03]);
const IMPL = (d: Buffer, o: number) => regid(d, o, '*Kinomill', [0x00, 0x00]);

function timestamp(d: Buffer, o: number, t: Date): void {
  const tz = -t.getTimezoneOffset();
  d.writeUInt16LE(0x1000 | (tz & 0x0fff), o);
  d.writeInt16LE(t.getFullYear(), o + 2);
  d[o + 4] = t.getMonth() + 1;
  d[o + 5] = t.getDate();
  d[o + 6] = t.getHours();
  d[o + 7] = t.getMinutes();
  d[o + 8] = t.getSeconds();
}

function both32(d: Buffer, o: number, v: number): void {
  d.writeUInt32LE(v >>> 0, o);
  d.writeUInt32BE(v >>> 0, o + 4);
}
function both16(d: Buffer, o: number, v: number): void {
  d.writeUInt16LE(v, o);
  d.writeUInt16BE(v, o + 2);
}

function isoDate7(d: Buffer, o: number, t: Date): void {
  d[o] = t.getFullYear() - 1900;
  d[o + 1] = t.getMonth() + 1;
  d[o + 2] = t.getDate();
  d[o + 3] = t.getHours();
  d[o + 4] = t.getMinutes();
  d[o + 5] = t.getSeconds();
  d[o + 6] = (-t.getTimezoneOffset() / 15) & 0xff;
}

function isoDate17(t: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getFullYear(), 4)}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}00`;
}

const blocks = (bytes: number) => Math.max(0, Math.ceil(bytes / S));

/* ───────── layout ───────── */

interface FNode {
  file: IsoFile;
  size: number;
  isoLba: number; // absolute
  feLb: number; // partition relative
  uid: number;
}
interface DNode {
  dir: IsoDir;
  parent: DNode | null;
  files: FNode[];
  dirs: DNode[];
  isoLba: number;
  isoSize: number;
  feLb: number;
  fidLb: number;
  fidBytes: number;
  pathIndex: number;
  uid: number;
}

function isoName(n: string, isDir: boolean): string {
  const up = n.toUpperCase();
  if (!/^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{0,3})?$/.test(up)) throw new Error(`"${n}" is not a valid ISO 9660 level 1 name`);
  return isDir ? up : `${up};1`;
}

function dirRecord(name: Buffer, lba: number, size: number, isDir: boolean, t: Date): Buffer {
  const len = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
  const r = Buffer.alloc(len);
  r[0] = len;
  both32(r, 2, lba);
  both32(r, 10, size);
  isoDate7(r, 18, t);
  r[25] = isDir ? 2 : 0;
  both16(r, 28, 1);
  r[32] = name.length;
  name.copy(r, 33);
  return r;
}

function fidSize(nameLen: number): number {
  const l = 38 + (nameLen ? nameLen + 1 : 0);
  return (l + 3) & ~3;
}

export async function writeUdfIso(opts: IsoOptions): Promise<void> {
  const now = new Date();
  let uid = 16;

  // build tree
  const mk = (dir: IsoDir, parent: DNode | null): DNode => {
    const node: DNode = { dir, parent, files: [], dirs: [], isoLba: 0, isoSize: 0, feLb: 0, fidLb: 0, fidBytes: 0, pathIndex: 0, uid: parent ? uid++ : 0 };
    node.files = dir.files.map((f) => {
      const st = fs.statSync(f.source);
      if (st.size > 0x3fffffff * 4 - 1) throw new Error(`${f.name} is too large for an ISO image`);
      return { file: f, size: st.size, isoLba: 0, feLb: 0, uid: uid++ };
    });
    node.dirs = dir.dirs.map((d) => mk(d, node));
    return node;
  };
  const root = mk(opts.root, null);

  // directory order for path tables: breadth first, sorted by name
  const ordered: DNode[] = [];
  const queue: DNode[] = [root];
  while (queue.length) {
    const d = queue.shift()!;
    ordered.push(d);
    d.pathIndex = ordered.length; // 1-based
    queue.push(...[...d.dirs].sort((a, b) => (a.dir.name < b.dir.name ? -1 : 1)));
  }

  // ISO directory extents sizes
  for (const d of ordered) {
    let bytes = 0;
    let used = 0;
    const add = (recLen: number) => {
      if (used + recLen > S) {
        bytes += S;
        used = 0;
      }
      used += recLen;
    };
    add(34);
    add(34);
    for (const c of d.dirs) add(33 + isoName(c.dir.name, true).length + (isoName(c.dir.name, true).length % 2 === 0 ? 1 : 0));
    for (const f of d.files) {
      const n = isoName(f.file.name, false).length;
      add(33 + n + (n % 2 === 0 ? 1 : 0));
    }
    d.isoSize = bytes + S;
  }

  // path tables
  const ptEntries = ordered.map((d) => {
    const id = d.parent ? Buffer.from(isoName(d.dir.name, true), 'ascii') : Buffer.from([0]);
    return { d, id };
  });
  const ptSize = ptEntries.reduce((s, e) => s + 8 + e.id.length + (e.id.length % 2), 0);
  const ptSectors = blocks(ptSize);

  // absolute layout
  let next = 257;
  const lPath = next;
  next += ptSectors;
  const mPath = next;
  next += ptSectors;
  for (const d of ordered) {
    d.isoLba = next;
    next += d.isoSize / S;
  }
  const P = next; // UDF partition start
  let lb = 0;
  const fsdLb = lb++;
  const fsdTermLb = lb++;
  // FEs + FID blocks for directories (depth first), FEs for files
  const walk = (d: DNode) => {
    d.feLb = lb++;
    d.fidBytes = fidSize(0) + d.dirs.reduce((s, c) => s + fidSize(c.dir.name.length), 0) + d.files.reduce((s, f) => s + fidSize(f.file.name.length), 0);
    d.fidLb = lb;
    lb += blocks(d.fidBytes);
    for (const f of d.files) f.feLb = lb++;
    d.dirs.forEach(walk);
  };
  walk(root);
  // file data in the given order (depth first, files in listed order)
  const dataOrder: FNode[] = [];
  const collect = (d: DNode) => {
    dataOrder.push(...d.files);
    d.dirs.forEach(collect);
  };
  collect(root);
  let dataLb = lb;
  for (const f of dataOrder) {
    f.isoLba = P + dataLb;
    dataLb += Math.max(1, blocks(f.size));
  }
  const lastAvdp = P + dataLb;
  const totalSectors = lastAvdp + 1;
  const partLen = lastAvdp - P;
  const totalBytes = dataOrder.reduce((s, f) => s + f.size, 0);

  /* ── build metadata sectors ── */
  const meta = new Map<number, Buffer>(); // absolute sector → 2048-byte buffer
  const sec = (n: number) => {
    let b = meta.get(n);
    if (!b) {
      b = Buffer.alloc(S);
      meta.set(n, b);
    }
    return b;
  };
  const label = opts.volumeLabel.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32) || 'DVD_VIDEO';

  // ISO 9660 PVD
  {
    const d = sec(16);
    d[0] = 1;
    d.write('CD001', 1, 'ascii');
    d[6] = 1;
    d.write(''.padEnd(32, ' '), 8, 'ascii');
    d.write(label.padEnd(32, ' '), 40, 'ascii');
    both32(d, 80, totalSectors);
    both16(d, 120, 1);
    both16(d, 124, 1);
    both16(d, 128, S);
    both32(d, 132, ptSize);
    d.writeUInt32LE(lPath, 140);
    d.writeUInt32BE(mPath, 148);
    dirRecord(Buffer.from([0]), root.isoLba, root.isoSize, true, now).copy(d, 156);
    d.write(''.padEnd(128 * 4 + 37 * 3, ' '), 190, 'ascii');
    d.write('KINOMILL'.padEnd(128, ' '), 574, 'ascii');
    const cd = isoDate17(now);
    d.write(cd, 813, 'ascii');
    d.write(cd, 830, 'ascii');
    d.write('0000000000000000', 847, 'ascii');
    d.write('0000000000000000', 864, 'ascii');
    d[881] = 1;
  }
  {
    const d = sec(17);
    d[0] = 255;
    d.write('CD001', 1, 'ascii');
    d[6] = 1;
  }
  // UDF volume recognition sequence
  ['BEA01', 'NSR02', 'TEA01'].forEach((id, i) => {
    const d = sec(18 + i);
    d[0] = 0;
    d.write(id, 1, 'ascii');
    d[6] = 1;
  });

  // ISO path tables
  {
    const l = Buffer.alloc(ptSectors * S);
    const m = Buffer.alloc(ptSectors * S);
    let o = 0;
    for (const e of ptEntries) {
      l[o] = m[o] = e.id.length;
      l.writeUInt32LE(e.d.isoLba, o + 2);
      m.writeUInt32BE(e.d.isoLba, o + 2);
      const parent = e.d.parent ? e.d.parent.pathIndex : 1;
      l.writeUInt16LE(parent, o + 6);
      m.writeUInt16BE(parent, o + 6);
      e.id.copy(l, o + 8);
      e.id.copy(m, o + 8);
      o += 8 + e.id.length + (e.id.length % 2);
    }
    for (let i = 0; i < ptSectors; i++) {
      l.copy(sec(lPath + i), 0, i * S, (i + 1) * S);
      m.copy(sec(mPath + i), 0, i * S, (i + 1) * S);
    }
  }
  // ISO directory records
  for (const d of ordered) {
    const buf = Buffer.alloc(d.isoSize);
    let o = 0;
    const put = (r: Buffer) => {
      if ((o % S) + r.length > S) o = Math.ceil(o / S) * S;
      r.copy(buf, o);
      o += r.length;
    };
    put(dirRecord(Buffer.from([0]), d.isoLba, d.isoSize, true, now));
    const par = d.parent ?? d;
    put(dirRecord(Buffer.from([1]), par.isoLba, par.isoSize, true, now));
    const entries: { name: string; rec: Buffer }[] = [
      ...d.dirs.map((c) => ({ name: isoName(c.dir.name, true), rec: dirRecord(Buffer.from(isoName(c.dir.name, true), 'ascii'), c.isoLba, c.isoSize, true, now) })),
      ...d.files.map((f) => ({ name: isoName(f.file.name, false), rec: dirRecord(Buffer.from(isoName(f.file.name, false), 'ascii'), f.isoLba, f.size, false, now) })),
    ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) put(e.rec);
    for (let i = 0; i < d.isoSize / S; i++) buf.copy(sec(d.isoLba + i), 0, i * S, (i + 1) * S);
  }

  // UDF anchor (256 and last sector)
  const avdp = (loc: number) => {
    const d = Buffer.alloc(512);
    d.writeUInt32LE(16 * S, 16);
    d.writeUInt32LE(32, 20);
    d.writeUInt32LE(16 * S, 24);
    d.writeUInt32LE(48, 28);
    return tag(d, 2, loc);
  };
  avdp(256).copy(sec(256));

  // volume descriptor sequence (main at 32, reserve at 48)
  const vds = (base: number) => {
    let n = 0;
    // Primary Volume Descriptor
    {
      const d = Buffer.alloc(512);
      d.writeUInt32LE(n++, 16);
      dstring(d, 24, 32, label);
      d.writeUInt16LE(1, 56);
      d.writeUInt16LE(1, 58);
      d.writeUInt16LE(2, 60);
      d.writeUInt16LE(2, 62);
      d.writeUInt32LE(1, 64);
      d.writeUInt32LE(1, 68);
      const vsid = (Date.now().toString(16).padStart(16, '0') + label).slice(0, 126);
      dstring(d, 72, 128, vsid);
      charspec(d, 200);
      charspec(d, 264);
      regid(d, 344, '*Kinomill');
      timestamp(d, 376, now);
      IMPL(d, 388);
      tag(d, 1, base).copy(sec(base));
    }
    // Implementation Use Volume Descriptor
    {
      const d = Buffer.alloc(512);
      d.writeUInt32LE(n++, 16);
      regid(d, 20, '*UDF LV Info', [...UDF_REV, 0x00]);
      charspec(d, 52);
      dstring(d, 116, 128, label);
      IMPL(d, 52 + 64 + 128 + 36 * 3);
      tag(d, 4, base + 1).copy(sec(base + 1));
    }
    // Partition Descriptor
    {
      const d = Buffer.alloc(512);
      d.writeUInt32LE(n++, 16);
      d.writeUInt16LE(1, 20); // allocated
      d.writeUInt16LE(0, 22); // partition number
      regid(d, 24, '+NSR02');
      d.writeUInt32LE(1, 184); // read only
      d.writeUInt32LE(P, 188);
      d.writeUInt32LE(partLen, 192);
      IMPL(d, 196);
      tag(d, 5, base + 2).copy(sec(base + 2));
    }
    // Logical Volume Descriptor
    {
      const d = Buffer.alloc(446);
      d.writeUInt32LE(n++, 16);
      charspec(d, 20);
      dstring(d, 84, 128, label);
      d.writeUInt32LE(S, 212);
      DOMAIN(d, 216);
      d.writeUInt32LE(S, 248); // FSD long_ad
      d.writeUInt32LE(fsdLb, 252);
      d.writeUInt16LE(0, 256);
      d.writeUInt32LE(6, 264); // map table length
      d.writeUInt32LE(1, 268); // one partition map
      IMPL(d, 272);
      d.writeUInt32LE(2 * S, 432); // integrity sequence extent
      d.writeUInt32LE(64, 436);
      d[440] = 1;
      d[441] = 6;
      d.writeUInt16LE(1, 442);
      d.writeUInt16LE(0, 444);
      tag(d, 6, base + 3).copy(sec(base + 3));
    }
    // Unallocated Space Descriptor
    {
      const d = Buffer.alloc(24);
      d.writeUInt32LE(n++, 16);
      tag(d, 7, base + 4).copy(sec(base + 4));
    }
    // Terminating Descriptor
    tag(Buffer.alloc(512), 8, base + 5).copy(sec(base + 5));
  };
  vds(32);
  vds(48);

  // Logical Volume Integrity Descriptor (+ terminator)
  {
    const d = Buffer.alloc(134);
    timestamp(d, 16, now);
    d.writeUInt32LE(1, 28); // closed
    d.writeBigUInt64LE(BigInt(uid), 40); // next unique id
    d.writeUInt32LE(1, 72);
    d.writeUInt32LE(46, 76);
    d.writeUInt32LE(0, 80); // free space
    d.writeUInt32LE(partLen, 84); // size
    IMPL(d, 88);
    d.writeUInt32LE(dataOrder.length, 120);
    d.writeUInt32LE(ordered.length, 124);
    d.writeUInt16LE(0x0102, 128);
    d.writeUInt16LE(0x0102, 130);
    d.writeUInt16LE(0x0102, 132);
    tag(d, 9, 64).copy(sec(64));
    tag(Buffer.alloc(512), 8, 65).copy(sec(65));
  }

  // File Set Descriptor (+ terminator)
  {
    const d = Buffer.alloc(512);
    timestamp(d, 16, now);
    d.writeUInt16LE(3, 28);
    d.writeUInt16LE(3, 30);
    d.writeUInt32LE(1, 32);
    d.writeUInt32LE(1, 36);
    charspec(d, 48);
    dstring(d, 112, 128, label);
    charspec(d, 240);
    dstring(d, 304, 32, label);
    d.writeUInt32LE(S, 400);
    d.writeUInt32LE(root.feLb, 404);
    DOMAIN(d, 416);
    tag(d, 256, fsdLb).copy(sec(P + fsdLb));
    tag(Buffer.alloc(512), 8, fsdTermLb).copy(sec(P + fsdTermLb));
  }

  // File Entries and directory contents
  const fileEntry = (loc: number, kind: 'dir' | 'file', size: number, extents: { lb: number; len: number }[], links: number, id: number) => {
    const d = Buffer.alloc(176 + 8 * extents.length);
    d.writeUInt32LE(0, 16);
    d.writeUInt16LE(4, 20); // strategy 4
    d.writeUInt16LE(1, 24); // max entries
    d[27] = kind === 'dir' ? 4 : 5;
    d.writeUInt16LE(0, 34); // short_ad allocation descriptors
    d.writeUInt32LE(0xffffffff, 36); // uid
    d.writeUInt32LE(0xffffffff, 40); // gid
    d.writeUInt32LE(0x14a5, 44); // r-x for everybody
    d.writeUInt16LE(links, 48);
    d.writeBigUInt64LE(BigInt(size), 56);
    d.writeBigUInt64LE(BigInt(extents.reduce((s, e) => s + blocks(e.len), 0)), 64);
    timestamp(d, 72, now);
    timestamp(d, 84, now);
    timestamp(d, 96, now);
    d.writeUInt32LE(1, 108);
    IMPL(d, 128);
    d.writeBigUInt64LE(BigInt(id), 160);
    d.writeUInt32LE(0, 168);
    d.writeUInt32LE(8 * extents.length, 172);
    extents.forEach((e, i) => {
      d.writeUInt32LE(e.len, 176 + i * 8);
      d.writeUInt32LE(e.lb, 180 + i * 8);
    });
    tag(d, 261, loc).copy(sec(P + loc));
  };
  const fid = (buf: Buffer, off: number, blockLb: number, name: string | null, feLb: number, flags: number) => {
    const n = name === null ? 0 : name.length + 1;
    const size = fidSize(name === null ? 0 : name.length);
    const d = Buffer.alloc(size);
    d.writeUInt16LE(1, 16);
    d[18] = flags;
    d[19] = n;
    d.writeUInt32LE(S, 20);
    d.writeUInt32LE(feLb, 24);
    d.writeUInt16LE(0, 28);
    d.writeUInt16LE(0, 36);
    if (name !== null) {
      d[38] = 8;
      d.write(name, 39, 'latin1');
    }
    tag(d, 257, blockLb).copy(buf, off);
    return size;
  };
  const splitExtents = (startLb: number, size: number) => {
    const max = 0x3ffff800; // largest extent that is a multiple of the block size
    const out: { lb: number; len: number }[] = [];
    let left = size;
    let lb2 = startLb;
    if (size === 0) return out;
    while (left > 0) {
      const len = Math.min(left, max);
      out.push({ lb: lb2, len });
      lb2 += blocks(len);
      left -= len;
    }
    return out;
  };
  const emitDir = (d: DNode) => {
    const buf = Buffer.alloc(blocks(d.fidBytes) * S);
    let o = 0;
    const blk = () => d.fidLb + Math.floor(o / S);
    o += fid(buf, o, blk(), null, (d.parent ?? d).feLb, 0x0a);
    for (const c of d.dirs) o += fid(buf, o, blk(), c.dir.name, c.feLb, 0x02);
    for (const f of d.files) o += fid(buf, o, blk(), f.file.name, f.feLb, 0x00);
    for (let i = 0; i < buf.length / S; i++) buf.copy(sec(P + d.fidLb + i), 0, i * S, (i + 1) * S);
    fileEntry(d.feLb, 'dir', d.fidBytes, [{ lb: d.fidLb, len: d.fidBytes }], 1 + d.dirs.length, d.uid);
    for (const f of d.files) fileEntry(f.feLb, 'file', f.size, splitExtents(f.isoLba - P, f.size), 1, f.uid);
    d.dirs.forEach(emitDir);
  };
  emitDir(root);

  avdp(lastAvdp).copy(sec(lastAvdp));

  /* ── write image ── */
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const fd = fs.openSync(opts.out, 'w');
  try {
    const zero = Buffer.alloc(S);
    const firstData = dataOrder.length ? dataOrder[0].isoLba : lastAvdp;
    // metadata region
    const metaBuf = Buffer.alloc(firstData * S);
    for (const [n, b] of meta) if (n < firstData) b.copy(metaBuf, n * S);
    fs.writeSync(fd, metaBuf, 0, metaBuf.length, 0);
    // file data
    let done = 0;
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    for (const f of dataOrder) {
      const src = fs.openSync(f.file.source, 'r');
      try {
        let pos = 0;
        let outPos = f.isoLba * S;
        while (pos < f.size) {
          if (opts.signal?.aborted) throw new Error('Canceled');
          const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, f.size - pos), pos);
          if (n <= 0) throw new Error(`Unexpected end of ${f.file.name}`);
          fs.writeSync(fd, chunk, 0, n, outPos);
          pos += n;
          outPos += n;
          done += n;
          opts.onProgress?.(totalBytes ? done / totalBytes : 1);
        }
        const pad = (S - (f.size % S)) % S;
        if (pad) fs.writeSync(fd, zero, 0, pad, outPos);
        if (f.size === 0) fs.writeSync(fd, zero, 0, S, f.isoLba * S);
      } finally {
        fs.closeSync(src);
      }
    }
    fs.writeSync(fd, sec(lastAvdp), 0, S, lastAvdp * S);
  } finally {
    fs.closeSync(fd);
  }
  opts.onProgress?.(1);
}

/** Image description for a DVD-Video folder (…/VIDEO_TS + empty AUDIO_TS) with files in player order. */
export function dvdVideoTree(discDir: string): IsoDir {
  const vts = path.join(discDir, 'VIDEO_TS');
  const names = fs.readdirSync(vts).filter((n) => /^(VIDEO_TS|VTS_\d\d_\d)\.(IFO|VOB|BUP)$/i.test(n));
  const rank = (n: string) => {
    const up = n.toUpperCase();
    const set = up.startsWith('VIDEO_TS') ? 0 : Number(up.slice(4, 6));
    const ext = up.endsWith('.IFO') ? 0 : up.endsWith('.VOB') ? 1 : 2;
    const part = up.startsWith('VTS_') ? Number(up.slice(7, 8)) : 0;
    return set * 1000 + ext * 100 + part;
  };
  names.sort((a, b) => rank(a) - rank(b));
  return {
    name: '',
    files: [],
    dirs: [
      { name: 'AUDIO_TS', files: [], dirs: [] },
      { name: 'VIDEO_TS', files: names.map((n) => ({ name: n.toUpperCase(), source: path.join(vts, n) })), dirs: [] },
    ],
  };
}
