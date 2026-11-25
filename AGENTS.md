# Project Rules

## 技术栈
- Chrome Extension Manifest V3 (`manifest.json`)，原生 JavaScript、HTML、CSS；本地化消息位于 `_locales/en` 与 `_locales/zh_CN`。

## 目录职责
- 根目录：扩展清单、JavaScript/CSS/HTML 文件及图片资源。
- `_locales/`：扩展本地化消息。
- `docs/superpowers/`：已确认的设计说明与实施计划。
- `.agent/MEMORY.md`：当前任务切片与经验交接。

## 常用命令
- 测试：未配置自动化测试。
- 检查 manifest JSON：`Get-Content .\manifest.json -Raw | ConvertFrom-Json | Out-Null`
- 检查根目录 JavaScript 语法：`Get-ChildItem -File -Filter *.js | ForEach-Object { node --check $_.FullName }`

## 红线
- 修改 `manifest.json` 引用的路径时，同步确认对应文件存在。
- 当前没有自动化测试或构建脚本；不得把语法检查描述为功能测试。
- 每次编码只处理 `.agent/MEMORY.md` 中锁定的一个任务切片。
