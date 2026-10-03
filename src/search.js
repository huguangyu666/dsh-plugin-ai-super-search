import { promises as fs } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { delimiter, extname, isAbsolute, relative, resolve, sep } from 'node:path'

const DEFAULT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.sh', '.yaml', '.yml', '.toml'])
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', 'env', '__pycache__', 'dist', 'build', 'target', '.idea', '.vscode'])
const LANGUAGE_BY_EXT = {
  '.py': 'python', '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.h': 'c',
  '.hpp': 'cpp', '.sh': 'shell', '.bash': 'shell', '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json',
}
const DEFAULTS = { maxFiles: 200, maxBytes: 2_000_000, maxResults: 50, timeoutMs: 20_000, maxRedirects: 3 }

/** TinyFish Search API 端点（可用 TINYFISH_SEARCH_BASE_URL 覆盖）。 */
const TINYFISH_DEFAULT_BASE_URL = 'https://api.search.tinyfish.ai'

/**
 * TinyFish API Key。免费申请：https://agent.tinyfish.ai/api-keys
 * 该服务明文承诺 Search 不计费（`never draws from your wallet`）。
 */
export function tinyfishKey(env = process.env) {
  return String(env.TINYFISH_API_KEY || '').trim()
}

/** TinyFish 端点，允许通过环境变量覆盖（便于走代理或自建网关）。 */
export function tinyfishBaseUrl(env = process.env) {
  const raw = String(env.TINYFISH_SEARCH_BASE_URL || '').trim()
  return raw || TINYFISH_DEFAULT_BASE_URL
}

/** AnySearch 默认端点 */
const ANYSEARCH_DEFAULT_BASE_URL = 'https://api.anysearch.com'

/**
 * AnySearch API Key。支持通用网页检索与垂直搜索。
 */
export function anysearchKey(env = process.env) {
  return String(env.ANYSEARCH_API_KEY || '').trim()
}

export function anysearchBaseUrl(env = process.env) {
  const raw = String(env.ANYSEARCH_BASE_URL || '').trim()
  return raw || ANYSEARCH_DEFAULT_BASE_URL
}

export class SearchError extends Error {
  constructor(message, code = 'search_error', details = {}) {
    super(message)
    this.name = 'SearchError'
    this.code = code
    this.details = details
  }
}

