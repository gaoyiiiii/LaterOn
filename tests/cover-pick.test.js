// 图板「封面组合」——自己从项目里已抓到的封面中挑几张、拖拽决定顺序：
//  1) 没挑过时照旧自动拼（最新的优先、最多 3 张）
//  2) 编辑项目弹窗里列出备选，点一下加入、点 × 取消，最多 3 张
//  3) 拖动已挑的缩略图能换顺序；拖动中只挪一条指示线，不动 DOM
//  4) 保存后写进 project.coverPick，图板和侧栏缩略图都跟着改
//  5) 全部取消 = 回到自动；挑的那几篇没了 = 自动兜底；有自定义上传封面时以它为准
// 顺带锁住图板简介的行高：一句话的简介只占一行（以前被 min-height 撑成两行）。
// 运行：NODE_PATH=<jsdom 路径> node tests/cover-pick.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");
const dialogCss = fs.readFileSync(`${ROOT}/dialog.css`, "utf8");
const libraryCss = fs.readFileSync(`${ROOT}/library.css`, "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
virtualConsole.on("error", (message) => errors.push(String(message)));

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "chrome-extension://lateron/library.html",
  virtualConsole
});
const { window } = dom;
const { document } = window;

// ── 假的 chrome API ─────────────────────────────────────────
const now = Date.now();
const item = (id, image, savedAt) => ({
  id, title: `标题 ${id}`, description: "摘要", image, favicon: "",
  source: "少数派", url: `https://example.com/${id}`, savedAt, status: "unread", projectId: "work"
});
const store = {
  laterOnItems: [
    item("w1", "https://example.com/1.jpg", now),
    item("w2", "https://example.com/2.jpg", now - 1000),
    item("w3", "https://example.com/3.jpg", now - 2000),
    item("w4", "https://example.com/4.jpg", now - 3000),
    item("w5", "", now - 4000)          // 没抓到封面 → 不进备选
  ],
  laterOnProjects: [{ id: "work", name: "工作", createdAt: 1 }],
  laterOnActiveProject: "all",
  laterOnSettings: {},
  laterOnFilter: "all",
  laterOnFilterChosen: true
};
const changeListeners = [];
const projectsWrites = [];
window.chrome = {
  storage: {
    local: {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in store) out[key] = store[key];
        return Promise.resolve(out);
      },
      set(patch) {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
          if (key === "laterOnProjects") projectsWrites.push(value);
        }
        window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        return Promise.resolve();
      }
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  },
  tabs: { query: () => Promise.resolve([{ id: 1, windowId: 1 }]), create: () => Promise.resolve({ id: 2 }) },
  runtime: { getURL: (p) => `chrome-extension://lateron/${p}`, onMessage: { addListener() {} } }
};

// jsdom 没有排版（getBoundingClientRect 全是 0），而「拖到第几张前面」是靠
// 缩略图当时的横向中点判断的，所以给封面组合里的每张缩略图铺一排假坐标。
const CELL_W = 54;
const CELL_H = 38;
const CELL_STEP = CELL_W + 7;
window.Element.prototype.getBoundingClientRect = function () {
  const strip = this.parentNode?.classList?.contains("lod-pick-strip") ? this.parentNode : null;
  if (!strip) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
  const cells = [...strip.children].filter((el) => el.classList.contains("lod-pick"));
  const left = Math.max(0, cells.indexOf(this)) * CELL_STEP;
  return { left, top: 0, right: left + CELL_W, bottom: CELL_H, width: CELL_W, height: CELL_H, x: left, y: 0, toJSON() {} };
};

window.eval(dialogSource);
window.eval(librarySource);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 5) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

const boardOf = (id) => [...document.querySelectorAll(".board-card")].find((card) => card.dataset.project === id);
const coverOf = (id) => boardOf(id)?.querySelector(".board-cover");
const coverSrcs = (id) => [...coverOf(id).querySelectorAll(".board-img")].map((img) => img.getAttribute("src"));
const thumbOf = (id) => document.querySelector(`#projectList .project-row[data-id="${id}"] .project-thumb img`)?.getAttribute("src") || "";
const pin = () => store.laterOnProjects.find((project) => project.id === "work").coverPick || null;

const dialog = () => document.querySelector(".lod-root:not([hidden])");
const picks = () => dialog().querySelector(".lod-picks");
const strip = () => dialog().querySelector(".lod-pick-strip");
const chips = () => [...dialog().querySelectorAll(".lod-pick")];
const onChips = () => [...dialog().querySelectorAll(".lod-pick.is-on")];
const chipOf = (id) => chips().find((el) => el.dataset.pick === id);
const pickedIds = () => onChips().map((el) => el.dataset.pick);
const badgeOf = (id) => chipOf(id)?.querySelector(".lod-pick-order")?.textContent || "";
const pickNote = () => dialog().querySelector(".lod-pick-note")?.textContent || "";
const pickNoteEl = () => dialog().querySelector(".lod-pick-note");

