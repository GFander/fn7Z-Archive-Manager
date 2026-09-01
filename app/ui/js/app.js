/* fn7z 前端主逻辑（双窗格） */
"use strict";

const API_BASE = "/app/fn7z/api";

const $ = (id) => document.getElementById(id);

/* ---------------- 工具函数 ---------------- */

function isArchivePath(name) {
  return /\.(7z|zip|rar|tar|gz|bz2|xz|tgz|tbz2|txz|zst|lz4|lzma|cab|iso|jar|war|apk)$/i.test(
    name
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function typeName(entry) {
  if (entry.isDir) return "文件夹";
  const ext = (entry.name.split(".").pop() || "").toUpperCase();
  return ext ? `${ext} 文件` : "文件";
}

let toastTimer = null;
function toast(message, isError = false) {
  const t = $("toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

async function api(path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.success === false) {
    throw new Error(data.error || `请求失败 (${resp.status})`);
  }
  return data;
}

/* 流式 API：压缩/解压时接收 SSE 进度事件 */
async function apiStream(path, body, onProgress) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`请求失败 (${resp.status})`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return await new Promise((resolve, reject) => {
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop();
          for (const part of parts) {
            const lines = part.split("\n");
            const evtLine = lines.find((l) => l.startsWith("event: "));
            const dataLine = lines.find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            let data;
            try {
              data = JSON.parse(dataLine.slice(6));
            } catch {
              continue;
            }
            const event = evtLine ? evtLine.slice(7) : "";
            if (event === "progress") {
              if (onProgress) onProgress(data);
            } else if (event === "done") {
              resolve(data);
              return;
            } else if (event === "error") {
              reject(new Error(data.error || "操作失败"));
              return;
            }
          }
        }
        reject(new Error("连接中断，请重试"));
      } catch (err) {
        reject(err);
      }
    })();
  });
}

function formatBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n,
    i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/* ---------------- 操作进度条 ---------------- */

function showProgress(title, hint) {
  $("progressTitle").textContent = title;
  $("progressPercent").textContent = "0%";
  $("progressHint").textContent = hint || "";
  $("progressFill").style.width = "0%";
  $("progressOverlay").classList.remove("hidden");
}

function updateProgress(data) {
  const p = Math.max(0, Math.min(100, Number(data.percent) || 0));
  $("progressFill").style.width = p + "%";
  $("progressPercent").textContent = p + "%";
  if (data.hint) $("progressHint").textContent = data.hint;
}

function hideProgress() {
  $("progressOverlay").classList.add("hidden");
}

/* ---------------- 窗格工厂 ---------------- */

