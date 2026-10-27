#!/usr/bin/env node
// session-reel: render a Claude Code session transcript (.jsonl) as MP4 replays.
// Needs Node 18+ and ffmpeg (built with libass) on PATH. Only prompts, replies and
// tool-call summaries are drawn, never tool output; secrets, emails and home paths are masked.
//
//   node reel.mjs [session-id | id-prefix | file.jsonl] [--format both|horizontal|vertical]
//                 [--theme desktop|desktop-light|paper|terminal] [--length 60] [--title "hook"]
//                 [--sound on|off] [--volume 80] [--text normal|large] [--camera on|off]
//                 [--watermark on|off] [--accent #D97757] [--fps 60] [--out reel.mp4]
//   node reel.mjs list [--cwd <dir>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects')
const OUT_DIR = path.join(HOME, 'session-reels')
const SFX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sfx')
const RATE = 48000
const INTRO = 2.8
const OUTRO = 4
const MIN_STEP = 0.3 // seconds; faster events share a step, so every scroll finishes easing
const EASE = 0.34 // seconds a scroll or fade-in takes
const IDLE = 10 * 60e3 // a gap longer than this is a break, not work
const HIDDEN = /^(mcp__ccd_|ToolSearch$)/ // desktop-app bookkeeping, not work
const BS = '\\'

// `desktop` is sampled from the Claude Code desktop app (dark); the others are our own looks.
export const THEMES = {
  desktop: { layout: 'desktop', ui: 'sans', reply: 'sans', bg: '#191919', fg: '#EFEFEF', dim: '#9C9C9C', bubble: '#252525', field: '#303030', edge: '#3A3A3A', ok: '#32D74B', err: '#FF2C56', accent: '#D97757' },
  'desktop-light': { layout: 'desktop', ui: 'sans', reply: 'sans', bg: '#FBFBFA', fg: '#1F1F1E', dim: '#76766F', bubble: '#EFEFEC', field: '#FFFFFF', edge: '#DCDCD7', ok: '#1A7F37', err: '#CF222E', accent: '#C96442' },
  paper: { layout: 'desktop', ui: 'sans', reply: 'serif', bg: '#F4F0E6', fg: '#1C1B18', dim: '#6F6A60', bubble: '#E7E0D0', field: '#FBF8F1', edge: '#D6CEBC', ok: '#2F7D4A', err: '#B3261E', accent: '#C15F3C' },
  terminal: { layout: 'terminal', ui: 'mono', reply: 'mono', bg: '#101114', fg: '#ECECEC', dim: '#8B8F96', edge: '#2A2D33', ok: '#4EBA65', err: '#E5534B', accent: '#D97757' },
}

// ---------- finding sessions ----------

function allTranscripts() {
  const out = []
  for (const dir of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    let names = []
    try { names = fs.readdirSync(path.join(PROJECTS, dir)) } catch { continue }
    for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(PROJECTS, dir, n))
  }
  return out
}

export function findTranscript(arg) {
  if (arg.endsWith('.jsonl') && fs.existsSync(arg)) return arg
  const hits = allTranscripts().filter(f => path.basename(f).startsWith(arg))
  if (hits.length === 1) return hits[0]
  throw new Error(hits.length ? `"${arg}" matches ${hits.length} sessions; give more of the id` : `no session "${arg}" under ${PROJECTS}`)
}

// ---------- reading a transcript ----------

const TAG_BLOCK = /<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g

export function promptText(content) {
  let s = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  const cmd = s.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (cmd) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim()
  }
  // ponytail: drops every <tag>...</tag> block (system reminders, pasted blocks, event
  // envelopes); a prompt that pastes literal HTML loses that part too.
  s = s.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, ' [pasted] ').replace(TAG_BLOCK, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s || s.startsWith('[Request interrupted') || s.startsWith('Caveat:')) return ''
  return s
}

