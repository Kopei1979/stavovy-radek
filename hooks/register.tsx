// Stavový řádek pro Claude Code v terminálu i v aplikaci Claude.
//
//   Opus 5.5 │ ████░░░░░░ 42% ⧗ 12 min │ 73%↑ 1:48 │ libs/Dress-Code │ 🌿 rule-fixes │ 📁 scratch
//
// Terminál: mod doplní do nastavení statusLine se statusline/statusline.cjs
// (jen když si uživatel žádný vlastní nenastavil), takže stačí plugin
// nainstalovat. Bez Node.js kreslí místo toho pruh nad promptem.
// Desktop: pruh nad promptem. Všude, i na mobilu: /stav otevře panel.
// Projekt a scratch jsou tlačítka: otevřou panel s obsahem složky.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { CacheMark, Folder, LimitInfo, Snapshot } from '../types'

const PLUGIN = 'stavovy-radek'
const PANE = 'stavovy-radek'
const FOLDER_PANE = 'stavovy-radek-slozka'
const COMMAND = 'stav'

const BAR_CELLS = 10
const CACHE_MIN_TOKENS = 20_000 // pod tímto objemem nehrozí nic drahého
const PACE_TOLERANCE = 2 // procentní body, o které smí spotřeba předběhnout čas
const REFRESH_MS = 30_000

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
}

// Značky tvaru: když se změní pole, starší uložená hodnota se nepoužije.
const snap = atom({ plugin: 'stavovy-radek', key: 'snap' } as const, null, { shape: 'snap-1' })
const cache = atom({ plugin: 'stavovy-radek', key: 'cache' } as const, null, { shape: 'cache-1' })
const folder = atom({ plugin: 'stavovy-radek', key: 'folder' } as const, null, { shape: 'folder-1' })
const tick = atom({ plugin: 'stavovy-radek', key: 'tick' } as const, 0)
const terminalBand = atom({ plugin: 'stavovy-radek', key: 'terminalBand' } as const, false)

type Engine = EngineInterface
type RenderArg = Parameters<Engine['ui']['resolve']>[0]
type Level = 'success' | 'warning' | 'error'

// ---------------------------------------------------------------- pomocníci

const levelColor = (pct: number): Level => (pct < 50 ? 'success' : pct < 80 ? 'warning' : 'error')

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** „claude-opus-5-5“ → „Opus 5.5“; co už je čitelné, nechá být. */
export function modelName(raw: string): string {
  const id = raw.toLowerCase().replace(/\[.*?\]/g, '').trim()
  let m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (m && m[1] && m[2]) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`
  m = id.match(/claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)/)
  if (m && m[1] && m[3]) return `${cap(m[3])} ${m[1]}${m[2] ? '.' + m[2] : ''}`
  if (/^[a-z]+$/.test(id)) return cap(id)
  return raw
}

/** 1:48 do 24 hodin, jinak 3d 4h. */
export function formatLeft(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean)
const baseName = (p: string) => parts(p).pop() ?? p
const lastTwo = (p: string) => parts(p).slice(-2).join('/') || p
const joinPath = (first: string, ...rest: string[]) => {
  const sep = first.includes('\\') && !first.includes('/') ? '\\' : '/'
  return [first.replace(/[\\/]+$/, ''), ...rest].join(sep)
}

/** Okno limitu, které je nejblíž vyčerpání. */
function worstLimit(limits: readonly SessionRateLimit[]): LimitInfo | null {
  let worst: LimitInfo | null = null
  for (const r of limits) {
    if (worst && r.percentUsed <= worst.pct) continue
    const resetsAt = r.resetsAt ? Date.parse(r.resetsAt) : NaN
    worst = {
      kind: r.kind,
      pct: r.percentUsed,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      windowMs: WINDOW_MS[r.kind] ?? null,
    }
  }
  return worst
}

/** Spotřeba předbíhá čas: z okna uběhlo méně, než se ho vyčerpalo. */
function isAhead(l: LimitInfo, now: number): boolean {
  if (l.windowMs === null || l.resetsAt === null) return false
  const elapsedPct = (100 * (l.windowMs - (l.resetsAt - now))) / l.windowMs
  return l.pct > elapsedPct + PACE_TOLERANCE
}

// ---------------------------------------------------------------- sběr dat

/** Jméno propojeného git worktree, ve kterém relace běží; jinak null. */
async function gitWorktree($: Engine, cwd: string): Promise<string | null> {
  try {
    const r = await $.process.run(
      ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { cwd, timeoutMs: 5000 },
    )
    if (r.exitCode !== 0) return null
    const [gitDir, commonDir, top] = r.stdout.trim().split(/\r?\n/)
    return gitDir && commonDir && top && gitDir !== commonDir ? baseName(top) : null
  } catch {
    return null
  }
}

let scratchPath: string | null = null

/** Odkládací složka Clauda: <tmp>/claude-<uid>/<projekt>/<id relace>/scratchpad. */
async function findScratch($: Engine, id: string, cwd: string): Promise<string | null> {
  const env = [
    await $.env.get('CLAUDE_CODE_TMPDIR'),
    '/tmp',
    await $.env.get('TMPDIR'),
    await $.env.get('TEMP'),
    await $.env.get('TMP'),
  ]
  const roots = [...new Set(env.filter((r): r is string => !!r))]
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  for (const root of roots) {
    let bases: string[] = []
    try {
      bases = (await $.fs.list(root)).filter(x => x.kind === 'dir' && x.name.startsWith('claude')).map(x => x.name)
    } catch {
      continue
    }
    for (const base of bases) {
      const baseDir = joinPath(root, base)
      const guess = joinPath(baseDir, slug, id, 'scratchpad')
      if (await $.fs.exists(guess).catch(() => false)) return guess
      const projects = await $.fs.list(baseDir).catch(() => [])
      for (const p of projects) {
        if (p.kind !== 'dir') continue
        const candidate = joinPath(baseDir, p.name, id, 'scratchpad')
        if (await $.fs.exists(candidate).catch(() => false)) return candidate
      }
    }
  }
  return null
}

let isRefreshing = false

async function refresh($: Engine): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const [usage, model, root, cwd, id] = await Promise.all([
      $.session.usage(),
      $.session.model(),
      $.session.root(),
      $.session.cwd(),
      $.session.id(),
    ])
    const worktree = await gitWorktree($, cwd)
    if (!scratchPath) scratchPath = await findScratch($, id, cwd)
    let scratch: Snapshot['scratch'] = null
    if (scratchPath) {
      const count = (await $.fs.list(scratchPath).catch(() => [])).length
      if (count > 0) scratch = { label: 'scratch', path: scratchPath, count }
    }
    const next: Snapshot = {
      model: modelName(model),
      contextPct: usage.context.percent ?? null,
      limit: worstLimit(usage.rateLimits),
      isSubscriber: usage.rateLimits.length > 0,
      project: { label: lastTwo(root), path: root },
      worktree,
      scratch,
    }
    await update($, snap, () => next)
  } catch (err) {
    $.ui.log(`${PLUGIN}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    isRefreshing = false
  }
}