function createPane(side) {
  const pane = {
    side,
    el: $(side === "left" ? "paneLeft" : "paneRight"),
    listBody: null,
    pathInput: null,
    searchInput: null,
    rootsBar: null,
    selectAll: null,
    state: {
      mode: "browse",
      cwd: "",
      parent: "",
      roots: [],
      entries: [],
      archiveItems: [],
      archivePath: "",
      archiveDir: "",
      archiveDirStack: [],
      selected: new Set(),
      history: [],
    },
  };

  pane.listBody = pane.el.querySelector(".pane-list");
  pane.pathInput = pane.el.querySelector(".pane-path");
  pane.searchInput = pane.el.querySelector(".pane-search");
  pane.rootsBar = pane.el.querySelector(".pane-roots");
  pane.selectAll = pane.el.querySelector(".pane-select-all");

  pane.currentViewRows = function () {
    const filter = pane.searchInput.value.trim().toLowerCase();
    const rows =
      pane.state.mode === "archive"
        ? pane.currentArchiveItems()
        : pane.state.entries;
    return filter
      ? rows.filter((e) => e.name.toLowerCase().includes(filter))
      : rows;
  };

  pane.currentArchiveItems = function () {
    const prefix = pane.state.archiveDir;
    const items = [];
    const seenDirs = new Set();

    for (const it of pane.state.archiveItems) {
      const rel = it.path.replace(/\/+$/, "");
      if (prefix) {
        if (rel === prefix) continue;
        if (!rel.startsWith(prefix + "/")) continue;
      }
      const isDir = Boolean(it.isDir) || /\/$/.test(String(it.path || ""));
      const rest = prefix ? rel.slice(prefix.length + 1) : rel;
      const slash = rest.indexOf("/");

      if (slash === -1) {
        if (isDir) {
          const dirPath = prefix ? `${prefix}/${rest}` : rest;
          seenDirs.add(dirPath);
          items.push({
            name: rest + "/",
            path: it.path,
            isDir: true,
            size: null,
            sizeText: "--",
            mtime: it.mtime,
            icon: "folder",
          });
        } else {
          items.push(it);
        }
      } else {
        const dirName = rest.slice(0, slash);
        const dirPath = prefix ? `${prefix}/${dirName}` : dirName;
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          items.push({
            name: dirName + "/",
            path: dirPath,
            isDir: true,
            size: null,
            sizeText: "--",
            mtime: "",
            icon: "folder",
          });
        }
      }
    }

    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
    return items;
  };

  pane.syncSelectAll = function () {
    const rows = pane.currentViewRows();
    pane.selectAll.checked =
      rows.length > 0 &&
      rows.every((e) => pane.state.selected.has(e.path || e.name));
  };

  pane.onRowCheck = function (checkbox) {
    const key = checkbox.dataset.key;
    if (checkbox.checked) pane.state.selected.add(key);
    else pane.state.selected.delete(key);
    const row = checkbox.closest("tr");
    if (row) row.classList.toggle("selected", checkbox.checked);
    pane.syncSelectAll();
    updateStatusText();
    updateButtons();
  };

  pane.renderRows = function () {
    const filter = pane.searchInput.value.trim().toLowerCase();
    const rows =
      pane.state.mode === "archive"
        ? pane.currentArchiveItems()
        : pane.state.entries;
    const visible = filter
      ? rows.filter((e) => e.name.toLowerCase().includes(filter))
      : rows;

    pane.listBody.innerHTML = "";
    if (!visible.length) {
      const tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = `<td colspan="5">${
        filter ? "没有匹配项" : "（空）"
      }</td>`;
      pane.listBody.appendChild(tr);
      markRowKinds(pane);
      return;
    }

    for (const entry of visible) {
      const tr = document.createElement("tr");
      tr.className = entry.isDir ? "folder-row" : "";
      if (pane.state.selected.has(entry.path || entry.name)) {
        tr.classList.add("selected");
      }

      const key = entry.path || entry.name;
      const icon =
        entry.icon === "folder" ? "📁" : entry.icon === "archive" ? "🗜" : "📄";
      const checked = pane.state.selected.has(key) ? " checked" : "";

      tr.innerHTML = `
        <td><input type="checkbox" class="row-check" data-key="${escapeHtml(key)}"${checked}></td>
        <td><span class="file-icon">${icon}</span><span class="file-name">${escapeHtml(
        entry.name
      )}</span></td>
        <td class="col-size">${escapeHtml(entry.sizeText || "--")}</td>
        <td class="col-type">${escapeHtml(typeName(entry))}</td>
        <td class="col-time">${escapeHtml(entry.mtime || "--")}</td>
      `;

      tr.addEventListener("click", (ev) => {
        if (ev.target.closest(".row-check")) return;
        const ck = tr.querySelector(".row-check");
        ck.checked = !ck.checked;
        pane.onRowCheck(ck);
      });

      tr.addEventListener("dblclick", () => {
        if (pane.state.mode === "browse") {
          if (entry.isDir) {
            pane.navigateTo(entry.path);
          } else if (isArchivePath(entry.name)) {
            pane.openArchive(entry.path);
          }
        } else if (entry.isDir) {
          pane.navigateArchiveDir(entry.path);
        }
      });

      // 拖放源
      tr.setAttribute("draggable", "true");
      tr.addEventListener("dragstart", (ev) => {
        const sel = [...pane.state.selected];
        const key = entry.path || entry.name;
        const all =
          pane.state.mode === "archive"
            ? pane.currentArchiveItems()
            : pane.state.entries;
        const items = sel.includes(key)
          ? sel
              .map((k) => all.find((e) => (e.path || e.name) === k))
              .filter(Boolean)
          : [entry];
        ev.dataTransfer.setData(
          "application/x-fn7z",
          JSON.stringify({
            side: pane.side,
            mode: pane.state.mode,
            items: items.map((it) => ({
              path: it.path || it.name,
              name: it.name,
              isDir: Boolean(it.isDir),
              icon: it.icon,
            })),
          })
        );
        ev.dataTransfer.effectAllowed = "copy";
      });

      const ck = tr.querySelector(".row-check");
      ck.addEventListener("change", () => pane.onRowCheck(ck));
      pane.listBody.appendChild(tr);
    }
    pane.syncSelectAll();
    markRowKinds(pane);
  };

  pane.renderRoots = function () {
    if (!pane.state.roots.length) {
      pane.rootsBar.classList.add("hidden");
      pane.rootsBar.innerHTML = "";
      return;
    }
    pane.rootsBar.classList.remove("hidden");
    pane.rootsBar.innerHTML = "";
    for (const root of pane.state.roots) {
      const chip = document.createElement("button");
      chip.className = "root-chip";
      chip.textContent = root;
      chip.title = `进入 ${root}`;
      chip.addEventListener("click", () => pane.navigateTo(root));
      pane.rootsBar.appendChild(chip);
    }
  };

  pane.navigateTo = async function (dirPath, pushHistory = true) {
    try {
      const data = await api("/list-dir", { path: dirPath });
      if (pushHistory) {
        pane.state.history.push(pane.state.cwd);
        if (pane.state.history.length > 200) pane.state.history.shift();
      }
      pane.state.mode = "browse";
      pane.state.cwd = data.cwd;
      pane.state.parent = data.parent;
      pane.state.roots = data.roots || [];
      pane.state.entries = data.entries || [];
      pane.state.archiveItems = [];
      pane.state.archivePath = "";
      pane.state.archiveDir = "";
      pane.state.archiveDirStack = [];
      pane.state.selected.clear();
      pane.pathInput.value = pane.state.cwd;
      pane.selectAll.checked = false;
      pane.renderRoots();
      pane.renderRows();
      updateStatusText();
      updateButtons();
    } catch (err) {
      toast(err.message, true);
    }
  };

  pane.openArchive = async function (path) {
    try {
      const data = await api("/archive/list", { path });
      pane.state.mode = "archive";
      pane.state.archivePath = data.archive;
      pane.state.archiveItems = data.items || [];
      pane.state.archiveDir = "";
      pane.state.archiveDirStack = [];
      pane.state.entries = [];
      pane.state.selected.clear();
      pane.pathInput.value = data.archive;
      pane.selectAll.checked = false;
      pane.renderRoots();
      pane.renderRows();
      updateStatusText();
      updateButtons();
    } catch (err) {
      toast(err.message, true);
    }
  };

  pane.navigateArchiveDir = function (dirPath) {
    pane.state.archiveDirStack.push(pane.state.archiveDir);
    pane.state.archiveDir = dirPath.replace(/\/+$/, "");
    pane.state.selected.clear();
    pane.pathInput.value = `${pane.state.archivePath} > ${pane.state.archiveDir}/`;
    pane.renderRows();
    updateStatusText();
    updateButtons();
  };

  pane.archiveGoUp = function () {
    const prev = pane.state.archiveDirStack.pop();
    if (prev !== undefined) {
      pane.state.archiveDir = prev;
      pane.state.selected.clear();
      pane.pathInput.value =
        prev === ""
          ? pane.state.archivePath
          : `${pane.state.archivePath} > ${prev}/`;
      pane.renderRows();
      updateStatusText();
      updateButtons();
      return true;
    }
    return false;
  };

  pane.goBack = function () {
    if (pane.state.mode === "archive") {
      if (pane.archiveGoUp()) return;
      const dir = pane.state.archivePath
        ? pane.state.archivePath.substring(
            0,
            pane.state.archivePath.lastIndexOf("/")
          )
        : "";
      if (dir) {
        pane.navigateTo(dir, false);
        return;
      }
    }
    const prev = pane.state.history.pop();
    if (prev) {
      pane.navigateTo(prev, false);
    } else {
      pane.navigateTo(pane.state.cwd || "", false);
    }
  };

  pane.refresh = function () {
    if (pane.state.mode === "archive") {
      const dir = pane.state.archiveDir;
      pane.openArchive(pane.state.archivePath).then(() => {
        if (dir) {
          pane.state.archiveDir = dir;
          pane.renderRows();
        }
      });
    } else {
      pane.navigateTo(pane.state.cwd, false);
    }
  };

  return pane;
}

