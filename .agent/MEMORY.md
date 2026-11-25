# Active Tasks
- [x] 完成 Agent-coding 规范接入：新增项目规则与任务记忆、验证并提交。
- [x] Bug：在分组视图中，已分组网页卡片仍显示「等待整理」；应显示当前组别。
- [x] 功能：从扩展点击添加或使用快捷键添加网页时，可在弹窗中选择目标组，默认「等待整理」，并沿用现有弹窗风格。
- [ ] 样式：将扩展字体调整为 PingFang SC Medium 或更粗的字重，并验证无该字体时的回退表现。

---

# 经验与交接（Agent 自主维护）
- `manifest.json` 使用 Manifest V3，配置 `background.js` 为 service worker、`sidepanel.html` 为 side panel、`settings.html` 为 options 页面。
- 默认语言为 `zh_CN`；仓库当前含 `_locales/zh_CN` 与 `_locales/en`。
- `library.js` 的 `createCard` 在填充组别选项后必须显式选择 `item.projectId || ""`；否则新建 select 默认停在首项「等待整理」。未分组网页以空值继续显示「等待整理」。
- 原始本地副本缺少测试目录；fork 有可直接运行的 `tests/*.test.js`，其中 DOM 检查依赖 jsdom。使用仓库外临时依赖，模拟 Chrome API 的 Node 检查不等于真实浏览器验收。
- 原目录保留在 `C:\Users\ADMIN\Documents\Add-on\LaterOn`，其早期历史与 fork 无关联。已配置 origin 为 `https://github.com/VicissitudeYW/LaterOn.git`；继续开发使用基于 fork main 的隔离工作区 `C:\Users\ADMIN\.codex\worktrees\lateron-save-project-picker\LaterOn`、分支 `codex/single-save-project-picker`，已带入卡片组别修复与任务规范。
- 单页添加默认复用现有浮层并传入空项目（等待整理）；仅 `askFolderOnSingle === false && askFolderOnSingleOptIn === true` 表示明确关闭。设置读取、监听与后台必须一致；整窗入口仍用上次项目，包括仅剩一个可添加网页时。
- 2026-11-25：单页切片经历 RED→GREEN，完整 54 个 Node 测试脚本、9 项新增设置检查、manifest 与根目录 JS 检查通过，只读独立审查无阻断；未重载真实浏览器扩展，未做实际视觉验收。字体切片尚未实施。
