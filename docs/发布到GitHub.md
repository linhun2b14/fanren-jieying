# 发布到 GitHub

本仓库（开发仓库）里混着**不该公开**的东西，所以发布不是 `git push` 一下就完事：

| 不该公开的 | 在哪 |
|---|---|
| 自家域名 / 内网拓扑 / 机器用户名路径 / 内部运维文档引用 | `docs/_ops-doc-candidate.md`、`docs/部署说明.md`、`docs/archive/`、若干文档正文 |
| 本机绝对路径（`...`） | 各测试与文档（别人 clone 下来跑不通） |
| 大文件素材 | `ref/`（1.1 GB 视频抽帧）、`tools/ff/`（ffmpeg） |

所以采用**「导出快照 → 单独一个公开仓库」**的流程：开发历史留在本地，公开仓库是一份洗干净的快照。

---

## 一、生成公开快照

```powershell
cd <开发仓库>
node tools\export-public.js                                  # 默认导出到 ..\fanren-jieying-public
node tools\export-public.js D:\somewhere\fanren-public       # 也可以指定目标目录
```

脚本会自动：拷白名单文件 → 洗掉域名/内网 IP/本机路径/用户名 → 跳过私密文档与素材 →
然后把 `data/cards.json` 解析一遍、所有 JS 过一遍 `node --check`、再扫一遍敏感词表，
最后**在导出目录里跑一遍 `tests/run-all.js --no-ui`**（证明"干净 clone 能跑"）。
任何一项不过就以非零退出码结束 —— 别在红的时候发布。

> 洗不干净的东西会以 `✗ 仍有命中：…` 列出来。判据表就在脚本里（`SENSITIVE` 那一段），
> 新增一类就加进去，或者把那个文件加进 `SKIP_REL`。

## 二、首次发布

```bash
cd ../fanren-jieying-public
git init -b main
git add -A && git commit -m "first public snapshot"
```

然后在 GitHub 建一个空仓库（网页点一下，或装了 `gh` 的话 `gh repo create <名字> --private|--public --source=. --push`），
再把本地这份推上去：

```bash
git remote add origin git@github.com:<你的账号>/<仓库名>.git   # 或 https://github.com/<账号>/<仓库名>.git
git push -u origin main
```

用 HTTPS 推时要过凭据：推荐装 Git Credential Manager（Windows 版 Git 自带），
或者在 GitHub 建一个 **fine-grained PAT**（只给这一个仓库的 `Contents: Read and write`），
推送时用户名填账号、密码填 PAT。**别把 PAT 写进任何文件里。**

## 三、后续更新

```powershell
cd <开发仓库>
node tools\export-public.js                 # 重新生成（目标目录里已有 .git 会**保留**，只刷新工作区）
cd ..\fanren-jieying-public
git add -A
git commit -m "sync: <这次改了什么>"
git push
```

> 公开仓库的 `.git` 只有"每次快照"的提交；开发仓库的逐条历史（含设计过程、ops 日志）
> 仍然只在本机。想公开完整历史的话，得先做一次 `git filter-repo` 式的历史清洗 ——
> 现在这套快照流程就是为了避免那件事。

## 四、发布前检查清单

- [ ] `node tools\export-public.js` 四道复检全绿（JSON / JS 语法 / 敏感词 / 回归 36 套）
- [ ] 导出目录里 `node server\index.js` 起得来，`/healthz` 与首页 200（本文档上一节的做法）
- [ ] `docs/部署教程.md` 里的占位符（域名、内网 IP）没有被真实值替换回来
- [ ] 公开仓库的提交里没有 `ref/`、`tools/ff/`、日志、卡池备份
- [ ] 想清楚要不要加 `LICENSE`（本项目是**同人复刻、非商业**；不加 = 保留所有权利）
