import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tab } from '../types'

// Bumped after each scan so the cards redraw.
const revisionAtom = atom({ plugin: 'token-maxxing', key: 'revision' } as const, 0)
// Which period the pane shows.
const tabAtom = atom({ plugin: 'token-maxxing', key: 'tab' } as const, 'month' as Tab)

// API prices in $ per million tokens (Anthropic first-party rates, Nov. 2026).
// Cache writes: 1.25x input for the 5-minute TTL, 2x for the 1-hour TTL.
type Price = { input: number; output: number; cacheRead: number }
const PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}

// The longest known id the model starts with, so dated ids (claude-haiku-4-5-20251001) match.
function priceOf(model: string): Price | undefined {
  let best: string | undefined
  for (const id of Object.keys(PRICES)) {
    const isMatch = model === id || model.startsWith(`${id}-`)
    if (isMatch && (best === undefined || id.length > best.length)) best = id
  }
  return best === undefined ? undefined : PRICES[best]
}

type Bucket = { tokens: number; output: number; cost: number; messages: number }
type Cache = {
  version: 1
  // Bytes already read from each transcript (always at a line end).
  offsets: Record<string, number>
  // message id + request id -> [bucket key, output tokens counted, $ per output token]
  seen: Record<string, [string, number, number]>
  // "YYYY-MM|model" -> totals
  buckets: Record<string, Bucket>
}

const CHUNK = 4 * 1024 * 1024
let stats: Cache | undefined
let scanning: Promise<void> | undefined
let lastError: string | undefined
let lastScanAt = 0

const emptyCache = (): Cache => ({ version: 1, offsets: {}, seen: {}, buckets: {} })

// Byte length of a string once encoded as UTF-8.
function utf8Length(text: string) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

// ~/.claude, from where the plugin is installed (…/.claude/plugins/… or …/.claude/mods/…).
function claudeDirOf(root: string) {
  const match = /^(.*?[\\/]\.claude)(?:[\\/]|$)/.exec(root)
  return match ? match[1] : undefined
}

function addLine(cache: Cache, line: string) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return
  let entry: any
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  const message = entry?.message
  const usage = message?.usage
  const model: unknown = message?.model
  if (!usage || typeof model !== 'string' || model.startsWith('<')) return
  const key = `${message.id ?? ''}:${entry.requestId ?? ''}`
  const output = Number(usage.output_tokens) || 0
  const known = cache.seen[key]
  if (known) {
    // A later line of the same reply carries the final output count: add the difference.
    const [bucketKey, counted, perOutput] = known
    if (output > counted) {
      const bucket = cache.buckets[bucketKey]
      if (bucket) {
        bucket.tokens += output - counted
        bucket.output += output - counted
        bucket.cost += (output - counted) * perOutput
      }
      known[1] = output
    }
    return
  }

  const price = priceOf(model)
  const speed = usage.speed === 'fast' ? 2 : 1
  const input = Number(usage.input_tokens) || 0
  const cacheRead = Number(usage.cache_read_input_tokens) || 0
  const write1h = Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0
  const writeAll = Number(usage.cache_creation_input_tokens) || 0
  const write5m = usage.cache_creation ? Number(usage.cache_creation.ephemeral_5m_input_tokens) || 0 : writeAll
  const perOutput = price ? (price.output * speed) / 1e6 : 0
  const cost = price
    ? ((input * price.input + write5m * price.input * 1.25 + write1h * price.input * 2 + cacheRead * price.cacheRead) * speed) / 1e6 +
      output * perOutput
    : 0

  const month = typeof entry.timestamp === 'string' ? entry.timestamp.slice(0, 7) : 'unknown'
  const bucketKey = `${month}|${model.replace(/-\d{8}$/, '')}`
  const bucket = (cache.buckets[bucketKey] ??= { tokens: 0, output: 0, cost: 0, messages: 0 })
  bucket.tokens += input + cacheRead + write5m + write1h + output
  bucket.output += output
  bucket.cost += cost
  bucket.messages += 1
  cache.seen[key] = [bucketKey, output, perOutput]
}