/* ---------------- 窗格实例与活动窗格 ---------------- */

const paneLeft = createPane("left");
const paneRight = createPane("right");
let activePane = paneLeft;

function otherPane(pane) {
  return pane === paneLeft ? paneRight : paneLeft;
}

function setActivePane(pane) {
  if (activePane === pane) return;
  activePane = pane;
  paneLeft.el.classList.toggle("active-pane", paneLeft === pane);
  paneLeft.el.classList.toggle("inactive-pane", paneLeft !== pane);
  paneRight.el.classList.toggle("active-pane", paneRight === pane);
  paneRight.el.classList.toggle("inactive-pane", paneRight !== pane);
  updateStatusText();
  updateButtons();
}

/* 删除/拖放等改动后，两个窗格都刷新，保持同目录内容同步 */
function refreshAllPanes() {
  paneLeft.refresh();
  paneRight.refresh();
}

/* 工具栏按钮启用/禁用状态（作用于活动窗格） */
function updateButtons() {
  const s = activePane.state;
  const inArchive = s.mode === "archive";
  const hasSelection = (activePane.currentViewRows() || []).some((e) =>
    activePane.state.selected.has(e.path || e.name)
  );

  $("btnDelete").disabled = !hasSelection;
  $("btnExtract").disabled = !inArchive;
  $("btnTest").disabled = !inArchive;
  $("btnOpenArchive").disabled = inArchive;
  $("btnBack").disabled = false;
}

