# Active Tasks
- [x] 完成 Agent-coding 规范接入：新增项目规则与任务记忆、验证并提交。
- [x] Bug：在分组视图中，已分组网页卡片仍显示「等待整理」；应显示当前组别。
- [ ] 功能：从扩展点击添加或使用快捷键添加网页时，可在弹窗中选择目标组，默认「等待整理」，并沿用现有弹窗风格。
- [ ] 样式：将扩展字体调整为 PingFang SC Medium 或更粗的字重，并验证无该字体时的回退表现。

---

# 经验与交接（Agent 自主维护）
- `manifest.json` 使用 Manifest V3，配置 `background.js` 为 service worker、`sidepanel.html` 为 side panel、`settings.html` 为 options 页面。
- 默认语言为 `zh_CN`；仓库当前含 `_locales/zh_CN` 与 `_locales/en`。
- `library.js` 的 `createCard` 在填充组别选项后必须显式选择 `item.projectId || ""`；否则新建 select 默认停在首项「等待整理」。未分组网页以空值继续显示「等待整理」。
- 项目没有自动化测试或构建脚本；`manifest.json` 解析和根目录 JavaScript 语法检查通过不等于浏览器功能测试。
- 本地 Git 历史与 fork 的 `main` 无关联，且未配置 remote；扩展源文件原先未跟踪，本次仅将 `library.js` 纳入本地提交，其余扩展文件保持未跟踪。
