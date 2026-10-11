# claude-cli-sessions

A small, zero-dependency local web UI (plus an optional macOS app shell) for managing **Claude Code CLI sessions** — the ones that don't show up in Claude Desktop. 零依赖的本地 Web 界面，用来管理不属于 Claude Desktop 的 Claude Code 命令行会话。

> Everything runs on your machine. The server listens on `127.0.0.1` only and reads transcripts from `~/.claude/projects`. Nothing is uploaded; no session data is stored in this repository.
> 全部在本机运行，只监听 127.0.0.1，只读取本机 `~/.claude/projects` 下的记录，不上传任何内容。

## Features 功能
- List and search CLI sessions, see which ones are running 列表、搜索、运行状态
- Read a transcript (tool calls collapsed) 查看对话记录
- Resume in Terminal / iTerm, attach to the tmux pane it runs in, or open in Claude Desktop 恢复、接入 tmux、转 Desktop
- Rename (same record `/rename` writes), AI-generated title (uses `claude -p --model haiku`), notes, archive, move to Trash 改名、AI 标题、备注、归档、移到废纸篓

## Run 运行
Requires Node.js and the `claude` CLI on your machine.

```sh
node server.js          # → http://127.0.0.1:7717
PORT=8000 node server.js
```

Notes and archive flags are kept in `state.json` next to `server.js` (override the directory with `STATE_DIR`). That file is git-ignored.

## macOS app (optional)
Needs Xcode Command Line Tools and Node at runtime.

```sh
./build-app.sh          # builds "CLI Sessions.app" (ad-hoc signed)
```

## Caveats 注意
- macOS-oriented (Terminal/iTerm automation, `open claude://…`); the server itself is plain Node.
- "Rename" and "AI title" **append a line to the session's `.jsonl` transcript**; "Delete" moves the file to the Trash. Back up anything you care about.
- The UI is in Chinese. 界面为中文。

## License
MIT
