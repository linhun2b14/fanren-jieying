'use strict';
/**
 * 一键同步到公开仓库：**导出干净快照 → 提交 → 推送**。
 *
 *   node tools/sync-public.js ["提交说明"] [公开仓库目录]
 *
 * 公开仓库目录默认 `..\fanren-jieying-public`。
 * 导出器自带四道复检（卡池/JS 语法/敏感词/导出目录里的引擎回归），**不过就中止**，
 * 不会把没洗干净的东西推上去；工作区没有变化时也不会产生空提交。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MSG = process.argv[2] || ('sync: ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' (UTC)');
const PUB = path.resolve(process.argv[3] || path.join(path.dirname(ROOT), 'fanren-jieying-public'));

/** git 不一定在 PATH 里（本机就是全路径调用），所以自己找一下 */
function findGit() {
  if (process.env.GIT_BIN) return process.env.GIT_BIN;
  const candidates = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe', '/usr/bin/git'];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch (e) { /* 换下一个 */ }
  }
  throw new Error('找不到 git —— 用 GIT_BIN=<git 路径> 环境变量指定');
}
const GIT = findGit();
const git = (args, opts) => execFileSync(GIT, args, Object.assign({ cwd: PUB, stdio: 'inherit' }, opts || {}));
const gitOut = (args) => execFileSync(GIT, args, { cwd: PUB, encoding: 'utf8' }).trim();

if (!fs.existsSync(path.join(PUB, '.git'))) {
  console.error('目标目录不是 git 仓库：' + PUB + '\n先按 docs\\发布到GitHub.md 里的"首次发布"建仓。');
  process.exit(1);
}
const remote = gitOut(['remote', 'get-url', 'origin']);
console.log('同步到：' + remote + '（' + PUB + '）\n');

// 1) 导出干净快照（内含复检；红就直接抛错中止）
execFileSync(process.execPath, [path.join(__dirname, 'export-public.js'), PUB], { stdio: 'inherit' });

// 2) 有没有变化
const changed = gitOut(['status', '--porcelain']);
if (!changed) { console.log('\n公开仓库没有变化，跳过提交与推送。'); process.exit(0); }
console.log('\n改动：\n' + changed.split('\n').map((l) => '  ' + l).join('\n'));

// 3) 提交 + 推送
git(['add', '-A']);
git(['commit', '-m', MSG]);
git(['push']);

console.log('\n✔ 已推送：' + gitOut(['log', '--oneline', '-1']));