// Reads what was appended to one transcript since the last scan.
async function readFile($: EngineInterface, cache: Cache, path: string, size: number) {
  let offset = cache.offsets[path] ?? 0
  if (size < offset) offset = 0 // rewritten: read again, the seen keys stop double counts
  let isSkipping = false
  while (offset < size) {
    const length = Math.min(CHUNK, size - offset)
    const text = (await $.fs.read(path, { offset, length })) as string
    const end = text.lastIndexOf('\n')
    if (end < 0) {
      // One line longer than a chunk (a huge tool output): skip to its end.
      if (length < CHUNK) break
      offset += length
      isSkipping = true
      continue
    }
    let body = text.slice(0, end)
    if (isSkipping) {
      const first = body.indexOf('\n')
      body = first < 0 ? '' : body.slice(first + 1)
      isSkipping = false
    }
    for (const line of body.split('\n')) addLine(cache, line)
    offset += utf8Length(text.slice(0, end + 1))
  }
  cache.offsets[path] = offset
}

async function transcripts($: EngineInterface, dir: string, depth: number, found: { path: string; size: number }[]) {
  const entries = await $.fs.list(dir).catch(() => [])
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) found.push({ path, size: entry.size })
    else if (entry.kind === 'dir' && depth > 0) await transcripts($, path, depth - 1, found)
  }
}

// The Claude Code config folder: from where the mod is installed, else from the environment
// (a mod loaded with --plugin-dir from a folder outside ~/.claude, or a custom CLAUDE_CONFIG_DIR).
async function findClaudeDir($: EngineInterface) {
  const fromRoot = claudeDirOf($.plugin.root)
  if (fromRoot) return fromRoot
  const read = async (command: string[]) => {
    const ran = await $.process.run(command).catch(() => undefined)
    const out = ran && ran.exitCode === 0 ? ran.stdout.trim() : ''
    return out && !out.includes('%') ? out : undefined
  }
  const configDir = await read(['printenv', 'CLAUDE_CONFIG_DIR'])
  if (configDir) return configDir
  const home = (await read(['printenv', 'HOME'])) ?? (await read(['cmd', '/c', 'echo %USERPROFILE%']))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}

async function scan($: EngineInterface) {
  const claudeDir = await findClaudeDir($)
  if (!claudeDir) {
    lastError = 'dossier ~/.claude introuvable'
    return
  }
  const cachePath = `${claudeDir}/token-maxxing/cache.json`
  if (!stats) {
    const saved = await $.fs.read(cachePath).catch(() => undefined)
    try {
      const parsed = saved ? (JSON.parse(saved as string) as Cache) : undefined
      stats = parsed?.version === 1 ? parsed : emptyCache()
    } catch {
      stats = emptyCache()
    }
  }
  const files: { path: string; size: number }[] = []
  await transcripts($, `${claudeDir}/projects`, 3, files)
  for (const { path, size } of files) {
    if ((stats.offsets[path] ?? 0) === size) continue
    await readFile($, stats, path, size).catch(error => {
      $.ui.log(`token-maxxing: ${path}: ${error}`, { to: 'debug' })
    })
  }
  // Transcripts Claude Code deletes later stay counted here: the cache is the history.
  await $.fs.write(cachePath, JSON.stringify(stats))
  lastScanAt = await $.clock.now()
  lastError = undefined
}

function refresh($: EngineInterface) {
  scanning ??= scan($)
    .catch(error => {
      lastError = String(error)
    })
    .finally(() => {
      scanning = undefined
    })
    .then(() => update($, revisionAtom, n => n + 1))
  return scanning
}

// ----- drawing -----

const PANE = 'token-maxxing'
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

// One accent for the whole pane, and one hue per model family.
const ACCENT = '#7c8cff'
const MUTED = '#8b949e'
const GOOD = '#3fb950'
const WARN = '#d29922'
const FAMILY_COLORS: [RegExp, string][] = [
  [/opus/, '#a78bfa'],
  [/sonnet/, '#f0883e'],
  [/haiku/, '#56d364'],
  [/fable|mythos/, '#39c5cf'],
]
const familyColor = (model: string) => FAMILY_COLORS.find(([pattern]) => pattern.test(model))?.[1] ?? MUTED

type ModelLine = { model: string; cost: number; tokens: number; share: number }
type MonthBar = { month: string; cost: number }
type View = {
  period: string
  cost: number
  tokens: number
  replies: number
  models: ModelLine[]
  months: MonthBar[]
  since?: string
}