export function isAllowedPath(candidate, roots) {
  const target = resolve(String(candidate))
  return (roots || []).some((root) => {
    const base = resolve(String(root))
    const rel = relative(base, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || (a === 192 && b === 168) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) || a >= 224
}

export function isBenchmarkAddress(address) {
  const host = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const version = isIP(host)
  if (version !== 4) return false
  const parts = host.split('.').map(Number)
  return parts.length === 4 && parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19
}

export function isAddressBlocked(address, options = {}) {
  // RFC 2544 基准网段 198.18/15：Clash 类代理 fake-ip 模式会解析公共域名到该网段，
  // 默认放行（本地/私网/链路本地/云元数据仍严格拦截）；DSH_SEARCH_BLOCK_BENCHMARK=1 恢复严格模式。
  if (isBenchmarkAddress(address)) return Boolean(options.blockBenchmark)
  return isBlockedHost(address)
}

function isPrivateIpv6(host) {
  const value = host.toLowerCase()
  return value === '::' || value === '::1' || value.startsWith('::ffff:') ||
    value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') ||
    value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
    value.startsWith('ff')
}

export function isBlockedHost(rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'metadata' || host === 'metadata.google.internal') return true
  const version = isIP(host)
  if (version === 4) return isPrivateIpv4(host)
  if (version === 6) return isPrivateIpv6(host)
  return false
}

function configuredRoots(input) {
  const values = Array.isArray(input) && input.length > 0
    ? input
    : String(process.env.DSH_SEARCH_ROOTS || '').split(delimiter).filter(Boolean)
  return [...new Set((values.length ? values : [process.cwd()]).map((value) => resolve(value)))]
}

function numberOption(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function normalizeExtensions(values) {
  if (!Array.isArray(values) || values.length === 0) return DEFAULT_EXTENSIONS
  return new Set(values.map((value) => {
    const ext = String(value).trim().toLowerCase()
    return ext.startsWith('.') ? ext : `.${ext}`
  }).filter(Boolean))
}

function languageFor(filePath) {
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()] || 'text'
}

async function safeRealpath(path) {
  try {
    return await fs.realpath(path)
  } catch {
    throw new SearchError(`目录不存在或不可读: ${path}`, 'path_unavailable')
  }
}

async function resolveAllowedDirectory(input, roots) {
  const requested = String(input || '.').trim() || '.'
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(roots[0], requested)
  if (!isAllowedPath(candidate, roots)) throw new SearchError('目录不在 DSH_SEARCH_ROOTS 允许范围内', 'path_denied')
  const real = await safeRealpath(candidate)
  if (!isAllowedPath(real, roots)) throw new SearchError('目录符号链接越过了允许根目录', 'path_denied')
  const stat = await fs.stat(real)
  if (!stat.isDirectory()) throw new SearchError('搜索目标不是目录', 'path_invalid')
  return real
}

async function assertSafeUrl(input, options = {}) {
  let url
  try { url = new URL(String(input)) } catch { throw new SearchError('URL 格式无效', 'url_invalid') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new SearchError('只允许 http/https URL', 'url_scheme_denied')
  if (url.username || url.password) throw new SearchError('URL 不允许携带账号密码', 'url_invalid')
  if (isAddressBlocked(url.hostname, options)) throw new SearchError(`已拒绝本地或私网地址: ${url.hostname}`, 'ssrf_blocked')
  if (isIP(url.hostname) === 0) {
    let addresses
    try { addresses = await lookup(url.hostname, { all: true }) } catch {
      throw new SearchError(`无法解析 URL 主机: ${url.hostname}`, 'dns_failed')
    }
    if (!addresses.length || addresses.some((entry) => isAddressBlocked(entry.address, options))) {
      throw new SearchError(`URL 解析到了本地或私网地址: ${url.hostname}`, 'ssrf_blocked')
    }
  }
  return url
}

async function fetchText(url, options = {}) {
  const timeoutMs = numberOption(options.timeoutMs, DEFAULTS.timeoutMs, 1000, 120_000)
  const maxRedirects = numberOption(options.maxRedirects, DEFAULTS.maxRedirects, 0, 5)
  let current = await assertSafeUrl(url, options)
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(current, {
        method: options.method || 'GET',
        body: options.body,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'dsh-ai-super-search/0.1', 'accept': 'text/html,text/plain,text/markdown,application/json,*/*;q=0.8', ...(options.headers || {}) },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new SearchError('重定向缺少 Location', 'redirect_invalid')
        if (attempt === maxRedirects) throw new SearchError('重定向次数超过限制', 'redirect_limit')
        current = await assertSafeUrl(new URL(location, current).toString(), options)
        continue
      }
      const text = await response.text()
      if (!response.ok) throw new SearchError(`请求失败: HTTP ${response.status}`, 'http_error', { status: response.status })
      return { url: current.toString(), text, status: response.status, contentType: response.headers.get('content-type') || '' }
    } catch (error) {
      if (error instanceof SearchError) throw error
      const message = error?.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : String(error?.message || error)
      throw new SearchError(message, error?.name === 'AbortError' ? 'timeout' : 'network_error')
    } finally {
      clearTimeout(timer)
    }
  }
  throw new SearchError('请求失败', 'network_error')
}
function decodeHtml(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
}

/**
 * 取第一个非空字符串。各搜索后端对「摘要」的字段命名不统一
 * （snippet / description / content / summary / text…），逐个尝试。
 * 全部拿不到时返回空串 —— 交给上层决定省略该字段。
 */
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return ''
}

function cleanText(text) {
  return decodeHtml(String(text).replace(/<[^>]*>/g, ' '))
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim()
}

function htmlTitle(html, fallback) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
  return (cleanText(title || '') || fallback || '未命名页面').slice(0, 200)
}

