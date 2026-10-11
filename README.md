# claude-cli-sessions

**English** | [简体中文](README.zh-CN.md)

A small, zero-dependency local web UI (plus an optional macOS app shell) for managing **Claude Code CLI sessions** — the ones that don't show up in Claude Desktop.

> Everything runs on your machine. The server listens on `127.0.0.1` only and reads transcripts from `~/.claude/projects`. Nothing is uploaded; no session data is stored in this repository.

## Features
- List and search CLI sessions, see which ones are running
- Read a transcript (tool calls collapsed)
- Resume in Terminal / iTerm, attach to the tmux pane it runs in, or open in Claude Desktop
- Rename (same record `/rename` writes), AI-generated title (uses `claude -p --model haiku`), notes, archive, move to Trash
- UI in English and Simplified Chinese (see [Languages](#languages))

## Run
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

## Languages
The UI defaults to English and switches to Simplified Chinese automatically when your browser (or, in the macOS app, your system) language starts with `zh`. Use the language picker in the top-right corner to change it; the choice is remembered.

AI-generated titles are written in the current UI language. Transcript content is always shown as-is.

To add a language, copy the `en` block in [`i18n.js`](i18n.js), translate the values and set `_name`. Native strings of the macOS shell live in the `STRINGS` table in [`app/main.swift`](app/main.swift), and the permission prompt text in [`build-app.sh`](build-app.sh).

## Caveats
- macOS-oriented (Terminal/iTerm automation, `open claude://…`); the server itself is plain Node.
- "Rename" and "AI title" **append a line to the session's `.jsonl` transcript**; "Delete" moves the file to the Trash. Back up anything you care about.

## License
MIT