function monthLabel(month: string, withYear = true) {
  const [year, index] = month.split('-')
  const name = MONTHS[Number(index) - 1] ?? month
  return withYear ? `${name} ${year}` : name
}

function viewOf(cache: Cache, month: string, tab: Tab): View {
  const byModel = new Map<string, ModelLine>()
  const byMonth = new Map<string, number>()
  let cost = 0
  let tokens = 0
  let replies = 0
  for (const [key, bucket] of Object.entries(cache.buckets)) {
    const [bucketMonth, model] = key.split('|')
    byMonth.set(bucketMonth, (byMonth.get(bucketMonth) ?? 0) + bucket.cost)
    if (tab === 'month' && bucketMonth !== month) continue
    const line = byModel.get(model) ?? { model, cost: 0, tokens: 0, share: 0 }
    line.cost += bucket.cost
    line.tokens += bucket.tokens
    byModel.set(model, line)
    cost += bucket.cost
    tokens += bucket.tokens
    replies += bucket.messages
  }
  const models = [...byModel.values()]
    .filter(line => line.tokens > 0)
    .map(line => ({ ...line, share: cost > 0 ? line.cost / cost : 0 }))
    .sort((a, b) => b.cost - a.cost)
  const months = [...byMonth.entries()]
    .filter(([key]) => /^\d{4}-\d{2}$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([key, value]) => ({ month: key, cost: value }))
  return {
    period: tab === 'month' ? monthLabel(month) : 'depuis le début',
    cost,
    tokens,
    replies,
    models,
    months,
    since: months[0] ? monthLabel(months[0].month) : undefined,
  }
}

// French number formats: 75,40 $ · 1 568 $ · 75,6 M · 2,74 Md
function groupThousands(value: number) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
function usd(value: number) {
  if (value >= 100) return `${groupThousands(value)} $`
  return `${value.toFixed(2).replace('.', ',')} $`
}
function tokenCount(count: number) {
  if (count >= 1e9) return `${(count / 1e9).toFixed(2).replace('.', ',')} Md`
  if (count >= 1e6) return `${(count / 1e6).toFixed(1).replace('.', ',')} M`
  if (count >= 1e3) return `${Math.round(count / 1e3)} k`
  return `${count}`
}
const percent = (share: number) => `${Math.round(share * 100)} %`
const shortModel = (model: string) => model.replace(/^claude-/, '')
const times = (ratio: number) => `x${ratio.toFixed(1).replace('.', ',')}`

function sinceLastScan(now: number) {
  if (lastScanAt === 0) return 'jamais mis à jour'
  const minutes = Math.floor((now - lastScanAt) / 60_000)
  return minutes < 1 ? "mis à jour à l'instant" : `mis à jour il y a ${minutes} min`
}

// ----- SVG pieces (desktop) -----

function shareBarSvg(width: number, share: number, color: string) {
  const filled = Math.max(share > 0 ? 3 : 0, Math.round(width * share))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="4" viewBox="0 0 ${width} 4"><rect width="${width}" height="4" rx="2" fill="${MUTED}" fill-opacity="0.18"/><rect width="${filled}" height="4" rx="2" fill="${color}"/></svg>`
}

function dotSvg(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${color}"/></svg>`
}

// The fill is this month's API cost, the tick is the subscription price.
function gaugeSvg(width: number, ratio: number) {
  const scale = Math.max(2, Math.ceil(ratio * 1.15))
  const filled = Math.round(width * Math.min(1, ratio / scale))
  const tick = Math.round(width / scale)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10"><rect y="2" width="${width}" height="6" rx="3" fill="${MUTED}" fill-opacity="0.18"/><rect y="2" width="${filled}" height="6" rx="3" fill="${ratio >= 1 ? GOOD : WARN}"/><rect x="${tick - 1}" width="2" height="10" rx="1" fill="${MUTED}"/></svg>`
}

