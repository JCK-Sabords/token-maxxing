import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Lang, Tab } from '../types'

// Bumped after each scan so the cards redraw.
const revisionAtom = atom({ plugin: 'token-maxxing', key: 'revision' } as const, 0)
// Which period the pane shows.
const tabAtom = atom({ plugin: 'token-maxxing', key: 'tab' } as const, 'month' as Tab)
// The pane's language, picked at its bottom and kept in $.store under 'language'.
const langAtom = atom({ plugin: 'token-maxxing', key: 'lang' } as const, 'en' as Lang)

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
const DAY = 24 * 3600 * 1000
// The cache only spares the next session the full read: saving it now and then is enough.
const SAVE_MS = 10 * 60 * 1000
// What a read shows for a character cut at its edge.
const CUT = String.fromCharCode(0xfffd)
let stats: Cache | undefined
let scanning: Promise<void> | undefined
let lastError: string | undefined
let lastScanAt = 0
let isUnsaved = false
let savedAt = 0

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

// The lines that speak of usage, found without cutting the whole text into lines.
function* usageLines(text: string) {
  let at = text.indexOf('"usage"')
  while (at >= 0) {
    const newline = text.indexOf('\n', at)
    const end = newline < 0 ? text.length : newline
    yield text.slice(text.lastIndexOf('\n', at) + 1, end)
    at = text.indexOf('"usage"', end)
  }
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
    const start = isSkipping ? text.indexOf('\n') + 1 : 0
    isSkipping = false
    for (const line of usageLines(text.slice(start, end))) addLine(cache, line)
    // The next read starts after the last whole line. Only what follows it is measured, the rest
    // is the length asked for; unless a character is cut there, then everything before is measured.
    const tail = text.slice(end + 1)
    offset += tail.includes(CUT) ? utf8Length(text.slice(0, end + 1)) : length - utf8Length(tail)
  }
  cache.offsets[path] = offset
}

// Transcripts live in <projects>/<project>/<session>.jsonl and in <session>/subagents/.
// A session folder is only opened if its transcript moved, or is less than a day old:
// subagents only write while their session does.
async function transcripts($: EngineInterface, projects: string, now: number, offsets: Cache['offsets']) {
  const found: { path: string; size: number }[] = []
  // Lists a folder, keeping the transcripts it holds.
  const open = async (dir: string) => {
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) found.push({ path: `${dir}/${entry.name}`, size: entry.size })
    }
    return entries
  }
  for (const project of await open(projects)) {
    if (project.kind !== 'dir') continue
    const dir = `${projects}/${project.name}`
    const entries = await open(dir)
    const files = new Map(entries.map(entry => [entry.name, entry]))
    for (const folder of entries) {
      if (folder.kind !== 'dir') continue
      const main = files.get(`${folder.name}.jsonl`)
      if (main && offsets[`${dir}/${main.name}`] === main.size && now - main.mtimeMs > DAY) continue
      const inside = await open(`${dir}/${folder.name}`)
      if (inside.some(entry => entry.name === 'subagents')) await open(`${dir}/${folder.name}/subagents`)
    }
  }
  return found
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
  const now = await $.clock.now()
  const files = await transcripts($, `${claudeDir}/projects`, now, stats.offsets)
  for (const { path, size } of files) {
    const before = stats.offsets[path] ?? 0
    if (before === size) continue
    await readFile($, stats, path, size).catch(error => {
      $.ui.log(`token-maxxing: ${path}: ${error}`, { to: 'debug' })
    })
    if ((stats.offsets[path] ?? 0) !== before) isUnsaved = true
  }
  // Transcripts Claude Code deletes later stay counted here: the cache is the history.
  if (isUnsaved && now - savedAt >= SAVE_MS) {
    await $.fs.write(cachePath, JSON.stringify(stats))
    isUnsaved = false
    savedAt = now
  }
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

// The pane speaks English until the person picks another language at its bottom; the pick is kept in $.store.
const LANGS: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'hy', label: 'Հայերէն' },
  { value: 'ar', label: 'العربية' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
]
const isLang = (value: unknown): value is Lang => LANGS.some(option => option.value === value)
let lang: Lang = 'en'

