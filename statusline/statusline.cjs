#!/usr/bin/env node
// Stavový řádek pro Claude Code.
//
// Claude Code pošle skriptu na stdin JSON se stavem relace a zobrazí to, co
// skript vypíše. Segmenty zleva doprava:
//
//   Opus 5.5 │ ██████░░░░ 42% ⧗ 12 min │ 73%↑ 1:48 │ libs/Dress-Code │ 🌿 rule-fixes │ 📁 scratch
//
//   model · zaplnění kontextu · odpočet mezipaměti · vyčerpání předplatného
//   + čas do obnovení · projekt · git worktree · odkládací složka
//
// Prázdné segmenty (žádný worktree, prázdná scratch složka, žádné limity…)
// se nevypisují. Žádné závislosti, stačí Node.js 16+.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------- nastavení

const BAR_CELLS = 10; // šířka pruhu kontextu ve znacích
const CACHE_MIN_TOKENS = 20000; // pod tímto objemem nehrozí nic drahého → odpočet se skryje
const PACE_TOLERANCE = 2; // o kolik procentních bodů smí spotřeba předběhnout čas bez šipky
const USE_COLOR = !process.env.NO_COLOR;

// 256barevná paleta: funguje v Terminal.app, iTerm2, Windows Terminal, VS Code…
const C = {
  green: 77,
  yellow: 221,
  red: 203,
  track: 238, // nevyplněná část pruhu
  sep: 240, // oddělovače
  dim: 245,
};

const WINDOW_SECONDS = {
  five_hour: 5 * 3600,
  seven_day: 7 * 86400,
  daily: 86400,
  weekly: 7 * 86400,
  monthly: 30 * 86400,
};

// ---------------------------------------------------------------- pomocníci

const ESC = '\x1b';
const paint = (code, s) => (USE_COLOR ? `${ESC}[38;5;${code}m${s}${ESC}[39m` : s);
const bold = s => (USE_COLOR ? `${ESC}[1m${s}${ESC}[22m` : s);
const link = (url, s) => `${ESC}]8;;${url}${ESC}\\${s}${ESC}]8;;${ESC}\\`;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const levelColor = pct => (pct < 50 ? C.green : pct < 80 ? C.yellow : C.red);

// Viditelná šířka: bez escape sekvencí, emoji a široké znaky za dva sloupce.
function visibleWidth(s) {
  const plain = s
    .replace(/\x1b\]8;;.*?\x1b\\/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue;
    w += cp >= 0x1f300 ? 2 : 1;
  }
  return w;
}

// ---------------------------------------------------------------- segmenty

