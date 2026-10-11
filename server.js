#!/usr/bin/env node
// Claude CLI Session Manager — 管理不属于 Claude Desktop 的 session（entrypoint = cli / sdk-cli 等）
// 零依赖：node server.js  → http://127.0.0.1:7717
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = +process.env.PORT || 7717;
const ROOT = path.join(os.homedir(), '.claude', 'projects');
const SIDECAR = path.join(process.env.STATE_DIR || __dirname, 'state.json'); // { archived: {id: true}, notes: {id: "..."} }
const DESKTOP = /^claude-desktop/;
const HEAD = 256 * 1024, TAIL = 512 * 1024;

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const loadState = () => { try { return JSON.parse(fs.readFileSync(SIDECAR, 'utf8')); } catch { return { archived: {} }; } };
const saveState = (s) => fs.writeFileSync(SIDECAR, JSON.stringify(s, null, 1));

function readRange(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.toString('utf8', 0, n);
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
}
function cleanTitle(t) {
  t = String(t || '').trim();
  for (let i = 0; i < 3; i++) { // 剥掉开头的 <tag ...> 包装（如 <channel source=...>），保留内容
    const m = t.match(/^<([a-zA-Z_-]+)(?:\s[^>]*)?>\s*([\s\S]*)$/);
    if (!m) break;
    t = m[2].replace(new RegExp('</' + m[1] + '>\\s*$'), '').trim();
  }
  t = (t.split('\n').find(l => l.trim()) || '').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
const isNoise = (t) => !t || /^<(command-|local-command|system-reminder|ide_|task-notification)/.test(t.trim()) || t.startsWith('[Request interrupted');

const cache = new Map(); // file -> {sig, meta}
function indexFile(file, st) {
  const sig = st.mtimeMs + ':' + st.size;
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit.meta;
  const id = path.basename(file, '.jsonl');
  const meta = { id, project: path.basename(path.dirname(file)), file, size: st.size, mtime: st.mtimeMs,
    entrypoint: null, cwd: null, branch: null, first: null, title: null, aiTitle: null, last: null, model: null };
  const fd = fs.openSync(file, 'r');
  try {
    const head = readRange(fd, 0, Math.min(st.size, HEAD)).split('\n');
    if (st.size > HEAD) head.pop(); // 最后一行可能被截断
    for (const l of head) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.entrypoint && !meta.entrypoint) meta.entrypoint = o.entrypoint;
      if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
      if (o.gitBranch && !meta.branch) meta.branch = o.gitBranch;
      if (o.type === 'user' && !o.isSidechain && !meta.first) {
        const t = textOf(o.message && o.message.content);
        if (!isNoise(t)) meta.first = t.trim().slice(0, 200);
      }
      if (meta.entrypoint && meta.cwd && meta.first) break;
    }
    const tailStart = Math.max(0, st.size - TAIL);
    const tail = readRange(fd, tailStart, st.size - tailStart).split('\n');
    if (tailStart > 0) tail.shift();
    for (const l of tail) {
      if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'custom-title' && o.customTitle) meta.title = o.customTitle;
      else if (o.type === 'ai-title' && o.aiTitle) meta.aiTitle = o.aiTitle;
      if (o.timestamp) meta.last = o.timestamp;
      if (o.entrypoint) meta.lastEntry = o.entrypoint;
      if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
      if (o.type === 'assistant' && o.message && o.message.model) meta.model = o.message.model;
    }
    if (!meta.entrypoint && !meta.lastEntry) { // 大行文件：按块扫描找首个 entrypoint（上限 16MB）
      const re = /"entrypoint":"([^"]+)"/, buf = Buffer.alloc(1 << 20);
      for (let pos = 0; pos < Math.min(st.size, 16 << 20); pos += buf.length - 200) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos), m = re.exec(buf.toString('latin1', 0, n));
        if (m) { meta.entrypoint = m[1]; break; }
      }
    }
    // 以最近一次入口为准：desktop 创建后在 CLI resume 的算 CLI
    meta.entrypoint = meta.lastEntry || meta.entrypoint;
  } finally { fs.closeSync(fd); }
  cache.set(file, { sig, meta });
  return meta;
}

