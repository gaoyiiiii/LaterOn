// 共享的自定义弹窗：取代浏览器原生 confirm / alert，视觉与「选项目」浮层一致。
// 页面需引入 dialog.css + dialog.js，然后：
//   const ok = await LaterOnDialog.confirm({ title: "删除项目？", message: "…", tone: "danger", confirmText: "删除" });
//   await LaterOnDialog.alert({ title: "已清空所有收藏", message: "…", tone: "success" });
//   // 带输入框的（改标题 / 摘要就用的这个）：
//   const result = await LaterOnDialog.prompt({
//     title: "编辑收藏信息",
//     fields: [
//       { name: "title", label: "标题", value: "原标题" },
//       { name: "description", label: "摘要", value: "原摘要", multiline: true }
//     ]
//   });
//   if (result.ok) save(result.values.title, result.values.description);
//   // 额外加一块「封面上传」（选本地图片，自动压缩后作为该字段的值返回）：
//   const result = await LaterOnDialog.prompt({
//     title: "编辑收藏信息",
//     fields: [ … ],
//     cover: { name: "cover", label: "封面", value: item.image || "" }
//   });
//   // result.values.cover 是 data URL（用户上传）、""（用户移除/本来没封面），或与传入的 value 相同（没动过）
//   // 如果传入的 value 不是「用户自己的封面」而是按内容自动取的一张（项目图板就是这样），
//   // 传 cover.derived = true：移除按钮会先禁用（没有自定义封面可移除），上传后自动放开。
// 也支持字符串简写：LaterOnDialog.confirm("确定删除吗？")
// 交互：回车确认（多行输入框里 ⌘/Ctrl + 回车）、Esc 取消、点遮罩取消；
// 同一时刻只显示一个弹窗（自动排队，不会互相叠加）。
(function () {
  const ICONS = {
    question: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.3 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.9 2.3-2.9 4.2M12 17.2h.01"/></svg>',
    danger: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9.4v4.4M12 17h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.4M12 7.6h.01"/></svg>',
    success: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m8.3 12.5 2.6 2.6 5-5.6"/></svg>'
  };
  const CLOSE_MS = 240;

  // ── 封面上传 ─────────────────────────────────────────────
  // 浏览器扩展的本地存储只有几 MB 的配额，一张手机照直接存进去很快就爆了。
  // 所以选中图片后先等比缩到最长边 720px、再压成 JPEG，单张大约 50–80KB。
  const COVER_MAX_EDGE = 720;
  const COVER_QUALITY = 0.72;
  const COVER_MAX_BYTES = 20 * 1024 * 1024;   // 超过 20MB 的原图直接拒绝，免得卡住页面
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("这张图读取失败，换一张试试"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("这个文件不是能显示的图片"));
        image.onload = () => {
          const scale = Math.min(1, COVER_MAX_EDGE / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height, 1));
          const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
          const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext && canvas.getContext("2d");
          if (!context) { reject(new Error("当前环境不支持处理图片")); return; }
          // 先铺白底：PNG 透明区域转成 JPEG 后会变黑。
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", COVER_QUALITY));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  let host = null;
  let panel = null;
  let iconEl = null;
  let titleEl = null;
  let messageEl = null;
  let fieldsEl = null;
  let coverEl = null;
  let coverValue = "";       // 封面区当前的值：data URL（上传了）或 ""（没封面/已移除）
  let fieldInputs = [];
  let hintEl = null;
  let okBtn = null;
  let cancelBtn = null;

  let current = null;   // 当前弹窗的配置
  let settle = null;    // 当前弹窗的收尾回调（为空表示没有弹窗在显示）
  let chain = Promise.resolve();

  function build() {
    if (host) return;
    const mount = document.body || document.documentElement;
    host = document.createElement("div");
    host.className = "lod-root";
    host.hidden = true;
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.innerHTML = [
      '<div class="lod-backdrop"></div>',
      '<div class="lod-panel" tabindex="-1">',
      '  <div class="lod-head">',
      '    <span class="lod-icon" aria-hidden="true"></span>',
      '    <div class="lod-copy">',
      '      <h2 class="lod-title"></h2>',
      '      <p class="lod-message"></p>',
      '    </div>',
      '  </div>',
      '  <div class="lod-fields" hidden></div>',
      '  <div class="lod-cover" hidden></div>',
      '  <p class="lod-hint"></p>',
      '  <div class="lod-foot">',
      '    <button type="button" class="lod-cancel">取消</button>',
      '    <button type="button" class="lod-ok">确定</button>',
      '  </div>',
      '</div>'
    ].join("");
    mount.append(host);

    panel = host.querySelector(".lod-panel");
    iconEl = host.querySelector(".lod-icon");
    titleEl = host.querySelector(".lod-title");
    messageEl = host.querySelector(".lod-message");
    fieldsEl = host.querySelector(".lod-fields");
    coverEl = host.querySelector(".lod-cover");
    hintEl = host.querySelector(".lod-hint");
    okBtn = host.querySelector(".lod-ok");
    cancelBtn = host.querySelector(".lod-cancel");

    host.querySelector(".lod-backdrop").addEventListener("click", () => {
      if (current?.cancelable) settleWith(false);
    });
    cancelBtn.addEventListener("click", () => settleWith(false));
    okBtn.addEventListener("click", () => settleWith(true));
    host.addEventListener("keydown", onKeydown, true);
  }

  function onKeydown(event) {
    if (!settle) return;
    if (event.key === "Escape") {
      if (!current?.cancelable) return;
      event.preventDefault();
      event.stopPropagation();
      settleWith(false);
      return;
    }
    const focusables = [...fieldInputs.map((entry) => entry.el), cancelBtn, okBtn]
      .filter((element) => element && !element.hidden);
    if (event.key === "Tab") {
      if (!focusables.length) return;
      const index = focusables.indexOf(document.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusables.length - 1 : index - 1)
        : (index === -1 || index === focusables.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusables[next].focus();
      return;
    }
    if (event.key === "Enter") {
      // 焦点已经在按钮上时交给按钮自己处理，避免触发两次。
      const active = document.activeElement;
      if (active === okBtn || active === cancelBtn) return;
      // 多行输入框里回车 = 换行（写摘要时要分段）；想直接保存按 ⌘/Ctrl + 回车。
      if (active?.tagName === "TEXTAREA" && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      settleWith(true);
    }
  }

  // 表单模式：按配置渲染一行行输入框（单行用 input，多行用 textarea）。
  function renderFields(fields) {
    fieldInputs = [];
    fieldsEl.replaceChildren();
    if (!fields?.length) { fieldsEl.hidden = true; return; }
    fieldsEl.hidden = false;
    fields.forEach((field) => {
      const wrap = document.createElement("label");
      wrap.className = "lod-field";
      const label = document.createElement("span");
      label.className = "lod-field-label";
      label.textContent = field.label || "";
      const control = document.createElement(field.multiline ? "textarea" : "input");
      if (!field.multiline) control.type = "text";
      control.className = field.multiline ? "lod-textarea" : "lod-input";
      control.dataset.field = field.name || "";
      control.value = String(field.value ?? "");
      if (field.placeholder) control.placeholder = field.placeholder;
      if (field.maxLength) control.maxLength = field.maxLength;
      if (field.multiline) control.rows = field.rows || 4;
      wrap.append(label, control);
      fieldsEl.append(wrap);
      fieldInputs.push({ name: field.name, el: control });
    });
  }

  // 封面区：左边一张小预览，右边「上传图片 / 移除封面」两个按钮。
  // config.cover = { name, label, value, derived }；不传就不显示这一块。
  // derived = true 表示 value 是「按内容自动取的门面图」（项目图板用的就是这个），
  // 不是用户自己传的那张 —— 这种封面没有「移除」的概念，所以移除按钮先禁用，
  // 等用户真的上传了一张自己的图，才让它变得可点。
  function renderCover(config) {
    coverEl.replaceChildren();
    coverValue = config?.value || "";
    if (!config) { coverEl.hidden = true; return; }
    coverEl.hidden = false;
    let custom = !config.derived;   // 预览里的这张图，是不是用户自己定的封面

    const label = document.createElement("span");
    label.className = "lod-field-label";
    label.textContent = config.label || "封面";

    const row = document.createElement("div");
    row.className = "lod-cover-row";

    const preview = document.createElement("div");
    preview.className = "lod-cover-preview";

    const actions = document.createElement("div");
    actions.className = "lod-cover-actions";
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "lod-cover-btn";
    pickBtn.textContent = "上传图片";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "lod-cover-btn is-plain";
    removeBtn.textContent = "移除封面";
    actions.append(pickBtn, removeBtn);

    const note = document.createElement("p");
    note.className = "lod-cover-note";
    note.textContent = config.note || "选一张本地图片，会自动压缩后保存（约 50–80KB）";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.hidden = true;

    function paint() {
      preview.replaceChildren();
      if (coverValue) {
        const img = document.createElement("img");
        img.src = coverValue;
        img.alt = "";
        preview.append(img);
        preview.classList.remove("is-empty");
      } else {
        preview.textContent = "无封面";
        preview.classList.add("is-empty");
      }
      // derived 的封面（按内容自动取的那张）没有「移除」的概念：
      // 移除之后还是它，按钮会骗人，所以那种情况直接禁用。
      removeBtn.disabled = !coverValue || !custom;
    }

    pickBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      // 清空 value，这样连续选同一个文件也会再次触发 change。
      fileInput.value = "";
      if (!file) return;
      if (file.size > COVER_MAX_BYTES) { note.textContent = "这张图太大了（超过 20MB），换一张小点的"; return; }
      pickBtn.disabled = true;
      pickBtn.textContent = "处理中…";
      note.textContent = "正在压缩…";
      try {
        coverValue = await compressImage(file);
        custom = true;
        paint();
        note.textContent = "已就绪，点「保存」生效";
      } catch (error) {
        note.textContent = error?.message || "这张图没能处理，换一张试试";
      } finally {
        pickBtn.disabled = false;
        pickBtn.textContent = "上传图片";
      }
    });
    removeBtn.addEventListener("click", () => {
      coverValue = "";
      custom = false;
      paint();
      // 移除之后会退回到什么，收藏条目和项目图板不一样：前者回到 Logo 占位，
      // 后者回到「按项目里的收藏自动取一张」，所以文案交给调用方定。
      note.textContent = config.removedNote || "已移除，点「保存」生效（会显示 LaterOn 图标占位）";
    });

    row.append(preview, actions);
    coverEl.append(label, row, note, fileInput);
    paint();
  }

  // 把表单里的当前内容收成一个 { 字段名: 值 } 对象。
  function readFields() {
    const values = {};
    for (const entry of fieldInputs) values[entry.name] = entry.el.value;
    return values;
  }

  function show(config, done) {
    build();
    current = config;
    settle = done;

    host.dataset.tone = config.tone === "danger" ? "danger" : "default";
    renderFields(config.fields);
    renderCover(config.cover);
    iconEl.innerHTML = ICONS[config.tone] || ICONS.question;
    titleEl.textContent = config.title;
    messageEl.textContent = config.message;
    messageEl.hidden = !config.message;
    okBtn.textContent = config.confirmText;
    cancelBtn.textContent = config.cancelText;
    cancelBtn.hidden = !config.cancelable;
    // 表单类弹窗（编辑标题/摘要、编辑项目等）默认不再显示底部快捷键提示，
    // 让界面更简洁；只有确认类弹窗保留「回车确认 · Esc 取消」。
    const isForm = !!(current?.fields || current?.cover);
    const fallback = isForm ? "" : (config.cancelable ? "回车确认 · Esc 取消" : "回车确认");
    hintEl.textContent = config.hint || fallback;
    hintEl.hidden = !hintEl.textContent;

    host.hidden = false;
    host.classList.remove("is-out", "is-in");
    const animate = () => host.classList.add("is-in");
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(animate);
    else window.setTimeout(animate, 16);
    // 有输入框时把光标放进第一个框并全选，方便直接改写；没有输入框才聚焦面板本体。
    const firstField = fieldInputs[0]?.el;
    if (firstField) {
      firstField.focus();
      if (typeof firstField.select === "function") firstField.select();
    } else if (typeof panel.focus === "function") {
      panel.focus();
    }
  }

  function settleWith(result) {
    if (!settle) return;
    const done = settle;
    const resolved = current;
    // 表单模式不返回布尔值，而是 { ok, values } —— 调用方要拿到用户填的内容。
    let values = null;
    if (resolved?.fields || resolved?.cover) values = result === true ? readFields() : null;
    // 封面不在输入框里，单独塞进结果：值是 data URL 或 ""（移除封面）。
    if (values && resolved?.cover) values[resolved.cover.name || "cover"] = coverValue;
    const value = (resolved?.fields || resolved?.cover)
      ? { ok: result === true, values }
      : result;
    settle = null;
    current = null;
    host.classList.remove("is-in");
    host.classList.add("is-out");
    window.setTimeout(() => {
      host.hidden = true;
      host.classList.remove("is-out");
      done(value);
      if (resolved?.onClose) resolved.onClose(value);
    }, CLOSE_MS);
  }

  function normalize(input, defaults) {
    const base = typeof input === "string" ? { message: input } : { ...(input || {}) };
    return {
      tone: "question",
      title: "",
      message: "",
      confirmText: "确定",
      cancelText: "取消",
      cancelable: true,
      hint: "",
      fields: null,
      cover: null,
      ...defaults,
      ...base
    };
  }

  function open(config) {
    const previous = chain;
    let release = () => {};
    chain = new Promise((resolve) => { release = resolve; });
    return previous.then(() => new Promise((resolve) => {
      try {
        show(config, (value) => {
          release();
          resolve(value);
        });
      } catch (error) {
        console.warn("弹窗显示失败", error);
        release();
        resolve(false);
      }
    }));
  }

  window.LaterOnDialog = {
    confirm: (input) => open(normalize(input, { tone: "question" })),
    alert: (input) => open(normalize(input, { tone: "info", cancelable: false, confirmText: "知道了" })),
    // 带输入框的弹窗。返回 { ok, values }：ok 表示点了确认，values 是 { 字段名: 内容 }。
    prompt: (input) => open(normalize(input, {
      tone: "info",
      confirmText: "保存"
    })),
    close: () => settleWith(false),
    isOpen: () => !!settle
  };
})();
