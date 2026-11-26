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
    lastError = t().noClaudeDir
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

// The pane speaks English by default; `language: fr` in the options switches it to French.
type Lang = 'en' | 'fr'
let lang: Lang = 'en'

const TEXT = {
  en: {
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    thisMonth: 'This month',
    allTime: 'All time',
    allTimePeriod: 'all time',
    apiCost: 'API-equivalent cost',
    replies: 'replies',
    costLine: (cost: string, tokens: string, replies: string) => `${cost} for ${tokens} tokens and ${replies} replies`,
    planMonth: (price: string) => `Subscription ${price}/month`,
    planTotal: (paid: string, months: number) => `Subscription ${paid} over ${months} month${months > 1 ? 's' : ''}`,
    roi: 'ROI',
    byMonth: 'By month',
    byModel: 'By model',
    ofCost: 'of the cost',
    localSessions: (since?: string) => `Local sessions${since ? ` since ${since}` : ''}`,
    neverUpdated: 'never updated',
    justUpdated: 'updated just now',
    updatedAgo: (minutes: number) => `updated ${minutes} min ago`,
    close: 'Close',
    reading: 'Reading your session history…',
    cannotRead: (error: string) => `Could not read your history: ${error}`,
    paneWaits: (reason: string) => `token-maxxing: pane waiting (${reason})`,
    command: 'token-maxxing: tokens and API-equivalent cost per model, this month and all time',
    chartAlt: 'API-equivalent cost per month',
    noClaudeDir: 'could not find the ~/.claude folder',
    flex: 'Flex it on your profile pic ↗',
    wrapped: (year: string) => `Your ${year} Wrapped ↗`,
  },
  fr: {
    months: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    thisMonth: 'Ce mois',
    allTime: 'Total',
    allTimePeriod: 'depuis le début',
    apiCost: 'Coût équivalent API',
    replies: 'réponses',
    costLine: (cost: string, tokens: string, replies: string) => `${cost} pour ${tokens} tokens et ${replies} réponses`,
    planMonth: (price: string) => `Abonnement ${price} / mois`,
    planTotal: (paid: string, months: number) => `Abonnement ${paid} sur ${months} mois`,
    roi: 'rentabilisé',
    byMonth: 'Par mois',
    byModel: 'Par modèle',
    ofCost: 'du coût',
    localSessions: (since?: string) => `Sessions locales${since ? ` depuis ${since}` : ''}`,
    neverUpdated: 'jamais mis à jour',
    justUpdated: "mis à jour à l'instant",
    updatedAgo: (minutes: number) => `mis à jour il y a ${minutes} min`,
    close: 'Fermer',
    reading: "Lecture de l'historique des sessions…",
    cannotRead: (error: string) => `Lecture impossible : ${error}`,
    paneWaits: (reason: string) => `token-maxxing : panneau en attente (${reason})`,
    command: 'token-maxxing : tokens et coût équivalent API par modèle, ce mois et depuis le début',
    chartAlt: 'Coût équivalent API par mois',
    noClaudeDir: 'dossier ~/.claude introuvable',
    flex: 'Afficher sur ta photo de profil ↗',
    wrapped: (year: string) => `Ton Wrapped ${year} ↗`,
  },
}
const t = () => TEXT[lang]

// One accent for the whole pane, and one hue per model family.
const ACCENT = '#7c8cff'
const MUTED = '#8b949e'
const GOOD = '#3fb950'
const BAD = '#f85149'
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
  const name = t().months[Number(index) - 1] ?? month
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
    period: tab === 'month' ? monthLabel(month) : t().allTimePeriod,
    cost,
    tokens,
    replies,
    models,
    months,
    since: months[0] ? monthLabel(months[0].month) : undefined,
  }
}

// Number formats. en: $75.40, $1,568, 75.6M, 2.74B, 45%, x3.9
//                 fr: 75,40 $, 1 568 $, 75,6 M, 2,74 Md, 45 %, x3,9
function groupThousands(value: number) {
  const separator = lang === 'fr' ? ' ' : ','
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator)
}
function decimal(value: number, digits: number) {
  const text = value.toFixed(digits)
  return lang === 'fr' ? text.replace('.', ',') : text
}
function usd(value: number) {
  const amount = value >= 100 ? groupThousands(value) : decimal(value, 2)
  return lang === 'fr' ? `${amount} $` : `$${amount}`
}
function tokenCount(count: number) {
  const space = lang === 'fr' ? ' ' : ''
  if (count >= 1e9) return `${decimal(count / 1e9, 2)}${space}${lang === 'fr' ? 'Md' : 'B'}`
  if (count >= 1e6) return `${decimal(count / 1e6, 1)}${space}M`
  if (count >= 1e3) return `${Math.round(count / 1e3)}${space}k`
  return `${count}`
}
const percent = (share: number) => `${Math.round(share * 100)}${lang === 'fr' ? ' ' : ''}%`
const shortModel = (model: string) => model.replace(/^claude-/, '')
const times = (ratio: number) => `x${decimal(ratio, 1)}`