const plain = s => s.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*([-*]|\d+\.)\s+/gm, '')
  .replace(/[*`#>|]+/g, '').replace(/\s+/g, ' ').trim()
const lineCount = s => (typeof s === 'string' && s ? s.split('\n').length : 0)

function toolInfo(name, i, cwd) {
  const tool = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
  const file = i.file_path || i.notebook_path
  let add = 0, del = 0
  if (name === 'Edit') { add = lineCount(i.new_string); del = lineCount(i.old_string) }
  else if (name === 'MultiEdit') for (const e of i.edits || []) { add += lineCount(e.new_string); del += lineCount(e.old_string) }
  else if (name === 'Write') add = lineCount(i.content)
  let detail = file ? relPath(file, cwd)
    : name === 'WebFetch' ? hostOf(i.url)
    : i.command ?? i.pattern ?? i.query ?? i.description ?? i.skill ?? Object.values(i).find(v => typeof v === 'string') ?? ''
  detail = String(detail).replace(/\s+/g, ' ').trim().replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '')
  const edits = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)
  return { tool, detail, add, del, file: edits ? file : undefined, isPath: !!file }
}

function relPath(f, cwd) {
  const p = f.replace(/\\/g, '/'), c = (cwd || '').replace(/\\/g, '/').replace(/\/$/, '')
  return c && p.toLowerCase().startsWith(c.toLowerCase() + '/') ? p.slice(c.length + 1) : p
}

function hostOf(u) { try { return new URL(u).host } catch { return '' } }

export async function parse(file) {
  const events = [], failed = new Set(), seen = new Set()
  let cwd = '', title = ''
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle
    if (!o.message || o.isSidechain || o.isMeta || o.isCompactSummary) continue
    const t = Date.parse(o.timestamp)
    if (!t) continue
    cwd ||= o.cwd || ''
    const content = o.message.content
    if (o.type === 'user') {
      if (Array.isArray(content) && content.some(b => b.type === 'tool_result')) {
        for (const b of content) if (b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id)
        continue
      }
      const text = promptText(content)
      if (text) events.push({ t, kind: 'prompt', text })
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      const model = o.message.model
      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) {
          const key = `${o.message.id}:${b.text.slice(0, 64)}`
          const text = plain(b.text)
          if (!seen.has(key) && text) { seen.add(key); events.push({ t, kind: 'say', text, model }) }
        } else if (b.type === 'tool_use' && !seen.has(b.id) && !HIDDEN.test(b.name)) {
          seen.add(b.id)
          events.push({ t, kind: 'tool', id: b.id, model, ...toolInfo(b.name, b.input || {}, cwd) })
        }
      }
    }
  }
  for (const e of events) if (e.kind === 'tool') e.failed = failed.has(e.id)
  return { cwd, title, events }
}

export function modelName(id) {
  const m = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id || '')
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : ''
}

// ---------- masking ----------

const SECRET = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(-----END[^-]*PRIVATE KEY-----|$)/g,
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /[A-Za-z0-9_-]{40,}/g, // long opaque tokens and hashes
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, // emails
]

export function redact(s) {
  const homes = [HOME, HOME.replace(/\\/g, '/'), HOME.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/')]
  for (const h of homes) s = s.split(h).join('~')
  s = s.replace(/([\\/](?:Users|home)[\\/])[^\\/\s"']+/gi, '$1you') // other users, 8.3 short names
  s = s.replace(/\b((?:api[_-]?key|token|secret|password|passwd|bearer)["']?\s*[:=]?\s*["']?)[^\s"']{6,}/gi, '$1•••')
  for (const re of SECRET) s = s.replace(re, '•••')
  return s
}

// ---------- fonts: real advance widths, so bubbles and wrapping fit the text ----------

const WINDIR = process.env.WINDIR || 'C:/Windows'
const FONTS = {
  sans: { win32: ['Segoe UI', `${WINDIR}/Fonts/segoeui.ttf`], darwin: ['Helvetica Neue', '/System/Library/Fonts/HelveticaNeue.ttc'], linux: ['DejaVu Sans', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'] },
  serif: { win32: ['Georgia', `${WINDIR}/Fonts/georgia.ttf`], darwin: ['Georgia', '/System/Library/Fonts/Supplemental/Georgia.ttf'], linux: ['DejaVu Serif', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'] },
  mono: { win32: ['Cascadia Mono', `${WINDIR}/Fonts/CascadiaMono.ttf`], darwin: ['Menlo', '/System/Library/Fonts/Menlo.ttc'], linux: ['DejaVu Sans Mono', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'] },
}

// Advance width per font-size unit, as libass sizes text (size = winAscent + winDescent).
// Reads the first face of a TTF/TTC: head, hhea, OS/2, hmtx and a format-4 cmap.
export function fontWidths(file) {
  const b = fs.readFileSync(file)
  const base = b.toString('latin1', 0, 4) === 'ttcf' ? b.readUInt32BE(12) : 0
  const t = {}
  for (let i = 0; i < b.readUInt16BE(base + 4); i++) {
    const r = base + 12 + i * 16
    t[b.toString('latin1', r, r + 4)] = b.readUInt32BE(r + 8)
  }
  const height = t['OS/2'] ? b.readUInt16BE(t['OS/2'] + 74) + b.readUInt16BE(t['OS/2'] + 76)
    : b.readInt16BE(t.hhea + 4) - b.readInt16BE(t.hhea + 6)
  const metrics = b.readUInt16BE(t.hhea + 34)
  let sub = 0
  for (let i = 0; i < b.readUInt16BE(t.cmap + 2); i++) {
    const r = t.cmap + 4 + i * 8, at = t.cmap + b.readUInt32BE(r + 4)
    if (b.readUInt16BE(at) === 4 && b.readUInt16BE(r) !== 1) sub = at
  }
  if (!sub) throw new Error('no unicode cmap')
  const segs = b.readUInt16BE(sub + 6), ends = sub + 14, starts = ends + segs + 2, deltas = starts + segs, ranges = deltas + segs
  const glyph = c => {
    for (let i = 0; i < segs; i += 2) {
      if (c > b.readUInt16BE(ends + i)) continue
      const start = b.readUInt16BE(starts + i), delta = b.readInt16BE(deltas + i), ro = b.readUInt16BE(ranges + i)
      if (c < start) return 0
      if (!ro) return (c + delta) & 0xffff
      const g = b.readUInt16BE(ranges + i + ro + 2 * (c - start))
      return g ? (g + delta) & 0xffff : 0
    }
    return 0
  }
  const cache = new Map()
  return ch => {
    const c = ch.codePointAt(0)
    if (!cache.has(c)) {
      const g = c > 0xffff ? 0 : glyph(c)
      cache.set(c, b.readUInt16BE(t.hmtx + 4 * Math.min(g, metrics - 1)) / height)
    }
    return cache.get(c)
  }
}

function loadFont(kind) {
  const [name, file] = FONTS[kind][process.platform] || FONTS[kind].linux
  let width
  try { width = fontWidths(file) } catch { width = () => (kind === 'mono' ? 0.5 : 0.42) } // ponytail: rough average when the font file is elsewhere
  return { name, measure: (s, size) => { let w = 0; for (const ch of s) w += width(ch); return w * size } }
}

// ---------- text helpers ----------

export function wrapPx(s, maxW, measure, maxLines) {
  const out = []
  let cur = ''
  for (let w of s.split(' ').filter(Boolean)) {
    while (measure(w) > maxW) { // a token wider than the line is split
      if (cur) { out.push(cur); cur = '' }
      let i = 1
      while (i < w.length && measure(w.slice(0, i + 1)) <= maxW) i++
      out.push(w.slice(0, i)); w = w.slice(i)
    }
    const next = cur ? `${cur} ${w}` : w
    if (measure(next) <= maxW) cur = next
    else { out.push(cur); cur = w }
  }
  if (cur) out.push(cur)
  if (out.length > maxLines) {
    out.length = maxLines
    let last = out[maxLines - 1]
    while (last && measure(last + '…') > maxW) last = last.slice(0, -1)
    out[maxLines - 1] = last.trimEnd() + '…'
  }
  return out
}

export function clipPx(s, maxW, measure) {
  if (measure(s) <= maxW) return s
  while (s && measure(s + '…') > maxW) s = s.slice(0, -1)
  return s + '…'
}

const clipLeftPx = (s, maxW, measure) => {
  if (measure(s) <= maxW) return s
  while (s && measure('…' + s) > maxW) s = s.slice(1)
  return '…' + s
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, f) => a + (b - a) * f
const num = n => n.toLocaleString('en-US')
const plural = (n, word) => (n === 1 ? word : word + 's')
const easeOut = x => 1 - (1 - x) ** 3
const easeInOut = x => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2)

export function duration(ms) {
  const m = Math.round(ms / 60e3)
  if (m < 1) return `${Math.max(1, Math.round(ms / 1e3))}s`
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export const esc = s => s.replace(/[\\{}]/g, c => (c === BS ? BS + '\u2060' : BS + c))
const assColor = hex => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`
const assAlpha = v => `&H${Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0').toUpperCase()}&`
const ts = sec => {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}
const clock = t => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', ' ·')
const day = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

// A segment is [text, color, bold]; a run of segments is one line of text.
const seg = (text, color, bold = false) => [text, color, bold]
const draw = (segs, size, font) => (size || font ? `{${size ? `${BS}fs${size}` : ''}${font ? `${BS}fn${font}` : ''}}` : '')
  + segs.map(([t, c, b]) => `{${BS}c${assColor(c)}${BS}b${b ? 1 : 0}}${esc(t)}`).join('')
const shape = (pathCmds, color) => `{${BS}p1${BS}c${assColor(color)}${BS}bord0${BS}shad0}${pathCmds}{${BS}p0}`
const rect = (w, h) => `m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h}`
function roundRect(w, h, r) {
  const k = Math.round(0.5523 * r)
  return `m ${r} 0 l ${w - r} 0 b ${w - r + k} 0 ${w} ${r - k} ${w} ${r} l ${w} ${h - r} b ${w} ${h - r + k} ${w - r + k} ${h} ${w - r} ${h} `
    + `l ${r} ${h} b ${r - k} ${h} 0 ${h - r + k} 0 ${h - r} l 0 ${r} b 0 ${r - k} ${r - k} 0 ${r} 0`
}

// Typewriter via karaoke: unsung text takes the style's fully transparent secondary colour.
// `elapsed` (centiseconds) resumes the typing part-way, for a line that starts later.
export function typed(segs, startCs, perCs, elapsed = 0) {
  let acc = Math.round(Math.max(0, startCs - elapsed)), n = 0
  let out = `{${BS}k${acc}}`
  for (const [t, c, b] of segs) {
    out += `{${BS}c${assColor(c)}${BS}b${b ? 1 : 0}}`
    for (const ch of t) {
      const k = Math.round(Math.max(0, startCs + ++n * perCs - elapsed)) - acc
      acc += k
      out += `{${BS}k${k}}${esc(ch)}`
    }
  }
  return out
}

// ---------- the timeline ----------

export function plan(events, feedSeconds) {
  const evs = []
  for (const e of events) {
    const prev = evs.at(-1)
    if (prev && e.t - prev.t > IDLE) evs.push({ t: e.t, kind: 'gap', ms: e.t - prev.t })
    evs.push(e)
  }
  const weight = e => e.kind === 'prompt' ? clamp(0.9 + 0.02 * e.text.length, 1.4, 3.2)
    : e.kind === 'say' ? clamp(0.4 + 0.004 * e.text.length, 0.6, 1.4)
    : e.kind === 'gap' ? 0.7 : 0.22
  const total = evs.reduce((a, e) => a + weight(e), 0) || 1
  const scale = Math.min(1.5, feedSeconds / total)
  const prompts = evs.filter(e => e.kind === 'prompt').length || 1
  const promptFloor = Math.min(1.2, (0.5 * feedSeconds) / prompts)

  const steps = []
  let cur
  for (const e of evs) {
    const d = e.kind === 'prompt' ? Math.max(weight(e) * scale, promptFloor) : weight(e) * scale
    if (!cur || cur.prompt || e.kind === 'prompt' || cur.dur >= MIN_STEP) {
      cur = { t: e.t, events: [], dur: 0, prompt: e.kind === 'prompt' }
      steps.push(cur)
    }
    cur.events.push(e)
    cur.dur += d
  }
  for (const s of steps) s.dur = Math.max(s.dur, MIN_STEP)
  const budget = feedSeconds - 0.8
  for (let i = 0; i < 4; i++) { // floors can overshoot the length; squeeze the time above them until it fits
    const over = steps.reduce((a, s) => a + s.dur, 0) - budget
    const room = steps.reduce((a, s) => a + s.dur - MIN_STEP, 0)
    if (over <= 0.01 || room <= 0) break
    for (const s of steps) s.dur -= (s.dur - MIN_STEP) * Math.min(1, over / room)
  }
  if (steps.length) steps.at(-1).dur += 0.8 // let the last state read
  return steps
}

export function stats(events) {
  let active = 0
  for (let i = 1; i < events.length; i++) active += Math.min(events[i].t - events[i - 1].t, IDLE)
  const tools = events.filter(e => e.kind === 'tool')
  return {
    active,
    prompts: events.filter(e => e.kind === 'prompt').length,
    tools: tools.length,
    files: new Set(tools.filter(e => e.file).map(e => e.file.toLowerCase())).size,
    add: tools.reduce((a, e) => a + e.add, 0),
    del: tools.reduce((a, e) => a + e.del, 0),
  }
}

function tally() {
  const files = new Set()
  return {
    prompts: 0, tools: 0, add: 0, del: 0, model: '',
    get files() { return files.size },
    count(e) {
      if (e.model) this.model = modelName(e.model) || this.model
      if (e.kind === 'prompt') this.prompts++
      if (e.kind !== 'tool') return
      this.tools++; this.add += e.add; this.del += e.del
      if (e.file) files.add(e.file.toLowerCase())
    },
  }
}

// The desktop app's collapsed tool row: "Ran 4 commands, read a file, edited 2 files (1 failed)".
const ACTS = {
  Bash: ['ran', 'command'], PowerShell: ['ran', 'command'], Read: ['read', 'file'],
  Edit: ['edited', 'file'], MultiEdit: ['edited', 'file'], NotebookEdit: ['edited', 'file'], Write: ['created', 'file'],
  Grep: ['searched', 'pattern'], Glob: ['searched', 'pattern'], WebFetch: ['fetched', 'page'],
  WebSearch: ['ran', 'web search'], Agent: ['ran', 'agent'], Task: ['ran', 'agent'], Skill: ['ran', 'skill'],
}

export function toolSummary(tools) {
  const parts = new Map()
  for (const e of tools) {
    const [verb, noun] = ACTS[e.tool] || [`used ${e.tool}`, '']
    parts.set(`${verb}|${noun}`, (parts.get(`${verb}|${noun}`) || 0) + 1)
  }
  const text = [...parts].map(([k, n]) => {
    const [verb, noun] = k.split('|')
    if (!noun) return n === 1 ? verb : `${verb} ${n} times`
    if (noun === 'skill') return n === 1 ? 'ran skill' : `ran ${n} skills`
    const many = /(s|sh|ch)$/.test(noun) ? noun + 'es' : noun + 's'
    return n === 1 ? `${verb} ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}` : `${verb} ${n} ${many}`
  }).join(', ')
  const failed = tools.filter(e => e.failed).length
  return (text.charAt(0).toUpperCase() + text.slice(1)) + (failed ? ` (${failed} failed)` : '')
}

// ---------- the scene: timed items, a camera, and the ASS lines they become ----------

// An item is { start, end, layer, an, x, y, x1?, y1?, clip?, alpha?: [from, to], body },
// body a string or (elapsedCs) => string. The camera zooms the finished scene: every item
// crossing a camera move is cut into pieces with interpolated position and scale, so text
// stays vector-sharp at any zoom.
export function scene(W, H) {
  const items = [], open = new Map(), moves = []
  const rest = { z: 1, cx: W / 2, cy: H / 2 }
  let first = rest, last = rest
  const camAt = t => {
    let c = first
    for (const m of moves) {
      if (t >= m.t1) { c = m.to; continue }
      if (t > m.t0) {
        const e = easeInOut((t - m.t0) / (m.t1 - m.t0))
        return { z: lerp(m.from.z, m.to.z, e), cx: lerp(m.from.cx, m.to.cx, e), cy: lerp(m.from.cy, m.to.cy, e) }
      }
      return c
    }
    return c
  }
  const K = 12
  return {
    rest,
    add(d) {
      d = { layer: 1, an: 7, ...d }
      if (!(d.end - d.start >= 0.001)) return
      if (d.key) { // a held item extends the identical one that ends where it starts
        const k = `${d.layer}|${d.an}|${d.x}|${d.y}|${d.clip}|${d.body}`, prev = open.get(k)
        if (prev && Math.abs(prev.end - d.start) < 0.002) { prev.end = d.end; return }
        open.set(k, d)
      }
      items.push(d)
    },
    cameraStart(cam) { first = last = cam },
    camera(t0, t1, to) { moves.push({ t0, t1, from: last, to }); last = to },
    lines() {
      const cuts = moves.flatMap(m => Array.from({ length: K + 1 }, (_, k) => m.t0 + ((m.t1 - m.t0) * k) / K)).sort((a, b) => a - b)
      const f = v => Math.round(v * 10) / 10
      const map = (c, x, y) => [(x - c.cx) * c.z + W / 2, (y - c.cy) * c.z + H / 2]
      const out = []
      for (const d of items) {
        const cs = [d.start]
        for (const t of cuts) if (t > d.start + 0.004 && t < d.end - 0.004) cs.push(t)
        cs.push(d.end)
        const span = d.end - d.start, x1 = d.x1 ?? d.x, y1 = d.y1 ?? d.y
        for (let i = 0; i + 1 < cs.length; i++) {
          const a = cs[i], b = cs[i + 1], fa = (a - d.start) / span, fb = (b - d.start) / span
          const ca = camAt(a), cb = camAt(b)
          const [ax, ay] = map(ca, lerp(d.x, x1, fa), lerp(d.y, y1, fa)), [bx, by] = map(cb, lerp(d.x, x1, fb), lerp(d.y, y1, fb))
          let tags = `${BS}an${d.an}` + (f(ax) === f(bx) && f(ay) === f(by) ? `${BS}pos(${f(ax)},${f(ay)})` : `${BS}move(${f(ax)},${f(ay)},${f(bx)},${f(by)})`)
          if (ca.z !== 1 || cb.z !== 1) {
            tags += `${BS}fscx${f(ca.z * 100)}${BS}fscy${f(ca.z * 100)}`
            if (ca.z !== cb.z) tags += `${BS}t(${BS}fscx${f(cb.z * 100)}${BS}fscy${f(cb.z * 100)})`
          }
          if (d.clip) {
            const clip = c => { const [x0, y0] = map(c, d.clip[0], d.clip[1]), [x2, y2] = map(c, d.clip[2], d.clip[3]); return [x0, y0, x2, y2].map(Math.round).join(',') }
            const r0 = clip(ca), r1 = clip(cb)
            tags += `${BS}clip(${r0})` + (r0 !== r1 ? `${BS}t(${BS}clip(${r1}))` : '')
          }
          if (d.alpha) {
            const al = lerp(d.alpha[0], d.alpha[1], fa), bl = lerp(d.alpha[0], d.alpha[1], fb)
            tags += `${BS}alpha${assAlpha(al)}` + (assAlpha(al) !== assAlpha(bl) ? `${BS}t(${BS}alpha${assAlpha(bl)})` : '')
          }
          const body = typeof d.body === 'function' ? d.body((a - d.start) * 100) : d.body
          out.push(`Dialogue: ${d.layer},${ts(a)},${ts(b)},M,,0,0,0,,{${tags}}${body}`)
        }
      }
      return out.join('\n')
    },
  }
}

const later = (body, offCs) => (typeof body === 'function' ? e => body(e + offCs) : body)

// One piece of a block over one frame: eased from y0 to y1 (and faded in), then held.
function glide(out, start, dur, ease, x, y0, y1, fade, clip, body, layer) {
  if (y0 !== y1 || fade) {
    const K = 6 // libass moves linearly; six pieces of an ease-out curve read as one smooth glide
    for (let k = 0; k < K; k++) {
      const a = easeOut(k / K), b = easeOut((k + 1) / K)
      const t0 = start + (ease * k) / K, t1 = start + (ease * (k + 1)) / K
      out.add({ start: t0, end: t1, layer, x, y: lerp(y0, y1, a), x1: x, y1: lerp(y0, y1, b), clip, alpha: fade ? [1 - a, 1 - b] : undefined, body: later(body, (t0 - start) * 100) })
    }
    start += ease; dur -= ease
    body = later(body, ease * 100)
  }
  out.add({ start, end: start + dur, layer, x, y: y1, clip, body, key: typeof body === 'string' })
}

// Lays each frame's blocks top-down (bottom-anchored once they overflow) and moves every
// block from where it stood in the previous frame; new blocks ride the scroll, rise and fade in.
function play(out, frames, L, T) {
  const was = new Map()
  const clip = [0, L.feedTop, L.W, L.feedBottom]
  for (const f of frames) {
    const ease = Math.min(EASE, f.dur * 0.9)
    const total = f.blocks.reduce((a, b) => a + b.h + b.gap, 0)
    const scrolled = Math.max(0, total - (L.feedBottom - L.feedTop))
    let y = L.feedTop - scrolled
    if (scrolled) for (let i = 0; i < 6; i++) { // a soft fade where the feed slides under the header
      out.add({ start: f.start, end: f.start + f.dur, layer: 2, x: 0, y: L.feedTop + i * 10, body: `{${BS}1a${assAlpha(i / 6)}}${shape(rect(L.W, 10), T.bg)}`, key: true })
    }
    const tops = f.blocks.map(b => { const top = Math.round(y); y += b.h + b.gap; return top })
    const known = f.blocks.findIndex(b => was.has(b.id))
    const shift = known < 0 ? 0 : was.get(f.blocks[known].id) - tops[known]
    f.blocks.forEach((b, i) => {
      const top = tops[i], fresh = !was.has(b.id)
      const from = fresh ? top + shift : was.get(b.id)
      was.set(b.id, top)
      const inView = v => v + b.h > L.feedTop && v < L.feedBottom
      if (!inView(top) && !inView(from)) return
      for (const p of (fresh && b.firstPieces) || b.pieces) {
        const y0 = from + (fresh && !p.still ? L.rise : 0) + p.dy
        glide(out, f.start, f.dur, ease, b.x + p.dx, y0, top + p.dy, fresh && !p.still && !p.stream, clip, p.body, p.layer ?? 1)
      }
    })
    for (const c of f.chrome) out.add({ start: f.start, end: f.start + f.dur, layer: 3, ...c, key: typeof c.body === 'string' })
  }
}

// ---------- layouts ----------

function layout(kind, vertical, big) {
  const k = big ? 1.15 : 1
  const W = vertical ? 1080 : 1920, H = vertical ? 1920 : 1080
  const r = v => Math.round(v * k)
  // 9:16 keeps clear of the Shorts/Reels/TikTok overlays: tabs on top, buttons on the right, caption at the bottom.
  if (kind === 'terminal') {
    const L = vertical
      ? { X: 100, fs: r(40), lh: r(60), headY: 160, feedTop: 260, feedBottom: 1470, footY: 1520 }
      : { X: 100, fs: r(44), lh: r(62), headY: 56, feedTop: 160, feedBottom: 920, footY: 966 }
    return { ...L, W, H, colX: L.X, colW: W - 2 * L.X, rise: L.lh, bigFs: r(vertical ? 66 : 72), statFs: r(vertical ? 88 : 84), metaFs: L.fs }
  }
  const L = vertical
    ? { colX: 100, fs: r(42), lh: r(60), toolFs: r(36), titleY: 150, feedTop: 236, fieldBottom: 1560, statusFs: r(34), introZoom: 1.75, margin: 44 }
    : { colX: 160, fs: r(40), lh: r(58), toolFs: r(34), titleY: 46, feedTop: 124, fieldBottom: 1004, statusFs: r(28), introZoom: 2, margin: 70 }
  L.colW = W - 2 * L.colX
  L.pad = 28
  L.idleH = Math.round(2 * L.pad + L.fs * 1.12)
  L.feedBottom = L.fieldBottom - L.idleH - 40
  L.statusY = L.fieldBottom + 18
  return { ...L, W, H, X: L.colX, padX: 30, padY: 20, radius: 26, gap: 34, rise: 40, bubbleMax: Math.round(L.colW * (vertical ? 0.84 : 0.72)), bigFs: r(vertical ? 66 : 72), statFs: r(vertical ? 88 : 84), metaFs: r(36) }
}

// ---------- the desktop-app looks (desktop, desktop-light, paper) ----------

function desktopFrames({ parsed, steps, L, F, T, out, cues, opt, introHook }) {
  const ui = F.ui, rep = F.reply
  const repFont = rep.name !== ui.name ? rep.name : undefined
  const mU = s => ui.measure(s, L.fs), mR = s => rep.measure(s, L.fs), mT = s => ui.measure(s, L.toolFs)
  const run = tally(), blocks = [], frames = []
  let id = 0, group = null

  const bubble = s => {
    const lines = wrapPx(redact(s), L.bubbleMax - 2 * L.padX, mU, 8)
    const w = Math.round(Math.max(...lines.map(mU)) + 2 * L.padX), h = Math.round(2 * L.padY + L.fs * 1.12 + (lines.length - 1) * L.lh)
    return { id: id++, x: L.colX + L.colW - w, h, gap: L.gap, pieces: [
      { dx: 0, dy: 0, layer: 0, body: shape(roundRect(w, h, L.radius), T.bubble) },
      ...lines.map((l, i) => ({ dx: L.padX, dy: L.padY + i * L.lh, body: draw([seg(l, T.fg)], L.fs) })),
    ] }
  }
  // Replies stream in word by word, the way the app shows them arriving.
  const say = (s, dur) => {
    const lines = wrapPx(redact(s), L.colW, mR, 3), chars = lines.join('').length || 1
    const per = Math.min(90, dur * 70) / chars
    let before = 6
    const head = `{${BS}fs${L.fs}${repFont ? `${BS}fn${repFont}` : ''}}`
    return { id: id++, x: L.colX, h: Math.round(L.fs * 1.12 + (lines.length - 1) * L.lh), gap: L.gap,
      pieces: lines.map((l, i) => ({ dx: 0, dy: i * L.lh, body: draw([seg(l, T.fg)], L.fs, repFont) })),
      firstPieces: lines.map((l, i) => {
        const b0 = before
        before += l.length * per
        return { dx: 0, dy: i * L.lh, stream: true, body: e => head + typed([seg(l, T.fg)], b0, per, e) }
      }) }
  }
  const row = segs => ({ id: id++, x: L.colX, h: Math.round(L.toolFs * 1.15), gap: L.gap, pieces: [{ dx: 0, dy: 0, body: draw(segs, L.toolFs) }] })
  const groupPieces = g => {
    const add = g.tools.reduce((a, e) => a + e.add, 0), del = g.tools.reduce((a, e) => a + e.del, 0)
    const diff = [...(add ? [seg(`  +${num(add)}`, T.ok)] : []), ...(del ? [seg(`  −${num(del)}`, T.err)] : [])]
    const room = L.colW - mT(diff.map(s => s[0]).join('') + '  ▸')
    return [{ dx: 0, dy: 0, body: draw([seg(clipPx(toolSummary(g.tools), room, mT), T.dim), ...diff, seg('  ▸', T.dim)], L.toolFs) }]
  }

  // The composer grows upward with its text, as in the app.
  const fieldH = n => L.idleH + (n - 1) * L.lh
  const fieldTop = n => L.fieldBottom - fieldH(n)
  const iconY = L.fieldBottom - Math.round(L.idleH / 2)
  const plus = shape('m 12 0 l 16 0 l 16 12 l 28 12 l 28 16 l 16 16 l 16 28 l 12 28 l 12 16 l 0 16 l 0 12 l 12 12', T.fg)
  const enter = shape('m 30 0 l 34 0 l 34 21 l 10 21 l 10 17 l 30 17 m 0 19 l 11 9 l 11 29', T.fg)
  const caret = shape(rect(3, Math.round(L.fs * 1.1)), T.fg)
  // Own layers, not draw order: a held icon keeps its first place in the script, under a field that grew later.
  const composer = n => [
    { layer: 3, x: L.colX, y: fieldTop(n), body: shape(roundRect(L.colW, fieldH(n), 30), T.edge) },
    { layer: 4, x: L.colX + 2, y: fieldTop(n) + 2, body: shape(roundRect(L.colW - 4, fieldH(n) - 4, 28), T.field) },
    { layer: 5, x: L.colX + 30, y: iconY - 14, body: plus },
    { layer: 5, x: L.colX + L.colW - 64, y: iconY - 15, body: enter },
  ]
  const chrome = t => [
    { x: L.colX, y: L.titleY, body: draw([seg(clipPx(parsed.titleText, L.colW * 0.6, s => ui.measure(s, L.statusFs + 4)), T.fg, true)], L.statusFs + 4) },
    { an: 9, x: L.colX + L.colW, y: L.titleY, body: draw([seg(clock(t), T.dim)], L.statusFs) },
    { x: L.colX, y: L.statusY, body: draw([seg(`${num(run.prompts)}${plural(run.prompts, ' prompt')} · ${num(run.tools)}${plural(run.tools, ' tool call')} · ${num(run.files)}${plural(run.files, ' file')}`, T.dim)], L.statusFs) },
    { an: 9, x: L.colX + L.colW, y: L.statusY, body: draw([seg(`+${num(run.add)}`, T.ok), seg(` −${num(run.del)}`, T.err), ...(run.model ? [seg(`   ${run.model}`, T.fg)] : [])], L.statusFs) },
  ]
  const frame = (at, dur, t, extra) => frames.push({ start: at, dur, blocks: blocks.slice(-60).map(b => (b.tools ? { ...b, pieces: groupPieces(b) } : b)), chrome: [...chrome(t), ...(extra || composer(1))] })

  // Types a prompt into the composer with a moving caret; returns the composer's height in lines.
  const compose = (at, dur, t, text, zoom) => {
    const width = zoom ? (L.W - 2 * L.margin) / zoom - 130 : L.colW - 180
    const lines = wrapPx(redact(text), width, mU, zoom ? 5 : 4), chars = lines.join('').length || 1
    const typeStart = zoom ? 0.12 : 0.1, typeDur = Math.min(zoom ? 1.5 : 2.2, dur * 0.7)
    const per = (typeDur * 100) / chars
    const top = fieldTop(lines.length), x = L.colX + 90
    let before = typeStart * 100
    const items = lines.map((l, i) => {
      const b0 = before, y = top + L.pad + i * L.lh, cs = [...l]
      before += cs.length * per
      cs.forEach((_, k) => { // the caret steps with each character as it appears
        const t0 = at + (b0 + k * per) / 100
        out.add({ start: t0, end: t0 + per / 100, layer: 6, x: x + mU(cs.slice(0, k + 1).join('')), y: y + 2, body: caret })
      })
      return { layer: 5, x, y, body: e => `{${BS}fs${L.fs}}` + typed([seg(l, T.fg)], b0, per, e) }
    })
    const lastLine = lines.at(-1) || '', end = at + dur
    for (let s = at + before / 100; s < end; s += 1.06) { // the caret blinks once the text is in
      out.add({ start: s, end: Math.min(end, s + 0.53), layer: 6, x: x + mU(lastLine), y: top + L.pad + (lines.length - 1) * L.lh + 2, body: caret })
    }
    cues.push({ t: at + typeStart, sound: 'typing', dur: typeDur })
    frame(at, dur, t, [...composer(lines.length), ...items])
    return lines.length
  }
  const camFor = n => {
    const z = L.H > L.W ? 1.08 : 1.12, cy = fieldTop(n) + fieldH(n) / 2
    return { z, cx: L.W / 2, cy: cy - (0.22 * L.H) / z }
  }
  const zoomCams = opt.camera && steps.filter(s => s.prompt).length <= 24

  if (introHook) { // the intro is the first prompt typed in close-up, then the camera pulls out
    const zoom = opt.camera ? L.introZoom : 0
    const n = compose(0, INTRO, introHook.t, introHook.text, zoom || 0)
    if (zoom) {
      out.cameraStart({ z: zoom, cx: L.colX + (L.W / 2 - L.margin) / zoom, cy: fieldTop(n) + fieldH(n) / 2 })
      out.camera(INTRO - 0.85, INTRO - 0.1, out.rest)
    }
  }

  let at = INTRO
  let skip = !!introHook
  for (const step of steps) {
    const first = step.events[0]
    if (first.kind === 'prompt') {
      group = null
      if (!skip) {
        const dur = step.dur * 0.55
        const n = compose(at, dur, step.t, first.text, 0)
        if (zoomCams) out.camera(at, at + Math.min(0.5, dur * 0.4), camFor(n))
        at += dur
        step.dur -= dur
        if (zoomCams) out.camera(at, at + 0.55, out.rest)
      }
      skip = false
      run.count(first)
      blocks.push(bubble(first.text))
      cues.push({ t: at, sound: 'enter' })
    } else {
      for (const e of step.events) {
        run.count(e)
        if (e.kind === 'tool') {
          if (!group) {
            group = { id: id++, x: L.colX, h: Math.round(L.toolFs * 1.15), gap: L.gap, tools: [] }
            blocks.push(group)
          }
          group.tools.push(e)
        } else {
          group = null
          if (e.kind === 'say') blocks.push(say(e.text, step.dur))
          else { blocks.push(row([seg(`··· ${duration(e.ms)} later`, T.dim)])); cues.push({ t: at, sound: 'pages' }) }
        }
      }
    }
    frame(at, step.dur, step.t)
    at += step.dur
  }
  return { frames, end: at }
}

// ---------- the terminal (CLI) look ----------

function terminalFrames({ parsed, steps, L, F, T, cues }) {
  const cw = F.ui.measure('0', L.fs), cols = Math.floor(L.colW / cw), m = s => s.length * cw
  const run = tally(), blocks = [], frames = []
  let id = 0
  const INDENT = '\u00A0\u00A0' // libass trims leading spaces, not NBSP
  const line = (segs, extra = {}) => ({ id: id++, x: L.X, h: L.lh, gap: 0, segs, pieces: segs.length ? [{ dx: 0, dy: 0, body: draw(segs) }] : [], ...extra })

  const linesFor = e => {
    const text = e.text && redact(e.text)
    if (e.kind === 'prompt') {
      const ls = wrapPx(text, (cols - 2) * cw, m, 4)
      return [...(blocks.length ? [line([])] : []), ...ls.map((l, i) => line([seg(i ? INDENT : '> ', T.accent, true), seg(l, T.fg, true)], { typed: true }))]
    }
    if (e.kind === 'say') return wrapPx(text, (cols - 2) * cw, m, 2).map((l, i) => line([seg(i ? INDENT : '● ', T.fg), seg(l, T.fg)]))
    if (e.kind === 'gap') return [line([seg(`${INDENT}··· ${duration(e.ms)} later`, T.dim)])]
    const edit = e.add || e.del ? ` +${e.add} −${e.del}` : ''
    const room = (cols - 2 - e.tool.length - 2 - edit.length) * cw
    const segs = [seg('● ', e.failed ? T.err : T.ok), seg(e.tool, T.fg, true)]
    if (e.detail) {
      const d = redact(e.detail)
      segs.push(seg(`(${e.isPath ? clipLeftPx(d, room, m) : clipPx(d, room, m)})`, T.dim)) // paths keep their file name
    }
    if (edit) segs.push(seg(` +${e.add}`, T.ok), seg(` −${e.del}`, T.err))
    return [line(segs)]
  }

  const rule = y => ({ x: L.X, y, body: shape(rect(L.colW, 2), T.edge) })
  const chrome = t => {
    const stat = [seg(num(run.prompts), T.fg, true), seg(plural(run.prompts, ' prompt') + '   ', T.dim), seg(num(run.tools), T.fg, true), seg(plural(run.tools, ' tool call'), T.dim)]
    const stat2 = [seg(num(run.files), T.fg, true), seg(plural(run.files, ' file') + '   ', T.dim), seg(`+${num(run.add)}`, T.ok), seg(' ', T.dim), seg(`−${num(run.del)}`, T.err)]
    const rows = L.W < L.H ? [stat, stat2] : [[...stat, seg('   ', T.dim), ...stat2]]
    return [
      { x: L.X, y: L.headY, body: draw([seg(path.basename(parsed.cwd || '') || 'session', T.fg, true)]) },
      { an: 9, x: L.W - L.X, y: L.headY, body: draw([seg(clock(t), T.dim)]) },
      rule(L.headY + L.lh), rule(L.feedBottom + 8),
      ...rows.map((segs, i) => ({ x: L.X, y: L.footY + i * L.lh, body: draw(segs) })),
    ]
  }

  let at = INTRO
  for (const step of steps) {
    const fresh = []
    for (const e of step.events) { run.count(e); fresh.push(...linesFor(e)) }
    const typedLines = fresh.filter(l => l.typed)
    const chars = typedLines.reduce((a, l) => a + l.segs[1][0].length, 0) || 1
    const typeDur = Math.min(step.dur * 0.6, 2.4), per = (typeDur * 100) / chars
    let before = 4
    for (const l of typedLines) { // typed in the frame it appears in, plain from then on
      const b0 = before, mark = draw(l.segs.slice(0, 1))
      l.firstPieces = [{ dx: 0, dy: 0, still: true, body: e => mark + typed(l.segs.slice(1), b0, per, e) }]
      before += l.segs[1][0].length * per
    }
    if (typedLines.length) {
      cues.push({ t: at + 0.04, sound: 'typing', dur: typeDur })
      cues.push({ t: at + before / 100 + 0.08, sound: 'enter' })
    }
    if (step.events.some(e => e.kind === 'gap')) cues.push({ t: at, sound: 'pages' })
    blocks.push(...fresh)
    frames.push({ start: at, dur: step.dur, blocks: blocks.slice(-80), chrome: chrome(step.t) })
    at += step.dur
  }
  return { frames, end: at }
}

// ---------- the subtitle script ----------

export function script(parsed, opts = {}) {
  const opt = { vertical: false, length: 60, theme: 'desktop', text: 'normal', camera: true, watermark: true, ...opts }
  const T = { ...(THEMES[opt.theme] || THEMES.desktop), ...(opt.accent ? { accent: opt.accent } : {}) }
  const F = { ui: loadFont(T.ui), reply: loadFont(T.reply) }
  const L = layout(T.layout, opt.vertical, opt.text === 'large')
  const { events } = parsed
  const steps = plan(events, Math.max(5, opt.length - INTRO - OUTRO))
  const all = stats(events)
  const project = path.basename(parsed.cwd || '') || 'session'
  parsed = { ...parsed, titleText: parsed.title || project }
  const out = scene(L.W, L.H), cues = []
  const desktop = T.layout === 'desktop'

  // Intro. Desktop looks type the first prompt into the composer (see desktopFrames); a custom
  // --title, a session that opens without a prompt, and the terminal look get big typed text.
  const hookPrompt = !opt.title && events[0]?.kind === 'prompt' ? events[0] : null
  if (!desktop || !hookPrompt) {
    const hook = redact(opt.title || events.find(e => e.kind === 'prompt')?.text || project)
    const mark = desktop ? '' : '> '
    // A short hook is set big enough to fill the frame; a long one drops to the base size.
    let size = L.bigFs, lines
    for (const k of [2, 1.6, 1.3, 1]) {
      size = Math.round(L.bigFs * k)
      const m = s => F.ui.measure(s, size)
      lines = wrapPx(hook, L.colW - m(mark), m, k === 1 ? 5 : 3)
      if (k === 1 || !lines.at(-1).endsWith('\u2026')) break
    }
    let y = Math.round(L.H / 2 - (lines.length * size * 1.3 + 90) / 2)
    const per = 140 / (lines.join('').length || 1)
    let before = 12
    lines.forEach((l, i) => {
      const b0 = before, m = mark && draw([seg(i ? '\u00A0\u00A0' : mark, T.accent, true)])
      out.add({ start: 0, end: INTRO, x: L.X, y, body: e => `{${BS}fs${size}${BS}fad(0,300)}${m}${typed([seg(l, T.fg, !desktop)], b0, per, e)}` })
      before += l.length * per
      y += Math.round(size * 1.3)
    })
    out.add({ start: 0, end: INTRO, x: L.X, y: y + 40, body: `{${BS}fad(400,300)}${draw([seg(`${parsed.titleText} · ${day(events[0]?.t ?? Date.now())} · ${duration(all.active)} of work`, T.dim)], L.metaFs)}` })
    cues.push({ t: 0.3, sound: 'typing', dur: 1.45 })
  }

  const build = desktop ? desktopFrames : terminalFrames
  const { frames, end: feedEnd } = build({ parsed, steps, L, F, T, out, cues, opt, introHook: desktop ? hookPrompt : null })
  play(out, frames, L, T)

  // Outro: the totals count up, each traceable to the transcript.
  const o0 = feedEnd, o1 = feedEnd + OUTRO
  const statM = s => F.ui.measure(s, L.statFs)
  const rows = [ // [value, how the number reads, its label]; a session that changed no files skips those rows
    [all.prompts, num, n => [seg(plural(n, ' prompt'), T.dim)]],
    [all.tools, num, n => [seg(plural(n, ' tool call'), T.dim)]],
    ...(all.files ? [[all.files, num, n => [seg(plural(n, ' file') + ' changed', T.dim)]]] : []),
    ...(all.add || all.del ? [[all.add, v => `+${num(v)}`, () => [seg(`−${num(all.del)}`, T.err, true), seg(' lines', T.dim)]]] : []),
  ]
  const col = Math.max(...rows.map(([n, fmt]) => statM(fmt(n)))) // numbers right-aligned in one column
  const header = `${parsed.titleText} · ${duration(all.active)} of work in `, took = `${Math.round(o1)}s`
  const labelW = Math.max(...rows.map(([n, , label]) => statM(label(n).map(s => s[0]).join(''))))
  const X = Math.max(L.X, Math.round((L.W - Math.max(col + 24 + labelW, F.ui.measure(header + took, L.metaFs))) / 2)) // the block sits centred
  let y = Math.round(L.H / 2 - (rows.length * L.statFs * 1.35 + 90) / 2)
  out.add({ start: o0, end: o1, x: X, y, body: `{${BS}fad(300,0)}${draw([seg(header, T.dim), seg(took, T.accent)], L.metaFs)}` })
  y += 90
  const countUp = (i, value, numColor, label) => {
    const s = o0 + 0.25 + i * 0.14, N = 14, span = 0.9, rise = 0.4
    for (let k = 0; k <= N; k++) {
      const t0 = s + (span * k) / N, t1 = k === N ? o1 : s + (span * (k + 1)) / N
      const v = Math.round(value * easeOut(k / N)), a = easeOut(Math.min(1, (t0 - s) / rise)), b = easeOut(Math.min(1, (t1 - s) / rise))
      const move = { x1: undefined, y: y + 36 * (1 - a), y1: y + 36 * (1 - b), alpha: a < 1 ? [1 - a, 1 - b] : undefined }
      out.add({ start: t0, end: t1, an: 9, x: X + col, ...move, x1: X + col, body: draw([seg(numColor(v), T.fg, true)], L.statFs) })
      out.add({ start: t0, end: t1, x: X + col + 24, ...move, x1: X + col + 24, body: draw(label(v), L.statFs) })
    }
    y += Math.round(L.statFs * 1.35)
  }
  rows.forEach(([n, fmt, label], i) => countUp(i, n, fmt, label))
  cues.push({ t: o0 + 0.25 + (rows.length - 1) * 0.14 + 0.9, sound: 'knock' })
  if (opt.watermark) out.add({ start: o0 + 0.8, end: o1, an: 2, x: L.W / 2, y: L.H - 70, body: `{${BS}fad(400,0)}${draw([seg('made with session-reel', T.dim)], Math.round(L.metaFs * 0.8))}` })

  const head = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${L.W}`, `PlayResY: ${L.H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: M,${F.ui.name},${L.fs},&H00ECECEC,&HFF000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  return { ass: `${head.join('\n')}\n${out.lines()}\n`, seconds: o1, W: L.W, H: L.H, bg: T.bg, cues: cues.sort((a, b) => a.t - b.t), project, stats: all }
}

// ---------- sound: our own ElevenLabs-made effects, mixed in JS ----------

function readWav(file) {
  const b = fs.readFileSync(file)
  let p = 12, fmt, data
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4), size = b.readUInt32LE(p + 4)
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) }
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size)
    p += 8 + size + (size & 1)
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`${file}: expected a 16-bit PCM WAV`)
  const n = Math.floor(data.length / 2 / fmt.ch), samples = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2)
    samples[i] = s / fmt.ch / 32768
  }
  return { rate: fmt.rate, samples }
}