// 当前在跑的“外部”(非 Desktop 拉起) claude 进程 → session。
// 1) 命令行带 --resume/--session-id 的直接取 id；2) 否则用进程 cwd 找项目目录里「进程启动后写过」的最近 jsonl（tmux 里直接起的 claude 就是这种）；
// 3) 都对不上的（卡在启动确认框、还没发过消息等）记为 pending，列表里以占位项显示
const etimeSec = (s) => { const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3]) * 60 + (+m[4])) : 0; };
function runningIds(cb) {
  execFile('ps', ['-axo', 'pid=,tty=,etime=,command='], { maxBuffer: 8e6, env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }, (e, out) => {
    const m = new Map(), procs = [], now = Date.now();
    m.pending = [];
    for (const line of (out || '').split('\n')) {
      const mm = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(.*)$/);
      if (!mm || path.basename(mm[4]) !== 'claude' || /Application Support\/Claude|Claude\.app/.test(line)) continue;
      const r = line.match(/(?:--resume|--session-id|-r)[ =]([0-9a-f-]{36})/);
      if (r) { m.set(r[1], { pid: +mm[1], external: true, tty: mm[2] }); continue; }
      if (/\s(-p|--print)(\s|$)/.test(mm[5])) continue;
      const nm = mm[5].match(/--name\s+(.+?)(?:\s+\[|\s--|$)/), rest = mm[5].match(/--name\s+(.*)$/);
      procs.push({ pid: +mm[1], tty: mm[2], start: now - etimeSec(mm[3]) * 1000, name: nm ? nm[1].trim() : '', rest: rest ? rest[1] : '' });
    }
    // 先按 --name 与 session 自定义标题精确匹配（启动参数里 --name 会写成 custom-title）
    const metas = [...cache.values()].map(c => c.meta).filter(x => x.title && x.title.length >= 3).sort((a, b) => b.mtime - a.mtime);
    for (const p of procs) {
      if (!p.rest) continue;
      const hit = metas.find(x => !m.has(x.id) && p.rest.startsWith(x.title));
      if (hit) { m.set(hit.id, { pid: p.pid, external: true, tty: p.tty }); p.done = true; }
    }
    procs.splice(0, procs.length, ...procs.filter(p => !p.done));
    if (!procs.length) return cb(m);
    execFile('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', procs.map(p => p.pid).join(',')], { maxBuffer: 4e6 }, (e2, o2) => {
      let pid = null;
      for (const l of (o2 || '').split('\n')) { if (l[0] === 'p') pid = +l.slice(1); else if (l[0] === 'n' && pid) { const p = procs.find(x => x.pid === pid); if (p) p.cwd = l.slice(1); } }
      const byDir = new Map();
      for (const p of procs) { const k = (p.cwd || '').replace(/[^a-zA-Z0-9]/g, '-'); (byDir.get(k) || byDir.set(k, []).get(k)).push(p); }
      for (const [k, ps] of byDir) {
        let ranked = [];
        try { ranked = fs.readdirSync(path.join(ROOT, k)).filter(f => f.endsWith('.jsonl')).map(f => ({ id: f.slice(0, -6), t: fs.statSync(path.join(ROOT, k, f)).mtimeMs })).sort((x, y) => y.t - x.t); } catch {}
        ps.sort((x, y) => x.pid - y.pid);
        const used = new Set();
        if (ps.length > 1) { m.pending.push(...ps); continue; } // 同目录多个且名字对不上：不猜，显示为占位
        for (const p of ps) { // 只认进程启动之后写过的文件，否则会把旧 session 误认成它的
          const c = ranked.find(x => x.t >= p.start - 5000 && !used.has(x.id) && !m.has(x.id));
          if (c) { used.add(c.id); m.set(c.id, { pid: p.pid, external: true, tty: p.tty }); }
          else m.pending.push(p);
        }
      }
      cb(m);
    });
  });
}

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(p => fs.existsSync(p)) || 'tmux';
function tmuxPanes(cb) { // tty(如 ttys001) → 'session:win.pane'
  execFile(TMUX, ['list-panes', '-a', '-F', '#{pane_tty} #{session_name}:#{window_index}.#{pane_index}'], (e, out) => {
    const m = new Map();
    for (const l of (out || '').split('\n')) { const i = l.indexOf(' '); if (i > 0) m.set(l.slice(0, i).replace('/dev/', ''), l.slice(i + 1)); }
    cb(m);
  });
}

