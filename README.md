# fn7Z-Archive-Manager

运行于飞牛 fnOS 的原生归档管理器，调用系统自带 `/usr/trim/bin/7zz` 作为压缩/解压引擎。

## 功能

- 浏览已授权目录（应用设置中授权目录，或 data-share 共享目录）
- 打开压缩包并列出内容（7z / zip / rar / tar / gz / bz2 / xz 等）
- 解压（可指定输出目录、密码）
- 压缩（格式、压缩级别、密码）
- 测试压缩包完整性
- 从压缩包中删除文件

## 技术方案

- 入口：飞牛统一网关（`/app/fn7z` → `target/app.sock`），登录态由网关校验
- 后端：Node.js（`nodejs_v22` 运行时依赖），零第三方依赖，监听 Unix Socket
- 前端：原生 HTML/CSS/JS，参照 Windows 7-Zip 界面布局与飞牛设计语言
- 权限：`run-as=package` 专用用户，路径白名单校验，7zz 参数数组调用（无 shell 拼接）

## 构建

```bash
fnpack build
```

生成 `fn7z.fpk`。

## 本地测试

模拟 fnOS 环境变量直接启动后端：

```bash
export TRIM_APPDEST=/path/to/target
export TRIM_PKGVAR=/path/to/var
export TRIM_DATA_ACCESSIBLE_PATHS=/path/to/authorized
export FN7Z_7ZZ=/usr/trim/bin/7zz
export FN7Z_SOCKET_PATH=$TRIM_APPDEST/app.sock
cd app/server && node server.js
```

然后通过 curl 或浏览器代理访问 `/app/fn7z/`。

## 在 fnOS 设备上安装

```bash
appcenter-cli install-fpk fn7z.fpk
# 或应用中心 → 手动安装
```

## 目录结构

```text
fn7z/
├── manifest          # 应用元信息
├── ICON.PNG          # 64x64 包图标
├── ICON_256.PNG      # 256x256 包图标
├── app/
│   ├── server/       # Node.js 后端（server.js）
│   └── ui/           # 前端页面 + 入口配置 + 图标
├── cmd/              # 生命周期脚本
├── config/           # privilege + resource
└── wizard/           # 安装/升级/卸载/配置向导
```
