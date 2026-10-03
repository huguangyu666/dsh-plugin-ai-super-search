/**
 * 把本插件的免费搜索链路注册成 DSH 的 `WebSearchProvider`。
 *
 * 为什么需要这一层（而不是只加几个 `ai_super_search_*` 工具）：
 * 模型在训练时被塑造成默认调用内置的 `web_search` 工具。只提供新工具名，
 * 模型很可能继续走 `web_search` —— 而那条路会打到官方 DeepSeek 的付费
 * Messages 通道（每次搜索 = 一次完整模型调用 + 服务端检索工具，独立计费）。
 *
 * 注册同名能力的 provider 并切换 `web.searchProvider`，可以让**内置
 * `web_search` 工具本身**改走免费 HTTP 链路，模型行为零改变、成本归零。
 *
 * 可用性设计：`available()` 恒为 true。因为底层是
 * TinyFish（免费）→ Bing 抓取 → Jina → DuckDuckGo 的纯 HTTP 降级链，
 * 即使没有配 TinyFish key 也仍然能出结果。这样在 profile 里硬切
 * `searchProvider: tinyfish` 永远不会把搜索能力切死。
 *
 * @module dsh-plugin-ai-super-search/provider
 */
import { WebError } from '@deepseek-ai/dsh-web'

/** 注册到 `ctx.web` 的稳定 provider id。 */
export const FREE_SEARCH_PROVIDER_ID = 'tinyfish'

/**
 * 构造 provider。
 * @param {{webSearch: (args: {query: string, limit?: number}) => Promise<{results?: Array<{url?: string, title?: string, snippet?: string}>}>}} service
 *   本插件的搜索服务（已内置免费后端降级链）。
 * @returns {{id: string, available: () => boolean, search: (request: {query: string, maxResults?: number}, signal?: AbortSignal) => Promise<{sources: Array<{url: string, title?: string, snippet?: string}>, truncated: boolean}>}}
 */
export function createWebSearchProvider(service) {
  return {
    id: FREE_SEARCH_PROVIDER_ID,

    /** 廉价本地检查，绝不发网络请求。免费降级链保证恒可用。 */
    available() {
      return true
    },

    /**
     * 执行一次搜索。
     * @param request - 查询与可选结果上限。
     * @param signal - 可选取消信号。
     * @returns 规范化搜索结果（截断由 ctx.web 按 maxResults 执行）。
     */
    async search(request, signal) {
      if (signal?.aborted === true) throw aborted(signal)

      let outcome
      try {
        outcome = await service.webSearch({
          query: request.query,
          limit: request.maxResults ?? 10,
        })
      } catch (error) {
        if (signal?.aborted === true) throw aborted(signal)
        throw new WebError(
          `免费搜索链路全部失败：${error?.message || String(error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }

      if (signal?.aborted === true) throw aborted(signal)

      const raw = Array.isArray(outcome?.results) ? outcome.results : []
      const seen = new Set()
      const sources = []
      for (const item of raw) {
        const url = typeof item?.url === 'string' ? item.url.trim() : ''
        if (url.length === 0 || seen.has(url)) continue
        seen.add(url)
        const title = typeof item?.title === 'string' && item.title.length > 0 ? item.title : undefined
        const snippet =
          typeof item?.snippet === 'string' && item.snippet.length > 0 ? item.snippet : undefined
        sources.push({
          url,
          ...(title === undefined ? {} : { title }),
          ...(snippet === undefined ? {} : { snippet }),
        })
      }

      return { sources, truncated: false }
    },
  }
}

/** 构造 provider 的稳定取消错误。 */
function aborted(signal) {
  return new WebError('免费搜索已取消', 'WEB_ABORTED', { cause: signal?.reason })
}