/* ---------------- 状态栏 ---------------- */

function updateStatusText() {
  const p = activePane;
  const s = p.state;
  const info = $("statusInfo");
  const hint = $("paneHint");
  hint.textContent = `当前活动：${p.side === "left" ? "左" : "右"}窗格（点击切换）`;

  if (s.mode === "archive") {
    const current = p.currentArchiveItems();
    const total = current
      .filter((i) => !i.isDir)
      .reduce((sum, i) => sum + (i.size || 0), 0);
    info.textContent =
      `压缩包：${s.archivePath}${s.archiveDir ? " > " + s.archiveDir : ""}` +
      ` ｜ 已选择 ${s.selected.size} 项 ｜ 共 ${current.length} 项` +
      ` ｜ 文件总大小 ${formatBytes(total)}`;
  } else {
    const total = s.entries
      .filter((e) => !e.isDir)
      .reduce((sum, e) => sum + (e.size || 0), 0);
    info.textContent =
      `已选择 ${s.selected.size} 项 ｜ 共 ${s.entries.length} 项 ｜ 文件总大小 ${formatBytes(total)}`;
  }
}

/* ---------------- 行标记（供拖放目标识别） ---------------- */

function markRowKinds(pane) {
  for (const tr of pane.listBody.querySelectorAll("tr")) {
    if (tr.classList.contains("empty-row")) continue;
    const name = tr.querySelector(".file-name")?.textContent || "";
    const icon = tr.querySelector(".file-icon")?.textContent || "";
    const isDir = icon === "📁";
    if (pane.state.mode === "browse") {
      tr.dataset.kind = isDir
        ? "folder"
        : isArchivePath(name)
        ? "archive-file"
        : "file";
      tr.dataset.entry = JSON.stringify({
        path:
          pane.state.entries.find((e) => e.name === name)?.path || name,
      });
    } else {
      tr.dataset.kind = isDir ? "archive-dir" : "file";
      tr.dataset.entry = JSON.stringify({
        path:
          pane.currentArchiveItems().find((e) => e.name === name)?.path || name,
      });
    }
  }
}