type Strings = {
  months: string[]
  thisMonth: string
  allTime: string
  allTimePeriod: string
  apiCost: string
  tokens: string
  replies: string
  costLine: (cost: string, tokens: string, replies: string) => string
  planMonth: (price: string) => string
  planTotal: (paid: string, months: number) => string
  roi: string
  byMonth: string
  byModel: string
  ofCost: string
  localSessions: (since?: string) => string
  neverUpdated: string
  justUpdated: string
  updatedAgo: (minutes: number) => string
  close: string
  reading: string
  cannotRead: (error: string) => string
  paneWaits: (reason: string) => string
  command: string
  chartAlt: string
  noClaudeDir: string
  flex: string
  wrapped: (year: string) => string
  language: string
}

const TEXT: Record<Lang, Strings> = {
  en: {
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    thisMonth: 'This month',
    allTime: 'All time',
    allTimePeriod: 'all time',
    apiCost: 'API-equivalent cost',
    tokens: 'tokens',
    replies: 'replies',
    costLine: (cost, tokens, replies) => `${cost} for ${tokens} tokens and ${replies} replies`,
    planMonth: price => `Subscription ${price}/month`,
    planTotal: (paid, months) => `Subscription ${paid} over ${months} month${months > 1 ? 's' : ''}`,
    roi: 'ROI',
    byMonth: 'By month',
    byModel: 'By model',
    ofCost: 'of the cost',
    localSessions: since => `Local sessions${since ? ` since ${since}` : ''}`,
    neverUpdated: 'never updated',
    justUpdated: 'updated just now',
    updatedAgo: minutes => `updated ${minutes} min ago`,
    close: 'Close',
    reading: 'Reading your session history…',
    cannotRead: error => `Could not read your history: ${error}`,
    paneWaits: reason => `token-maxxing: pane waiting (${reason})`,
    command: 'token-maxxing: tokens and API-equivalent cost per model, this month and all time',
    chartAlt: 'API-equivalent cost per month',
    noClaudeDir: 'could not find the ~/.claude folder',
    flex: 'Flex it on your profile pic ↗',
    wrapped: year => `Your ${year} Wrapped ↗`,
    language: 'Language',
  },
  fr: {
    months: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
    thisMonth: 'Ce mois',
    allTime: 'Total',
    allTimePeriod: 'depuis le début',
    apiCost: 'Coût équivalent API',
    tokens: 'tokens',
    replies: 'réponses',
    costLine: (cost, tokens, replies) => `${cost} pour ${tokens} tokens et ${replies} réponses`,
    planMonth: price => `Abonnement ${price} / mois`,
    planTotal: (paid, months) => `Abonnement ${paid} sur ${months} mois`,
    roi: 'rentabilisé',
    byMonth: 'Par mois',
    byModel: 'Par modèle',
    ofCost: 'du coût',
    localSessions: since => `Sessions locales${since ? ` depuis ${since}` : ''}`,
    neverUpdated: 'jamais mis à jour',
    justUpdated: "mis à jour à l'instant",
    updatedAgo: minutes => `mis à jour il y a ${minutes} min`,
    close: 'Fermer',
    reading: "Lecture de l'historique des sessions…",
    cannotRead: error => `Lecture impossible : ${error}`,
    paneWaits: reason => `token-maxxing : panneau en attente (${reason})`,
    command: 'token-maxxing : tokens et coût équivalent API par modèle, ce mois et depuis le début',
    chartAlt: 'Coût équivalent API par mois',
    noClaudeDir: 'dossier ~/.claude introuvable',
    flex: 'Afficher sur ta photo de profil ↗',
    wrapped: year => `Ton Wrapped ${year} ↗`,
    language: 'Langue',
  },
  de: {
    months: ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'],
    thisMonth: 'Dieser Monat',
    allTime: 'Gesamt',
    allTimePeriod: 'seit Beginn',
    apiCost: 'API-äquivalente Kosten',
    tokens: 'Tokens',
    replies: 'Antworten',
    costLine: (cost, tokens, replies) => `${cost} für ${tokens} Tokens und ${replies} Antworten`,
    planMonth: price => `Abo ${price}/Monat`,
    planTotal: (paid, months) => `Abo ${paid} über ${months} Monat${months > 1 ? 'e' : ''}`,
    roi: 'ROI',
    byMonth: 'Pro Monat',
    byModel: 'Pro Modell',
    ofCost: 'der Kosten',
    localSessions: since => `Lokale Sitzungen${since ? ` seit ${since}` : ''}`,
    neverUpdated: 'nie aktualisiert',
    justUpdated: 'gerade aktualisiert',
    updatedAgo: minutes => `vor ${minutes} Min. aktualisiert`,
    close: 'Schließen',
    reading: 'Sitzungsverlauf wird gelesen…',
    cannotRead: error => `Verlauf nicht lesbar: ${error}`,
    paneWaits: reason => `token-maxxing: Bereich wartet (${reason})`,
    command: 'token-maxxing: Tokens und API-äquivalente Kosten pro Modell, diesen Monat und insgesamt',
    chartAlt: 'API-äquivalente Kosten pro Monat',
    noClaudeDir: 'Ordner ~/.claude nicht gefunden',
    flex: 'Auf deinem Profilbild zeigen ↗',
    wrapped: year => `Dein Wrapped ${year} ↗`,
    language: 'Sprache',
  },
  hy: {
    months: ['Յունուար', 'Փետրուար', 'Մարտ', 'Ապրիլ', 'Մայիս', 'Յունիս', 'Յուլիս', 'Օգոստոս', 'Սեպտեմբեր', 'Հոկտեմբեր', 'Նոյեմբեր', 'Դեկտեմբեր'],
    thisMonth: 'Այս ամիս',
    allTime: 'Ընդհանուր',
    allTimePeriod: 'սկիզբէն ի վեր',
    apiCost: 'API-ի համարժէք արժէք',
    tokens: 'token',
    replies: 'պատասխան',
    costLine: (cost, tokens, replies) => `${cost}՝ ${tokens} token եւ ${replies} պատասխանի համար`,
    planMonth: price => `Բաժանորդագրութիւն ${price} / ամիս`,
    planTotal: (paid, months) => `Բաժանորդագրութիւն ${paid}՝ ${months} ամսուան համար`,
    roi: 'ROI',
    byMonth: 'Ըստ ամիսի',
    byModel: 'Ըստ մոդելի',
    ofCost: 'արժէքէն',
    localSessions: since => `Տեղական նիստեր${since ? `, սկսեալ ${since}` : ''}`,
    neverUpdated: 'տակաւին չէ թարմացուած',
    justUpdated: 'քիչ առաջ թարմացուեցաւ',
    updatedAgo: minutes => `թարմացուեցաւ ${minutes} րոպէ առաջ`,
    close: 'Գոցել',
    reading: 'Նիստերու պատմութիւնը կը կարդացուի…',
    cannotRead: error => `Կարելի չեղաւ կարդալ պատմութիւնը՝ ${error}`,
    paneWaits: reason => `token-maxxing՝ վահանակը կը սպասէ (${reason})`,
    command: 'token-maxxing՝ token-ներ եւ API-ի համարժէք արժէք ըստ մոդելի, այս ամիս եւ սկիզբէն ի վեր',
    chartAlt: 'API-ի համարժէք արժէք ըստ ամիսի',
    noClaudeDir: '~/.claude թղթապանակը չգտնուեցաւ',
    flex: 'Ցուցադրէ պրոֆիլի նկարիդ վրայ ↗',
    wrapped: year => `Քու ${year}-ի Wrapped-ը ↗`,
    language: 'Լեզու',
  },
  ar: {
    months: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
    thisMonth: 'هذا الشهر',
    allTime: 'الإجمالي',
    allTimePeriod: 'منذ البداية',
    apiCost: 'التكلفة المكافئة عبر API',
    tokens: 'توكن',
    replies: 'رد',
    costLine: (cost, tokens, replies) => `${cost} مقابل ${tokens} توكن و${replies} رد`,
    planMonth: price => `الاشتراك ${price} شهريًا`,
    planTotal: (paid, months) => `الاشتراك ${paid} خلال ${arabicMonths(months)}`,
    roi: 'العائد',
    byMonth: 'حسب الشهر',
    byModel: 'حسب النموذج',
    ofCost: 'من التكلفة',
    localSessions: since => `جلسات محلية${since ? ` منذ ${since}` : ''}`,
    neverUpdated: 'لم يُحدَّث بعد',
    justUpdated: 'حُدِّث للتو',
    updatedAgo: minutes => `حُدِّث قبل ${minutes} دقيقة`,
    close: 'إغلاق',
    reading: 'جارٍ قراءة سجل الجلسات…',
    cannotRead: error => `تعذّرت قراءة السجل: ${error}`,
    paneWaits: reason => `token-maxxing: اللوحة في الانتظار (${reason})`,
    command: 'token-maxxing: التوكنات والتكلفة المكافئة عبر API لكل نموذج، هذا الشهر ومنذ البداية',
    chartAlt: 'التكلفة المكافئة عبر API شهريًا',
    noClaudeDir: 'تعذّر العثور على المجلد ~/.claude',
    flex: 'اعرضها على صورة ملفك الشخصي ↗',
    wrapped: year => `ملخّصك لعام ${year} ↗`,
    language: 'اللغة',
  },
  es: {
    months: ['ene.', 'feb.', 'mar.', 'abr.', 'may.', 'jun.', 'jul.', 'ago.', 'sept.', 'oct.', 'nov.', 'dic.'],
    thisMonth: 'Este mes',
    allTime: 'Total',
    allTimePeriod: 'desde el principio',
    apiCost: 'Coste equivalente en API',
    tokens: 'tokens',
    replies: 'respuestas',
    costLine: (cost, tokens, replies) => `${cost} por ${tokens} tokens y ${replies} respuestas`,
    planMonth: price => `Suscripción ${price}/mes`,
    planTotal: (paid, months) => `Suscripción ${paid} en ${months} mes${months > 1 ? 'es' : ''}`,
    roi: 'ROI',
    byMonth: 'Por mes',
    byModel: 'Por modelo',
    ofCost: 'del coste',
    localSessions: since => `Sesiones locales${since ? ` desde ${since}` : ''}`,
    neverUpdated: 'nunca actualizado',
    justUpdated: 'actualizado ahora mismo',
    updatedAgo: minutes => `actualizado hace ${minutes} min`,
    close: 'Cerrar',
    reading: 'Leyendo tu historial de sesiones…',
    cannotRead: error => `No se pudo leer tu historial: ${error}`,
    paneWaits: reason => `token-maxxing: panel en espera (${reason})`,
    command: 'token-maxxing: tokens y coste equivalente en API por modelo, este mes y desde el principio',
    chartAlt: 'Coste equivalente en API por mes',
    noClaudeDir: 'no se encontró la carpeta ~/.claude',
    flex: 'Presúmelo en tu foto de perfil ↗',
    wrapped: year => `Tu Wrapped ${year} ↗`,
    language: 'Idioma',
  },
  pt: {
    months: ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'],
    thisMonth: 'Este mês',
    allTime: 'Total',
    allTimePeriod: 'desde o início',
    apiCost: 'Custo equivalente na API',
    tokens: 'tokens',
    replies: 'respostas',
    costLine: (cost, tokens, replies) => `${cost} por ${tokens} tokens e ${replies} respostas`,
    planMonth: price => `Assinatura ${price}/mês`,
    planTotal: (paid, months) => `Assinatura ${paid} em ${months} ${months > 1 ? 'meses' : 'mês'}`,
    roi: 'ROI',
    byMonth: 'Por mês',
    byModel: 'Por modelo',
    ofCost: 'do custo',
    localSessions: since => `Sessões locais${since ? ` desde ${since}` : ''}`,
    neverUpdated: 'nunca atualizado',
    justUpdated: 'atualizado agora',
    updatedAgo: minutes => `atualizado há ${minutes} min`,
    close: 'Fechar',
    reading: 'Lendo seu histórico de sessões…',
    cannotRead: error => `Não foi possível ler seu histórico: ${error}`,
    paneWaits: reason => `token-maxxing: painel aguardando (${reason})`,
    command: 'token-maxxing: tokens e custo equivalente na API por modelo, este mês e desde o início',
    chartAlt: 'Custo equivalente na API por mês',
    noClaudeDir: 'pasta ~/.claude não encontrada',
    flex: 'Ostente na sua foto de perfil ↗',
    wrapped: year => `Seu Wrapped ${year} ↗`,
    language: 'Idioma',
  },
}
const t = () => TEXT[lang]