function listSessions(cb) {
  const state = loadState();
  const out = [];
  let dirs = []; try { dirs = fs.readdirSync(ROOT); } catch {}
  for (const d of dirs) {
    let files; try { files = fs.readdirSync(path.join(ROOT, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(ROOT, d, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      let meta; try { meta = indexFile(file, st); } catch { continue; }
      out.push(meta);
    }
  }
  runningIds((run) => tmuxPanes((panes) => {
    // 入口记为 desktop，但当前正由终端里的 claude 进程运行的（如 resume / bot 拉起），也算 CLI
    const pend = (run.pending || []).map(p => ({ id: 'pending-' + p.pid, project: '', cwd: p.cwd, branch: null, entrypoint: 'cli', model: null,
      title: p.name || '(尚未产生对话)', renamed: false, generated: false, first: null, mtime: p.start, last: null, size: 0, pid: p.pid,
      tmux: panes.get(p.tty) || null, archived: false, note: '', pending: true }));
    cb(out.filter(m => !DESKTOP.test(m.entrypoint || '') || (run.get(m.id) || {}).external).map(m => ({
      id: m.id, project: m.project, cwd: m.cwd, branch: m.branch, entrypoint: (run.get(m.id) || {}).external ? 'cli' : (m.entrypoint || 'unknown'), model: m.model,
      title: m.title || m.aiTitle || cleanTitle(m.first) || '(无标题)', renamed: !!m.title, generated: !!m.aiTitle, first: m.first,
      mtime: m.mtime, last: m.last, size: m.size,
      pid: (run.get(m.id) || {}).pid || null, tmux: panes.get((run.get(m.id) || {}).tty) || null, archived: !!state.archived[m.id], note: (state.notes || {})[m.id] || '',
    })).concat(pend).sort((a, b) => b.mtime - a.mtime));
  }));
}

function findFile(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  for (const d of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, d, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const cut = (x, n) => { x = String(x ?? ''); return x.length > n ? x.slice(0, n) + `\n… (已截断，共 ${x.length} 字符)` : x; };
function toolInfo(name, i) { // → { summary: 一行摘要, detail: 展开后的主体 }
  i = i || {};
  const one = (x) => String(x || '').split('\n').find(l => l.trim())?.trim().slice(0, 100) || '';
  switch (name) {
    case 'Bash': return { summary: i.description || one(i.command), detail: cut(i.command, 4000) };
    case 'Read': return { summary: i.file_path, detail: cut([i.file_path, i.offset != null ? `offset ${i.offset}` : '', i.limit != null ? `limit ${i.limit}` : ''].filter(Boolean).join('  '), 500) };
    case 'Write': return { summary: i.file_path, detail: cut(i.file_path + '\n\n' + (i.content || ''), 2000) };
    case 'Edit': return { summary: i.file_path, detail: cut(`${i.file_path}\n\n--- old\n${i.old_string || ''}\n+++ new\n${i.new_string || ''}`, 3000) };
    case 'Grep': return { summary: i.pattern, detail: cut(`pattern: ${i.pattern}${i.path ? '\npath: ' + i.path : ''}${i.glob ? '\nglob: ' + i.glob : ''}`, 800) };
    case 'Glob': return { summary: i.pattern, detail: cut(`${i.pattern}${i.path ? '\npath: ' + i.path : ''}`, 500) };
    case 'WebFetch': case 'WebSearch': return { summary: i.url || i.query, detail: cut(JSON.stringify(i, null, 1), 1500) };
    case 'Agent': case 'Task': return { summary: i.description || one(i.prompt), detail: cut(i.prompt, 3000) };
    default: return { summary: one(i.description || i.command || i.query || i.file_path || i.prompt || ''), detail: cut(JSON.stringify(i, null, 1), 2000) };
  }
}
const resultText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[图片]' : '').filter(Boolean).join('\n') : '';

function transcript(file, limit = 300) {
  const msgs = [], byId = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const c = o.message && o.message.content;
    if (o.type === 'user' && Array.isArray(c)) // 工具结果回填到对应的调用上
      for (const r of c) if (r && r.type === 'tool_result' && byId.has(r.tool_use_id)) { const t = byId.get(r.tool_use_id); t.result = cut(resultText(r.content), 2500); t.error = !!r.is_error; }
    const t = textOf(c);
    const tools = Array.isArray(c) ? c.filter(x => x && x.type === 'tool_use').map(x => { const ti = toolInfo(x.name, x.input), tool = { name: x.name, ...ti, result: null }; byId.set(x.id, tool); return tool; }) : [];
    if (o.type === 'user' && isNoise(t)) continue;
    if (!t && !tools.length) continue;
    msgs.push({ role: o.type, t: t.slice(0, 4000), tools, ts: o.timestamp });
  }
  return { total: msgs.length, msgs: msgs.slice(-limit) };
}

function claudeBin() {
  const c = [process.env.CLAUDE_BIN, path.join(os.homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  return c.find(p => fs.existsSync(p)) || 'claude';
}
function genTitle(file) {
  const t = transcript(file, 100000).msgs.filter(m => m.role === 'user');
  const picks = [...t.slice(0, 3), ...t.slice(-1)].map(m => cleanTitle(m.t.replace(/\s+/g, ' ')).slice(0, 300) || m.t.slice(0, 300));
  const prompt = '下面是一段 Claude Code 会话中用户说过的话（按时间顺序）。请为这个会话起一个简短的中文标题（8~20 个字，概括主题，名词短语，不要标点结尾，不要引号），只输出标题本身。\n\n' + picks.map((x, i) => `${i + 1}. ${x}`).join('\n');
  return new Promise((res, rej) => {
    const p = spawn(claudeBin(), ['-p', '--model', 'haiku', '--no-session-persistence'], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PATH: process.env.PATH + ':' + path.join(os.homedir(), '.local/bin') + ':/opt/homebrew/bin:/usr/local/bin' } });
    let out = ''; const to = setTimeout(() => { p.kill(); rej(new Error('生成超时')); }, 90000);
    p.stdout.on('data', d => out += d); p.on('error', e => { clearTimeout(to); rej(e); });
    p.on('close', () => { clearTimeout(to); const title = out.trim().split('\n').pop().replace(/^["'“「《#\s]+|["'”」》。\s]+$/g, '').slice(0, 40); title ? res(title) : rej(new Error('模型没有返回标题')); });
    p.stdin.end(prompt);
  });
}

// 在所选终端里运行 shell 命令。term: 'Terminal' | 'iTerm' | 'iTerm-CC'（CC 只影响 tmux 接入，其余按 iTerm 处理）
// GUI 拉起的终端常常没有 UTF-8 locale，中文会乱码：显式设置，tmux 另加 -u 强制 UTF-8
const UTF8 = 'export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8; ';
const termOf = () => (loadState().settings || {}).term || process.env.TERM_APP || 'Terminal';
function runInTerm(shellCmd, term) {
  const esc = (x) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const app = term === 'Terminal'
    ? `tell application "Terminal"\nactivate\ndo script "${esc(shellCmd)}"\nend tell`
    : `tell application "iTerm"\nactivate\ncreate window with default profile command "${esc('/bin/sh -c ' + q(shellCmd))}"\nend tell`;
  return new Promise((res, rej) => execFile('osascript', ['-e', app], (e) => e ? rej(e) : res()));
}
function openInTerminal(cwd, id) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  return runInTerm(UTF8 + `cd ${q(dir)} && claude --resume ${id}`, termOf());
}
function attachTmux(target) {
  if (!/^[\w.-]+:\d+\.\d+$/.test(target)) throw new Error('bad target');
  const sess = target.split(':')[0], win = target.split('.')[0], term = termOf();
  const pre = UTF8 + `${q(TMUX)} -u select-window -t ${q(win)}; ${q(TMUX)} -u select-pane -t ${q(target)}; `;
  // -CC：iTerm 原生 tmux 集成（每个 tmux 窗口对应 iTerm 窗口/标签）
  return runInTerm(pre + (term === 'iTerm-CC' ? `${q(TMUX)} -u -CC attach -t ${q(sess)}` : `${q(TMUX)} -u attach -t ${q(sess)}`), term);
}

function trash(file) {
  const esc = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((res, rej) => execFile('osascript', ['-e', `tell application "Finder" to delete POSIX file "${esc}"`], (e) => e ? rej(e) : res()));
}

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', d => s += d); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  // 防 DNS rebinding / 跨站：仅接受本机 Host；写操作要求自定义头
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (host !== '127.0.0.1' && host !== 'localhost') return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html');
    if (req.method === 'GET' && url.pathname === '/api/settings') return send(res, 200, { term: termOf(), iterm: fs.existsSync('/Applications/iTerm.app') });
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      if (req.headers['x-csm'] !== '1') return send(res, 403, { error: 'missing header' });
      const b = await readBody(req); if (!['Terminal', 'iTerm', 'iTerm-CC'].includes(b.term)) return send(res, 400, { error: 'bad term' });
      const st = loadState(); st.settings = { ...(st.settings || {}), term: b.term }; saveState(st); return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') return listSessions((l) => send(res, 200, l));
    if (req.method === 'GET' && url.pathname === '/api/transcript') {
      if (/^pending-/.test(url.searchParams.get('id') || '')) return send(res, 200, { total: 0, msgs: [] });
      const f = findFile(url.searchParams.get('id') || ''); if (!f) return send(res, 404, { error: 'not found' });
      return send(res, 200, transcript(f));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-csm'] !== '1') return send(res, 403, { error: 'missing header' });
      const b = await readBody(req);
      const act = url.pathname.slice(5);
      if (/^pending-\d+$/.test(b.id || '')) { // 还没有 transcript 的运行中进程：只支持接入 tmux
        if (act !== 'tmux') return send(res, 400, { error: '该进程还没有对话记录，仅支持接入 tmux' });
        const run = await new Promise(r => runningIds(r)), t = await new Promise(r => tmuxPanes(r));
        const p = (run.pending || []).find(x => 'pending-' + x.pid === b.id), target = p && t.get(p.tty);
        if (!target) return send(res, 404, { error: '该进程当前不在 tmux 中运行' });
        await attachTmux(target); return send(res, 200, { ok: true, target });
      }
      const f = findFile(b.id || ''); if (!f) return send(res, 404, { error: 'not found' });
      if (act === 'resume') { await openInTerminal(b.cwd, b.id); return send(res, 200, { ok: true }); }
      if (act === 'desktop') { await new Promise((ok, no) => execFile('open', ['claude://resume?session=' + b.id], e => e ? no(e) : ok())); return send(res, 200, { ok: true }); }
      if (act === 'tmux') {
        const run = await new Promise(r => runningIds(r)), t = await new Promise(r => tmuxPanes(r));
        const target = t.get((run.get(b.id) || {}).tty);
        if (!target) return send(res, 404, { error: '该 session 当前不在 tmux 中运行' });
        await attachTmux(target); return send(res, 200, { ok: true, target });
      }
      if (act === 'archive') { const s = loadState(); s.archived = s.archived || {}; b.on ? s.archived[b.id] = true : delete s.archived[b.id]; saveState(s); return send(res, 200, { ok: true }); }
      if (act === 'note') { const s = loadState(); s.notes = s.notes || {}; if (b.note) s.notes[b.id] = String(b.note).slice(0, 500); else delete s.notes[b.id]; saveState(s); return send(res, 200, { ok: true }); }
      if (act === 'rename') {
        const title = String(b.title || '').trim().slice(0, 200); if (!title) return send(res, 400, { error: 'empty' });
        // 与 claude 自身一致：追加 custom-title 记录（/resume 会读取）
        fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: b.id }) + '\n');
        return send(res, 200, { ok: true });
      }
      if (act === 'gentitle') {
        const title = await genTitle(f);
        fs.appendFileSync(f, JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: b.id }) + '\n'); // 与 claude 自身一致；自定义标题优先级更高
        return send(res, 200, { ok: true, title });
      }
      if (act === 'delete') { await trash(f); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'unknown action' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`Claude CLI Session Manager → http://127.0.0.1:${PORT}`));