// Every take of every sound in sfx/ (typing-1.wav, typing-2.wav, ...), grouped by name.
export function loadSounds(dir = SFX_DIR) {
  const sounds = {}
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const m = f.match(/^([a-z]+)(?:-\d+)?\.wav$/)
    if (m) (sounds[m[1]] ||= []).push(readWav(path.join(dir, f)))
  }
  return sounds
}

// Each sound's level in the mix; every file in sfx/ is peak-normalised to -3 dBFS.
export const LEVEL = { typing: 1.6, enter: 1.3, pages: 1, knock: 1.3 }

// One-shots play once; a cue with `dur` loops its sound (the typing bed) with short fades.
// Repeats rotate takes and nudge pitch and level, so nothing machine-guns.
export function mix(cues, seconds, sounds, volume = 1) {
  const buf = new Float32Array(Math.ceil(seconds * RATE))
  const used = {}
  for (const c of cues) {
    const takes = sounds[c.sound]
    if (!takes?.length) continue
    const n = (used[c.sound] = (used[c.sound] ?? -1) + 1)
    const s = takes[n % takes.length], src = s.samples
    const wobble = c.dur ? 0 : ((n * 7919) % 11) / 10 - 0.5 // deterministic -0.5..0.5
    const step = (s.rate / RATE) * (1 + 0.06 * wobble), gain = (LEVEL[c.sound] ?? 1) * volume * (1 + 0.2 * wobble)
    const start = Math.round(c.t * RATE), len = c.dur ? Math.round(c.dur * RATE) : Math.floor((src.length - 1) / step)
    const fade = Math.round(0.04 * RATE)
    for (let i = 0; i < len; i++) {
      const o = start + i
      if (o < 0) continue
      if (o >= buf.length) break
      const pos = (i * step) % (src.length - 1), j = Math.floor(pos), f = pos - j
      const env = c.dur ? Math.min(1, i / fade, (len - i) / fade) : 1
      buf[o] += (src[j] * (1 - f) + src[j + 1] * f) * env * gain
    }
  }
  return buf
}