function sinceLastScan(now: number) {
  if (lastScanAt === 0) return t().neverUpdated
  const minutes = Math.floor((now - lastScanAt) / 60_000)
  return minutes < 1 ? t().justUpdated : t().updatedAgo(minutes)
}

// ----- SVG pieces (desktop) -----

function shareBarSvg(width: number, share: number, color: string) {
  const filled = Math.max(share > 0 ? 3 : 0, Math.round(width * share))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="4" viewBox="0 0 ${width} 4"><rect width="${width}" height="4" rx="2" fill="${MUTED}" fill-opacity="0.18"/><rect width="${filled}" height="4" rx="2" fill="${color}"/></svg>`
}

function dotSvg(color: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="${color}"/></svg>`
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
  if (tab === 'month') return { label: t().planMonth(usd(planPriceUsd)), paid: planPriceUsd, ratio: view.cost / planPriceUsd }
  const months = monthsBetween(view.months[0]?.month ?? month, month)
  const paid = planPriceUsd * months
  return { label: t().planTotal(usd(paid), months), paid, ratio: view.cost / paid }
}

function textReport(view: View, subscription: Subscription | undefined) {
  const lines = [
    `token-maxxing: ${t().apiCost}, ${view.period}`,
    t().costLine(usd(view.cost), tokenCount(view.tokens), groupThousands(view.replies)),
  ]
  if (subscription) lines.push(`${subscription.label}, ${t().roi} ${times(subscription.ratio)}`)
  lines.push('')
  const width = Math.max(8, ...view.models.map(line => shortModel(line.model).length))
  for (const line of view.models) {
    lines.push(`${shortModel(line.model).padEnd(width)}  ${blocks(line.share, 12)}  ${usd(line.cost).padStart(9)}  ${tokenCount(line.tokens).padStart(8)}`)
  }
  return lines.join('\n')
}

// ----- the flex page -----

const FLEX_URL = 'https://jck-sabords.github.io/token-maxxing/flex/'

// FNV-1a, the same as the flex page: it catches typos and casual edits, it is not a proof.
function checksum(text: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// The page reads the score after the #, which the browser never sends to a server.
function flexUrl(view: View, tab: Tab, month: string, subscription: Subscription | undefined) {
  const roi = subscription ? subscription.ratio.toFixed(1) : ''
  const tokens = String(Math.round(view.tokens))
  const cost = String(Math.round(view.cost))
  const since = tab === 'all' ? (view.months[0]?.month ?? '') : month
  const c = checksum(`${roi}|${tokens}|${cost}|${tab}|${since}|token-maxxing`)
  const params = new URLSearchParams({ roi, tokens, cost, period: tab, since, lang, c })
  return `${FLEX_URL}#${params.toString()}`
}

const WRAPPED_URL = 'https://jck-sabords.github.io/token-maxxing/wrapped/'

// The year so far, for the Wrapped card: totals, the model and the month that cost the most.
function wrappedUrl(cache: Cache, month: string, planPriceUsd: number) {
  const year = month.slice(0, 4)
  const byModel = new Map<string, number>()
  const byMonth = new Map<string, number>()
  let tokens = 0
  let cost = 0
  let replies = 0
  for (const [key, bucket] of Object.entries(cache.buckets)) {
    const [bucketMonth, model] = key.split('|')
    if (!bucketMonth.startsWith(`${year}-`)) continue
    tokens += bucket.tokens
    cost += bucket.cost
    replies += bucket.messages
    byModel.set(model, (byModel.get(model) ?? 0) + bucket.cost)
    byMonth.set(bucketMonth, (byMonth.get(bucketMonth) ?? 0) + bucket.cost)
  }
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]
  const record = [...byMonth.entries()].sort((a, b) => b[1] - a[1])[0]
  const months = monthsBetween([...byMonth.keys()].sort()[0] ?? month, month)
  const paid = planPriceUsd > 0 ? planPriceUsd * months : 0
  // Same order as the page's FIELDS: the checksum depends on it.
  const fields = {
    year,
    tokens: String(Math.round(tokens)),
    cost: String(Math.round(cost)),
    replies: String(replies),
    roi: paid > 0 ? (cost / paid).toFixed(1) : '',
    paid: paid > 0 ? String(Math.round(paid)) : '',
    top: top ? shortModel(top[0]) : '',
    topShare: top && cost > 0 ? String(Math.round((top[1] / cost) * 100)) : '0',
    recMonth: record ? record[0] : month,
    recCost: String(Math.round(record ? record[1] : 0)),
    months: String(months),
  }
  const c = checksum(`${Object.values(fields).join('|')}|token-maxxing-wrapped`)
  return `${WRAPPED_URL}#${new URLSearchParams({ ...fields, lang, c }).toString()}`
}

// ----- the pane -----