const transfer = () => ({
  types: ["text/plain"], dropEffect: "", effectAllowed: "",
  getData: () => "", setData() {}, setDragImage() {}
});
const dragEvent = (el, type, dataTransfer, point = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = dataTransfer;
  if (point.clientX !== undefined) event.clientX = point.clientX;
  if (point.clientY !== undefined) event.clientY = point.clientY;
  el.dispatchEvent(event);
  return event;
};
// 把某张已挑的封面拖到 clientX 那个位置放下；返回拖动过程中有没有出现指示线。
async function dragPick(id, clientX) {
  const cell = chipOf(id);
  const dt = transfer();
  dragEvent(cell, "dragstart", dt);
  dragEvent(strip(), "dragover", dt, { clientX });
  const hadLine = !!strip().querySelector(".lod-pick-line");
  dragEvent(strip(), "drop", dt);
  dragEvent(cell, "dragend", dt);   // 真浏览器里 drop 之后还会来一个 dragend
  await tick(20);
  return hadLine;
}
async function openBoardEdit() {
  click(boardOf("work").querySelector(".board-edit"));
  await tick(30);
}
async function saveBoardEdit() {
  click(dialog().querySelector(".lod-ok"));
  await tick(320);   // 等关闭动画走完、promise resolve
}

(async () => {
  await tick(30);

  console.log("── ① 默认还是「自动拼封面」──");
  check("图板拼了 3 格封面", coverOf("work").dataset.count === "3", coverOf("work").dataset.count);
  check("自动取的是最新的 3 篇", coverSrcs("work").join(" ") === "https://example.com/1.jpg https://example.com/2.jpg https://example.com/3.jpg",
    coverSrcs("work").join(" "));
  check("项目没写过简介时，简介是自动生成的那句概览", /主要来自 少数派/.test(boardOf("work").querySelector(".board-note")?.textContent || ""),
    boardOf("work").querySelector(".board-note")?.textContent);

  console.log("\n── ② 弹窗里的封面组合 ──");
  await openBoardEdit();
  check("编辑项目弹窗里出现了封面组合区", picks().hidden === false);
  check("备选只有抓到封面的 4 篇（没封面的那篇不在）", chips().length === 4, String(chips().length));
  check("一开始一张都没挑", onChips().length === 0, pickedIds().join(","));
  check("并且说明了「还没挑 = 自动拼」", /还没挑/.test(pickNote()), pickNote());

  click(chipOf("w3"));
  await tick(10);
  check("点一下就加入，并标成第 1 张", badgeOf("w3") === "1", badgeOf("w3"));
  check("已挑的排在备选前面（第 1 张在最左）", chips()[0].dataset.pick === "w3", chips().map((el) => el.dataset.pick).join(","));
  check("拼图顺序 = 挑的顺序", pickedIds().join(",") === "w3", pickedIds().join(","));

  click(chipOf("w1"));
  await tick(10);
  check("再挑一张，它排第 2", pickedIds().join(",") === "w3,w1" && badgeOf("w1") === "2", pickedIds().join(","));

  // 点身体不会取消（怕手滑把刚排好的顺序弄乱），只有右上角那个 × 才会。
  click(chipOf("w3"));
  await tick(10);
  check("点已挑缩略图的身体不会取消", pickedIds().join(",") === "w3,w1", pickedIds().join(","));
  click(chipOf("w3").querySelector(".lod-pick-x"));
  await tick(10);
  check("点 × 才取消", pickedIds().join(",") === "w1", pickedIds().join(","));
  click(chipOf("w3"));
  await tick(10);

  console.log("\n── ③ 拖拽调顺序 ──");
  // w3 在第 1 位、w1 在第 2 位；把 w1 拖到最左（x 小于第 1 张的中点）→ 换到第 1 位。
  const hadLine = await dragPick("w1", 5);
  check("拖动过程中出现了插入指示线", hadLine);
  check("拖到最左后顺序反过来", pickedIds().join(",") === "w1,w3", pickedIds().join(","));
  check("序号跟着重排", badgeOf("w1") === "1" && badgeOf("w3") === "2", `${badgeOf("w1")}/${badgeOf("w3")}`);
  check("拖动结束后指示线收掉了", !strip().querySelector(".lod-pick-line"));

  // 拖到最后（x 远大于所有缩略图）→ 又换回去。
  await dragPick("w1", 9999);
  check("拖到最右后顺序又换回来", pickedIds().join(",") === "w3,w1", pickedIds().join(","));

  // 原地拖一下：不该白写一次存储。
  const writesBefore = projectsWrites.length;
  await dragPick("w1", CELL_STEP + 5);   // 正好落在它自己所在的槽位
  check("原地放下不写存储", projectsWrites.length === writesBefore, `写了 ${projectsWrites.length - writesBefore} 次`);

  console.log("\n── ④ 最多 3 张 ──");
  click(chipOf("w2"));
  await tick(10);
  check("挑满 3 张", pickedIds().join(",") === "w3,w1,w2", pickedIds().join(","));
  click(chipOf("w4"));
  await tick(10);
  check("再点第 4 张不会加进去", pickedIds().length === 3 && !pickedIds().includes("w4"), pickedIds().join(","));
  check("提示里说清了要先取消一张", /最多用 3 张/.test(pickNote()), pickNote());
  check("提示用的是警示色", pickNoteEl().classList.contains("is-warn"));

  console.log("\n── ⑤ 保存后图板和侧栏都跟着变 ──");
  await saveBoardEdit();
  check("写进了 project.coverPick", pin()?.join(",") === "w3,w1,w2", JSON.stringify(pin()));
  check("提示里点明了改的是封面组合", /封面组合/.test(document.querySelector("#toast").textContent), document.querySelector("#toast").textContent);
  check("图板封面变成挑出来的 3 格", coverOf("work").dataset.count === "3" && coverSrcs("work").join(" ") ===
    "https://example.com/3.jpg https://example.com/1.jpg https://example.com/2.jpg", coverSrcs("work").join(" "));
  check("侧栏项目缩略图用的是挑的第 1 张", thumbOf("work") === "https://example.com/3.jpg", thumbOf("work"));

  console.log("\n── ⑥ 再打开时恢复挑好的顺序 ──");
  await openBoardEdit();
  check("已挑的 3 张按顺序显示，序号 1/2/3", pickedIds().join(",") === "w3,w1,w2" &&
    chips().slice(0, 3).map((el) => el.querySelector(".lod-pick-order").textContent).join("") === "123",
    pickedIds().join(","));
  check("说明里标出了已挑 3/3", /已经挑满/.test(pickNote()), pickNote());

  console.log("\n── ⑦ 只挑 1 张 / 全部取消 ──");
  click(chipOf("w2").querySelector(".lod-pick-x"));
  click(chipOf("w1").querySelector(".lod-pick-x"));
  await tick(10);
  check("取消到只剩 1 张", pickedIds().join(",") === "w3", pickedIds().join(","));
  await saveBoardEdit();
  check("只挑 1 张时封面就是那一张（铺满）", coverOf("work").dataset.count === "1" &&
    coverSrcs("work").join(" ") === "https://example.com/3.jpg", coverSrcs("work").join(" "));

  await openBoardEdit();
  click(chipOf("w3").querySelector(".lod-pick-x"));
  await tick(10);
  await saveBoardEdit();
  check("全部取消后字段被删掉（不留空壳）", !("coverPick" in store.laterOnProjects.find((p) => p.id === "work")),
    JSON.stringify(store.laterOnProjects[0]));
  check("封面回到自动拼的 3 格", coverOf("work").dataset.count === "3" && coverSrcs("work").join(" ") ===
    "https://example.com/1.jpg https://example.com/2.jpg https://example.com/3.jpg", coverSrcs("work").join(" "));

  console.log("\n── ⑧ 挑的那几篇没了 → 自动兜底 ──");
  store.laterOnProjects = [{ id: "work", name: "工作", createdAt: 1, coverPick: ["gone-1", "w4"] }];
  changeListeners.forEach((fn) => fn({ laterOnProjects: { newValue: store.laterOnProjects } }, "local"));
  await tick(30);
  check("只剩还存在的那一篇当封面", coverSrcs("work").join(" ") === "https://example.com/4.jpg", coverSrcs("work").join(" "));
  await openBoardEdit();
  check("打开弹窗时把死掉的 id 剔掉了", pickedIds().join(",") === "w4", pickedIds().join(","));
  await saveBoardEdit();

  console.log("\n── ⑨ 上传的自定义封面优先 ──");
  store.laterOnProjects = [{ id: "work", name: "工作", createdAt: 1, cover: "data:image/jpeg;base64,MINE", coverPick: ["w3"] }];
  changeListeners.forEach((fn) => fn({ laterOnProjects: { newValue: store.laterOnProjects } }, "local"));
  await tick(30);
  check("有自定义封面时图板整块铺满它", coverOf("work").dataset.count === "1" &&
    coverSrcs("work").join(" ") === "data:image/jpeg;base64,MINE", coverSrcs("work").join(" "));
  await openBoardEdit();
  check("此时组合区标成「不生效」", picks().classList.contains("is-muted"));
  check("并说明了要先移除自定义封面", /自定义封面正生效/.test(pickNote()), pickNote());
  check("挑过的顺序照样记着（没被清掉）", pickedIds().join(",") === "w3", pickedIds().join(","));
  await saveBoardEdit();

  console.log("\n── ⑩ 没备选的弹窗不受影响 ──");
  let plain;
  window.LaterOnDialog.prompt({ title: "编辑收藏", cover: { name: "cover", label: "封面", value: "" } })
    .then((value) => { plain = value; });
  await tick(30);
  check("不传备选时不显示封面组合区", dialog().querySelector(".lod-picks").hidden === true);
  check("结果里也没有 coverPick 字段", !("coverPick" in (plain?.values || {})));
  click(dialog().querySelector(".lod-cancel"));
  await tick(320);

  console.log("\n── ⑪ 自己挑的封面不受未读/已读筛选影响 ──");
  // 挑一张「已读」的当封面，再把顶部筛选拨到「未读」：那一篇不在当前列表里了，
  // 但封面是用户定的门面，不该跟着一起消失（自动拼的那份才跟筛选走）。
  store.laterOnItems = store.laterOnItems.map((it) => ({ ...it, status: it.id === "w3" ? "done" : "unread" }));
  store.laterOnProjects = [{ id: "work", name: "工作", createdAt: 1, coverPick: ["w3"] }];
  changeListeners.forEach((fn) => fn({
    laterOnItems: { newValue: store.laterOnItems },
    laterOnProjects: { newValue: store.laterOnProjects }
  }, "local"));
  await tick(30);
  click(document.querySelector('.nav-item[data-filter="unread"]'));
  await tick(40);
  check("切到未读后，自己挑的封面照样用", coverSrcs("work").join(" ") === "https://example.com/3.jpg", coverSrcs("work").join(" "));
  check("但篇数只算当前筛选里的", /4 篇/.test(boardOf("work").querySelector(".board-meta").textContent),
    boardOf("work").querySelector(".board-meta").textContent);
  check("侧栏缩略图也没跟着换", thumbOf("work") === "https://example.com/3.jpg", thumbOf("work"));
  click(document.querySelector('.nav-item[data-filter="all"]'));
  await tick(40);

  console.log("\n── ⑫ 图板简介按内容占高 ──");
  // jsdom 里量不出高度，所以直接锁 CSS：不能再有 min-height 把它撑成两行。
  const noteRule = new RegExp("^\\.board-note[^{]*\\{[^}]*\\}", "m").exec(libraryCss);
  check("找到了 .board-note 的样式规则", !!noteRule, noteRule?.[0]?.slice(0, 60));
  check("简介不再被强行撑成两行高", !!noteRule && !/min-height/.test(noteRule[0]), noteRule?.[0]?.replace(/\s+/g, " "));
  check("但还是最多两行（长简介不会把卡片撑爆）", !!noteRule && /-webkit-line-clamp:\s*2/.test(noteRule[0]));
  check("自动生成的那句仍然淡一档（is-auto 还在）", /\.board-note\.is-auto\s*\{/.test(libraryCss));
  // 图板上那句概览确实带着 is-auto（自己写的那句不带）。
  check("自动生成的概览标着 is-auto", boardOf("work").querySelector(".board-note")?.classList.contains("is-auto"));
  click(boardOf("work").querySelector(".board-edit"));
  await tick(30);
  const noteField = dialog().querySelector('[data-field="note"]');
  noteField.value = "收集工作里要用的长文";
  click(dialog().querySelector(".lod-ok"));
  await tick(320);
  check("自己写了简介就显示自己那句", boardOf("work").querySelector(".board-note")?.textContent === "收集工作里要用的长文",
    boardOf("work").querySelector(".board-note")?.textContent);
  check("自己写的那句不再标成自动生成", !boardOf("work").querySelector(".board-note")?.classList.contains("is-auto"));

  console.log("\n── ⑬ 样式与报错 ──");
  const used = new Set();
  for (const matched of dialogSource.matchAll(/class="([^"]+)"/g)) matched[1].split(/\s+/).forEach((n) => used.add(n));
  for (const matched of dialogSource.matchAll(/className\s*=\s*"([^"]+)"/g)) matched[1].split(/\s+/).forEach((n) => used.add(n));
  const missing = [...used].filter((name) => name.startsWith("lod-") && !dialogCss.includes(`.${name}`));
  check("封面组合用到的类名都在 CSS 里有样式", missing.length === 0, missing.join(", "));
  check("整个过程没有未捕获的错误", errors.length === 0, errors.join(" | "));

  console.log(failures ? `\n❌ 有 ${failures} 项没通过` : "\n🎉 全部通过");
  process.exit(failures ? 1 : 0);
})();
