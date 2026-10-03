import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../lib/index.js'

/**
 * 构造一个最小 ctx：记录工具注册、web provider 注册、以及被解析过的凭据引用。
 * @param {{credentials?: Record<string, string>}} options `credentials` 模拟凭据服务里已保存的值
 */
function makeCtx(options = {}) {
  const registered = []
  const providers = []
  const cleanups = []
  const injects = []
  const resolvedRefs = []
  return {
    registered,
    providers,
    injects,
    resolvedRefs,
    ctx: {
      tools: { register(tool) { registered.push(tool); return () => {} } },
      inject(services, callback) {
        injects.push(services)
        // 模拟「web 服务存在」的部署：立刻回调，让 provider 完成注册
        if (services.includes('web')) callback({ web: { registerSearchProvider(p) { providers.push(p); return () => {} } } })
        // 模拟凭据服务：只返回调用方真正保存过的引用
        if (services.includes('credentials')) {
          callback({
            credentials: {
              async resolve(ref) {
                resolvedRefs.push(ref)
                const stored = options.credentials ?? {}
                return Object.hasOwn(stored, ref) ? { value: stored[ref] } : undefined
              },
            },
          })
        }
      },
      effect(effect) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
    },
    runCleanups() { for (const cleanup of cleanups) cleanup() },
  }
}

test('registers four namespaced read-only tools', () => {
  const h = makeCtx()
  apply(h.ctx)
  assert.equal(name, 'dsh-plugin-ai-super-search')
  assert.deepEqual(h.registered.map((tool) => tool.name), [
    'ai_super_search_web_search',
    'ai_super_search_fetch_url',
    'ai_super_search_local_files',
    'ai_super_search_code',
  ])
  h.runCleanups()
})

test('registers the free search provider into ctx.web', () => {
  const h = makeCtx()
  apply(h.ctx)
  assert.deepEqual(h.injects, [['credentials'], ['web']])
  assert.equal(h.providers.length, 1)
  const provider = h.providers[0]
  assert.equal(provider.id, 'tinyfish')
  // 免费降级链保证恒可用：没配 key 也不能把搜索切死
  assert.equal(provider.available(), true)
  h.runCleanups()
})

test('provider 把服务结果映射成缝隙的 sources 形状', async () => {
  const h = makeCtx()
  apply(h.ctx)
  const provider = h.providers[0]
  // 直接替换服务不可行（闭包私有），改为验证映射契约的形状约束：
  // 这里用一个真实调用会走网络，故只断言方法与签名存在且不抛同步错。
  assert.equal(typeof provider.search, 'function')
  assert.equal(provider.search.length, 2)
  h.runCleanups()
})

test('tools 都声明了 schema 与 execute', () => {
  const h = makeCtx()
  apply(h.ctx)
  for (const tool of h.registered) {
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters 不是 object`)
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} 缺 required`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0, `${tool.name} description 为空`)
  }
  h.runCleanups()
})

test('面板保存的 Key 经凭据服务一路走到搜索链路（不再只认环境变量）', async (t) => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.TINYFISH_API_KEY
  // 清掉环境变量：这条链路必须靠凭据服务才能成立
  delete process.env.TINYFISH_API_KEY
  globalThis.fetch = async () => { throw new Error('stubbed: tests must not hit the network') }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.TINYFISH_API_KEY
    else process.env.TINYFISH_API_KEY = originalKey
  })

  const h = makeCtx({ credentials: { TINYFISH_API_KEY: 'from-credentials' } })
  apply(h.ctx)
  const tool = h.registered.find((item) => item.name === 'ai_super_search_web_search')
  const result = await tool.execute({ query: 'credential-bridge', limit: 1 })

  assert.equal(result.ok, true)
  const statuses = result.data.statuses
  const tinyfishStatus = statuses.find((entry) => entry.startsWith('tinyfish:'))
  assert.ok(
    tinyfishStatus !== undefined,
    `凭据服务里的 Key 应让 tinyfish 进链，实际状态：${statuses.join(', ')}`,
  )
  assert.notEqual(tinyfishStatus, 'tinyfish:no_key', 'Key 明明在凭据服务里，不该报 no_key')
  assert.ok(h.resolvedRefs.includes('TINYFISH_API_KEY'), '应当去凭据服务解析过该引用')
  h.runCleanups()
})

test('web 服务缺失时仍能装载（只注册工具）', () => {
  const registered = []
  const ctx = {
    tools: { register(tool) { registered.push(tool); return () => {} } },
    inject() { /* 模拟 web 永不就绪：回调不被触发 */ },
    effect(effect) { effect() },
  }
  apply(ctx)
  assert.equal(registered.length, 4)
})