// „claude-opus-5-5“ → „Opus 5.5“, „claude-3-5-sonnet-20241022“ → „Sonnet 3.5“.
function modelName(model) {
  const display = (model && model.display_name) || '';
  if (/\d/.test(display)) return display;
  const id = String((model && model.id) || '').toLowerCase().replace(/\[.*?\]/g, '');
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  let m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  m = id.match(/claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)/);
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? '.' + m[2] : ''}`;
  return display || id || 'Claude';
}

function contextSegment(d) {
  const cw = d.context_window || {};
  let pct = num(cw.used_percentage);
  if (pct === null && cw.current_usage && num(cw.context_window_size)) {
    const u = cw.current_usage;
    const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    pct = (100 * used) / cw.context_window_size;
  }
  const p = Math.max(0, Math.min(100, pct || 0));
  const filled = Math.round((p / 100) * BAR_CELLS);
  const bar =
    paint(levelColor(p), '█'.repeat(filled)) + paint(C.track, '░'.repeat(BAR_CELLS - filled));
  return `${bar} ${pct === null ? paint(C.dim, '–') : Math.round(p) + '%'}`;
}

// Odpočet do vychladnutí mezipaměti. Prázdný, když je studená nebo levná.
function cacheSegment(d, now) {
  const pc = d.prompt_cache;
  if (!pc || !pc.warm || !num(pc.expires_at)) return '';
  const left = pc.expires_at - now;
  if (left <= 0) return '';
  const stake = num(pc.recache_tokens_if_cold);
  if (stake !== null && stake < CACHE_MIN_TOKENS) return '';
  const min = Math.ceil(left / 60);
  const text = left < 60 ? '<1 min' : `${min} min`;
  return paint(left < 120 ? C.red : C.yellow, `⧗ ${text}`);
}

// Okno limitu, které je nejblíž vyčerpání, šipka ↑ když spotřeba předbíhá čas,
// a za ním čas do obnovení.
function limitSegment(d, now) {
  const rl = d.rate_limits;
  if (!rl) return '';
  let worst = null;
  for (const [kind, w] of Object.entries(rl)) {
    const pct = w && num(w.used_percentage);
    if (pct === null) continue;
    if (!worst || pct > worst.pct) worst = { kind, pct, resetsAt: num(w.resets_at), period: w.period };
  }
  if (!worst) return '';

  const len = WINDOW_SECONDS[worst.kind] || WINDOW_SECONDS[worst.period];
  let ahead = false;
  if (len && worst.resetsAt) {
    const elapsedPct = (100 * (len - (worst.resetsAt - now))) / len;
    ahead = worst.pct > elapsedPct + PACE_TOLERANCE;
  }
  const pctText = paint(levelColor(worst.pct), `${Math.round(worst.pct)}%${ahead ? '↑' : ''}`);
  return worst.resetsAt ? `${pctText} ${formatLeft(worst.resetsAt - now)}` : pctText;
}

// 1:48 do 24 hodin, jinak 3d 4h.
function formatLeft(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function fileLink(p, text) {
  try {
    return link(pathToFileURL(p).href, text);
  } catch {
    return text;
  }
}

// Poslední dvě složky cesty projektu, klikací (otevře složku).
function projectSegment(d) {
  const dir = (d.workspace && (d.workspace.project_dir || d.workspace.current_dir)) || d.cwd;
  if (!dir) return '';
  const parts = path.resolve(dir).split(/[\\/]+/).filter(Boolean);
  const label = parts.slice(-2).join('/') || dir;
  return fileLink(dir, label);
}

function worktreeSegment(d) {
  const name = (d.worktree && d.worktree.name) || (d.workspace && d.workspace.git_worktree);
  return name ? `🌿 ${name}` : '';
}

// Odkládací složka Clauda: <tmp>/claude-<uid>/<projekt>/<session_id>/scratchpad.
function findScratchpad(sessionId, cwd) {
  if (!sessionId) return null;
  const roots = [...new Set([process.env.CLAUDE_CODE_TMPDIR, '/tmp', os.tmpdir()].filter(Boolean))];
  const slug = cwd ? path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-') : null;
  const isDir = p => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const list = p => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const root of roots) {
    for (const base of list(root).filter(n => n.startsWith('claude'))) {
      const baseDir = path.join(root, base);
      if (slug) {
        const guess = path.join(baseDir, slug, sessionId, 'scratchpad');
        if (isDir(guess)) return guess;
      }
      for (const project of list(baseDir)) {
        const candidate = path.join(baseDir, project, sessionId, 'scratchpad');
        if (isDir(candidate)) return candidate;
      }
    }
  }
  return null;
}

function scratchSegment(d) {
  const dir = findScratchpad(d.session_id, d.cwd || (d.workspace && d.workspace.current_dir));
  if (!dir) return '';
  let count = 0;
  try {
    count = fs.readdirSync(dir).length;
  } catch {}
  return count ? fileLink(dir, '📁 scratch') : '';
}

// ---------------------------------------------------------------- sestavení

function render(d, now) {
  const cache = cacheSegment(d, now);
  // Pořadí = pořadí na řádku; drop = kdo jde pryč první, když se nevejde.
  const segments = [
    { text: bold(modelName(d.model)), drop: 9 },
    { text: contextSegment(d) + (cache ? ' ' + cache : ''), drop: 8 },
    { text: limitSegment(d, now), drop: 7 },
    { text: projectSegment(d), drop: 4 },
    { text: worktreeSegment(d), drop: 5 },
    { text: scratchSegment(d), drop: 3 },
  ].filter(s => s.text);

  const sep = paint(C.sep, ' │ ');
  const join = segs => segs.map(s => s.text).join(sep);
  const columns = parseInt(process.env.COLUMNS, 10) || 0;
  let shown = segments;
  while (columns && shown.length > 1 && visibleWidth(join(shown)) > columns - 4) {
    const lowest = Math.min(...shown.map(s => s.drop));
    shown = shown.filter(s => s.drop !== lowest);
  }
  return join(shown);
}

module.exports = { render, modelName, formatLeft, visibleWidth };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => {
    let data = {};
    try {
      data = JSON.parse(raw || '{}');
    } catch {}
    try {
      process.stdout.write(render(data, Date.now() / 1000) + '\n');
    } catch (err) {
      process.stdout.write(`statusline: ${err.message}\n`);
    }
  });
}
