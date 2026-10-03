import { createSearchService, SearchError } from './search.js'
import { createWebSearchProvider } from './provider.js'
import {
  formatError,
  formatSearchOutput,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromValue,
} from './present.js'

export const name = 'dsh-plugin-ai-super-search'
export const inject = ['tools']

function output(value) {
  const text = value?.ok === false ? formatError(value) : JSON.stringify(value?.data ?? value, null, 2)
  return [{ type: 'text', text }]
}

async function run(task) {
  try {
    return { ok: true, data: await task() }
  } catch (error) {
    const known = error instanceof SearchError
    return {
      ok: false,
      error: {
        code: known ? error.code : 'internal_error',
        message: String(error?.message || error),
      },
    }
  }
}

/** 通用工具的呈现：保持裸 JSON（本地搜索/抓取等非卡片场景）。 */
const objectOutput = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => output(value),
}

/**
 * 搜索工具的呈现：**逐字对齐官方 dsh-tool-web 的四件套**，
 * 让 `ai_super_search_web_search` 在前端渲染出与内置 `web_search` 一致的
 * 搜索卡片（`card: 'web'`, `kind: 'search'`），而不是一坨裸 JSON。
 *
 * - render           → 官方同款 markdown 源码列表（模型侧可读性也大幅提升）
 * - presentationMeta → 可重放的结构化 sources，驱动前端富卡片
 * - presentCall      → 运行中的卡片标题
 * - presentResult    → 完成后的富卡片
 */
const webSearchOutput = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => {
    if (value?.ok === false) return [{ type: 'text', text: formatError(value) }]
    const view = searchMetaFromValue(value)
    return [
      {
        type: 'text',
        text: formatSearchOutput({
          sources: view?.sources ?? [],
          truncated: view?.truncated ?? false,
        }),
      },
    ]
  },
  presentationMeta: (_args, value) => searchMetaFromValue(value),
}

export function apply(ctx) {
  const service = createSearchService()
  const tools = [
    {
      name: 'ai_super_search_web_search',
      description:
        '搜索公开网页。免费链路（零 Token 成本）：TinyFish → AnySearch → Bing → Jina → DuckDuckGo 依次降级。'
        + '返回结构化来源列表（标题/链接/摘要），无需任何 API Key 即可使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回多少条，默认 10' },
        },
        required: ['query'],
      },
      output: webSearchOutput,
      execute: async (args) => run(() => service.webSearch(args)),
      presentCall: presentSearchCall,
      presentResult: presentSearchResult,
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
    },
    {
      name: 'ai_super_search_fetch_url',
      description: '读取公开网页正文，支持 URL 片段；Jina Reader 失败后直连 HTML。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的 http/https URL' },
          maxChars: { type: 'integer', minimum: 0, maximum: 200_000, description: '最多返回字符数，0 表示不截断' },
        },
        required: ['url'],
      },
      output: objectOutput,
      execute: async (args) => run(() => service.fetchUrl(args)),
      isConcurrencySafe: () => true,
      timeoutMs: 60_000,
    },
    {
      name: 'ai_super_search_local_files',
      description: '在 DSH_SEARCH_ROOTS 允许的本地目录中搜索文本文件。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查找的文本' },
          directory: { type: 'string', description: '允许根目录内的目录，默认第一个根目录' },
          fileTypes: { type: 'array', items: { type: 'string' }, description: '扩展名过滤，例如 ["md", "txt"]' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少个文件' },
        },
        required: ['query'],
      },
      output: objectOutput,
      execute: async (args) => run(() => service.searchLocalFiles(args)),
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
    },
    {
      name: 'ai_super_search_code',
      description: '在允许的本地代码目录中搜索文本并返回文件、语言、行号和上下文。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '符号名或代码文本' },
          directory: { type: 'string', description: '允许根目录内的代码目录，默认第一个根目录' },
          fileTypes: { type: 'array', items: { type: 'string' }, description: '可选扩展名过滤' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回多少个匹配' },
        },
        required: ['query'],
      },
      output: objectOutput,
      execute: async (args) => run(() => service.searchCode(args)),
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
    },
  ]

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `ai-super-search: ${tool.name}`)
  }

  // 关键整合：把免费搜索链路注册成 DSH 的 WebSearchProvider。
  // 配合 profile 里 `web.searchProvider: tinyfish`，内置的 `web_search` 工具
  // 本身就会改走免费 HTTP 通道 —— 模型行为零改变，官方 DeepSeek 的
  // 付费搜索通道（每次 = 一次完整 Messages 调用 + 服务端检索工具）被彻底绕开。
  // 用 inject 而非硬依赖：部署里没有 web 服务时本插件仍然只提供工具，不报错。
  // `?.` 同时让只 mock 了 tools 的测试桩也能装载。
  ctx.inject?.(['web'], (webCtx) => {
    webCtx.web.registerSearchProvider(createWebSearchProvider(service))
  })

  ctx.effect(() => () => { void service.close() }, 'ai-super-search: close')
}
