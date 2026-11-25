# Project Rules

## 技术栈
- Chrome Extension Manifest V3 (`manifest.json`)，原生 JavaScript、HTML、CSS；本地化消息位于 `_locales/en` 与 `_locales/zh_CN`。

## 目录职责
- 根目录：扩展清单、JavaScript/CSS/HTML 文件及图片资源。
- `_locales/`：扩展本地化消息。
- `docs/superpowers/`：已确认的设计说明与实施计划。
- `.agent/MEMORY.md`：当前任务切片与经验交接。

## 常用命令
- 测试：fork 的 `tests/*.test.js` 为可直接运行的 Node 行为脚本，未配置统一测试运行器；部分脚本需要 `jsdom`。测试依赖可安装在仓库外：`npm install --prefix "$env:TEMP\lateron-test-dependencies" --no-audit --no-fund jsdom@26.1.0`，然后设置 `$env:NODE_PATH = "$env:TEMP\lateron-test-dependencies\node_modules"`。
- 运行全部脚本：`Get-ChildItem .\tests -File -Filter *.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { throw "Test failed: $($_.Name)" } }`
- 检查 manifest JSON：`Get-Content .\manifest.json -Raw | ConvertFrom-Json | Out-Null`
- 检查根目录 JavaScript 语法：`Get-ChildItem -File -Filter *.js | ForEach-Object { node --check $_.FullName }`

## 红线
- 修改 `manifest.json` 引用的路径时，同步确认对应文件存在。
- Node 测试使用 Chrome API 替身；不得把模拟检查或语法检查描述为真实浏览器功能验收。
- 每次编码只处理 `.agent/MEMORY.md` 中锁定的一个任务切片。