/* ---------------- 拖放处理 ---------------- */

function resolveDropTarget(pane, ev) {
  const row = ev.target.closest("tr[data-kind]");
  if (row) {
    return {
      kind: row.dataset.kind,
      entry: JSON.parse(row.dataset.entry || "null"),
    };
  }
  return { kind: "current", entry: null };
}

function parseDragPayload(ev) {
  const raw = ev.dataTransfer.getData("application/x-fn7z");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleDrop(pane, ev) {
  const src = parseDragPayload(ev);
  if (!src) return false;
  ev.preventDefault();

  const target = resolveDropTarget(pane, ev);
  const dstState = pane.state;
  const srcPane = src.side === "left" ? paneLeft : paneRight;
  const srcState = srcPane.state;

  let dstPath = "";
  let dstIsArchive = false;
  let dstArchivePath = "";
  let dstInsideDir = "";

  if (target.kind === "folder") {
    dstPath = target.entry.path;
  } else if (target.kind === "archive-file") {
    dstIsArchive = true;
    dstArchivePath = target.entry.path;
  } else if (target.kind === "archive-dir") {
    dstIsArchive = true;
    dstArchivePath = dstState.archivePath;
    dstInsideDir = target.entry.path;
  } else {
    if (dstState.mode === "archive") {
      dstIsArchive = true;
      dstArchivePath = dstState.archivePath;
      dstInsideDir = dstState.archiveDir;
    } else {
      dstPath = dstState.cwd;
    }
  }

  const srcItems = src.items || [];
  if (!srcItems.length) return true;

  try {
    if (!dstIsArchive && src.mode === "browse") {
      await api("/copy", {
        sources: srcItems.map((i) => i.path),
        dest_dir: dstPath,
      });
      toast(`已复制 ${srcItems.length} 项到 ${dstPath}`);
      refreshAllPanes();
    } else if (!dstIsArchive && src.mode === "archive") {
      showProgress("正在解压...", dstPath);
      await apiStream(
        "/archive/extract-items",
        {
          path: srcState.archivePath,
          items: srcItems.map((i) => ({ path: i.path, is_dir: i.isDir })),
          output_dir: dstPath,
        },
        updateProgress
      );
      hideProgress();
      toast(`已解压 ${srcItems.length} 项到 ${dstPath}`);
      refreshAllPanes();
    } else if (dstIsArchive && src.mode === "archive") {
      if (srcState.archivePath === dstArchivePath && srcPane === pane) {
        toast("不能拖到同一个压缩包内", true);
        return true;
      }
      showProgress("正在合并到压缩包...", dstArchivePath);
      await apiStream(
        "/archive/merge",
        {
          src_archive: srcState.archivePath,
          dst_archive: dstArchivePath,
          items: srcItems.map((i) => ({ path: i.path, is_dir: i.isDir })),
          dest_path: dstInsideDir,
        },
        updateProgress
      );
      hideProgress();
      toast(`已合并 ${srcItems.length} 项到 ${dstArchivePath}`);
      refreshAllPanes();
    } else if (dstIsArchive && src.mode === "browse") {
      showProgress("正在压入压缩包...", dstArchivePath);
      await apiStream(
        "/archive/add-items",
        {
          path: dstArchivePath,
          sources: srcItems.map((i) => i.path),
          dest_path: dstInsideDir,
        },
        updateProgress
      );
      hideProgress();
      toast(`已压缩 ${srcItems.length} 项到 ${dstArchivePath}`);
      refreshAllPanes();
    }
  } catch (err) {
    hideProgress();
    toast(err.message, true);
  }
  return true;
}

function setupDragDrop(pane) {
  pane.el.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    pane.el.classList.add("drop-target");
    const row = ev.target.closest("tr[data-kind]");
    pane.el
      .querySelectorAll("tr.drag-over")
      .forEach((r) => r.classList.remove("drag-over"));
    if (row) row.classList.add("drag-over");
  });
  pane.el.addEventListener("dragleave", (ev) => {
    if (!pane.el.contains(ev.relatedTarget)) {
      pane.el.classList.remove("drop-target");
      pane.el
        .querySelectorAll("tr.drag-over")
        .forEach((r) => r.classList.remove("drag-over"));
    }
  });
  pane.el.addEventListener("drop", async (ev) => {
    pane.el.classList.remove("drop-target");
    pane.el
      .querySelectorAll("tr.drag-over")
      .forEach((r) => r.classList.remove("drag-over"));
    await handleDrop(pane, ev);
  });
}