function htmlMainText(html) {
  const withoutChrome = String(html)
    .replace(/<(script|style|nav|footer|aside|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const body = withoutChrome.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ||
    withoutChrome.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || withoutChrome
  const marked = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n${'#'.repeat(Number(level))} ${cleanText(text)}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>|<\/div\s*>|<\/li\s*>|<\/tr\s*>/gi, '\n')
  return cleanText(marked)
}

function slugify(text) {
  return cleanText(text).toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
}

function extractMarkdownFragment(markdown, fragment) {
  if (!fragment) return markdown
  const wanted = slugify(decodeURIComponent(fragment))
  const lines = String(markdown).split('\n')
  let start = -1
  let level = 7
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (match && (slugify(match[2]) === wanted || slugify(match[2]).includes(wanted))) {
      start = index
      level = match[1].length
      break
    }
  }
  if (start < 0) return markdown
  const selected = [lines[start]]
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+/)
    if (match && match[1].length <= level) break
    selected.push(lines[index])
  }
  return selected.join('\n').trim()
}

function parseJinaLinks(markdown, limit) {
  const results = []
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g
  let match
  while ((match = pattern.exec(markdown)) && results.length < limit) {
    const title = cleanText(match[1])
    if (!title || title.startsWith('!')) continue
    results.push({ title, url: match[2], snippet: '', score: Math.max(0.1, 1 - results.length * 0.1), source: 'jina' })
  }
  return results
}

