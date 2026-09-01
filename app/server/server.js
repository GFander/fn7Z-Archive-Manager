#!/usr/bin/env node
/*
 * fn7z 后端服务
 *
 * 以飞牛 fnOS 统一网关方式运行：
 *   - 监听 ${TRIM_APPDEST}/app.sock (Unix Socket)
 *   - 请求路径前缀为 /app/fn7z
 *   - 网关校验登录态后转发，并附带 X-Trim-* 用户上下文 Header
 *
 * 引擎：调用系统自带 /usr/trim/bin/7zz（可用 FN7Z_7ZZ 覆盖）。
 * 安全：所有路径必须位于授权根目录（TRIM_DATA_ACCESSIBLE_PATHS /
 *       TRIM_DATA_SHARE_PATHS / TRIM_PKGHOME）内；7zz 一律以参数数组调用。
 */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

const APP_DEST = process.env.TRIM_APPDEST || "/var/apps/fn7z/target";
const PKG_VAR = process.env.TRIM_PKGVAR || "/var/apps/fn7z/var";
const PKG_HOME = process.env.TRIM_PKGHOME || "";
const APPNAME = process.env.TRIM_APPNAME || "fn7z";
const GATEWAY_PREFIX = process.env.FN7Z_GATEWAY_PREFIX || `/app/${APPNAME}`;
const SOCKET_PATH =
  process.env.FN7Z_SOCKET_PATH || path.join(APP_DEST, "app.sock");
const UI_DIR =
  process.env.FN7Z_UI_DIR || path.join(APP_DEST, "ui");

const SEVEN_Z =
  process.env.FN7Z_7ZZ ||
  (fs.existsSync("/usr/trim/bin/7zz") ? "/usr/trim/bin/7zz" : "7zz");

const MAX_BODY = 2 * 1024 * 1024; // 2MB
const TIMEOUT_LIST = 30 * 1000;
const TIMEOUT_TEST = 120 * 1000;
const TIMEOUT_OP = 10 * 60 * 1000;

/* ---------------- 路径安全 ---------------- */

function splitPaths(value) {
  if (!value) return [];
  return String(value)
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function listAuthorizedRoots() {
  const roots = [];
  for (const p of splitPaths(process.env.TRIM_DATA_ACCESSIBLE_PATHS)) {
    roots.push({ root: path.resolve(p), source: "user-authorized" });
  }
  for (const p of splitPaths(process.env.TRIM_DATA_SHARE_PATHS)) {
    roots.push({ root: path.resolve(p), source: "data-share" });
  }
  if (PKG_HOME) {
    roots.push({ root: path.resolve(PKG_HOME), source: "package-home" });
  }
  // 去重
  const seen = new Set();
  return roots.filter((r) => {
    if (seen.has(r.root)) return false;
    seen.add(r.root);
    return true;
  });
}

function resolveAuthorized(relPath) {
  const roots = listAuthorizedRoots();
  const target = path.resolve(relPath);

  for (const { root } of roots) {
    if (target === root || target.startsWith(root + path.sep)) {
      return { target, root };
    }
  }

  return {
    error: `路径不在授权范围内：${relPath}。请在应用设置中授权目录后再访问。`,
  };
}

function defaultHome() {
  const roots = listAuthorizedRoots();
  return roots.length ? roots[0].root : os.homedir();
}

/* ---------------- 7zz 封装 ---------------- */

function run7zz(args, timeoutMs, options) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const opts = options || {};
    const onProgress = opts.onProgress || null;
    const progressRe = /(\d{1,3})%/g;
    let lastPercent = null;
    const feedProgress = (chunk) => {
      if (!onProgress) return;
      progressRe.lastIndex = 0;
      let m;
      while ((m = progressRe.exec(chunk)) !== null) {
        const p = parseInt(m[1], 10);
        if (Number.isFinite(p) && p >= 0 && p <= 100) lastPercent = p;
      }
      if (lastPercent !== null) onProgress(lastPercent);
    };

    const child = spawn(SEVEN_Z, args, {
      cwd: opts.cwd || os.tmpdir(),
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("7zz 操作超时"));
    }, timeoutMs || TIMEOUT_OP);

    child.stdout.on("data", (d) => {
      stdout += d;
      feedProgress(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      feedProgress(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `无法调用 7zz（${SEVEN_Z}）：${err.message}。请确认系统已安装 7-Zip。`
        )
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function copyPath(src, dest) {
  const st = await fs.promises.stat(src);
  if (st.isDirectory()) {
    await copyTree(src, dest);
  } else {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
  }
}

async function copyTree(src, dest) {
  const st = await fs.promises.stat(src);
  if (!st.isDirectory()) {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    return;
  }
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    await copyPath(path.join(src, ent.name), path.join(dest, ent.name));
  }
}

/* 递归查找目录中的第一个文件 */
async function findFirstFile(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isFile()) return full;
    if (ent.isDirectory()) {
      const found = await findFirstFile(full);
      if (found) return found;
    }
  }
  return null;
}