// Arabic counts months as: 1 شهر واحد, 2 شهرين, 3 to 10 أشهر, 11 and more شهرًا.
function arabicMonths(months: number) {
  if (months === 1) return 'شهر واحد'
  if (months === 2) return 'شهرين'
  return months <= 10 ? `${months} أشهر` : `${months} شهرًا`
}

// How each language writes numbers: thousands and decimal marks, where the $ goes, unit words.
type NumberStyle = { thousands: string; decimal: string; dollarFirst: boolean; space: string; k: string; m: string; b: string }
const NUMBERS: Record<Lang, NumberStyle> = {
  en: { thousands: ',', decimal: '.', dollarFirst: true, space: '', k: 'k', m: 'M', b: 'B' },
  fr: { thousands: ' ', decimal: ',', dollarFirst: false, space: ' ', k: 'k', m: 'M', b: 'Md' },
  de: { thousands: '.', decimal: ',', dollarFirst: false, space: ' ', k: 'Tsd.', m: 'Mio.', b: 'Mrd.' },
  hy: { thousands: ' ', decimal: ',', dollarFirst: false, space: ' ', k: 'հզր', m: 'մլն', b: 'մլրդ' },
  ar: { thousands: ',', decimal: '.', dollarFirst: false, space: ' ', k: 'ألف', m: 'مليون', b: 'مليار' },
  es: { thousands: '.', decimal: ',', dollarFirst: false, space: ' ', k: 'mil', m: 'M', b: 'mil M' },
  pt: { thousands: '.', decimal: ',', dollarFirst: false, space: ' ', k: 'mil', m: 'mi', b: 'bi' },
}

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

