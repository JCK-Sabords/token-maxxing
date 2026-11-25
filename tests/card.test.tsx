import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-25T12:00:00Z')

// Two lines of the same reply (partial then final output), one older reply on another model.
const TRANSCRIPT = [
  JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: '2026-11-20T10:00:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 } } }),
  JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: '2026-11-20T10:00:01Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 } } }),
  JSON.stringify({ type: 'assistant', requestId: 'r2', timestamp: '2026-10-02T10:00:00Z', message: { id: 'm2', model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } } } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  '',
].join('\n')

const PANE = {
  plugin: 'token-maxxing',
  component: 'Pane',
  requestId: 'token-maxxing',
  props: { title: 'Token-maxxing', isFocused: false, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// The engine beneath the mod: one project with one transcript, no cache yet.
function engine(on: any, surfaces: string[]) {
  on('clock.now', () => ({ value: NOW }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { cost: { usd: 0 }, rateLimits: [], context: { window: 200_000 } } }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.open', () => ({ value: surfaces.length > 0 ? { isPlaced: true, requestId: 'token-maxxing' } : { isPlaced: false, reason: 'no surface' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.list', (_: unknown, e: { path?: string }) => {
    const path = String(e.path).replace(/\\/g, '/')
    if (path.endsWith('/projects')) return { value: [{ name: 'proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    if (path.endsWith('/proj')) return { value: [{ name: 's.jsonl', kind: 'file', size: TRANSCRIPT.length, mtimeMs: 0, isLink: false }] }
    return { value: [] }
  })
  on('fs.read', (_: unknown, e: { path: string; offset?: number; length?: number }) => {
    if (e.path.endsWith('cache.json')) return { deny: 'ENOENT' }
    const offset = e.offset ?? 0
    return { value: TRANSCRIPT.slice(offset, e.length === undefined ? undefined : offset + e.length) }
  })
  on('fs.write', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  // Where the mod is not under a .claude folder, it asks the environment.
  on('process.run', () => ({ value: { stdout: '/home/test\n', stderr: '', exitCode: 0 } }))
}

test('the pane shows this month, then all time, at API prices', { options: { planPriceUsd: 20 } } as never, async ($, on) => {
  engine(on, ['desktop'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  // Nov.: opus-5-5 = 1000*4 + 1M*0.2 + 100k*20 = 2,204 $ ; plan 20 $ -> x0,1
  expect(await ui.find({ type: 'Text', text: /^2,20 \$$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rentabilisé x0,1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^sonnet-5$/ })).toBeUndefined()

  await ui.press({ key: 'tab-all' })
  // All time adds sonnet-5 = 1M*2*2 (1h cache write) + 1M*10 = 14 $
  expect(await ui.find({ type: 'Text', text: /^16,20 \$$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^sonnet-5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^14,00 \$$/ })).toBeDefined()
  // Oct. and Nov. at 20 $: 40 $ paid against 16,20 $ of API cost
  expect(await ui.find({ type: 'Text', text: /^Abonnement 40,00 \$ sur 2 mois$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rentabilisé x0,4/ })).toBeDefined()
  await ui.unmount()
})

test('/tokens answers with text where no surface draws a pane', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const ran = (await $.command.run({ command: 'tokens', args: '' } as never)) as { text?: string }
  expect(ran.text).toMatch(/nov\. 2026/)
  expect(ran.text).toMatch(/opus-5-5 .*2,20 \$/)
  expect(ran.text).toMatch(/depuis le début\n16,20 \$/)
})

test('the pane also draws in the terminal', async ($, on) => {
  engine(on, ['terminal'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /Token-maxxing/ }))?.text).toMatch(/2,20 \$/)
  await ui.unmount()
})
