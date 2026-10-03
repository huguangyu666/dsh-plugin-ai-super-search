/**
 * 深色模式回归测试。
 *
 * 背景：GUI 设置面板曾经把输入框底色写成 `var(--dsw-alias-field-fill, #ffffff)`，
 * 但 DSH 主题里**根本没有** `--dsw-alias-field-fill` 这个 token →
 * 深色模式下底色回落成 `#ffffff` 白；而输入文字色
 * `--dsw-alias-label-primary` 深色下是近白（#f9fafb）→ **白底白字**，
 * 用户看不见自己输入的内容（placeholder 是 UA 默认灰，反而看得见）。
 *
 * 这三条断言把那次的成因直接钉住：不许引用已知缺失的 token、
 * 底色兜底必须是非实色的（继承所在表面）、底色与字色不能是同一维度。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

/** DSH 主题里确认不存在的 token；用它会回落到硬编码浅色。 */
const MISSING_TOKENS = ['--dsw-alias-field-fill']

test('不把 DSH 未定义的主题 token 用进 var()', () => {
  for (const token of MISSING_TOKENS) {
    // 只查真正的用法 var(--token…)：注释里为了记录事故会提到名字，不该误报
    assert.ok(
      !source.includes(`var(${token}`),
      `${token} 不在 DSH 主题定义里，深色模式会回落成硬编码浅色 → 白底白字`,
    )
  }
})

test('表单底色兜底必须是非实色（继承表面），不能是不透明浅色', () => {
  const match = source.match(/^\s*field:\s*'([^']+)'/m)
  assert.ok(match, 'client.js 里找不到 field 色定义')
  assert.match(
    match[1],
    /^var\(--dsw-[a-z0-9-]+,\s*(transparent|inherit|currentColor)\)$/,
    `field 的兜底值必须让底色继承所在表面，实际是：${match[1]}`,
  )
})

test('输入底色与文字色取自不同维度，避免同色', () => {
  const background = source.match(/^\s*field:\s*'var\(([^,)]+)/m)?.[1]?.trim()
  const foreground = source.match(/^\s*fieldText:\s*'var\(([^,)]+)/m)?.[1]?.trim()
  assert.ok(background && foreground, 'field / fieldText 都必须走 var()')
  assert.notEqual(background, foreground, '输入底色与文字色不能是同一个 token')
})

test('placeholder / select option / autofill 覆盖规则存在（原生控件的 UA 配色）', () => {
  for (const marker of ['::placeholder', 'select option', ':-webkit-autofill']) {
    assert.ok(source.includes(marker), `缺少深色模式覆盖规则：${marker}`)
  }
})