/* 在解压目录下查找与条目同名的目录；找不到则返回最深的第一层目录 */
async function findExtractedDir(root, wantName) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const recurse = async (dir) => {
    const sub = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of sub) {
      if (ent.isDirectory()) {
        const full = path.join(dir, ent.name);
        if (ent.name === wantName) return full;
        const found = await recurse(full);
        if (found) return found;
      }
    }
    return null;
  };
  const direct = await recurse(root);
  if (direct) return direct;
  for (const ent of entries) {
    if (ent.isDirectory()) return path.join(root, ent.name);
  }
  return null;
}

/* 检查目标压缩包及其所在目录是否可写，返回清晰的中文错误 */
async function assertWritableArchive(archivePath) {
  const dir = path.dirname(archivePath);
  try {
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `目标目录不可写：${dir}。请在应用设置中为该目录授权“读写”权限后再试。`
    );
  }
  try {
    await fs.promises.access(archivePath, fs.constants.W_OK);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(
        `目标压缩包文件不可写：${archivePath}。请检查文件权限（可能属于其他用户），或在应用设置中重新授权“读写”。`
      );
    }
  }
}

/* 把 7zz 的常见错误转成可读的中文提示 */
function translate7zzError(stderr, fallback) {
  const msg = String(stderr || "").trim() || fallback;
  if (/errno\s*=\s*13|permission denied/i.test(msg)) {
    return "写入被拒绝（权限不足）。目标压缩包或其所在目录对应用用户不可写，请在应用设置中授权“读写”权限，或检查文件/目录权限后重试。";
  }
  return msg;
}

/* 解析 `7zz l -ba -slt` 的结构化输出 */
function parseSlt(output) {
  const items = [];
  let current = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith("Path = ")) {
      if (current) items.push(current);
      current = { Path: line.slice(7) };
    } else if (current) {
      const idx = line.indexOf(" = ");
      if (idx > 0) {
        current[line.slice(0, idx)] = line.slice(idx + 3);
      }
    }
  }
  if (current) items.push(current);
  return items;
}

function formatSize(bytes) {
  if (bytes === "") return "--";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* 兼容不同 7zz 版本的目录标记：Folder=+ / Attributes=D / 路径尾斜杠 */
function isSltDir(it) {
  return (
    it.Folder === "+" ||
    /^\s*D\b/.test(it.Attributes || "") ||
    /\/$/.test(String(it.Path || ""))
  );
}

function archiveIcon(name) {
  return /\.(7z|zip|rar|tar|gz|bz2|xz|tgz|tbz2|txz|zst|lz4|lzma|cab|iso|jar|war|apk)$/i.test(
    name
  )
    ? "archive"
    : "file";
}

/* ---------------- 文件系统操作 ---------------- */

async function listDirectory(dirPath) {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const out = [];

  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dirPath, ent.name);
    try {
      const st = await fs.promises.stat(full);
      out.push({
        name: ent.name,
        path: full,
        isDir: ent.isDirectory() || st.isDirectory(),
        size: st.isDirectory() ? null : st.size,
        sizeText: st.isDirectory() ? "--" : formatSize(st.size),
        mtime: st.mtime.toISOString().slice(0, 19).replace("T", " "),
        icon: st.isDirectory() ? "folder" : archiveIcon(ent.name),
      });
    } catch {
      // 无权限或已消失的条目跳过
    }
  }

  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return out;
}

