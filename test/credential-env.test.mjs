/**
 * 回归测试：凭据服务优先、环境变量兜底。
 *
 * 背景：GUI 面板把 Key 存进 DSH 的 credentials 服务，而搜索链路原先只读
 * `process.env` —— 两条路是断的：面板显示「已配置」，搜索却永远拿不到那把 Key，
 * 一路退化到免 Key 的 AnySearch，**全程零报错**。
 * 官方契约见 dsh-web-search-deepseek：先 `credentials.resolve(ref)`，环境变量兜底。
 *
 * 判别方式不依赖网络：没有 Key 时 `tinyfish` 连进链资格都没有（`hasTinyfishKey`
 * 为假，根本不会被尝试）；有 Key 时它会被尝试，失败码也不会是 `no_key`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSearchService } from '../lib/search.js'

const originalFetch = globalThis.fetch
const originalKey = process.env.TINYFISH_API_KEY

test('凭据服务里的 Key 能被搜索链路读到', async (t) => {
  // 清掉环境变量，逼出「凭据服务」这一条路
  delete process.env.TINYFISH_API_KEY
  // 不真发请求：走到 fetch 就说明 Key 已经读到了
  globalThis.fetch = async () => { throw new Error('stubbed: tests must not hit the network') }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.TINYFISH_API_KEY
    else process.env.TINYFISH_API_KEY = originalKey
  })

  // 对照组：没有任何凭据来源 → tinyfish 不该被尝试
  const bare = createSearchService()
  const withoutCredential = await bare.webSearch({ query: 'credential-env', limit: 1 })
  assert.ok(
    !withoutCredential.statuses.some((entry) => entry.startsWith('tinyfish:')),
    `没有 Key 时不该尝试 tinyfish，实际状态：${withoutCredential.statuses.join(', ')}`,
  )
  await bare.close()

  // 实验组：凭据服务同时给出 Key 与首选引擎 → 必须真的尝试 TinyFish
  const withCredential = createSearchService({
    resolveEnv: async () => ({ TINYFISH_API_KEY: 'credential-only-key', DSH_SEARCH_ENGINE: 'tinyfish' }),
  })
  const result = await withCredential.webSearch({ query: 'credential-env', limit: 1 })
  const tinyfishStatus = result.statuses.find((entry) => entry.startsWith('tinyfish:'))
  assert.ok(
    tinyfishStatus !== undefined,
    `凭据提供了 Key，tinyfish 应被尝试，实际状态：${result.statuses.join(', ')}`,
  )
  assert.notEqual(
    tinyfishStatus,
    'tinyfish:no_key',
    '凭据服务里已有 Key，不该再报 no_key —— 说明 Key 没被读到',
  )
  await withCredential.close()
})

test('resolveEnv 抛错时自动退回环境变量，搜索不中断', async (t) => {
  globalThis.fetch = async () => { throw new Error('stubbed') }
  t.after(() => { globalThis.fetch = originalFetch })
  const service = createSearchService({
    resolveEnv: async () => { throw new Error('credentials service down') },
  })
  const result = await service.webSearch({ query: 'credential-env', limit: 1 })
  assert.ok(Array.isArray(result.statuses) && result.statuses.length > 0, '应照常给出各后端状态')
  await service.close()
})