// ---------------------------------------------------------------- akce

async function openFolder($: Engine, f: Folder): Promise<void> {
  await update($, folder, () => f)
  await $.ui.open({ id: FOLDER_PANE, title: f.label })
}

async function revealInOs($: Engine, path: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const isMac = !isWindows && (await $.fs.exists('/System/Library/CoreServices').catch(() => false))
  const argv = isWindows ? ['explorer.exe', path] : isMac ? ['open', path] : ['xdg-open', path]
  try {
    const r = await $.process.run(argv, { timeoutMs: 10_000 })
    // explorer.exe vrací 1 i při úspěchu
    if (r.exitCode !== 0 && !isWindows) $.ui.toast('Složku se nepodařilo otevřít ve správci souborů.')
  } catch {
    $.ui.toast('Složku se nepodařilo otevřít ve správci souborů.')
  }
}

// ---------------------------------------------------------------- kreslení

async function drawRow($: Engine, e: RenderArg, isWorking: boolean) {
  const s = await read($, snap)
  if (!s) return null
  await read($, tick) // přepočet odpočtů každých 30 s
  const c: CacheMark | null = await read($, cache)
  const now = await $.clock.now()
  const { Box, Text, Button } = $.ui.resolve(e)

  // Kontext: pruh + procenta, hned za nimi odpočet mezipaměti.
  const pct = s.contextPct
  const p = Math.max(0, Math.min(100, pct ?? 0))
  const filled = Math.round((p / 100) * BAR_CELLS)
  let cacheText: string | null = null
  let cacheColor: Level = 'warning'
  if (c && !isWorking && c.tokens >= CACHE_MIN_TOKENS) {
    const left = c.at + c.ttlMs - now
    if (left > 0) {
      cacheText = left < 60_000 ? '<1 min' : `${Math.ceil(left / 60_000)} min`
      if (left < 120_000) cacheColor = 'error'
    }
  }

  const segments = [
    <Text weight="bold">{s.model}</Text>,
    <Text>
      <Text color={levelColor(p)}>{'█'.repeat(filled)}</Text>
      <Text color="inactive">{'░'.repeat(BAR_CELLS - filled)}</Text>
      {' '}
      {pct === null ? <Text dimColor>–</Text> : `${Math.round(p)}%`}
      {cacheText ? <Text color={cacheColor}>{` ⧗ ${cacheText}`}</Text> : null}
    </Text>,
  ]

  if (s.limit) {
    const l = s.limit
    segments.push(
      <Text>
        <Text color={levelColor(l.pct)}>{`${Math.round(l.pct)}%${isAhead(l, now) ? '↑' : ''}`}</Text>
        {l.resetsAt !== null ? ` ${formatLeft(l.resetsAt - now)}` : ''}
      </Text>,
    )
  }

  segments.push(
    <Button key="projekt" plain onPress={() => openFolder($, s.project)}>
      {s.project.label}
    </Button>,
  )

  if (s.worktree) segments.push(<Text>🌿 {s.worktree}</Text>)

  const scratch = s.scratch
  if (scratch) {
    segments.push(
      <Button key="scratch" plain onPress={() => openFolder($, scratch)}>
        📁 scratch
      </Button>,
    )
  }

  const items = segments.flatMap((seg, i) =>
    i === 0 ? [seg] : [<Text color="subtle"> │ </Text>, seg],
  )

  return (
    <Box flexDirection="row" flexWrap="wrap" alignItems="center">
      {items}
    </Box>
  )
}

