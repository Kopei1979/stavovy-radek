import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-11-11T10:00:00Z')
const MIN = 60_000
const SCRATCH = '/tmp/claude-0/-home-user-libs-Dress-Code/abc/scratchpad'

const BAND = {
  plugin: 'stavovy-radek',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'stavovy-radek',
  component: 'Pane',
  requestId: 'stavovy-radek',
  props: {
    title: 'Stav',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 12, mtimeMs: 0, isLink: false })

// Hooky testu stojí místo enginu: odpovídají na všechno, na co se mod ptá.
function engine(
  on: On,
  opts: { scratchFiles: number; limit: number; hasNode?: boolean; userSettings?: Record<string, unknown> },
) {
  on('settings.read', () => ({ value: opts.userSettings ?? {} }))
  on('command.register', () => ({ value: { command: 'stav' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 84_000, window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: opts.limit, resetsAt: new Date(NOW + 108 * MIN + 20_000).toISOString() },
        { kind: 'seven_day', percentUsed: 41.2, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
      ],
    },
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: '/home/user/libs/Dress-Code' }))
  on('session.cwd', () => ({ value: '/home/user/libs/Dress-Code' }))
  on('session.id', () => ({ value: 'abc' }))
  on('process.run', (_, e) => ({
    value: e.argv[0] === 'node' ? { exitCode: opts.hasNode === false ? 127 : 0, stdout: 'v22.0.0', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } : {
      exitCode: 0,
      stdout: '/r/.git/worktrees/rule-fixes\n/r/.git\n/r/.claude/worktrees/rule-fixes\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: e.path === SCRATCH }))
  on('fs.list', (_, e) => {
    if (e.path === '/tmp') return { value: [entry('claude-0', 'dir'), entry('other', 'dir')] }
    if (e.path === SCRATCH) {
      return { value: Array.from({ length: opts.scratchFiles }, (_, i) => entry(`f${i}.txt`, 'file')) }
    }
    return { value: [] }
  })
}

test('pruh na desktopu ukáže všechny segmenty jako na obrázku', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { scratchFiles: 2, limit: 73 })

  await $.session.start({ cwd: '/home/user/libs/Dress-Code', surface: 'desktop', isInteractive: true })
  await clock.settle()
  // Odpověď, která četla z mezipaměti, před 48 minutami (hodinové TTL → zbývá 12 min).
  await clock.set(NOW)
  await $.turn.complete({
    answer: 'hotovo',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4_000 },
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const missingIn = async (texts: string[]) => {
    const missing: string[] = []
    for (const text of texts) {
      const found = await ui.find({ type: 'Text', text: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
      if (!found) missing.push(text)
    }
    return missing
  }

  // Hned po odpovědi: 73 % vyčerpáno, ale z 5h okna uběhlo jen 64 % → šipka.
  expect(await missingIn(['Opus 5.5', '████', '░░░░░░', '42%', '⧗ 60 min', '73%↑', '1:48', '🌿 rule-fixes'])).toEqual([])
  expect(await ui.find({ key: 'projekt' })).toBeDefined()
  expect(await ui.find({ key: 'scratch' })).toBeDefined()

  // O 48 minut později: mezipaměť za 12 min vyprší, čas spotřebu dohnal.
  await clock.advance(48 * MIN)
  expect(await missingIn(['⧗ 12 min', '73%', '1:00'])).toEqual([])
  expect(await ui.find({ type: 'Text', text: /↑/ })).toBeUndefined()

  // Po vypršení odpočet zmizí.
  await clock.advance(13 * MIN)
  expect(await ui.find({ type: 'Text', text: /⧗/ })).toBeUndefined()
  await ui.unmount()
})

test('prázdná scratch složka a pomalá spotřeba: bez scratch a bez šipky', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { scratchFiles: 0, limit: 20 })

  await $.session.start({ cwd: '/home/user/libs/Dress-Code', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'scratch' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↑/ })).toBeUndefined()
  // Bez odpovědi z mezipaměti není co odpočítávat.
  expect(await ui.find({ type: 'Text', text: /⧗/ })).toBeUndefined()
  // Okno nejblíž limitu je teď týdenní (41 %), obnoví se za 3 dny.
  expect(await ui.find({ type: 'Text', text: /41%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3d 0h/ })).toBeDefined()
  await ui.unmount()
})

test('v terminálu pruh nekreslí (tam je statusline.js), panel /stav jde všude', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { scratchFiles: 1, limit: 73 })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/home/user/libs/Dress-Code', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await band.unmount()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    await pane.unmount()
  }
})

// Pruh v terminálu se kreslí jen tehdy, když mod doplnil svůj statusLine
// (settings.read) a ten nemůže běžet, protože chybí Node.js.
test('bez Node.js kreslí pruh i v terminálu', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { scratchFiles: 0, limit: 73, hasNode: false })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/home/user/libs/Dress-Code', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
  await band.unmount()
})

test('vlastní statusLine uživatele má přednost: mod ho nepřepíše ani nepřekreslí', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, {
    scratchFiles: 0,
    limit: 73,
    hasNode: false,
    userSettings: { statusLine: { type: 'command', command: 'muj.sh' } },
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/home/user/libs/Dress-Code', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await band.unmount()
})