// ---------- rendering ----------

function ffmpeg(args, cwd, seconds, report) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { cwd })
    let err = '', buf = ''
    p.on('error', e => reject(e.code === 'ENOENT'
      ? new Error('ffmpeg not found on PATH (winget install ffmpeg · brew install ffmpeg · apt install ffmpeg)') : e))
    p.stderr.on('data', d => { err += d })
    p.stdout.on('data', d => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) {
        const us = l.match(/^out_time_us=(\d+)/)
        if (us) report(Math.min(0.99, Number(us[1]) / 1e6 / seconds))
      }
    })
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited ${code}`))))
  })
}

async function render(arg, opt) {
  const file = findTranscript(arg)
  const parsed = await parse(file)
  if (!parsed.events.length) throw new Error(`nothing to replay in ${file}`)
  const formats = opt.format === 'vertical' ? [true] : opt.format === 'horizontal' ? [false] : [false, true]
  const sounds = opt.sound ? loadSounds() : {} // silent unless asked for
  const id = path.basename(file, '.jsonl').slice(0, 8)
  const stamp = new Date(parsed.events[0].t).toISOString().slice(0, 10)
  let last = -1
  for (const [i, vertical] of formats.entries()) {
    const s = script(parsed, { ...opt, vertical })
    const suffix = vertical ? '9x16' : '16x9'
    const out = path.resolve(opt.out
      ? (formats.length > 1 ? opt.out.replace(/(\.mp4)?$/i, `-${suffix}.mp4`) : opt.out)
      : path.join(OUT_DIR, `${s.project}-${stamp}-${id}-${suffix}.mp4`))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reel-'))
    try {
      fs.writeFileSync(path.join(tmp, 'reel.ass'), s.ass)
      const audio = Object.keys(sounds).length
        ? (fs.writeFileSync(path.join(tmp, 'mix.f32'), Buffer.from(mix(s.cues, s.seconds, sounds, (opt.volume ?? 80) / 100).buffer)),
          ['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'mix.f32'])
        : ['-f', 'lavfi', '-i', `anullsrc=r=${RATE}:cl=mono`]
      await ffmpeg([
        '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
        '-f', 'lavfi', '-i', `color=c=0x${s.bg.slice(1)}:s=${s.W}x${s.H}:r=${opt.fps || 60}:d=${s.seconds.toFixed(2)}`,
        ...audio,
        '-vf', 'ass=reel.ass', '-af', 'alimiter=limit=0.9:level=false', '-shortest',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', out,
      ], tmp, s.seconds, f => {
        const pct = Math.floor(((i + f) / formats.length) * 100)
        if (pct > last) { last = pct; console.log(`progress ${pct}`) }
      })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    const st = s.stats
    if (i === 0) console.log(`${s.project}: ${duration(st.active)} of work, ${st.prompts} prompts, ${st.tools} tool calls, ${st.files} files -> ${s.seconds.toFixed(1)}s video`)
    console.log(`done ${out}`)
  }
}

function firstPrompt(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(512 * 1024)
  const n = fs.readSync(fd, buf, 0, buf.length, 0)
  fs.closeSync(fd)
  let cwd = ''
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    cwd ||= o.cwd || ''
    if (o.type === 'user' && o.message && !o.isMeta && !o.isSidechain) {
      const text = promptText(o.message.content)
      if (text) return { cwd, text }
    }
  }
  return { cwd, text: '' }
}

function list(cwd) {
  let files = allTranscripts()
  const mine = cwd ? files.filter(f => path.basename(path.dirname(f)) === cwd.replace(/[^A-Za-z0-9]/g, '-')) : []
  if (mine.length) files = mine
  const recent = files.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 12)
  for (const { f, m } of recent) {
    const { cwd: c, text } = firstPrompt(f)
    const when = new Date(m).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    const t = redact(text)
    console.log(`${path.basename(f).slice(0, 8)}  ${when.padEnd(16)}  ${(path.basename(c) || '?').padEnd(14).slice(0, 14)}  ${t.length > 60 ? t.slice(0, 59) + '…' : t}`)
  }
  console.log(`\nRender one: /reel <id>   (--format vertical|horizontal, --theme ${Object.keys(THEMES).join('|')}, --length 30)`)
}

const onOff = (v, name) => {
  if (v === 'on' || v === 'true') return true
  if (v === 'off' || v === 'false') return false
  throw new Error(`--${name} is on or off`)
}

async function main() {
  const argv = process.argv.slice(2), opt = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--vertical' || a === '--horizontal') opt.format = a.slice(2)
    else if (a === '--format') opt.format = argv[++i]
    else if (a === '--theme') opt.theme = argv[++i]
    else if (a === '--length') opt.length = Number(argv[++i])
    else if (a === '--title') opt.title = argv[++i]
    else if (a === '--out') opt.out = argv[++i]
    else if (a === '--cwd') opt.cwd = argv[++i]
    else if (a === '--sound') opt.sound = onOff(argv[++i], 'sound')
    else if (a === '--camera') opt.camera = onOff(argv[++i], 'camera')
    else if (a === '--watermark') opt.watermark = onOff(argv[++i], 'watermark')
    else if (a === '--volume') opt.volume = Number(argv[++i])
    else if (a === '--text') opt.text = argv[++i]
    else if (a === '--fps') opt.fps = Number(argv[++i])
    else if (a === '--accent') opt.accent = argv[++i] || undefined
    else pos.push(a)
  }
  if (opt.length !== undefined && !(opt.length >= 10 && opt.length <= 600)) throw new Error('--length is seconds, 10 to 600')
  if (opt.format && !['both', 'horizontal', 'vertical'].includes(opt.format)) throw new Error('--format is both, horizontal or vertical')
  if (opt.theme && !THEMES[opt.theme]) throw new Error(`--theme is ${Object.keys(THEMES).join(', ')}`)
  if (opt.text && !['normal', 'large'].includes(opt.text)) throw new Error('--text is normal or large')
  if (opt.volume !== undefined && !(opt.volume >= 0 && opt.volume <= 100)) throw new Error('--volume is 0 to 100')
  if (opt.fps !== undefined && ![30, 60].includes(opt.fps)) throw new Error('--fps is 30 or 60')
  if (opt.accent && !/^#[0-9a-f]{6}$/i.test(opt.accent)) throw new Error('--accent is a hex colour like #D97757')
  if (pos[0] === 'list') return list(opt.cwd)
  if (!pos[0]) throw new Error('give a session id, an id prefix or a .jsonl path (or: list)')
  await render(pos[0], opt)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
