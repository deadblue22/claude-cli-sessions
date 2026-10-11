# claude-cli-sessions

[English](README.md) | **简体中文**

一个零依赖的本地 Web 界面（另附可选的 macOS 应用外壳），用来管理 **Claude Code 命令行会话**——也就是不会出现在 Claude Desktop 里的那些 session。

> 全部在本机运行：服务只监听 `127.0.0.1`，只读取本机 `~/.claude/projects` 下的记录，不上传任何内容；本仓库不保存任何 session 数据。

## 功能
- 列出、搜索 CLI session，查看哪些正在运行
- 查看对话记录（工具调用默认折叠）
- 在 Terminal / iTerm 中恢复、接入其所在的 tmux 窗格，或在 Claude Desktop 中打开
- 重命名（与 `/rename` 写入的记录相同）、AI 生成标题（使用 `claude -p --model haiku`）、备注、归档、移到废纸篓
- 界面支持英文和简体中文（见[语言](#语言)）

## 运行
需要本机装有 Node.js 和 `claude` 命令行。

```sh
node server.js          # → http://127.0.0.1:7717
PORT=8000 node server.js
```

备注和归档标记保存在 `server.js` 同目录的 `state.json` 里（可用 `STATE_DIR` 指定目录），该文件已被 git 忽略。

## macOS 应用（可选）
构建需要 Xcode Command Line Tools，运行时需要 Node。

```sh
./build-app.sh          # 构建 "CLI Sessions.app"（ad-hoc 签名）
```

## 语言
界面默认英文；浏览器语言（macOS 应用里为系统语言）以 `zh` 开头时自动切换为简体中文。也可以用右上角的语言选择器切换，选择会被记住。

AI 生成的标题使用当前界面语言；对话记录内容始终原样显示，不做翻译。

新增语言：复制 [`i18n.js`](i18n.js) 里的 `en` 一节，翻译各项并设置 `_name`。macOS 外壳的原生文案在 [`app/main.swift`](app/main.swift) 的 `STRINGS` 表里，权限提示文案在 [`build-app.sh`](build-app.sh) 里。

## 注意
- 面向 macOS（Terminal/iTerm 自动化、`open claude://…`）；服务端本身是普通 Node。
- “重命名”和“AI 标题”会**向 session 的 `.jsonl` 记录追加一行**；“删除”会把文件移到废纸篓。重要内容请自行备份。

## 许可证
MIT