// Number formats follow NUMBERS[lang]: en $75.40, $1,568, 75.6M, 2.74B, 45%; fr 75,40 $, 1 568 $, 75,6 M, 2,74 Md, 45 %
const style = () => NUMBERS[lang]
function groupThousands(value: number) {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, style().thousands)
}
function decimal(value: number, digits: number) {
  return value.toFixed(digits).replace('.', style().decimal)
}
function usd(value: number) {
  const amount = value >= 100 ? groupThousands(value) : decimal(value, 2)
  return style().dollarFirst ? `$${amount}` : `${amount} $`
}
function tokenCount(count: number) {
  const { space, k, m, b } = style()
  if (count >= 1e9) return `${decimal(count / 1e9, 2)}${space}${b}`
  if (count >= 1e6) return `${decimal(count / 1e6, 1)}${space}${m}`
  if (count >= 1e3) return `${Math.round(count / 1e3)}${space}${k}`
  return `${count}`
}
const percent = (share: number) => `${Math.round(share * 100)}${style().space}%`
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

async function selectLang($: EngineInterface, value: string) {
  if (!isLang(value)) return
  lang = value
  await $.store.set('language', value)
  await update($, langAtom, () => value)
}

export const register: Register = (on, rawOptions) => {
  const raw = (rawOptions ?? {}) as Record<string, unknown>
  // Values saved from /plugin configure can arrive as text.
  const planPriceUsd = Number(raw.planPriceUsd) || 0
  const openOnNewSession = String(raw.openOnNewSession ?? 'true') !== 'false'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const saved = await $.store.get('language').catch(() => undefined)
    if (isLang(saved)) {
      lang = saved
      await update($, langAtom, () => saved)
    }
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
    lang = await read($, langAtom)
    const { Box, Text, Button, Link, Select } = $.ui.resolve(e)
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

    const picker = (
      <Select key="lang" label={t().language} options={LANGS} value={lang} onSelect={value => selectLang($, value)} />
    )

    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text>{textReport(view, subscription)}</Text>
          {flex}
          {wrapped}
          <Text dimColor>{t().localSessions()}, {sinceLastScan(now)}</Text>
          {picker}
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
            {tokenCount(view.tokens)} {t().tokens}, {groupThousands(view.replies)} {t().replies}
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
                {tokenCount(line.tokens)} {t().tokens}, {percent(line.share)}
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

        {picker}
      </Box>
    )
  })
}