/** Příkaz statusLine, který mod doplní: skript přibalený k pluginu. */
function statusLineCommand(root: string): string {
  return `node "${root.replace(/\\/g, '/')}/statusline/statusline.cjs"`
}

// ---------------------------------------------------------------- háčky

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Ukáže stavový řádek v panelu (funguje i na mobilu)',
    })
    void refresh($)
    $.clock.every(REFRESH_MS, () => {
      void update($, tick, n => n + 1)
      void refresh($)
    })

    // Bez Node.js náš statusLine v terminálu nepoběží: pak kreslíme pruh.
    const statusLine = (await $.settings.read({ key: 'statusLine' }).catch(() => undefined)) as
      | { command?: unknown }
      | undefined
    const isOurs = statusLine?.command === statusLineCommand($.plugin.root)
    const hasNode = isOurs
      ? await $.process
          .run(['node', '--version'], { timeoutMs: 5000 })
          .then(r => r.exitCode === 0)
          .catch(() => false)
      : true
    await update($, terminalBand, () => isOurs && !hasNode)

    return next(e)
  })

  // Terminálový stavový řádek bez ručního nastavování: když uživatel nemá
  // vlastní statusLine, doplníme ten náš. Jeho vlastní má vždy přednost.
  on('settings.read', async ($, e, next) => {
    const r = await next(e)
    if (e.source !== undefined || r.value === undefined || r.value.statusLine !== undefined) return r

    return {
      value: {
        ...r.value,
        statusLine: { type: 'command', command: statusLineCommand($.plugin.root), refreshInterval: 30 },
      },
    }
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    void refresh($)

    return r
  })

  // Konec tahu hlavní smyčky: odpověď právě obnovila mezipaměť.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.usage) {
      const u = e.usage
      const cached = u.cache_read_input_tokens + u.cache_creation_input_tokens
      const usage = await $.session.usage()
      const mark: CacheMark | null =
        cached > 0
          ? {
              at: await $.clock.now(),
              // Předplatné (Pro/Max) jede s hodinovou mezipamětí, API s pětiminutovou.
              ttlMs: usage.rateLimits.length > 0 ? 3_600_000 : 300_000,
              tokens: usage.context.tokens ?? u.input_tokens + cached,
            }
          : null
      await update($, cache, () => mark)
    }
    void refresh($)

    return r
  })

  on('command.run', { command: COMMAND }, async $ => {
    void refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Stav' })

    return { text: opened.isPlaced ? 'Stavový řádek je v panelu.' : 'Panel se zobrazí, jakmile na něj bude místo.' }
  }).catch(() => ({ text: 'Panel se stavovým řádkem se nepodařilo otevřít.' }))

  // Pruh nad promptem na desktopu; v terminálu jen tehdy, když tam nemůže
  // běžet statusline.cjs (chybí Node.js).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (e.surface !== 'desktop' && !(e.surface === 'terminal' && (await read($, terminalBand)))) return next(e)
    const row = await drawRow($, e, e.props.isWorking)

    return row ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const row = await drawRow($, e, false)

    return row ?? <Text dimColor>Stav se načítá…</Text>
  })

  on('ui.render', { component: 'Pane', requestId: FOLDER_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const f = await read($, folder)
    if (!f) return <Text dimColor>Není vybraná žádná složka.</Text>

    const entries = await $.fs.list(f.path).catch(() => null)
    if (!entries) return <Text color="error">Složku nejde přečíst: {f.path}</Text>
    const sorted = [...entries].sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
    )
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 6)
    const isRemote = (await $.env.get('CLAUDE_CODE_REMOTE')) === 'true'

    return (
      <Box flexDirection="column">
        <Text dimColor>{f.path}</Text>
        {sorted.length === 0 && <Text dimColor>(prázdná)</Text>}
        {sorted.slice(0, room).map(x => (
          <Text>
            {x.kind === 'dir' ? '📁 ' : '   '}
            {x.name}
            {x.kind === 'file' ? <Text dimColor>{`  ${formatSize(x.size)}`}</Text> : null}
          </Text>
        ))}
        {sorted.length > room && <Text dimColor>{`… a dalších ${sorted.length - room}`}</Text>}
        {!isRemote && (
          <Button key="otevrit" onPress={() => revealInOs($, f.path)}>
            Otevřít ve správci souborů
          </Button>
        )}
      </Box>
    )
  })
}