async function openPane($: EngineInterface, isAsked: boolean) {
  const opened = await $.ui.open({ id: PANE, title: 'token-maxxing', columns: 46 })
  if (!opened.isPlaced) {
    $.ui.log(`token-maxxing: pane waits: ${opened.reason}`, { to: 'debug' })
    if (isAsked) $.ui.toast(t().paneWaits(opened.reason))
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
  lang = String(raw.language ?? 'en').trim().toLowerCase().startsWith('fr') ? 'fr' : 'en'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'tokens', description: t().command, immediate: true })
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
      if (!stats) return { text: `token-maxxing: ${t().cannotRead(lastError ?? '?')}` }
      const month = new Date(await $.clock.now()).toISOString().slice(0, 7)
      const thisMonth = viewOf(stats, month, 'month')
      const allTime = viewOf(stats, month, 'all')
      return {
        text: [
          textReport(thisMonth, subscriptionOf(thisMonth, 'month', month, planPriceUsd)),
          textReport(allTime, subscriptionOf(allTime, 'all', month, planPriceUsd)),
        ].join('\n\n'),
        isTextDisplayOnly: true,
      }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, revisionAtom)
    const tab = await read($, tabAtom)
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const now = await $.clock.now()

    if (!stats || Object.keys(stats.buckets).length === 0) {
      return (
        <Box flexDirection="column" gap="sm" padding="sm">
          <Text weight="semibold">token-maxxing</Text>
          <Text size="caption" dimColor>
            {lastError ? t().cannotRead(lastError) : t().reading}
          </Text>
        </Box>
      )
    }

    const month = new Date(now).toISOString().slice(0, 7)
    const view = viewOf(stats, month, tab)
    const subscription = subscriptionOf(view, tab, month, planPriceUsd)
    const flex = <Link key="flex" href={flexUrl(view, tab, month, subscription)} label={t().flex} />
    const wrapped = <Link key="wrapped" href={wrappedUrl(stats, month, planPriceUsd)} label={t().wrapped(month.slice(0, 4))} />
    const tabs = (
      <Box key="tabs" flexDirection="row" gap="xs">
        <Button key="tab-month" label={t().thisMonth} variant={tab === 'month' ? 'primary' : 'secondary'} onPress={() => selectTab($, 'month')} />
        <Button key="tab-all" label={t().allTime} variant={tab === 'all' ? 'primary' : 'secondary'} onPress={() => selectTab($, 'all')} />
      </Box>
    )

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text>{textReport(view, subscription)}</Text>
          {flex}
          {wrapped}
          <Text dimColor>{t().localSessions()}, {sinceLastScan(now)}</Text>
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    const width = Math.max(180, Math.min(360, Math.round((e.props.bodyColumns ?? 40) * 7.2)))

    return (
      <Box flexDirection="column" gap="lg" padding="sm">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold">token-maxxing</Text>
          {tabs}
        </Box>

        <Box flexDirection="column" gap="xs">
          <Text size="caption" dimColor>{t().apiCost}, {view.period}</Text>
          <Text size="title" weight="bold" tabular>{usd(view.cost)}</Text>
          <Text size="caption" dimColor tabular>
            {tokenCount(view.tokens)} tokens, {groupThousands(view.replies)} {t().replies}
          </Text>
        </Box>

        {subscription && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="caption" dimColor tabular>{subscription.label}</Text>
            <Text size="caption" weight="semibold" color={subscription.ratio >= 1 ? GOOD : BAD} tabular>
              {t().roi} {times(subscription.ratio)}
            </Text>
          </Box>
        )}

        <Box flexDirection="row" justifyContent="flex-end" gap="md" flexWrap="wrap">
          {wrapped}
          {flex}
        </Box>

        {tab === 'all' && view.months.length > 1 && (
          <Box flexDirection="column" gap="xs">
            <Text size="caption" dimColor>{t().byMonth}</Text>
            <Svg source={monthChartSvg(width, view.months, month)} alt={t().chartAlt} width={width} height={72} />
          </Box>
        )}

        <Box flexDirection="column" gap="md">
          <Text size="caption" dimColor>{t().byModel}</Text>
          {view.models.map(line => (
            <Box key={line.model} flexDirection="column" gap="xs">
              <Box flexDirection="row" justifyContent="space-between" alignItems="center">
                <Box flexDirection="row" gap="xs" alignItems="center">
                  <Svg source={dotSvg(familyColor(line.model))} alt="" width={8} height={8} />
                  <Text size="caption" weight="medium">{shortModel(line.model)}</Text>
                </Box>
                <Text size="caption" weight="medium" tabular>{usd(line.cost)}</Text>
              </Box>
              <Svg source={shareBarSvg(width, line.share, familyColor(line.model))} alt={`${percent(line.share)} ${t().ofCost}`} width={width} height={4} />
              <Text size="footnote" dimColor tabular>
                {tokenCount(line.tokens)} tokens, {percent(line.share)}
              </Text>
            </Box>
          ))}
        </Box>

        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="footnote" dimColor>
            {t().localSessions(view.since)}, {sinceLastScan(now)}
          </Text>
          <Button key="close" label={t().close} role="dismiss" plain dimColor onPress={() => closePane($)} />
        </Box>
      </Box>
    )
  })
}