/* ---------------- HTTP 处理 ---------------- */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("无效的 JSON 请求体"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { success: false, error: message });
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isStreamRequest(req) {
  return String(req.headers.accept || "").includes("text/event-stream");
}

function startSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function getUserId(req) {
  return req.headers["x-trim-userid"] || "local";
}

function requireAuthOrLocal(req, res, next) {
  // 统一网关已经校验登录态；本地直连调试时放行（仅监听本机 socket）
  next();
}

function parseArchiveRequest(body) {
  const checked = resolveAuthorized(body.path || "");
  if (checked.error) throw new Error(checked.error);
  return checked.target;
}

async function handleApi(req, res, urlPath) {
  if (urlPath === "/health" && req.method === "GET") {
    return sendJson(res, 200, {
      success: true,
      app: APPNAME,
      status: "ok",
      authorizedRoots: listAuthorizedRoots().map((r) => r.root),
    });
  }

  if (req.method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  const body = await readJsonBody(req);

  if (urlPath === "/list-dir") {
    const checked = resolveAuthorized(body.path || defaultHome());
    if (checked.error) return sendError(res, 403, checked.error);
    try {
      const entries = await listDirectory(checked.target);
      return sendJson(res, 200, {
        success: true,
        cwd: checked.target,
        parent: path.dirname(checked.target),
        roots: listAuthorizedRoots().map((r) => r.root),
        entries,
      });
    } catch (err) {
      return sendError(res, 500, `读取目录失败：${err.message}`);
    }
  }

  /* 文件系统间复制 */
  if (urlPath === "/copy") {
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return sendError(res, 400, "请指定要复制的文件或目录");
    }
    const destChecked = resolveAuthorized(body.dest_dir || "");
    if (destChecked.error) return sendError(res, 403, destChecked.error);
    const sources = [];
    for (const src of body.sources) {
      const c = resolveAuthorized(src);
      if (c.error) return sendError(res, 403, `${src}: ${c.error}`);
      sources.push(c.target);
    }
    try {
      for (const src of sources) {
        await copyPath(src, path.join(destChecked.target, path.basename(src)));
      }
      return sendJson(res, 200, { success: true, dest: destChecked.target });
    } catch (err) {
      return sendError(res, 500, `复制失败：${err.message}`);
    }
  }

  /* 文件系统删除（只在授权范围内） */
  if (urlPath === "/delete") {
    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      return sendError(res, 400, "请指定要删除的文件或目录");
    }
    const targets = [];
    for (const p of body.paths) {
      const c = resolveAuthorized(p);
      if (c.error) return sendError(res, 403, `${p}: ${c.error}`);
      if (c.target === c.root) {
        return sendError(res, 403, `不能删除授权根目录本身：${c.target}`);
      }
      targets.push(c.target);
    }
    try {
      for (const t of targets) {
        await fs.promises.rm(t, { recursive: true, force: true });
      }
      return sendJson(res, 200, { success: true, deleted: targets.length });
    } catch (err) {
      return sendError(res, 500, `删除失败：${err.message}`);
    }
  }

  if (urlPath === "/archive/list") {
    let archive;
    try {
      archive = parseArchiveRequest(body);
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    try {
      const r = await run7zz(["l", "-ba", "-slt", archive], TIMEOUT_LIST);
      if (r.code !== 0) {
        return sendError(res, 500, `7zz 列出失败：${r.stderr.trim() || "未知错误"}`);
      }
      const items = parseSlt(r.stdout).filter((it) => it.Path);

      // 目录识别：优先用 7zz 标记，再以“路径前缀”推断
      // （兼容 fnOS 上某些 7zz 版本完全不输出目录标记的情况）
      const dirFlags = new Map();
      const cleanPaths = items.map((it) =>
        String(it.Path).replace(/\/+$/, "")
      );
      for (const it of items) {
        const p = String(it.Path).replace(/\/+$/, "");
        dirFlags.set(p, isSltDir(it));
      }
      for (const p of cleanPaths) {
        if (dirFlags.get(p)) continue;
        if (cleanPaths.some((q) => q !== p && q.startsWith(p + "/"))) {
          dirFlags.set(p, true);
        }
      }

      const total = items
        .filter((it) => !dirFlags.get(String(it.Path).replace(/\/+$/, "")))
        .reduce(
        (sum, it) => sum + (Number(it.Size) || 0),
        0
      );
      return sendJson(res, 200, {
        success: true,
        archive,
        items: items.map((it) => {
          const p = String(it.Path).replace(/\/+$/, "");
          const isDir = dirFlags.get(p);
          return {
            name: path.basename(p),
            path: it.Path,
            isDir,
            size: isDir ? null : Number(it.Size) || 0,
            sizeText: isDir ? "--" : formatSize(it.Size),
            mtime: it.Modified || "--",
            icon: isDir ? "folder" : archiveIcon(it.Path),
          };
        }),
        totalText: formatSize(total),
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (urlPath === "/archive/extract") {
    let archive;
    try {
      archive = parseArchiveRequest(body);
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    const outChecked = resolveAuthorized(
      body.output_dir || path.dirname(archive)
    );
    if (outChecked.error) return sendError(res, 403, outChecked.error);

    const args = ["x", "-y", "-bsp1"];
    if (body.password) args.push(`-p${body.password}`);
    args.push(`-o${outChecked.target}`, archive);

    const streaming = isStreamRequest(req);
    if (streaming) startSse(res);
    try {
      const r = await run7zz(args, TIMEOUT_OP, {
        onProgress: streaming
          ? (p) => sendEvent(res, "progress", { percent: p })
          : null,
      });
      if (r.code !== 0) {
        if (streaming) {
          sendEvent(res, "error", {
            error: `解压失败：${translate7zzError(r.stderr, "未知错误")}`,
          });
          res.end();
          return;
        }
        return sendError(res, 500, `解压失败：${r.stderr.trim() || "未知错误"}`);
      }
      if (streaming) {
        sendEvent(res, "done", { success: true, output: outChecked.target });
        res.end();
        return;
      }
      return sendJson(res, 200, { success: true, output: outChecked.target });
    } catch (err) {
      if (streaming) {
        sendEvent(res, "error", { error: err.message });
        res.end();
        return;
      }
      return sendError(res, 500, err.message);
    }
  }

  if (urlPath === "/archive/create") {
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return sendError(res, 400, "请至少选择一个源文件/目录");
    }
    const outChecked = resolveAuthorized(body.output || "");
    if (outChecked.error) return sendError(res, 403, outChecked.error);

    const sources = [];
    for (const src of body.sources) {
      const c = resolveAuthorized(src);
      if (c.error) return sendError(res, 403, `${src}: ${c.error}`);
      sources.push(c.target);
    }

    const args = ["a", "-y", "-bsp1"];
    const level = Number(body.level);
    if (Number.isInteger(level) && level >= 0 && level <= 9) {
      args.push(`-mx${level}`);
    }
    const format = String(body.format || "7z");
    if (/^(7z|zip|tar|gzip|bzip2|xz)$/.test(format)) {
      args.push(`-t${format}`);
    }
    if (body.password) args.push(`-p${body.password}`);
    args.push(outChecked.target, ...sources);

    const streaming = isStreamRequest(req);
    if (streaming) startSse(res);
    try {
      const r = await run7zz(args, TIMEOUT_OP, {
        onProgress: streaming
          ? (p) => sendEvent(res, "progress", { percent: p })
          : null,
      });
      if (r.code !== 0) {
        if (streaming) {
          sendEvent(res, "error", {
            error: `压缩失败：${translate7zzError(r.stderr, "未知错误")}`,
          });
          res.end();
          return;
        }
        return sendError(res, 500, `压缩失败：${r.stderr.trim() || "未知错误"}`);
      }
      if (streaming) {
        sendEvent(res, "done", { success: true, output: outChecked.target });
        res.end();
        return;
      }
      return sendJson(res, 200, { success: true, output: outChecked.target });
    } catch (err) {
      if (streaming) {
        sendEvent(res, "error", { error: err.message });
        res.end();
        return;
      }
      return sendError(res, 500, err.message);
    }
  }

  if (urlPath === "/archive/test") {
    let archive;
    try {
      archive = parseArchiveRequest(body);
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    try {
      const r = await run7zz(["t", archive], TIMEOUT_TEST);
      const ok = r.code === 0;
      return sendJson(res, 200, {
        success: ok,
        ok,
        output: (r.stdout + r.stderr).trim(),
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  if (urlPath === "/archive/delete") {
    let archive;
    try {
      archive = parseArchiveRequest(body);
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return sendError(res, 400, "请选择要删除的文件");
    }
    try {
      const r = await run7zz(
        ["d", archive, ...body.files.map(String)],
        TIMEOUT_OP
      );
      if (r.code !== 0) {
        return sendError(res, 500, `删除失败：${r.stderr.trim() || "未知错误"}`);
      }
      return sendJson(res, 200, { success: true });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  /* 从压缩包中提取指定条目到文件系统目录 */
  if (urlPath === "/archive/extract-items") {
    let archive;
    try {
      archive = parseArchiveRequest(body);
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    const items = (Array.isArray(body.items) ? body.items : [])
      .filter((it) => it && it.path)
      .map((it) => ({ path: String(it.path), isDir: Boolean(it.is_dir) }));
    if (!items.length) {
      return sendError(res, 400, "请指定要提取的压缩包内条目");
    }
    const outChecked = resolveAuthorized(body.output_dir || path.dirname(archive));
    if (outChecked.error) return sendError(res, 403, outChecked.error);

    const streaming = isStreamRequest(req);
    if (streaming) startSse(res);
    const send = (event, data) => {
      if (streaming) sendEvent(res, event, data);
    };

    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fn7z-x-"));
    try {
      for (const item of items) {
        const itemTmp = await fs.promises.mkdtemp(path.join(tmp, "item-"));
        try {
          const r = item.isDir
            ? await run7zz(["x", "-y", "-bsp1", `-o${itemTmp}`, archive, item.path], TIMEOUT_OP, {
                onProgress: streaming ? (p) => send("progress", { percent: p }) : null,
              })
            : await run7zz(["e", "-y", "-bsp1", `-o${itemTmp}`, archive, item.path], TIMEOUT_OP, {
                onProgress: streaming ? (p) => send("progress", { percent: p }) : null,
              });
          if (r.code !== 0) {
            if (streaming) {
              send("error", {
                error: `提取失败：${translate7zzError(r.stderr, "未知错误")}`,
              });
              res.end();
              return;
            }
            return sendError(
              res,
              500,
              `提取失败：${translate7zzError(r.stderr, "未知错误")}`
            );
          }
          if (item.isDir) {
            // 7zz 解压保留相对路径，条目自身目录即 itemTmp/<item.path>
            let dirRoot = path.join(itemTmp, item.path);
            if (!(await fs.promises.stat(dirRoot).catch(() => null))?.isDirectory()) {
              dirRoot = await findExtractedDir(itemTmp, item.path.split("/").pop());
            }
            if (dirRoot) {
              await copyTree(dirRoot, path.join(outChecked.target, path.basename(dirRoot)));
            }
          } else {
            const file = await findFirstFile(itemTmp);
            if (file) await copyPath(file, path.join(outChecked.target, path.basename(file)));
          }
        } finally {
          fs.rmSync(itemTmp, { recursive: true, force: true });
        }
      }
      if (streaming) {
        send("done", { success: true, output: outChecked.target });
        res.end();
        return;
      }
      return sendJson(res, 200, { success: true, output: outChecked.target });
    } catch (err) {
      if (streaming) {
        send("error", { error: err.message });
        res.end();
        return;
      }
      throw err;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /* 把文件系统条目加入压缩包（可指定压缩包内目标路径） */
  if (urlPath === "/archive/add-items") {
    let archive;
    try {
      archive = parseArchiveRequest(body);
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return sendError(res, 400, "请指定要添加的文件或目录");
    }
    const destPath = String(body.dest_path || "").replace(/^\/+|\/+$/g, "");
    const sources = [];
    for (const src of body.sources) {
      const c = resolveAuthorized(src);
      if (c.error) return sendError(res, 403, `${src}: ${c.error}`);
      sources.push(c.target);
    }
    try {
      await assertWritableArchive(archive);
    } catch (err) {
      return sendError(res, 500, err.message);
    }

    const streaming = isStreamRequest(req);
    if (streaming) startSse(res);
    const send = (event, data) => {
      if (streaming) sendEvent(res, event, data);
    };

    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fn7z-a-"));
    try {
      if (destPath) {
        // 在临时目录中构造 destPath 结构，保持压缩包内相对路径
        const staging = path.join(tmp, "rel", destPath);
        await fs.promises.mkdir(staging, { recursive: true });
        for (const src of sources) {
          const name = path.basename(src);
          await copyPath(src, path.join(staging, name));
        }
        const r = await run7zz(
          ["a", "-y", "-bsp1", archive, "./" + destPath],
          TIMEOUT_OP,
          {
            cwd: path.join(tmp, "rel"),
            onProgress: streaming ? (p) => send("progress", { percent: p }) : null,
          }
        );
        if (r.code !== 0) {
          if (streaming) {
            send("error", {
              error: `添加失败：${translate7zzError(r.stderr, "未知错误")}`,
            });
            res.end();
            return;
          }
          return sendError(
            res,
            500,
            `添加失败：${translate7zzError(r.stderr, "未知错误")}`
          );
        }
      } else {
        // 直接添加到压缩包根目录
        const r = await run7zz(
          ["a", "-y", "-bsp1", archive, ...sources],
          TIMEOUT_OP,
          {
            onProgress: streaming ? (p) => send("progress", { percent: p }) : null,
          }
        );
        if (r.code !== 0) {
          if (streaming) {
            send("error", {
              error: `添加失败：${translate7zzError(r.stderr, "未知错误")}`,
            });
            res.end();
            return;
          }
          return sendError(
            res,
            500,
            `添加失败：${translate7zzError(r.stderr, "未知错误")}`
          );
        }
      }
      if (streaming) {
        send("done", { success: true, archive });
        res.end();
        return;
      }
      return sendJson(res, 200, { success: true, archive });
    } catch (err) {
      if (streaming) {
        send("error", { error: err.message });
        res.end();
        return;
      }
      throw err;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /* 压缩包 A 中的条目合并到压缩包 B（解压到临时目录 → 加入 B） */
  if (urlPath === "/archive/merge") {
    let srcArchive, dstArchive;
    try {
      srcArchive = parseArchiveRequest({ path: body.src_archive });
      dstArchive = parseArchiveRequest({ path: body.dst_archive });
    } catch (err) {
      return sendError(res, 403, err.message);
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return sendError(res, 400, "请指定要合并的压缩包内条目");
    }
    const destPath = String(body.dest_path || "").replace(/^\/+|\/+$/g, "");
    // items: [{ path, is_dir }]
    const items = body.items
      .filter((it) => it && it.path)
      .map((it) => ({
        path: String(it.path),
        isDir: Boolean(it.is_dir),
      }));
    if (!items.length) return sendError(res, 400, "请指定要合并的压缩包内条目");
    try {
      await assertWritableArchive(dstArchive);
    } catch (err) {
      return sendError(res, 500, err.message);
    }

    const streaming = isStreamRequest(req);
    if (streaming) startSse(res);
    const send = (event, data) => {
      if (streaming) sendEvent(res, event, data);
    };
    let mergeStage = 0; // 0=提取阶段(0-50%), 1=合并阶段(50-100%)
    const stageProgress = (p) => {
      send(
        "progress",
        mergeStage === 0
          ? { percent: Math.round(p / 2) }
          : { percent: Math.round(50 + p / 2) }
      );
    };

    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fn7z-m-"));
    try {
      const relRoot = path.join(tmp, "rel");
      const staging = destPath
        ? path.join(relRoot, destPath)
        : relRoot;
      await fs.promises.mkdir(staging, { recursive: true });

      for (const item of items) {
        const itemTmp = await fs.promises.mkdtemp(path.join(tmp, "item-"));
        try {
          const r1 = item.isDir
            ? await run7zz(
                ["x", "-y", "-bsp1", `-o${itemTmp}`, srcArchive, item.path],
                TIMEOUT_OP,
                { onProgress: streaming ? stageProgress : null }
              )
            : await run7zz(
                ["e", "-y", "-bsp1", `-o${itemTmp}`, srcArchive, item.path],
                TIMEOUT_OP,
                { onProgress: streaming ? stageProgress : null }
              );
          if (r1.code !== 0) {
            if (streaming) {
              send("error", {
                error: `从源压缩包提取失败：${translate7zzError(r1.stderr, "未知错误")}`,
              });
              res.end();
              return;
            }
            return sendError(
              res,
              500,
              `从源压缩包提取失败：${translate7zzError(r1.stderr, "未知错误")}`
            );
          }
          if (item.isDir) {
            // 目录：保留条目本身的名字/结构
            let dirRoot = path.join(itemTmp, item.path);
            if (!(await fs.promises.stat(dirRoot).catch(() => null))?.isDirectory()) {
              dirRoot = await findExtractedDir(itemTmp, item.path.split("/").pop());
            }
            if (dirRoot) {
              await copyTree(dirRoot, path.join(staging, path.basename(dirRoot)));
            }
          } else {
            // 文件：只取文件本体，放入目标路径（去掉父级目录）
            const file = await findFirstFile(itemTmp);
            if (file) {
              await copyPath(file, path.join(staging, path.basename(file)));
            }
          }
        } finally {
          fs.rmSync(itemTmp, { recursive: true, force: true });
        }
      }

      mergeStage = 1;
      if (destPath) {
        const r2 = await run7zz(
          ["a", "-y", "-bsp1", dstArchive, "./" + destPath],
          TIMEOUT_OP,
          { cwd: relRoot, onProgress: streaming ? stageProgress : null }
        );
        if (r2.code !== 0) {
          if (streaming) {
            send("error", {
              error: `合并失败：${translate7zzError(r2.stderr, "未知错误")}`,
            });
            res.end();
            return;
          }
          return sendError(
            res,
            500,
            `合并失败：${translate7zzError(r2.stderr, "未知错误")}`
          );
        }
      } else {
        const r2 = await run7zz(
          ["a", "-y", "-bsp1", dstArchive, "./"],
          TIMEOUT_OP,
          { cwd: relRoot, onProgress: streaming ? stageProgress : null }
        );
        if (r2.code !== 0) {
          if (streaming) {
            send("error", {
              error: `合并失败：${translate7zzError(r2.stderr, "未知错误")}`,
            });
            res.end();
            return;
          }
          return sendError(
            res,
            500,
            `合并失败：${translate7zzError(r2.stderr, "未知错误")}`
          );
        }
      }
      if (streaming) {
        send("done", { success: true, archive: dstArchive });
        res.end();
        return;
      }
      return sendJson(res, 200, { success: true, archive: dstArchive });
    } catch (err) {
      if (streaming) {
        send("error", { error: err.message });
        res.end();
        return;
      }
      throw err;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return sendError(res, 404, `未知接口：${urlPath}`);
}

/* ---------------- 静态资源 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(res, urlPath) {
  let rel = urlPath.replace(/^\/+/, "");
  if (!rel) rel = "index.html";
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(path.resolve(UI_DIR) + path.sep)) {
    return sendError(res, 403, "Forbidden");
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA 兜底：未匹配资源回退到 index.html
      if (!path.extname(rel)) {
        return fs.readFile(path.join(UI_DIR, "index.html"), (err2, html) => {
          if (err2) return sendError(res, 404, "Not Found");
          res.writeHead(200, {
            "Content-Type": MIME[".html"],
            "Content-Length": html.length,
          });
          res.end(html);
        });
      }
      return sendError(res, 404, "Not Found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

/* ---------------- 入口 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let urlPath = decodeURIComponent(url.pathname);

  if (urlPath.startsWith(GATEWAY_PREFIX)) {
    urlPath = urlPath.slice(GATEWAY_PREFIX.length) || "/";
  }

  requireAuthOrLocal(req, res, () => {});

  try {
    if (urlPath.startsWith("/api/")) {
      await handleApi(req, res, urlPath.slice("/api".length) || "/");
      return;
    }
    serveStatic(res, urlPath);
  } catch (err) {
    sendError(res, 500, err.message || "服务器内部错误");
  }
});

server.on("error", (err) => {
  console.error(`[fn7z] server error: ${err.message}`);
  process.exit(1);
});

fs.mkdirSync(APP_DEST, { recursive: true });
fs.mkdirSync(PKG_VAR, { recursive: true });
fs.rmSync(SOCKET_PATH, { force: true });

server.listen(SOCKET_PATH, () => {
  console.log(`[fn7z] listening on ${SOCKET_PATH}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    try {
      fs.rmSync(SOCKET_PATH, { force: true });
    } catch {}
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  process.exit(0);
});
