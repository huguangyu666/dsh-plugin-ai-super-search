import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSearchService, isAllowedPath, isAddressBlocked, isBlockedHost, parseDdg, parseBing } from '../lib/search.js'

test('allows paths inside a configured root and rejects sibling paths', () => {
  const root = 'C:\\research\\workspace'
  assert.equal(isAllowedPath('C:\\research\\workspace\\src', [root]), true)
  assert.equal(isAllowedPath('C:\\research\\workspace-backup', [root]), false)
})

test('blocks local and private hosts but allows a public host', () => {
  assert.equal(isBlockedHost('localhost'), true)
  assert.equal(isBlockedHost('127.0.0.1'), true)
  assert.equal(isBlockedHost('192.168.1.10'), true)
  assert.equal(isBlockedHost('example.com'), false)
})

test('searches local text files within the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-search-'))
  try {
    await writeFile(join(root, 'notes.md'), '# Note\nneedle appears here\n', 'utf8')
    const service = createSearchService({ roots: [root] })
    const result = await service.searchLocalFiles({ query: 'needle', directory: root, fileTypes: ['md'] })
    assert.equal(result.results.length, 1)
    assert.match(result.results[0].path, /notes\.md$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('searches code and returns matching line numbers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-code-'))
  try {
    await writeFile(join(root, 'main.py'), 'def search_target():\n    return "ok"\n', 'utf8')
    const service = createSearchService({ roots: [root] })
    const result = await service.searchCode({ query: 'search_target', directory: root })
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].line, 1)
    assert.equal(result.results[0].language, 'python')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a directory outside the configured root and closes idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-boundary-'))
  try {
    const service = createSearchService({ roots: [root] })
    await assert.rejects(() => service.searchLocalFiles({ query: 'x', directory: tmpdir() }), /DSH_SEARCH_ROOTS/)
    await service.close()
    await service.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects private URLs before making a network request', async () => {
  const service = createSearchService({ roots: [process.cwd()] })
  await assert.rejects(() => service.fetchUrl({ url: 'http://127.0.0.1:9/' }), /本地或私网地址/)
  await service.close()
})

test('benchmark net (proxy fake-ip) handling: allowed by default, blocked in strict mode', () => {
  assert.equal(isBlockedHost('198.18.0.68'), false)
  assert.equal(isAddressBlocked('198.18.0.68'), false)
  assert.equal(isAddressBlocked('198.18.0.68', { blockBenchmark: true }), true)
  assert.equal(isAddressBlocked('127.0.0.1'), true)
  assert.equal(isAddressBlocked('10.1.2.3'), true)
  assert.equal(isAddressBlocked('169.254.1.1'), true)
})

test('parses DDG lite markup with href before class and single quotes', () => {
  const html = '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeepseek.com%2F&rut=abc" class=\'result-link\'>DeepSeek</a><td class=\'result-snippet\'>AI 助手</td>'
  const results = parseDdg(html, 5)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://deepseek.com/')
  assert.equal(results[0].title, 'DeepSeek')
  assert.match(results[0].snippet, /AI/)
})

test('parses Bing SERP markup (b_algo blocks)', () => {
  const html = '<li class="b_algo"><h2><a href="https://example.com/page?q=1">Example Title</a></h2><div class="b_caption"><p>Some snippet text here</p></div></li>'
  const results = parseBing(html, 5)
  assert.equal(results.length, 1)
  assert.equal(results[0].url, 'https://example.com/page?q=1')
  assert.equal(results[0].title, 'Example Title')
  assert.equal(results[0].source, 'bing')
})
