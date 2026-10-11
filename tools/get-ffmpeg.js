// Download a static ffmpeg build and extract ffmpeg.exe / ffprobe.exe.
// PowerShell 5.1 HTTPS is broken on this box -> use Node 24 fetch.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DL = path.join(ROOT, 'tools', 'dl');
fs.mkdirSync(DL, { recursive: true });

const CANDIDATES = [
  {
    name: 'BtbN (win64-gpl)',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  },
  {
    name: 'gyan essentials',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  },
];

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastTick = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once('drain', r));
    }
    const now = Date.now();
    if (now - lastTick > 3000) {
      lastTick = now;
      const pct = total ? ((got / total) * 100).toFixed(1) + '%' : '?';
      process.stdout.write(`\r  ${(got / 1048576).toFixed(1)}MB ${pct}   `);
    }
  }
  await new Promise((r) => out.end(r));
  return got;
}

(async () => {
  let ok = null;
  for (const c of CANDIDATES) {
    const dest = path.join(DL, 'ffmpeg.zip');
    try {
      console.log(`[try] ${c.name} :: ${c.url}`);
      const n = await download(c.url, dest);
      console.log(`\n[done] ${(n / 1048576).toFixed(1)} MB -> ${dest}`);
      ok = dest;
      break;
    } catch (e) {
      console.log(`\n[fail] ${c.name}: ${e.message}`);
      try { fs.unlinkSync(dest); } catch {}
    }
  }
  if (!ok) {
    console.error('ALL DOWNLOADS FAILED');
    process.exit(1);
  }
  console.log('ZIP=' + ok);
})();