function monthChartSvg(width: number, months: MonthBar[], current: string) {
  const height = 72
  const chart = 52
  const gap = 6
  const max = Math.max(...months.map(bar => bar.cost), 1)
  const barWidth = Math.max(6, Math.floor((width - gap * (months.length - 1)) / Math.max(1, months.length)))
  const parts = months.map((bar, index) => {
    const x = index * (barWidth + gap)
    const h = Math.max(2, Math.round((bar.cost / max) * chart))
    const opacity = bar.month === current ? 1 : 0.4
    const label = monthLabel(bar.month, false).replace('.', '')
    return `<rect x="${x}" y="${chart - h}" width="${barWidth}" height="${h}" rx="2" fill="${ACCENT}" fill-opacity="${opacity}"/><text x="${x + barWidth / 2}" y="${height - 4}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="9" fill="${MUTED}">${label}</text>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

// ----- text version (terminal, and /tokens without a surface) -----

function blocks(share: number, width: number) {
  const filled = Math.round(share * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

type Subscription = { label: string; paid: number; ratio: number }

// Months from `from` to `to`, both counted: 2026-05 to 2026-11 is 7.
function monthsBetween(from: string, to: string) {
  const [fromYear, fromMonth] = from.split('-').map(Number)
  const [toYear, toMonth] = to.split('-').map(Number)
  return Math.max(1, (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1)
}

// What the subscription cost over the period shown: this month, or every month since the first one with data.
function subscriptionOf(view: View, tab: Tab, month: string, planPriceUsd: number): Subscription | undefined {
  if (planPriceUsd <= 0) return undefined
  if (tab === 'month') return { label: `Abonnement ${usd(planPriceUsd)} / mois`, paid: planPriceUsd, ratio: view.cost / planPriceUsd }
  const months = monthsBetween(view.months[0]?.month ?? month, month)
  const paid = planPriceUsd * months
  return { label: `Abonnement ${usd(paid)} sur ${months} mois`, paid, ratio: view.cost / paid }
}

function textReport(view: View, subscription: Subscription | undefined) {
  const lines = [
    `Token-maxxing · coût équivalent API · ${view.period}`,
    `${usd(view.cost)}  ·  ${tokenCount(view.tokens)} tokens  ·  ${groupThousands(view.replies)} réponses`,
  ]
  if (subscription) lines.push(`${subscription.label} · rentabilisé ${times(subscription.ratio)}`)
  lines.push('')
  const width = Math.max(8, ...view.models.map(line => shortModel(line.model).length))
  for (const line of view.models) {
    lines.push(`${shortModel(line.model).padEnd(width)}  ${blocks(line.share, 12)}  ${usd(line.cost).padStart(9)}  ${tokenCount(line.tokens).padStart(8)}`)
  }
  return lines.join('\n')
}

// ----- the pane -----

async function openPane($: EngineInterface, isAsked: boolean) {
  const opened = await $.ui.open({ id: PANE, title: 'Token-maxxing', columns: 46 })
  if (!opened.isPlaced) {
    $.ui.log(`token-maxxing: pane waits: ${opened.reason}`, { to: 'debug' })
    if (isAsked) $.ui.toast(`Token-maxxing : panneau en attente (${opened.reason})`)
  }
  return opened.isPlaced
}

async function closePane($: EngineInterface) {
  await $.ui.close({ id: PANE })
}

async function selectTab($: EngineInterface, tab: Tab) {
  await update($, tabAtom, () => tab)
}

export const register: Register = (on, rawOptions) => {
  const raw = (rawOptions ?? {}) as Record<string, unknown>
  // Values saved from /plugin configure can arrive as text.
  const planPriceUsd = Number(raw.planPriceUsd) || 0
  const openOnNewSession = String(raw.openOnNewSession ?? 'true') !== 'false'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tokens',
      description: 'Token-maxxing : tokens et coût équivalent API par modèle, ce mois et depuis le début',
      immediate: true,
    })
    void refresh($)
    const usage = await $.session.usage().catch(() => undefined)
    const isNew = !usage || (usage.cost?.usd ?? 0) === 0
    // The desktop app starts sessions through the SDK: isInteractive and surface are not reliable there.
    if (openOnNewSession && isNew) await openPane($, false)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    void refresh($)
    return completed
  })

  on('command.run', { command: 'tokens' }, async $ => {
    const isPlaced = await openPane($, true)
    void refresh($)
    if (!isPlaced) {
      // claude -p "/tokens": no pane to draw, answer with text.
      await refresh($)
      if (!stats) return { text: `Token-maxxing : historique illisible${lastError ? ` (${lastError})` : ''}` }
      const month = new Date(await $.clock.now()).toISOString().slice(0, 7)
      return {
        text: [
          textReport(viewOf(stats, month, 'month'), subscriptionOf(viewOf(stats, month, 'month'), 'month', month, planPriceUsd)),
          textReport(viewOf(stats, month, 'all'), subscriptionOf(viewOf(stats, month, 'all'), 'all', month, planPriceUsd)),
        ].join('\n\n'),
        isTextDisplayOnly: true,
      }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, revisionAtom)
    const tab = await read($, tabAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()

    if (!stats || Object.keys(stats.buckets).length === 0) {
      return (
        <Box flexDirection="column" gap="sm" padding="sm">
          <Text weight="semibold">Token-maxxing</Text>
          <Text size="caption" dimColor>
            {lastError ? `Lecture impossible : ${lastError}` : "Lecture de l'historique des sessions…"}
          </Text>
        </Box>
      )
    }

    const month = new Date(now).toISOString().slice(0, 7)
    const view = viewOf(stats, month, tab)
    const subscription = subscriptionOf(view, tab, month, planPriceUsd)
    const tabs = (
      <Box key="tabs" flexDirection="row" gap="xs">
        <Button key="tab-month" label="Ce mois" variant={tab === 'month' ? 'primary' : 'secondary'} onPress={() => selectTab($, 'month')} />
        <Button key="tab-all" label="Total" variant={tab === 'all' ? 'primary' : 'secondary'} onPress={() => selectTab($, 'all')} />
      </Box>
    )

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text>{textReport(view, subscription)}</Text>
          <Text dimColor>Sessions locales · {sinceLastScan(now)}</Text>
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    const width = Math.max(180, Math.min(360, Math.round((e.props.bodyColumns ?? 40) * 7.2)))

    return (
      <Box flexDirection="column" gap="lg" padding="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold">Token-maxxing</Text>
          {tabs}
        </Box>

        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor>Coût équivalent API · {view.period}</Text>
          <Text size="title" weight="bold" tabular>{usd(view.cost)}</Text>
          <Text size="caption" dimColor tabular>
            {tokenCount(view.tokens)} tokens · {groupThousands(view.replies)} réponses
          </Text>
        </Box>

        {subscription && (
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" justifyContent="space-between">
              <Text size="caption" dimColor tabular>{subscription.label}</Text>
              <Text size="caption" weight="semibold" color={subscription.ratio >= 1 ? GOOD : WARN} tabular>
                rentabilisé {times(subscription.ratio)}
              </Text>
            </Box>
            <Svg source={gaugeSvg(width, subscription.ratio)} alt={`Rentabilisé ${times(subscription.ratio)}`} width={width} height={10} />
          </Box>
        )}

        {tab === 'all' && view.months.length > 1 && (
          <Box flexDirection="column" gap="xs">
            <Text size="caption" dimColor>Par mois</Text>
            <Svg source={monthChartSvg(width, view.months, month)} alt="Coût équivalent API par mois" width={width} height={72} />
          </Box>
        )}

        <Box flexDirection="column" gap="md">
          <Text size="caption" dimColor>Par modèle</Text>
          {view.models.map(line => (
            <Box key={line.model} flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Box flexDirection="row" gap="xs" alignItems="center">
                  <Svg source={dotSvg(familyColor(line.model))} alt="" width={8} height={8} />
                  <Text size="caption" weight="medium">{shortModel(line.model)}</Text>
                </Box>
                <Text size="caption" weight="medium" tabular>{usd(line.cost)}</Text>
              </Box>
              <Svg source={shareBarSvg(width, line.share, familyColor(line.model))} alt={`${percent(line.share)} du coût`} width={width} height={4} />
              <Text size="footnote" dimColor tabular>
                {tokenCount(line.tokens)} tokens · {percent(line.share)}
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="footnote" dimColor>
            Sessions locales{view.since ? ` depuis ${view.since}` : ''} · {sinceLastScan(now)}
          </Text>
          <Button key="close" label="Fermer" role="dismiss" plain dimColor onPress={() => closePane($)} />
        </Box>
      </Box>
    )
  })
}
