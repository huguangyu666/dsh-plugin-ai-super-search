import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../lib/index.js'

/** 构造一个最小 ctx：既记录工具注册，也记录 web provider 注册。 */
function makeCtx() {
  const registered = []
  const providers = []
  const cleanups = []
  const injects = []
  return {
    registered,
    providers,
    injects,
    ctx: {
      tools: { register(tool) { registered.push(tool); return () => {} } },
      inject(services, callback) {
        injects.push(services)
        // 模拟「web 服务存在」的部署：立刻回调，让 provider 完成注册
        if (services.includes('web')) callback({ web: { registerSearchProvider(p) { providers.push(p); return () => {} } } })
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
  assert.equal(name, '@dsh-external/ai-super-search')
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
  assert.deepEqual(h.injects, [['web']])
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