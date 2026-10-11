// Minimal MP4 box walker: duration + track inventory (incl. subtitle tracks).
const fs = require('fs');
const { Buffer } = require('buffer');

const file = process.argv[2];
const buf = fs.readFileSync(file);
console.log(`file=${file} size=${(buf.length / 1048576).toFixed(1)}MB`);

function walk(start, end, depth, filter) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < hdr) break;
    boxes.push({ type, off, hdr, size, end: off + size });
    if (filter && filter.has(type)) walk(off + hdr, off + size, depth + 1, filter);
    off += size;
  }
  return boxes;
}

const top = walk(0, buf.length, 0, new Set(['moov']));
console.log('top-level: ' + top.map((b) => b.type).join(', '));

const moov = top.find((b) => b.type === 'moov');
if (!moov) { console.log('NO moov'); process.exit(1); }

const mvhd = walk(moov.off + moov.hdr, moov.end, 1, new Set()).find((b) => b.type === 'mvhd');
if (mvhd) {
  const ver = buf.readUInt8(mvhd.off + mvhd.hdr);
  const ts = ver === 1 ? buf.readUInt32BE(mvhd.off + mvhd.hdr + 20) : buf.readUInt32BE(mvhd.off + mvhd.hdr + 12);
  const du = ver === 1 ? Number(buf.readBigUInt64BE(mvhd.off + mvhd.hdr + 24)) : buf.readUInt32BE(mvhd.off + mvhd.hdr + 16);
  console.log(`duration=${(du / ts / 60).toFixed(2)} min (${du / ts}s) timescale=${ts}`);
}

const traks = walk(moov.off + moov.hdr, moov.end, 1, new Set(['trak']));
console.log(`tracks=${traks.length}`);
for (const trak of traks) {
  const kids = walk(trak.off + trak.hdr, trak.end, 2, new Set(['mdia']));
  const mdia = kids.find((b) => b.type === 'mdia');
  if (!mdia) continue;
  const mk = walk(mdia.off + mdia.hdr, mdia.end, 3, new Set());
  const hdlr = mk.find((b) => b.type === 'hdlr');
  const mdhd = mk.find((b) => b.type === 'mdhd');
  const handler = hdlr ? buf.toString('latin1', hdlr.off + hdlr.hdr + 8, hdlr.off + hdlr.hdr + 12) : '?';
  let info = '';
  if (mdhd) {
    const ver = buf.readUInt8(mdhd.off + mdhd.hdr);
    const ts = ver === 1 ? buf.readUInt32BE(mdhd.off + mdhd.hdr + 20) : buf.readUInt32BE(mdhd.off + mdhd.hdr + 12);
    const du = ver === 1 ? Number(buf.readBigUInt64BE(mdhd.off + mdhd.hdr + 24)) : buf.readUInt32BE(mdhd.off + mdhd.hdr + 16);
    info = ` dur=${(du / ts).toFixed(1)}s`;
  }
  console.log(`  - handler=${handler}${info}`);
}