export function parseBing(html, limit) {
  const results = []
  const blockRe = /<li[^>]*class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  let block
  while ((block = blockRe.exec(String(html))) && results.length < limit) {
    const link = block[1].match(/<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const url = decodeBingUrl(link[1])
    if (!/^https?:\/\//i.test(url)) continue
    const title = cleanText(link[2])
    if (!title) continue
    const snippetMatch = block[1].match(/<(?:p|span)[^>]*class=["'][^"']*b_(?:caption|snippet|lineclamp)[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|span)>/i)
    results.push({ title, url, snippet: snippetMatch ? cleanText(snippetMatch[1]) : '', score: Math.max(0.1, 1 - results.length * 0.1), source: 'bing' })
  }
  return results
}

function decodeBingUrl(href) {
  const value = String(href || '')
  // Bing 跳转链接格式: /ck/a?....&u=base64url(真实URL)
  const match = value.match(/[?&]u=([^&]+)/)
  if (!match) return value
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return decoded.startsWith('http') ? decoded : value
  } catch { return value }
}

function decodeDdgUrl(href) {
  const value = String(href || '')
  const match = value.match(/[?&]uddg=([^&]+)/)
  if (match) {
    try { return decodeURIComponent(match[1]) } catch { return match[1] }
  }
  if (value.startsWith('//')) return `https:${value}`
  return value
}

export function parseDdg(html, limit) {
  const results = []
  const anchorPattern = /<a(?=[^>]*\bclass=["'][^"']*result-link[^"']*["'])[^>]*>([\s\S]*?)<\/a>/gi
  const snippetPattern = /<[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi
  const tags = []
  let match
  while ((match = anchorPattern.exec(String(html))) && tags.length < limit) {
    const href = match[0].match(/href=["']([^"']+)["']/i)?.[1]
    if (!href) continue
    tags.push({ href, title: cleanText(match[1]) })
  }
  const snippets = [...String(html).matchAll(snippetPattern)].map((item) => cleanText(item[1]))
  for (let index = 0; index < tags.length; index += 1) {
    const { href, title } = tags[index]
    const url = decodeDdgUrl(href)
    if (!/^https?:\/\//i.test(url)) continue
    results.push({ title: title || url, url, snippet: snippets[index] || '', score: Math.max(0.1, 1 - results.length * 0.1), source: 'ddg' })
    if (results.length >= limit) break
  }
  return results
}
async function* walkFiles(root, extensions, limits) {
  const queue = [root]
  let visited = 0
  while (queue.length && visited < limits.maxFiles) {
    const current = queue.shift()
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (visited >= limits.maxFiles) break
      if (entry.isSymbolicLink()) continue
      const fullPath = resolve(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) queue.push(fullPath)
        continue
      }
      if (!entry.isFile() || !extensions.has(extname(entry.name).toLowerCase())) continue
      let stat
      try { stat = await fs.stat(fullPath) } catch { continue }
      visited += 1
      if (stat.size > limits.maxBytes) continue
      yield fullPath
    }
  }
}

function snippetFor(content, query, width = 280) {
  const source = String(content)
  const index = source.toLowerCase().indexOf(String(query).toLowerCase())
  if (index < 0) return source.slice(0, width)
  const start = Math.max(0, index - Math.floor(width / 3))
  return `${start > 0 ? '…' : ''}${source.slice(start, start + width)}${start + width < source.length ? '…' : ''}`
}

function normalizeQuery(value) {
  const query = String(value ?? '').trim()
  if (!query) throw new SearchError('query 不能为空', 'query_invalid')
  if (query.length > 500) throw new SearchError('query 过长', 'query_invalid')
  return query
}

export function createSearchService(options = {}) {
  const roots = configuredRoots(options.roots)
  const blockBenchmark = options.blockBenchmark ?? String(process.env.DSH_SEARCH_BLOCK_BENCHMARK || '') === '1'
  const limits = {
    maxFiles: numberOption(options.maxFiles, numberOption(process.env.DSH_SEARCH_MAX_FILES, DEFAULTS.maxFiles, 1, 2000), 1, 2000),
    maxBytes: numberOption(options.maxBytes, numberOption(process.env.DSH_SEARCH_MAX_BYTES, DEFAULTS.maxBytes, 1024, 20_000_000), 1024, 20_000_000),
    maxResults: numberOption(options.maxResults, numberOption(process.env.DSH_SEARCH_MAX_RESULTS, DEFAULTS.maxResults, 1, 200), 1, 200),
    timeoutMs: numberOption(options.timeoutMs, DEFAULTS.timeoutMs, 1000, 120_000),
  }

  // ⚠ GUI 面板把 Key 存进 DSH 的 credentials 服务，而这个服务此前只读
  // `process.env` —— 两条路是断的：面板显示「已配置」，搜索链路却永远看不到，
  // 只能退化到免 Key 后端。官方契约（见 dsh-web-search-deepseek）是
  // 「凭据服务优先、环境变量兜底」，所以在取 Key 前先拉一份凭据快照叠在
  // process.env 之上。没有注入 resolveEnv 时行为与以前完全一致。
  const resolveEnv = typeof options.resolveEnv === 'function' ? options.resolveEnv : null

  /** 合并后的有效环境：凭据服务里的同名引用优先，process.env 兜底。 */
  async function effectiveEnv() {
    if (resolveEnv === null) return process.env
    try {
      const stored = await resolveEnv()
      return stored !== null && typeof stored === 'object' ? { ...process.env, ...stored } : process.env
    } catch {
      return process.env
    }
  }

  let closed = false

  function assertOpen() {
    if (closed) throw new SearchError('搜索服务已关闭', 'service_closed')
  }

  async function searchLocalFiles({ query: rawQuery, directory = '.', fileTypes = [], limit } = {}) {
    assertOpen()
    const query = normalizeQuery(rawQuery)
    const root = await resolveAllowedDirectory(directory, roots)
    const maxResults = numberOption(limit, limits.maxResults, 1, limits.maxResults)
    const results = []
    const extensions = normalizeExtensions(fileTypes)
    for await (const filePath of walkFiles(root, extensions, limits)) {
      let content
      try { content = await fs.readFile(filePath, 'utf8') } catch { continue }
      if (!content.toLowerCase().includes(query.toLowerCase())) continue
      results.push({ title: filePath.split(/[\\/]/).pop() || filePath, path: filePath, snippet: snippetFor(content, query), score: 1, source: 'local_file' })
      if (results.length >= maxResults) break
    }
    return { query, directory: root, total: results.length, results, truncated: results.length >= maxResults }
  }

  async function searchCode({ query: rawQuery, directory = '.', fileTypes = [], limit } = {}) {
    const response = await searchLocalFiles({ query: rawQuery, directory, fileTypes: fileTypes.length ? fileTypes : [...DEFAULT_EXTENSIONS], limit })
    const results = []
    for (const file of response.results) {
      let content
      try { content = await fs.readFile(file.path, 'utf8') } catch { continue }
      const lines = content.split(/\r?\n/)
      const query = String(rawQuery).toLowerCase()
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(query)) continue
        results.push({ title: file.title, path: file.path, line: index + 1, language: languageFor(file.path), code: lines.slice(Math.max(0, index - 1), index + 2).join('\n'), score: 1, source: 'code' })
        if (results.length >= numberOption(limit, limits.maxResults, 1, limits.maxResults)) break
      }
      if (results.length >= numberOption(limit, limits.maxResults, 1, limits.maxResults)) break
    }
    return { query: normalizeQuery(rawQuery), directory: response.directory, total: results.length, results, truncated: results.length >= numberOption(limit, limits.maxResults, 1, limits.maxResults) }
  }

  /**
   * TinyFish Search API —— 官方明文承诺 `Search never draws from your wallet —
   * it's free at any balance, including $0.`，且直接返回结构化 JSON，
   * 不需要任何模型参与，因此是本插件唯一「零 Token 成本」的联网后端。
   *
   * GET https://api.search.tinyfish.ai?query=...&location=...
   * Header: X-API-Key
   * 返回: { query, results: [{ position, site_name, title, snippet, url }], total_results, page }
   */
  async function tinyfishSearch(query, maxResults, env = process.env) {
    const apiKey = tinyfishKey(env)
    if (!apiKey) throw new SearchError('未配置 TINYFISH_API_KEY', 'no_key')
    const url = new URL(tinyfishBaseUrl(env))
    url.searchParams.set('query', query)
    const location = String(env.TINYFISH_SEARCH_LOCATION || '').trim()
    if (location) url.searchParams.set('location', location)
    const language = String(env.TINYFISH_SEARCH_LANGUAGE || '').trim()
    if (language) url.searchParams.set('language', language)
    const domainType = String(env.TINYFISH_SEARCH_DOMAIN_TYPE || '').trim()
    if (domainType) url.searchParams.set('domain_type', domainType)

    const response = await fetchText(url.href, {
      timeoutMs: limits.timeoutMs,
      blockBenchmark,
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    })
    let body
    try {
      body = JSON.parse(response.text)
    } catch {
      throw new SearchError('TinyFish 响应不是合法 JSON', 'bad_response')
    }
    const results = []
    const seen = new Set()
    for (const item of Array.isArray(body?.results) ? body.results : []) {
      const resultUrl = typeof item?.url === 'string' ? item.url.trim() : ''
      if (!resultUrl || seen.has(resultUrl)) continue
      seen.add(resultUrl)
      // ⚠ 拿不到摘要就留空，**绝不拿 URL 冒充摘要**：否则卡片会显示
      // 「标题 + 一行网址」，看起来就像「搜索结果只有标题」。
      const summary = firstText(item?.snippet, item?.description, item?.content, item?.summary, item?.text)
      results.push({
        title: typeof item?.title === 'string' && item.title.length > 0 ? item.title : resultUrl,
        url: resultUrl,
        snippet: summary,
        score: Math.max(0.1, 1 - results.length * 0.1),
        source: 'tinyfish',
      })
      if (results.length >= maxResults) break
    }
    if (!results.length) throw new SearchError('TinyFish 无结果', 'no_results')
    return results
  }

  /**
   * AnySearch API —— 开源生态（如 dsh-web-search-anysearch）支持的通用网页检索 REST API。
   * POST {baseURL}/v1/search
   * Headers: Authorization: Bearer <key>
   * Body: { query, max_results, format: 'json', zone }
   */
  async function anysearchSearch(query, maxResults, allowAnonymous = false, env = process.env) {
    const apiKey = anysearchKey(env)
    if (!apiKey && !allowAnonymous) throw new SearchError('未配置 ANYSEARCH_API_KEY', 'no_key')
    const base = anysearchBaseUrl(env).replace(/\/+$/, '')
    const url = `${base}/v1/search`
    const zone = String(env.ANYSEARCH_ZONE || 'cn').trim()
    const language = String(env.ANYSEARCH_LANGUAGE || '').trim()

    const response = await fetchText(url, {
      method: 'POST',
      timeoutMs: limits.timeoutMs,
      blockBenchmark,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // ⚠ 只有真的拿到 Key 才附带鉴权头：官方明确说明带无效 Key 会直接 401/403，
        // 且不会静默回退到匿名模式，反而会白白丢掉按 IP 计量的每日免费额度。
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        query,
        max_results: Math.min(maxResults, 100),
        format: 'json',
        ...(zone ? { zone } : {}),
        ...(language ? { language } : {}),
      }),
    })

    let body
    try {
      body = JSON.parse(response.text)
    } catch {
      throw new SearchError('AnySearch 响应不是合法 JSON', 'bad_response')
    }

    // 兼容两种信封：{code,message,data:{results}} 与 {results,metadata}
    if (typeof body.code === 'number' && body.code !== 0) {
      throw new SearchError(body.message || `AnySearch API 错误 (${body.code})`, 'api_error')
    }

    const rawList = Array.isArray(body?.data?.results) ? body.data.results : (Array.isArray(body?.results) ? body.results : [])
    const results = []
    const seen = new Set()
    for (const item of rawList) {
      const resultUrl = typeof item?.url === 'string' ? item.url.trim() : ''
      if (!resultUrl || seen.has(resultUrl)) continue
      seen.add(resultUrl)
      // ★ 关键：AnySearch 的 `content` 是清洗后的正文（实测 157~517 字），
      // 信息量是 `snippet`（仅 140~160 字摘要）的 2~4 倍。
      // 缝隙只认 snippet 字段，所以把正文优先塞进 snippet，模型才拿得到实料。
      const rich = typeof item?.content === 'string' && item.content.trim().length > 0
        ? item.content.trim()
        : (typeof item?.snippet === 'string' ? item.snippet.trim() : '')
      results.push({
        title: typeof item?.title === 'string' && item.title.length > 0 ? item.title : resultUrl,
        url: resultUrl,
        snippet: rich.length > 0 ? rich.slice(0, 1200) : '',
        score: Math.max(0.1, 1 - results.length * 0.1),
        source: 'anysearch',
      })
      if (results.length >= maxResults) break
    }

    if (!results.length) throw new SearchError('AnySearch 无结果', 'no_results')
    return results
  }

  async function bingSearch(query, maxResults) {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&count=${Math.min(maxResults, 20)}`
    const response = await fetchText(url, {
      timeoutMs: limits.timeoutMs,
      blockBenchmark,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cookie': 'SRCHHPGUSR=SRCHLANG=zh-Hans',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    const title = response.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''
    if (/captcha|unusual traffic|verification/i.test(title) || /验证码|安全验证|流量异常|异常流量/.test(response.text.slice(0, 3000))) {
      throw new SearchError('Bing 触发了验证码/异常流量检测', 'bot_blocked')
    }
    const results = parseBing(response.text, maxResults)
    if (!results.length) throw new SearchError('Bing 无结果或页面结构变化', 'no_results')
    return results
  }

  async function webSearch({ query: rawQuery, limit = 10 } = {}) {
    assertOpen()
    const query = normalizeQuery(rawQuery)
    const maxResults = numberOption(limit, 10, 1, 50)
    const env = await effectiveEnv()
    const hasTinyfishKey = tinyfishKey(env) !== ''
    const preferred = String(env.DSH_SEARCH_ENGINE || '').trim().toLowerCase()

    // 智能降级链，按「结果质量 + 免费程度」排序：
    //   1. 显式指定的引擎永远第一
    //   2. TinyFish（配了 Key 才走）
    //   3. AnySearch —— ★ 支持匿名免费额度，无需 Key 也纳入链路；
    //      实测它返回结构化正文（content 字段），质量明显高于 Bing 抓页面，
    //      且 200 OK 命中率稳定（约 1.9s）。额度用尽会返回 402，自动降级到下一环。
    //   4~6. Bing 抓取 / Jina / DuckDuckGo —— 纯免 Key 兜底，保证永不空手。
    const order = []
    if (preferred) order.push(preferred)
    if (hasTinyfishKey && !order.includes('tinyfish')) order.push('tinyfish')
    if (!order.includes('anysearch')) order.push('anysearch')
    for (const fallback of ['bing', 'jina', 'ddg']) {
      if (!order.includes(fallback)) order.push(fallback)
    }

    const statuses = []
    for (const name of order) {
      try {
        let results
        if (name === 'tinyfish') {
          results = await tinyfishSearch(query, maxResults, env)
        } else if (name === 'anysearch') {
          // 无 Key 时以匿名身份请求（按 IP 每日免费额度），有 Key 则走鉴权额度
          results = await anysearchSearch(query, maxResults, true, env)
        } else if (name === 'bing') {
          results = await bingSearch(query, maxResults)
        } else if (name === 'jina') {
          const jinaKey = String(env.DSH_JINA_API_KEY || '').trim()
          const jina = await fetchText(`https://s.jina.ai/${encodeURIComponent(query)}`, {
            timeoutMs: limits.timeoutMs,
            blockBenchmark,
            headers: jinaKey ? { authorization: `Bearer ${jinaKey}` } : {},
          })
          results = parseJinaLinks(jina.text, maxResults)
          if (!results.length) throw new SearchError('Jina 无结果', 'no_results')
        } else {
          const ddg = await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { timeoutMs: limits.timeoutMs, blockBenchmark, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
          results = parseDdg(ddg.text, maxResults)
          if (!results.length) throw new SearchError('DDG 无结果', 'no_results')
        }
        if (results.length) return { query, backend: name, total: results.length, results }
        statuses.push(`${name}:no_results`)
      } catch (error) { statuses.push(`${name}:${error.code || 'failed'}`) }
    }
    return { query, backend: 'none', total: 0, results: [], error: '所有搜索后端均失败或无结果', statuses }
  }
  async function fetchUrl({ url: rawUrl, maxChars = 20_000 } = {}) {
    assertOpen()
    const input = String(rawUrl || '').trim()
    if (!input) throw new SearchError('url 不能为空', 'url_invalid')
    const original = await assertSafeUrl(input, { blockBenchmark })
    const baseUrl = new URL(original)
    const fragment = baseUrl.hash.slice(1)
    baseUrl.hash = ''
    let jinaError = null
    try {
      const jinaUrl = `https://r.jina.ai/${encodeURI(baseUrl.toString())}`
      const response = await fetchText(jinaUrl, { timeoutMs: limits.timeoutMs, headers: { accept: 'text/plain' }, blockBenchmark })
      let content = response.text.replace(/^Title:.*?\n\s*\n/i, '').replace(/^Markdown Content:\s*\n/i, '')
      content = extractMarkdownFragment(content, fragment)
      content = content.trim()
      if (content) {
        const capped = numberOption(maxChars, 20_000, 0, 200_000)
        return { url: original.toString(), title: htmlTitle(content, baseUrl.hostname), content: capped > 0 ? content.slice(0, capped) : content, extraction: fragment ? 'jina_fragment' : 'jina', truncated: capped > 0 && content.length > capped }
      }
    } catch (error) { jinaError = error }
    try {
      const response = await fetchText(baseUrl.toString(), { timeoutMs: limits.timeoutMs, blockBenchmark })
      let content = response.contentType.includes('html') ? htmlMainText(response.text) : response.text.trim()
      if (fragment && response.contentType.includes('html')) {
        const id = decodeURIComponent(fragment).replace(/[^\w:.-]/g, '')
        const fragmentMatch = response.text.match(new RegExp(`<[^>]+(?:id|name)=["']${id}["'][^>]*>[\\s\\S]*?(?=<h[1-6]\\b|<section\\b|<\/main|<\/article|$)`, 'i'))
        if (fragmentMatch) content = htmlMainText(fragmentMatch[0])
      }
      if (!content) throw new SearchError('页面正文为空', 'empty_content')
      const capped = numberOption(maxChars, 20_000, 0, 200_000)
      return { url: original.toString(), title: htmlTitle(response.text, baseUrl.hostname), content: capped > 0 ? content.slice(0, capped) : content, extraction: fragment ? 'direct_html_fragment' : 'direct_html', truncated: capped > 0 && content.length > capped, fallback: jinaError?.code || null }
    } catch (error) {
      if (jinaError) throw new SearchError(`网页抓取失败：${jinaError.message}; 直连失败：${error.message}`, 'fetch_failed')
      throw error
    }
  }

  return {
    roots: [...roots],
    limits: { ...limits },
    searchLocalFiles,
    searchCode,
    webSearch,
    fetchUrl,
    async close() { closed = true },
  }
}