/* ---------------- 工具栏 / 模态框（作用于活动窗格） ---------------- */

function openModal(title, buildBody, onConfirm) {
  $("modalTitle").textContent = title;
  const body = $("modalBody");
  body.innerHTML = "";
  buildBody(body);
  $("modal").classList.remove("hidden");

  const confirmBtn = $("modalConfirm");
  const cancelBtn = $("modalCancel");
  const cleanup = () => {
    $("modal").classList.add("hidden");
    confirmBtn.removeEventListener("click", onConfirm);
    cancelBtn.removeEventListener("click", cleanup);
  };
  cancelBtn.addEventListener("click", cleanup);
  confirmBtn.addEventListener("click", () => {
    try {
      onConfirm(cleanup);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function fieldRow(label, controlHtml) {
  return `<div class="form-group"><label>${escapeHtml(label)}</label>${controlHtml}</div>`;
}

function showExtractModal() {
  const p = activePane;
  openModal(
    "解压设置",
    (body) => {
      body.innerHTML =
        fieldRow(
          "解压到目录",
          `<input type="text" id="modalOutDir" placeholder="默认解压到压缩包所在目录">`
        ) +
        fieldRow(
          "密码（可选）",
          `<input type="password" id="modalPassword" placeholder="加密压缩包请输入密码">`
        ) +
        `<div class="hint-text">目标目录必须是已授权目录。默认使用压缩包所在目录。</div>`;
    },
    async (cleanup) => {
      const outDir = $("modalOutDir").value.trim();
      const password = $("modalPassword").value;
      showProgress("正在解压...", outDir || "解压到压缩包所在目录");
      try {
        const data = await apiStream(
          "/archive/extract",
          {
            path: p.state.archivePath,
            output_dir: outDir || undefined,
            password: password || undefined,
          },
          updateProgress
        );
        hideProgress();
        toast(`解压完成 → ${data.output}`);
        cleanup();
        refreshAllPanes();
      } catch (err) {
        hideProgress();
        toast(err.message, true);
      }
    }
  );
}

function showCreateModal() {
  const p = activePane;
  const selected = p.state.entries.filter((e) =>
    p.state.selected.has(e.path)
  );
  const defaultOutput = `${p.state.cwd.replace(/\/+$/, "")}/archive-${
    new Date().toISOString().slice(0, 10)
  }.7z`;
  openModal(
    "压缩设置",
    (body) => {
      body.innerHTML =
        fieldRow(
          "源文件/目录",
          `<input type="text" id="modalSources" value="${escapeHtml(
            selected.map((e) => e.path).join(", ") || p.state.cwd
          )}" readonly>`
        ) +
        fieldRow(
          "输出压缩包路径",
          `<input type="text" id="modalOutput" value="${escapeHtml(
            defaultOutput
          )}">`
        ) +
        `<div class="form-row">` +
        fieldRow(
          "格式",
          `<select id="modalFormat">
            <option value="7z" selected>7z</option>
            <option value="zip">zip</option>
            <option value="tar">tar</option>
            <option value="gzip">tar.gz</option>
            <option value="bzip2">tar.bz2</option>
            <option value="xz">tar.xz</option>
          </select>`
        ) +
        fieldRow(
          "压缩级别",
          `<select id="modalLevel">
            <option value="0">0 - 仅存储</option>
            <option value="1">1 - 最快</option>
            <option value="3">3 - 快速</option>
            <option value="5" selected>5 - 标准</option>
            <option value="7">7 - 最大</option>
            <option value="9">9 - 极限</option>
          </select>`
        ) +
        `</div>` +
        fieldRow(
          "密码（可选）",
          `<input type="password" id="modalPassword" placeholder="加密压缩包请输入密码">`
        ) +
        `<div class="hint-text">未选择任何文件时默认压缩当前目录全部内容。输出路径必须在已授权目录内。</div>`;
    },
    async (cleanup) => {
      const output = $("modalOutput").value.trim();
      if (!output) {
        toast("请填写输出压缩包路径", true);
        return;
      }
      const format = $("modalFormat").value;
      const sources = selected.length
        ? selected.map((e) => e.path)
        : [p.state.cwd];
      showProgress("正在压缩...", output);
      try {
        await apiStream(
          "/archive/create",
          {
            sources,
            output,
            format,
            level: $("modalLevel").value,
            password: $("modalPassword").value || undefined,
          },
          updateProgress
        );
        hideProgress();
        toast(`压缩完成 → ${output}`);
        cleanup();
        refreshAllPanes();
      } catch (err) {
        hideProgress();
        toast(err.message, true);
      }
    }
  );
}

function showTestModal() {
  const p = activePane;
  openModal(
    "测试压缩包",
    (body) => {
      body.innerHTML = `<div class="hint-text">正在测试：${escapeHtml(
        p.state.archivePath
      )}</div><pre id="testOutput" style="margin-top:10px;max-height:260px;overflow:auto;font-size:12px;background:#f5f7fa;padding:10px;border-radius:8px;white-space:pre-wrap;"></pre>`;
    },
    async (cleanup) => {
      $("statusInfo").textContent = "正在测试压缩包完整性...";
      try {
        const data = await api("/archive/test", { path: p.state.archivePath });
        $("testOutput").textContent =
          data.output || (data.ok ? "测试通过" : "测试失败");
        toast(data.ok ? "✅ 测试通过" : "❌ 测试失败：压缩包可能已损坏", !data.ok);
        cleanup();
      } catch (err) {
        toast(err.message, true);
      }
    }
  );
}

function deleteSelected() {
  const p = activePane;
  const s = p.state;
  const inArchive = s.mode === "archive";
  const selected = (inArchive ? p.currentArchiveItems() : s.entries).filter(
    (i) => p.state.selected.has(i.path || i.name)
  );
  if (!selected.length) return;
  const names = selected.map((i) => i.name || i.path);

  openModal(
    "确认删除",
    (body) => {
      body.innerHTML = `<div class="hint-text">${
        inArchive
          ? `将从压缩包中删除以下 ${selected.length} 项：`
          : `将从文件系统中永久删除以下 ${selected.length} 项（不可恢复）：`
      }</div><ul style="margin:10px 0 0 18px;font-size:13px;">${names
        .slice(0, 20)
        .map((f) => `<li>${escapeHtml(f)}</li>`)
        .join("")}${
        names.length > 20 ? `<li>… 等 ${names.length} 项</li>` : ""
      }</ul>`;
    },
    async (cleanup) => {
      $("statusInfo").textContent = "正在删除...";
      try {
        if (inArchive) {
          await api("/archive/delete", {
            path: s.archivePath,
            files: selected.map((i) => i.path || i.name),
          });
          toast(`已从压缩包删除 ${selected.length} 项`);
        } else {
          await api("/delete", {
            paths: selected.map((i) => i.path),
          });
          toast(`已删除 ${selected.length} 项`);
        }
        cleanup();
        refreshAllPanes();
      } catch (err) {
        toast(err.message, true);
      }
    }
  );
}

function promptOpenArchive() {
  openModal(
    "打开压缩包",
    (body) => {
      body.innerHTML =
        fieldRow(
          "压缩包路径",
          `<input type="text" id="modalArchivePath" placeholder="例如：/vol1/下载/archive.7z">`
        ) +
        `<div class="hint-text">支持 7z / zip / rar / tar / gz / bz2 / xz 等格式。路径必须在已授权目录内。</div>`;
    },
    (cleanup) => {
      const p = $("modalArchivePath").value.trim();
      if (!p) {
        toast("请输入压缩包路径", true);
        return;
      }
      cleanup();
      activePane.openArchive(p);
    }
  );
}

/* ---------------- 事件绑定 ---------------- */

$("btnBack").addEventListener("click", () => activePane.goBack());
$("btnRefresh").addEventListener("click", () => activePane.refresh());
$("btnHome").addEventListener("click", () => activePane.navigateTo(""));
$("btnOpenArchive").addEventListener("click", promptOpenArchive);
$("btnExtract").addEventListener("click", showExtractModal);
$("btnCreate").addEventListener("click", showCreateModal);
$("btnTest").addEventListener("click", showTestModal);
$("btnDelete").addEventListener("click", deleteSelected);

for (const p of [paneLeft, paneRight]) {
  p.el.addEventListener("mousedown", () => setActivePane(p));
  p.el.addEventListener("focusin", () => setActivePane(p));

  p.pathInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      const path = p.pathInput.value.trim();
      if (!path) return;
      const m = path.match(/^(.+?)\s*>\s*(.+)$/);
      if (m) {
        p.openArchive(m[1].trim());
      } else if (isArchivePath(path)) {
        p.openArchive(path);
      } else {
        p.navigateTo(path);
      }
    }
  });

  p.searchInput.addEventListener("input", () => p.renderRows());

  p.selectAll.addEventListener("change", (ev) => {
    const rows = p.currentViewRows();
    if (ev.target.checked) {
      for (const e of rows) p.state.selected.add(e.path || e.name);
    } else {
      for (const e of rows) p.state.selected.delete(e.path || e.name);
    }
    p.renderRows();
    updateStatusText();
    updateButtons();
  });

  setupDragDrop(p);
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("modal").classList.contains("hidden")) {
    $("modal").classList.add("hidden");
  }
});

/* ---------------- 初始化 ---------------- */

document.addEventListener("DOMContentLoaded", async () => {
  if (activePane === paneLeft) {
    paneLeft.el.classList.add("active-pane");
    paneRight.el.classList.add("inactive-pane");
    updateButtons();
  } else {
    setActivePane(paneLeft);
  }
  try {
    const health = await api("/health");
    $("userInfo").textContent = `引擎 /usr/trim/bin/7zz ｜ 授权目录 ${
      (health.authorizedRoots || []).length
    } 个`;
  } catch {
    $("userInfo").textContent = "引擎 /usr/trim/bin/7zz";
  }
  await paneLeft.navigateTo("");
  await paneRight.navigateTo("");
  $("statusInfo").textContent =
    "就绪 - 双击文件夹进入，双击压缩包打开；可从一侧拖拽到另一侧";
});

/* 暴露内部句柄（便于测试与调试，不影响功能） */
window.__fn7z = {
  paneLeft,
  paneRight,
  updateButtons,
  refreshAllPanes,
  setActivePane,
  otherPane,
  get activePane() {
    return activePane;
  },
};
