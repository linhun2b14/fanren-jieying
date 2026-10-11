'use strict';
// 零依赖读取 .xlsx：xlsx 就是一个 zip，解出 xl/sharedStrings.xml + xl/worksheets/sheet1.xml 后自己解析。
// 避免装 npm 包，也避免 PowerShell 处理中文的编码坑。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = process.argv[2] || 'D:\\结婴之战卡牌抄录表修正版.xlsx';
const WORK = 'ref\\su-cai\\xlsx';
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const zip = path.join(WORK, 'book.zip');
fs.copyFileSync(SRC, zip);
// Windows 自带 bsdtar 能解 zip
execFileSync('tar', ['-xf', zip, '-C', WORK], { stdio: 'inherit' });

const xmlDir = path.join(WORK, 'xl');
if (!fs.existsSync(xmlDir)) throw new Error('解压后没有 xl 目录，可能不是有效 xlsx');

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

// ---- 共享字符串表 ----
const shared = [];
const ssPath = path.join(xmlDir, 'sharedStrings.xml');
if (fs.existsSync(ssPath)) {
  const ss = fs.readFileSync(ssPath, 'utf8');
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(ss))) {
    const inner = m[1];
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner))) text += decode(t[1]);
    shared.push(text);
  }
}
console.log('sharedStrings:', shared.length, '条');

// ---- 找出所有工作表（可能不止一个）----
const wbPath = path.join(xmlDir, 'workbook.xml');
const wb = fs.readFileSync(wbPath, 'utf8');
const sheetNames = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g)].map((x) => decode(x[1]));
console.log('工作表:', sheetNames.join(' / ') || '(未解析到名称)');

const sheetFiles = fs.readdirSync(path.join(xmlDir, 'worksheets')).filter((f) => f.endsWith('.xml')).sort();
const allSheets = [];

function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

for (const f of sheetFiles) {
  const xml = fs.readFileSync(path.join(xmlDir, 'worksheets', f), 'utf8');
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cRe.exec(r[1]))) {
      const attrs = c[1] || '';
      const body = c[2] || '';
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      const tM = attrs.match(/t="([^"]+)"/);
      const idx = refM ? colIndex(refM[1]) : cells.length;
      let val = '';
      if (tM && tM[1] === 's') {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        val = vM ? (shared[Number(vM[1])] || '') : '';
      } else if (tM && tM[1] === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t, acc = '';
        while ((t = tRe.exec(body))) acc += decode(t[1]);
        val = acc;
      } else {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        val = vM ? decode(vM[1]) : '';
        if (/<is>/.test(body)) {
          const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
          let t, acc = '';
          while ((t = tRe.exec(body))) acc += decode(t[1]);
          val = acc;
        }
      }
      cells[idx] = val.replace(/\r\n/g, '\n');
    }
    rows.push(cells);
  }
  allSheets.push({ file: f, rows: rows });
  console.log(`  ${f}: ${rows.length} 行`);
}

const out = path.join(WORK, 'parsed.json');
fs.writeFileSync(out, JSON.stringify(allSheets, null, 1), 'utf8');
console.log('\n已写', out);

// ---- 预览第一个工作表 ----
const s0 = allSheets[0].rows;
console.log('\n=== 表头 ===');
console.log(JSON.stringify(s0[0]));
console.log('\n=== 前 3 行数据 ===');
s0.slice(1, 4).forEach((r) => console.log('  ' + JSON.stringify(r).slice(0, 220)));
