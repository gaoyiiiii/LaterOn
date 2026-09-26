// 生成「弹窗效果预览页」：把真实的 theme-vars.css / dialog.css / dialog.js 内联进 dev-tests/dialog-preview.html。
// 为什么要内联：present_files 的预览面板是把单个 HTML 放进快照目录打开的，相对路径的 css/js 加载不到。
// 好处：预览用的就是上线那份实现，改完 dialog.css / dialog.js 重跑一次这个脚本即可同步。
// 用法：node dev-tests/build-dialog-preview.js
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

const themeVars = read("theme-vars.css");
const dialogCss = read("dialog.css");
const dialogJs = read("dialog.js");

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LaterOn · 弹窗效果预览</title>
    <style>
      /* ── 主题变量（内联自 theme-vars.css，和真实页面一致）── */
${themeVars}

      /* ── 预览页自己的外壳样式，只为把弹窗摆出来看 ── */
      body {
        margin: 0;
        min-height: 100vh;
        padding: 40px 24px;
        background: var(--bg-grad);
        color: var(--ink);
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .demo { max-width: 760px; margin: 0 auto; }
      .demo-head { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 26px; }
      .demo-logo {
        display: grid; place-items: center; flex: none;
        width: 40px; height: 40px; border-radius: 13px;
        background: linear-gradient(140deg, #ff7a52, #ff4f2e);
        color: #fff; font-size: 21px; line-height: 1;
        box-shadow: 0 10px 22px -10px rgba(255,80,50,.85);
      }
      .demo-head h1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -.4px; }
      .demo-head p { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
      .demo-theme {
        margin-left: auto; flex: none;
        border: 1px solid var(--line); border-radius: 12px; padding: 9px 14px;
        background: var(--card); color: var(--ink);
        font-family: inherit; font-size: 12.5px; font-weight: 650; cursor: pointer;
      }
      .demo-theme:hover { background: var(--btn-soft); }
      .demo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(224px, 1fr)); gap: 10px; }
      .demo-btn {
        display: flex; flex-direction: column; gap: 5px; align-items: flex-start;
        border: 1px solid var(--line); border-radius: 15px; padding: 15px 16px;
        background: var(--card); color: var(--ink);
        font-family: inherit; text-align: left; cursor: pointer;
        box-shadow: var(--shadow-sm);
        transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
      }
      .demo-btn:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: var(--shadow-md); }
      .demo-btn strong { font-size: 13.5px; font-weight: 750; }
      .demo-btn span { color: var(--muted); font-size: 11.5px; line-height: 1.5; }
      .demo-tip {
        margin: 22px 0 0; padding: 13px 15px;
        border: 1px solid var(--line); border-radius: 14px;
        background: var(--glass-soft); color: var(--muted);
        font-size: 12.5px; line-height: 1.65;
      }
      .demo-tip strong { color: var(--ink); }

      /* ── 弹窗的真实样式（内联自 dialog.css）── */
${dialogCss}
    </style>
  </head>
  <body>
    <div class="demo">
      <div class="demo-head">
        <span class="demo-logo">↗</span>
        <div>
          <h1>LaterOn 弹窗效果预览</h1>
          <p>下面是应用里真实使用的弹窗组件，点任意按钮即可看到实际效果。</p>
        </div>
        <button class="demo-theme" id="themeToggle" type="button">切换深色</button>
      </div>

      <div class="demo-grid">
        <button class="demo-btn" type="button" data-demo="deleteFolder">
          <strong>删除项目的确认</strong>
          <span>危险操作：红色主题 + 警示图标</span>
        </button>
        <button class="demo-btn" type="button" data-demo="bulkDelete">
          <strong>批量删除的确认</strong>
          <span>会写清要删几篇</span>
        </button>
        <button class="demo-btn" type="button" data-demo="wipe">
          <strong>清空所有收藏的确认</strong>
          <span>设置页里的那个</span>
        </button>
        <button class="demo-btn" type="button" data-demo="importOk">
          <strong>导入完成</strong>
          <span>成功提示：绿色对勾图标</span>
        </button>
        <button class="demo-btn" type="button" data-demo="importFail">
          <strong>导入失败</strong>
          <span>错误提示：红色主题</span>
        </button>
        <button class="demo-btn" type="button" data-demo="shortcuts">
          <strong>没能打开快捷键设置</strong>
          <span>普通提示：只有一个按钮</span>
        </button>
      </div>

      <p class="demo-tip" id="result">
        <strong>交互都一样：</strong>回车 = 确认，Esc = 取消，点背景也能取消；提示类只有一个按钮。
        同一时刻只会显示一个弹窗，连着点会排队依次出现。
      </p>
    </div>

    <script>
      /* ── 弹窗的真实实现（内联自 dialog.js）── */
${dialogJs}
    </script>
    <script>
      const resultEl = document.getElementById("result");
      const demos = {
        deleteFolder: () => LaterOnDialog.confirm({
          tone: "danger",
          title: "删除项目「工作与灵感」？",
          message: "里面的 2 篇收藏会移到「待整理」，不会被删除。",
          confirmText: "删除项目"
        }),
        bulkDelete: () => LaterOnDialog.confirm({
          tone: "danger",
          title: "删除选中的 7 篇收藏？",
          message: "此操作无法撤销。",
          confirmText: "删除 7 篇"
        }),
        wipe: () => LaterOnDialog.confirm({
          tone: "danger",
          title: "清空所有收藏？",
          message: "所有收藏都会被删除，此操作无法撤销。",
          confirmText: "全部清空"
        }),
        importOk: () => LaterOnDialog.alert({
          tone: "success",
          title: "导入完成",
          message: "当前共 128 篇收藏。"
        }),
        importFail: () => LaterOnDialog.alert({
          tone: "danger",
          title: "导入失败",
          message: "文件格式不正确"
        }),
        shortcuts: () => LaterOnDialog.alert({
          title: "没能自动打开快捷键设置",
          message: "请手动在地址栏输入：chrome://extensions/shortcuts"
        })
      };

      document.querySelectorAll("[data-demo]").forEach((button) => {
        button.addEventListener("click", async () => {
          const key = button.dataset.demo;
          const answer = await demos[key]();
          resultEl.innerHTML = answer === undefined
            ? "刚才是<strong>提示类</strong>弹窗，看完点确认即可。"
            : (answer ? "你点了<strong>确认</strong>（返回 true，应用会继续执行）。" : "你点了<strong>取消</strong>（返回 false，应用什么都不做）。");
        });
      });

      const toggle = document.getElementById("themeToggle");
      toggle.addEventListener("click", () => {
        const dark = document.documentElement.dataset.theme === "dark";
        document.documentElement.dataset.theme = dark ? "light" : "dark";
        toggle.textContent = dark ? "切换深色" : "切换浅色";
      });
    </script>
  </body>
</html>
`;

const out = path.join(__dirname, "dialog-preview.html");
fs.writeFileSync(out, html);
console.log(`已生成 ${path.relative(ROOT, out)}`);
console.log(`  内联 theme-vars.css / dialog.css / dialog.js（共 ${(html.length / 1024).toFixed(1)} KB）`);
