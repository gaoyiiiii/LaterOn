// 收藏库（全屏页）和网页浮层（content script）共用的「选项目」面板。
//
// openFolderPicker(options) 两种用法共用同一套外观与交互：
//   • 整屏弹窗（收藏网页时选「收藏到哪个项目」）：不传 anchor，背后有灰色遮罩、面板居中。
//   • 贴着按钮的浮层（单篇或批量移动）：传 anchor = 触发它的项目控件，
//     没有遮罩、面板定位在按钮旁边，点外面或按 Esc 关闭。
//
// 之所以抽成共享模块：用户希望卡片上点出来的「窗口」和网页里收藏时那个是同一个，
// 只是出现的位置从「屏幕中央」变成了「按钮旁边」。两种用法走的就是同一份代码。
//
// 约定：本文件不依赖任何外部变量/函数（包括 chrome.* 也不在顶层调用），
// 这样它既能作为 content script 注入网页，也能被扩展页用 <script> 直接加载。
(function () {
  "use strict";

  // 新建项目：默认走后台的 CREATE_PROJECT（content script 和扩展页都通用）；
  // 调用方也可以自己传 onCreateProject 覆盖（比如扩展页想顺带刷新本地列表）。
  async function defaultCreateProject(name) {
    const response = await chrome.runtime.sendMessage({ type: "CREATE_PROJECT", name }).catch(() => null);
    return response?.project || null;
  }

  function openFolderPicker(options) {
    const data = options || {};
    const isPopover = !!data.anchor;
    const language = data.language === "en" || (!data.language && document.documentElement.lang === "en") ? "en" : "zh-CN";
    const copy = language === "en" ? {
      projects: "Choose a project", newProject: "New project name", cancel: "Cancel", moveTitle: "Move this save to which project?",
      saveTitle: "Save to which project?", saveSingleTitle: "Save this page to which project?",
      singleSaved: "This page is already saved — confirming will move it to the selected project", singleNew: "Choose a project to save this page",
      batchSaved: (total, saved) => `${total} tabs, including ${saved} already saved — confirming will move them to the selected project`,
      batchNew: (total) => `${total} tabs — choose a project to start saving them one by one`, pages: (n) => `View the ${n} pages to be saved`,
      newMove: "Type a new project name and press Enter to move", newSave: "Type a new project name and press Enter to save", inbox: "Inbox",
      processing: "Working…", createMove: (name) => `Create “${name}” and move`, createSave: (name) => `Create “${name}” and save`,
      moveTo: (name) => `Move to “${name}”`, saveTo: (name) => `Save to “${name}”`, createFailed: "Couldn’t create the project. Try again.",
      failed: "Something went wrong. Try again."
    } : {
      projects: "选择项目", newProject: "新建项目名称", cancel: "取消", moveTitle: "把这篇放到哪个项目？",
      saveTitle: "保存到哪个项目？", saveSingleTitle: "把这个网页保存到哪个项目？",
      singleSaved: "这个网页已经保存过——确认后会一并移进你选的项目", singleNew: "选好项目后就会保存这个网页",
      batchSaved: (total, saved) => `共 ${total} 个标签页，其中 ${saved} 个已经保存过——确认后会一并移进你选的项目`,
      batchNew: (total) => `共 ${total} 个标签页，选好项目后就会开始逐个保存`, pages: (n) => `查看将要保存的 ${n} 个网页`,
      newMove: "输入新项目名，回车直接移入", newSave: "输入新项目名，回车直接保存进去", inbox: "等待整理",
      processing: "正在处理…", createMove: (name) => `新建「${name}」并移入`, createSave: (name) => `新建「${name}」并保存`,
      moveTo: (name) => `移动到「${name}」`, saveTo: (name) => `保存到「${name}」`, createFailed: "新建项目失败，请重试。",
      failed: "操作失败，请重试。"
    };

    const HOST_ID = "lateron-folder-picker";
    const stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();

    // 主题：跟着设置走；设置为「跟随系统」时看系统偏好。
    const themeSetting = data.theme || "light";
    const prefersDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const dark = themeSetting === "dark" || (themeSetting !== "light" && prefersDark);

    let folders = Array.isArray(data.folders) ? data.folders.slice() : [];
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const savedCount = Number(data.savedCount) || 0;
    let selected = typeof data.selected === "string" ? data.selected : "";
    let busy = false;
    let closed = false;

    const host = document.createElement("div");
    host.id = HOST_ID;
    // 双保险：内联 !important 能压过页面自己的样式表，保证浮层不被页面搞变形。
    host.style.setProperty("all", "initial", "important");

    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = buildStyle();
    shadow.appendChild(style);

    // 品牌标识（图标 + LaterOn）只在「整屏弹窗」里出现——那是网页里 Alt+1 收藏时弹的那个，
    // 用户需要它说明这是谁弹的窗。贴按钮的浮层（收藏库卡片上点「所属项目」）不出这一行：
    // 人已经在收藏库里了，顶部再写一遍品牌纯属重复，还把项目列表往下挤了一截。
    const brandHtml = isPopover
      ? ""
      : `<div class="lon-brand"><img class="lon-logo" src="${chrome.runtime.getURL("icon128.png")}" width="34" height="34" alt="" />LaterOn</div>`;

    const root = document.createElement("div");
    root.className = "lon-root" + (isPopover ? " lon-popover" : "");
    if (dark) root.setAttribute("data-dark", "1");
    root.innerHTML = `
      <div class="lon-backdrop"></div>
      <div class="lon-panel" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="lateron-picker-title">
        <header>
          ${brandHtml}
          <h2 class="lon-title" id="lateron-picker-title"></h2>
          <p class="lon-summary"></p>
        </header>
        <details class="lon-pages">
          <summary><span class="lon-chev">▸</span><span class="lon-pages-label"></span></summary>
          <ul class="lon-page-list"></ul>
        </details>
        <div class="lon-box">
          <div class="lon-folders" role="radiogroup" aria-label="${copy.projects}">
            <div class="lon-folder-list"></div>
            <input class="lon-new-input" maxlength="28" placeholder="" aria-label="${copy.newProject}" />
          </div>
        </div>
        <footer class="lon-foot">
          <button type="button" class="lon-ghost">${copy.cancel}</button>
          <button type="button" class="lon-primary"></button>
        </footer>
      </div>
    `;
    shadow.appendChild(root);
    document.documentElement.appendChild(host);

    const $ = (selector) => root.querySelector(selector);
    const panel = $(".lon-panel");
    const summaryEl = $(".lon-summary");
    const pagesLabel = $(".lon-pages-label");
    const pageList = $(".lon-page-list");
    const folderList = $(".lon-folder-list");
    const newForm = $(".lon-new");
    const newInput = $(".lon-new-input");
    const confirmBtn = $(".lon-primary");
    const cancelBtn = $(".lon-ghost");

    // 标题 / 摘要 / 页面清单：浮层（改卡片项目）和整屏弹窗（收藏网页）文案不同。
    if (isPopover) {
      $(".lon-title").textContent = data.titleText || copy.moveTitle;
      summaryEl.textContent = "";
      $(".lon-pages").hidden = true;
    } else {
      const single = pages.length <= 1;
      // 整屏弹窗的默认标题；单篇收藏时再换成更具体的那句。
      $(".lon-title").textContent = copy.saveTitle;
      if (single) {
        $(".lon-title").textContent = copy.saveSingleTitle;
        summaryEl.textContent = savedCount > 0 ? copy.singleSaved : copy.singleNew;
        $(".lon-pages").hidden = true;
      } else {
        summaryEl.textContent = savedCount > 0 ? copy.batchSaved(pages.length, savedCount) : copy.batchNew(pages.length);
      }
    }
    pagesLabel.textContent = copy.pages(pages.length);
    pages.forEach((page, index) => {
      const li = document.createElement("li");
      const no = document.createElement("span");
      no.className = "lon-page-no";
      no.textContent = String(index + 1);
      const title = document.createElement("span");
      title.className = "lon-page-title";
      title.textContent = page.title || page.url;
      title.title = page.url || "";
      li.append(no, title);
      pageList.append(li);
    });

    newInput.placeholder = isPopover ? copy.newMove : copy.newSave;

    // 输入框里写下的新项目名（空 = 用上面选中的那个项目）。
    const pendingNewName = () => newInput.value.trim();
    const selectedName = () => {
      if (!selected) return copy.inbox;
      return folders.find((folder) => folder.id === selected)?.name || copy.inbox;
    };
    const applyLabel = () => {
      const name = pendingNewName();
      if (name) {
        confirmBtn.textContent = busy
          ? copy.processing
          : (isPopover ? copy.createMove(name) : copy.createSave(name));
      } else {
        confirmBtn.textContent = busy
          ? copy.processing
          : (isPopover ? copy.moveTo(selectedName()) : copy.saveTo(selectedName()));
      }
    };

    // 没有封面时的占位缩略图：用项目名首字做一个色块，视觉上仍是「图板缩略图」而不是文件夹。
    function makePlaceholder(name) {
      const span = document.createElement("span");
      span.className = "lon-folder-ph";
      span.textContent = (name || "·").trim().slice(0, 1);
      return span;
    }

    // HTTPS 页面不能加载 HTTP 封面，尤其是 127.0.0.1 这类地址不会被浏览器自动升级。
    // 先在创建 img 之前过滤掉不安全来源，避免触发 Mixed Content 请求和控制台告警。
    function isSafeCoverSource(value) {
      const source = String(value || "").trim();
      if (!source) return false;
      try {
        const parsed = new URL(source, document.baseURI);
        if (["https:", "data:", "blob:", "chrome-extension:", "moz-extension:"].includes(parsed.protocol)) {
          return true;
        }
        return parsed.protocol === "http:" && window.location.protocol !== "https:";
      } catch {
        return false;
      }
    }

    const renderFolders = () => {
      folderList.replaceChildren();
      folders.forEach((folder) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `lon-folder${selected === folder.id ? " is-selected" : ""}`;
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", selected === folder.id ? "true" : "false");

        const icon = document.createElement("span");
        icon.className = "lon-folder-icon";
        if (isSafeCoverSource(folder.cover)) {
          const img = document.createElement("img");
          img.className = "lon-folder-thumb";
          img.src = folder.cover;
          img.alt = "";
          img.loading = "lazy";
          // 封面加载失败（比如远程图被防盗链挡掉）就退回占位色块，不会留个破图。
          img.addEventListener("error", () => icon.replaceChildren(makePlaceholder(folder.name)));
          icon.append(img);
        } else {
          icon.append(makePlaceholder(folder.name));
        }
        const name = document.createElement("span");
        name.className = "lon-folder-name";
        name.textContent = folder.name;
        const count = document.createElement("strong");
        count.className = "lon-folder-count";
        count.textContent = String(folder.count || 0);
        const tick = document.createElement("span");
        tick.className = "lon-folder-tick";
        tick.textContent = "✓";
        button.append(icon, name, count, tick);

        button.addEventListener("click", () => {
          newInput.value = "";
          selected = folder.id;
          renderFolders();
        });
        button.addEventListener("dblclick", () => {
          selected = folder.id;
          renderFolders();
          submitSelection();
        });
        folderList.append(button);
      });
      applyLabel();
    };

    // ── 播放守卫：浮层开着的时候，网页里的视频不该被我们的按键打断 ──────
    // 为什么光拦事件还不够：视频网站的「空格 = 播放/暂停」很可能挂在 window 的捕获阶段，
    // 而且是页面加载时就注册好的 —— 比浮层的监听早，stopPropagation 拦不住；
    // 再加上 Shadow DOM 会把事件目标改写成浮层的根宿主，
    // 网站那句「焦点在输入框里就不响应快捷键」的判断也会失效。
    // 所以这里补最后一道：浮层还开着时被意外暂停的视频，立刻恢复播放。
    let keepPlaying = new WeakSet();
    const rememberPlaying = () => {
      document.querySelectorAll("video, audio").forEach((media) => {
        if (!media.paused && !media.ended) keepPlaying.add(media);
      });
    };
    const onMediaPause = (event) => {
      const media = event.target;
      if (closed || !media || !keepPlaying.has(media)) return;
      if (media.ended) { keepPlaying.delete(media); return; }
      try {
        const playing = media.play?.();
        if (playing && typeof playing.catch === "function") playing.catch(() => {});
      } catch {
        // 播不回去就算了，不能因为这里把浮层搞坏。
      }
    };
    const onMediaEnded = (event) => { keepPlaying.delete(event.target); };
    rememberPlaying();
    window.addEventListener("pause", onMediaPause, true);
    window.addEventListener("ended", onMediaEnded, true);

    const positionPanel = () => {
      if (!isPopover || !data.anchor) return;
      const rect = data.anchor.getBoundingClientRect();
      const pw = panel.offsetWidth || 360;
      const ph = panel.offsetHeight || 360;
      // 优先放在按钮下方；放不下就翻到上方。水平方向贴着按钮左缘并夹在视口内。
      let top = rect.bottom + 8;
      if (top + ph > window.innerHeight - 8) top = rect.top - ph - 8;
      if (top < 8) top = 8;
      let left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - pw - 8));
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
    };

    const close = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("keyup", onKeyup, true);
      window.removeEventListener("keydown", onPopoverKeydown, true);
      window.removeEventListener("scroll", positionPanel, true);
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("pause", onMediaPause, true);
      window.removeEventListener("ended", onMediaEnded, true);
      keepPlaying = new WeakSet();
      root.classList.remove("is-in");
      root.classList.add("is-out");
      window.setTimeout(() => host.remove(), 260);
    };

    // 输入框里写了新项目名 → 先建项目，再应用进去。
    const resolveProjectId = async () => {
      const name = pendingNewName();
      if (!name) return { ok: true, projectId: selected || null };
      const create = data.onCreateProject || defaultCreateProject;
      const project = await create(name);
      if (!project || !project.id) return { ok: false, error: copy.createFailed };
      if (!folders.some((folder) => folder.id === project.id)) {
        folders = [...folders, { id: project.id, name: project.name, count: 0 }];
      }
      selected = project.id;
      renderFolders();
      return { ok: true, projectId: project.id };
    };

    const submitSelection = async () => {
      if (busy || closed) return;
      busy = true;
      confirmBtn.disabled = true;
      applyLabel();
      const target = await resolveProjectId();
      if (!target.ok) {
        busy = false;
        confirmBtn.disabled = false;
        applyLabel();
        summaryEl.textContent = target.error;
        return;
      }
      // onPick 返回 { ok:false, error } 表示这次没成功（比如这一批已经被处理过），
      // 留在浮层里说明原因，让用户再操作一次；其余情况（成功 / 没返回值）直接关掉。
      let result;
      try {
        result = data.onPick ? await data.onPick(target.projectId, selectedName()) : null;
      } catch (error) {
        result = { ok: false, error: (error && error.message) || copy.failed };
      }
      if (result && result.ok === false) {
        busy = false;
        confirmBtn.disabled = false;
        applyLabel();
        if (result.error) summaryEl.textContent = result.error;
        return;
      }
      close();
    };

    const cancel = async () => {
      if (busy || closed) return;
      busy = true;
      if (data.onCancel) { try { await data.onCancel(); } catch { /* 取消失败也不拦着关掉 */ } }
      close();
    };

    // 键盘事件统一在捕获阶段处理：比页面自己的快捷键听得早，抢得到；
    // 用 composedPath 判断焦点是否在浮层的输入框里（Shadow DOM 里的 target 会被重定向）。
    const typingInInput = (event) => event.composedPath().includes(newInput);

    function onKeydown(event) {
      if (closed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
      if (typingInInput(event)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        submitSelection();
        return;
      }
      if (event.key !== "Tab") event.preventDefault();
      event.stopPropagation();
    }

    function onKeyup(event) {
      if (closed || typingInInput(event)) return;
      event.stopPropagation();
    }

    // 浮层（贴着卡片按钮）只拦 Esc：其余按键照常放行给网页/扩展页，
    // 否则会误伤页面里正在打字的搜索框等。输入框自己的按键在下面那一层就地兜住。
    function onPopoverKeydown(event) {
      if (closed) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    }

    // 输入框里的正常打字：事件在输入框这一层就地拦住、不再往外传。
    const swallowTyping = (event) => event.stopPropagation();
    newInput.addEventListener("keyup", swallowTyping);
    newInput.addEventListener("keypress", swallowTyping);
    newInput.addEventListener("input", () => { if (!busy) applyLabel(); });
    newInput.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) { swallowTyping(event); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        submitSelection();
        return;
      }
      swallowTyping(event);
    });

    confirmBtn.addEventListener("click", submitSelection);
    cancelBtn.addEventListener("click", cancel);
    $(".lon-backdrop").addEventListener("click", cancel);

    if (isPopover) {
      window.addEventListener("keydown", onPopoverKeydown, true);
      // 滚动 / 缩放时跟着按钮重新定位，别留在原地。
      window.addEventListener("scroll", positionPanel, true);
      window.addEventListener("resize", positionPanel);
    } else {
      window.addEventListener("keydown", onKeydown, true);
      window.addEventListener("keyup", onKeyup, true);
    }

    renderFolders();
    if (isPopover) positionPanel();
    panel.focus({ preventScroll: true });
    // 入场动画：下一帧再加类，保证 transition 生效。
    window.requestAnimationFrame(() => root.classList.add("is-in"));

    return { close };
  }

  function buildStyle() {
    return `
      :host { all: initial; }
      .lon-root, .lon-root *, .lon-root *::before, .lon-root *::after { box-sizing: border-box; }
      .lon-root {
        position: fixed; inset: 0; z-index: 2147483600;
        display: flex; align-items: center; justify-content: center;
        padding: 24px; overflow: auto;
        font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 14px; font-weight: 400; line-height: 1.5;
        letter-spacing: normal; word-spacing: normal; text-align: left;
        text-transform: none; text-indent: 0; white-space: normal; direction: ltr;
        color: var(--lon-ink); -webkit-font-smoothing: antialiased;
        --lon-card: #fdfcfa;
        --lon-ink: #171614;
        --lon-muted: #8a857c;
        --lon-subtle: #aaa69d;
        --lon-line: #e8e5dd;
        --lon-field: #ffffff;
        --lon-soft: #f1f0eb;
        --lon-soft-hover: #e7e5df;
        --lon-accent: #ff5c35;
        --lon-accent-soft: #fff1ec;
        --lon-panel-shadow: 0 34px 80px -24px rgba(15,13,10,.5), 0 8px 26px -10px rgba(15,13,10,.2);
        --lon-btn-shadow: 0 8px 20px -8px rgba(255,79,46,.9);
      }
      .lon-root[data-dark="1"] {
        --lon-card: #211f1d;
        --lon-ink: #f3f1ec;
        --lon-muted: #9a958c;
        --lon-subtle: #857f76;
        --lon-line: rgba(255,255,255,.1);
        --lon-field: #2a2725;
        --lon-soft: #2f2c29;
        --lon-soft-hover: #38342f;
        --lon-accent: #ff6a45;
        --lon-accent-soft: #3a241d;
        --lon-panel-shadow: 0 34px 80px -24px rgba(0,0,0,.82), 0 8px 26px -10px rgba(0,0,0,.55);
      }
      .lon-backdrop {
        position: absolute; inset: 0;
        background: rgba(20,18,14,.44);
        -webkit-backdrop-filter: blur(4px) saturate(130%);
        backdrop-filter: blur(4px) saturate(130%);
        opacity: 0; transition: opacity .22s ease;
      }
      .lon-panel {
        position: relative; display: flex; flex-direction: column; gap: 15px;
        width: min(432px, 100%); max-height: min(648px, calc(100vh - 48px));
        padding: 24px 24px 20px;
        border: 1px solid var(--lon-line); border-radius: 22px;
        background: var(--lon-card); box-shadow: var(--lon-panel-shadow);
        opacity: 0; transform: translateY(12px) scale(.97);
        transition: opacity .24s ease, transform .3s cubic-bezier(.2,.8,.3,1);
        outline: none;
      }
      .lon-root.is-in .lon-backdrop { opacity: 1; }
      .lon-root.is-in .lon-panel { opacity: 1; transform: none; }
      .lon-root.is-out .lon-backdrop { opacity: 0; }
      .lon-root.is-out .lon-panel { opacity: 0; transform: translateY(8px) scale(.98); }

      .lon-brand { display: flex; align-items: center; gap: 10px; color: var(--lon-muted); font-size: 13.5px; font-weight: 700; letter-spacing: .2px; }
      .lon-logo {
        display: block; width: 34px; height: 34px; border-radius: 9px;
        box-shadow: 0 6px 16px -6px rgba(255,80,50,.6);
      }
      .lon-title { margin: 12px 0 0; font-size: 20px; font-weight: 800; letter-spacing: -.4px; line-height: 1.3; color: var(--lon-ink); }
      .lon-summary { margin: 7px 0 0; color: var(--lon-muted); font-size: 12.5px; line-height: 1.6; }

      .lon-pages { border: 1px solid var(--lon-line); border-radius: 14px; background: var(--lon-soft); padding: 10px 13px; }
      .lon-pages[hidden] { display: none; }
      .lon-pages > summary { display: flex; align-items: center; gap: 7px; cursor: pointer; color: var(--lon-muted); font-size: 12.5px; font-weight: 650; list-style: none; }
      .lon-pages > summary::-webkit-details-marker { display: none; }
      .lon-chev { color: var(--lon-subtle); font-size: 10px; transition: transform .18s ease; }
      .lon-pages[open] .lon-chev { transform: rotate(90deg); }
      .lon-page-list { display: flex; flex-direction: column; gap: 5px; margin: 10px 0 2px; padding: 0 2px 0 0; list-style: none; max-height: 112px; overflow: auto; }
      .lon-page-list li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.5; }
      .lon-page-no { flex: none; min-width: 15px; color: var(--lon-subtle); font-size: 10.5px; font-weight: 700; text-align: right; }
      .lon-page-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--lon-ink); opacity: .82; }

      .lon-box { display: flex; flex-direction: column; gap: 9px; min-height: 0; }
      .lon-box-label { margin: 0; color: var(--lon-subtle); font-size: 10.5px; font-weight: 750; letter-spacing: 1px; text-transform: uppercase; }
      .lon-folders { display: flex; flex-direction: column; gap: 6px; max-height: 230px; overflow: auto; padding: 2px; margin: -2px; }
      .lon-folder-list { display: flex; flex-direction: column; gap: 6px; }
      .lon-folder {
        display: flex; align-items: center; gap: 11px; width: 100%;
        border: 1px solid var(--lon-line); border-radius: 13px; padding: 11px 13px;
        background: var(--lon-field); color: var(--lon-ink);
        font-family: inherit; font-size: 13.5px; text-align: left; cursor: pointer;
        transition: background .15s, border-color .15s, box-shadow .15s, transform .12s;
      }
      .lon-folder:hover { background: var(--lon-soft); }
      .lon-folder:active { transform: scale(.992); }
      .lon-folder.is-selected { border-color: var(--lon-accent); background: var(--lon-accent-soft); box-shadow: 0 0 0 3px rgba(255,92,53,.1); }
      .lon-folder-icon { display: block; flex: none; width: 30px; height: 30px; border-radius: 9px; overflow: hidden; background: transparent; }
      .lon-folder-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
      .lon-folder-ph { width: 100%; height: 100%; display: grid; place-items: center; border-radius: 9px; background: linear-gradient(140deg, #ffd9cc, #ffb39a); color: #fff; font-size: 13px; font-weight: 800; }
      .lon-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 650; }
      .lon-folder-count { flex: none; color: var(--lon-subtle); font-size: 11.5px; font-weight: 700; }
      .lon-folder-tick { flex: none; width: 14px; color: var(--lon-accent); font-size: 13px; font-weight: 800; opacity: 0; transition: opacity .15s; }
      .lon-folder.is-selected .lon-folder-tick { opacity: 1; }

      .lon-new-input {
        width: 100%; border: 1px solid var(--lon-line); border-radius: 12px; padding: 11px 13px;
        background: var(--lon-field); color: var(--lon-ink);
        font-family: inherit; font-size: 13px; outline: none;
        transition: border-color .15s, box-shadow .15s;
      }
      .lon-new-input::placeholder { color: var(--lon-subtle); }
      .lon-new-input:focus { border-color: var(--lon-accent); box-shadow: 0 0 0 3px rgba(255,92,53,.14); }

      .lon-hint { margin: 0; color: var(--lon-subtle); font-size: 11.5px; text-align: center; }
      .lon-foot { display: flex; gap: 10px; }
      .lon-foot button {
        border-radius: 14px; padding: 12px; font-family: inherit; font-size: 13.5px; cursor: pointer;
        transition: filter .15s, background .15s, transform .12s;
      }
      .lon-ghost { flex: 1; border: 1px solid var(--lon-line); background: transparent; color: var(--lon-ink); font-weight: 650; }
      .lon-ghost:hover { background: var(--lon-soft); }
      .lon-primary {
        flex: 1.7; border: 0; background: linear-gradient(140deg, #ff7a52, #ff4f2e);
        color: #fff; font-weight: 750; box-shadow: var(--lon-btn-shadow);
      }
      .lon-primary:hover:not(:disabled) { filter: brightness(1.05); }
      .lon-primary:active:not(:disabled) { transform: scale(.985); }
      .lon-primary:disabled { opacity: .62; cursor: default; box-shadow: none; }

      .lon-folders::-webkit-scrollbar, .lon-page-list::-webkit-scrollbar { width: 8px; }
      .lon-folders::-webkit-scrollbar-thumb, .lon-page-list::-webkit-scrollbar-thumb { border-radius: 99px; background: var(--lon-line); }
      .lon-folders::-webkit-scrollbar-track, .lon-page-list::-webkit-scrollbar-track { background: transparent; }

      /* ── 浮层（贴着卡片按钮）：没有灰色遮罩、定位在按钮旁边 ── */
      .lon-root.lon-popover {
        display: block; padding: 0; pointer-events: none;
      }
      .lon-root.lon-popover .lon-backdrop {
        background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none;
        opacity: 1; pointer-events: auto; transition: none;
      }
      .lon-root.lon-popover .lon-panel {
        position: absolute; pointer-events: auto;
        width: min(360px, calc(100vw - 16px));
        max-height: min(560px, calc(100vh - 16px));
      }
      /* 浮层没有品牌标识那一行了，标题的上边距是当初用来跟它拉开距离的，一起收掉，
         否则顶部会白留 12px。 */
      .lon-root.lon-popover .lon-title { margin-top: 0; }

      @media (max-width: 460px) {
        .lon-root { padding: 12px; }
        .lon-panel { gap: 12px; padding: 18px 16px 14px; border-radius: 18px; }
        .lon-title { font-size: 18px; }
      }
    `;
  }

  window.openFolderPicker = openFolderPicker;
})();
