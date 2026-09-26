// 卡片栅格的「几何」全是 CSS 决定的：一行排几张、右边会不会剩一大块空白、
// 页面出现滚动条时整页会不会横移。jsdom 不做排版，这类问题用逻辑测试永远测不出来，
// 所以这里用**静态断言**把规矩钉死 —— 数字来自真实截图量出来的容器宽度（1336px，
// 用户在 1920 宽的窗口里）。
//
// 这两个毛病都是用户报过的：
//   ① 收藏只有 4 张时右侧排得下、6 张以上就冒滚动条 → 整页（含左侧栏）横移 7.5px；
//   ② 一行明明放得下 6 张，却只排 5 张，右侧空掉一整张卡片的位置。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const css = fs.readFileSync(`${ROOT}/library.css`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

// 只抓**行首**那条基础规则：不加 ^ 锚定会先命中后代规则（比如 .grid.is-reordering .card），
// 读到的是别人的声明，断言就会「静默通过」——这个坑踩过一次。
const ruleOf = (selector) => new RegExp(`^${selector}[^{]*\\{[^}]*\\}`, "m").exec(css)?.[0] || "";

console.log("── 卡片栅格：一行排几张、右侧会不会空一大块 ──");
const gridRule = ruleOf("\\.grid");
const mm = /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\((\d+)px,\s*1fr\)\)/.exec(gridRule);
check(
  "用 minmax(下限, 1fr) 而不是固定像素（固定 210px 会在右侧白扔一整张卡片的位置）",
  !!mm,
  gridRule.slice(0, 118)
);
const min = Number(mm?.[1] || 0);
check("下限落在 170–205px（略小于旧版 210px，容器里才排得进第 6 张）", min >= 170 && min <= 205, `${min}px`);
check(
  "没有 justify-content（1fr 已经铺满；再写 start 会在排不满时把整行推开）",
  !/justify-content/.test(gridRule),
  gridRule.slice(0, 150)
);

const gap = Number(/gap:\s*\d+px\s+(\d+)px/.exec(gridRule)?.[1] || 0);
check("解析到了列间距（下面靠它反算列数与列宽）", gap > 0, `gap=${gap}px`);

// 下面几个反算必须**认识两种写法**：新的 minmax(Npx, 1fr) 和旧的固定 Npx。
// 只认新写法的话，一旦有人改回固定宽度，min 会解析成 0、列数变成几百列，
// 「右侧不剩空白」这类断言就会**因为算错而静默通过** —— 那等于白写。
const fixed = Number(/grid-template-columns:\s*repeat\(auto-fill,\s*(\d+)px\)/.exec(gridRule)?.[1] || 0);
const stretch = !!mm;
const step = stretch ? min : fixed; // 每列至少占多宽
const cols = (w) => Math.floor((w + gap) / (step + gap));
const trackW = (w) => (stretch ? (w - (cols(w) - 1) * gap) / cols(w) : fixed);
const leftover = (w) => Number((w - (cols(w) * trackW(w) + (cols(w) - 1) * gap)).toFixed(2));

// 1336px 是用户 1920 宽窗口里栅格的真实宽度（截图里量出来的：卡片左边界 → 排序按钮右边界）。
const CONTAINER = 1336;
check("用户的窗口宽度下一行排 6 张（旧写法只排 5 张）", cols(CONTAINER) === 6, `容器 ${CONTAINER}px → ${cols(CONTAINER)} 列`);
check(
  "每列摊到的宽度和旧版 210px 差不多（多塞一张靠的是填满，不是把卡片压小）",
  trackW(CONTAINER) >= 195 && trackW(CONTAINER) <= 215,
  `${trackW(CONTAINER).toFixed(1)}px`
);
[1200, 1336, 1680].forEach((w) => {
  check(`容器 ${w}px 时这一行被铺满（右侧不剩空白）`, leftover(w) < 0.5, `剩余 ${leftover(w)}px`);
});
console.log("\n── 页面滚动条：出现/消失都不该让整页横移 ──");
const htmlRule = ruleOf("html");
check("html 上写了 scrollbar-gutter: stable（滚动条的槽位永远留着）", /scrollbar-gutter:\s*stable/.test(htmlRule), htmlRule.slice(0, 96));
// 为什么这条必须有：.workspace 是 margin:auto 居中的，可用宽度少 15px 就会让整页（含左侧栏）横移 7.5px。
// 实测（真浏览器）：不加这条，侧栏左边界在「一屏装得下」和「内容撑出滚动条」两种状态下差 7.5px；
// 加了之后两种状态都是 82.5px，位移 0。
const workspaceRule = ruleOf("\\.workspace");
check(
  "工作区确实是居中布局的（所以滚动条一出现就横移，必须有上面那条兜底）",
  /margin:\s*auto/.test(workspaceRule),
  workspaceRule.slice(0, 130)
);

if (failures === 0) console.log("\n全部检查通过 🎉");
else {
  console.log(`\n有 ${failures} 项失败`);
  process.exitCode = 1;
}
