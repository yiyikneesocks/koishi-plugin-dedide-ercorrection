//index.ts
// 「的/地/得」纠正 —— 本地 ONNX 词性模型
//
// 原理：HanLP CTB 词性模型导出为 ONNX，CTB 词性集给 的/地/得 设有专属标签：
//   DEV → 地（状语）  DER → 得（补语）  DEG / DEC / SP → 的
// 模型判的是**语法槽位**，即使原文写错字也照样给出正确标签，所以
// 纠错 = 把标签映射回汉字。全程本地、无网络、无 Python、无分词器。
//
// 纠错核心（原 @azulores/de-corrector，2026-11-13 合并进来，npm 上该包已弃用）
// 位于 src/corrector/de-corrector.js，模型资产在 assets/（随 npm 包发布）。
//
// 本插件只负责「接进 Koishi」：占位符保护、长度守卫、中间件挂载。
// 回复形式（replyMode）：
//   plain  —— 直接发修正后的完整文本（旧行为）
//   quote  —— 引用原消息 + 修正后的完整文本（无 @）
//   auto   —— 短消息（≤ fullTextThreshold）：同 quote；
//             长消息：引用原消息 + 只发错误位置上下文片段（错误处标 〔地→的〕，
//             相邻错误（≤ quoteContextChars）自动合并为一段，不会隐藏）
import { Schema, Context, Session, h } from 'koishi'
import { DeCorrector } from './corrector/de-corrector.js'

export const name = 'dedide-ercorrection'
export const inject = []          // 不再需要 jieba

export interface Config {
  maxLength?: number
  verbose?: boolean
  replyMode?: 'plain' | 'quote' | 'auto'
  fullTextThreshold?: number
  quoteContextChars?: number
}

export const Config: Schema<Config> = Schema.object({
  maxLength: Schema.number()
    .description('超过此长度的消息不处理（0=不限制）')
    .default(500).min(0),
  verbose: Schema.boolean()
    .description('记录每次修改')
    .default(false),
  replyMode: Schema.union(['plain', 'quote', 'auto'] as const)
    .description('回复形式：plain=纯文本发全文 / quote=引用原消息发全文 / auto=短消息引用发全文、长消息引用+上下文片段（默认）')
    .default('auto'),
  fullTextThreshold: Schema.number()
    .description('auto 模式下，原文 ≤ 此码点数时引用发全文；超过则只发错误位置上下文片段')
    .default(100).min(10),
  quoteContextChars: Schema.number()
    .description('长消息片段中，错误位置前后各取多少字作为上下文；相邻错误间隔 ≤ 此值时合并为一段')
    .default(20).min(5).max(60),
})

// ── 占位内容（空格/换行/at/CQ 码）抽出与插回（按码点计数，避免 emoji 错位） ──
const PLACEHOLDER_RE = /(\s|<at[^>]*\/?>|\[CQ:[^\]]+\])/g

function extractPlaceholders(text: string): { clean: string; items: { content: string; pos: number }[] } {
  const items: { content: string; pos: number }[] = []
  let clean = ''
  let last = 0
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    clean += text.slice(last, m.index)
    items.push({ content: m[0], pos: Array.from(clean).length })
    last = m.index! + m[0].length
  }
  clean += text.slice(last)
  return { clean, items }
}

function restorePlaceholders(text: string, items: { content: string; pos: number }[]): string {
  const chars = Array.from(text)
  for (const { content, pos } of [...items].sort((a, b) => b.pos - a.pos)) {
    chars.splice(Math.min(pos, chars.length), 0, content)
  }
  return chars.join('')
}

/** 把 Koishi 的 content（字符串或元素数组）归一成纯文本 */
function contentToText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
  }
  return ''
}

interface Change { index: number; from: string; to: string; tag?: string }

/**
 * 长消息片段：把 changes（按 clean 文本的码点 index）按相邻关系分组，
 * 每组取「首错前 ctxLen 字 ~ 末错后 ctxLen 字」的窗口，错误字渲染成六角括号 〔地→的〕。
 * 相邻错误（间隔 ≤ ctxLen）自动并进同一段完整展示，不会被省略号藏掉。
 */
function buildSnippets(chars: string[], changes: Change[], ctxLen: number): string[] {
  if (!changes.length) return []
  const sorted = [...changes].sort((a, b) => a.index - b.index)
  const groups: Change[][] = []
  for (const c of sorted) {
    const g = groups[groups.length - 1]
    if (g && c.index - g[g.length - 1].index <= ctxLen) g.push(c)
    else groups.push([c])
  }
  return groups.map((g) => {
    const start = Math.max(0, g[0].index - ctxLen)
    const end = Math.min(chars.length, g[g.length - 1].index + ctxLen + 1)
    let body = ''
    let pos = start
    for (const c of g) {
      body += chars.slice(pos, c.index).join('') + `〔${c.from}→${c.to}〕`
      pos = c.index + 1
    }
    body += chars.slice(pos, end).join('')
    return (start > 0 ? '…' : '') + body + (end < chars.length ? '…' : '')
  })
}

// 供沙盒测试直接调用片段逻辑（不进入公共 API 面）
export const __test = { buildSnippets, markChanges }

/** 把 changes（clean 文本的码点 index）映射回加回占位符后的 restored 索引，并在原位渲染成六角括号 〔原→修〕 */
function markChanges(
  restored: string,
  changes: Change[],
  items: { content: string; pos: number }[],
): string {
  const out = Array.from(restored)
  const mapped = changes.map((c) => {
    let delta = 0
    for (const { content, pos } of items) {
      if (c.index >= pos) delta += content.length
    }
    return { index: c.index + delta, text: `〔${c.from}→${c.to}〕` }
  })
  // 从后往前替换，避免位移影响后面的索引
  mapped.sort((a, b) => b.index - a.index)
  for (const m of mapped) out.splice(m.index, 1, m.text)
  return out.join('')
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('dedide-ercorrection')
  const maxLength = config.maxLength ?? 500
  const replyMode = config.replyMode ?? 'auto'
  const fullThreshold = config.fullTextThreshold ?? 100
  const ctxLen = config.quoteContextChars ?? 20

  const corrector = new DeCorrector({ maxLength })

  // 预热：不阻塞插件注册；失败只告警，机器人照常工作
  let ready = false
  corrector.warmup().then(
    () => { ready = true; logger.info('model ready (local ONNX, offline)') },
    (e: any) => logger.warn('model load failed: %s', e?.message ?? e),
  )

  // ── 统计 ──
  const stats = {
    messages: 0,  // 含 的地得 且通过长度检查的消息数
    fixed: 0,     // 实际改动的消息数
    skipped: 0,   // 检查后无需改动
    errors: 0,    // 处理异常
  }

  const dumpStats = () => {
    logger.info('[stats] msgs=%d fixed=%d skipped=%d err=%d',
      stats.messages, stats.fixed, stats.skipped, stats.errors)
  }
  ctx.setInterval(dumpStats, 60000)
  ;(ctx as any).on('dispose', dumpStats)

  /** 全量检查；无改动 / 任何异常 → null */
  async function correct(content: string | undefined): Promise<{
    restored: string          // 占位符插回后的完整修正文本
    changes: Change[]         // 基于 clean 文本的码点 index
    chars: string[]           // clean 文本的码点数组（供片段渲染）
    items: { content: string; pos: number }[] // 占位符表（供 markChanges 映射索引）
  } | null> {
    if (!content || content.length <= 2) return null
    if (!/[的地得]/.test(content)) return null
    if (maxLength > 0 && Array.from(content).length > maxLength) return null
    if (!ready) return null

    stats.messages++

    // 占位符必须在送模型前抽出：否则 <at .../> 会被当作普通字符参与标注
    const { clean, items } = extractPlaceholders(content)
    if (!clean) return null

    let checked: { corrected: string; changes: Change[] }
    try {
      checked = await corrector.check(clean)
    } catch (e: any) {
      stats.errors++
      logger.warn('correction failed: %s', e?.message ?? e)
      return null
    }

    if (checked.corrected === clean) {
      stats.skipped++
      return null
    }

    const restored = restorePlaceholders(checked.corrected, items)

    // 最后一道保险：长度必须与原文完全一致，否则整条丢弃
    if (Array.from(restored).length !== Array.from(content).length) {
      stats.errors++
      logger.warn('[guard] length mismatch, dropped: %j -> %j', content, restored)
      return null
    }

    stats.fixed++
    return {
      restored,
      changes: checked.changes ?? [],
      chars: Array.from(clean),
      items,
    }
  }

  /** 便于测试 / 手动调用：返回完整修正文本（string|null） */
  async function correctMessage(content: string | undefined): Promise<string | null> {
    const r = await correct(content)
    return r?.restored ?? null
  }

  const root: any = (ctx as any).root ?? ctx
  ;(ctx as any).dedideErcCorrect = correctMessage
  root['dedideErcCorrect'] = correctMessage
  ;(ctx as any).dedideErcReady = () => ready
  root['dedideErcReady'] = () => ready

  ctx.middleware(async (session: Session, next) => {
    const text = contentToText(session.content)
    const r = await correct(text)
    if (!r) return next()

    const charLen = Array.from(text).length
    const useSnippet = replyMode === 'auto' && charLen > fullThreshold

    // plain 模式：走旧的「中间件返回值自动发送」路径，纯文本，不标记
    if (replyMode === 'plain') {
      if (config.verbose) logger.info('[fix] %j -> %j', text, r.restored)
      return r.restored
    }

    // quote / auto：显式发送「引用原消息 + 正文」，正文不含 at
    // 短消息：发完整修正文本，并在改错处标六角括号 〔原→修〕
    // 长消息：只发错误位置上下文片段（同标记，带 … 截断，相邻错误合并）
    const body = useSnippet && r.changes.length
      ? buildSnippets(r.chars, r.changes, ctxLen).join('\n')
      : markChanges(r.restored, r.changes, r.items)

    try {
      if (session.messageId) {
        await session.send([h('quote', { id: session.messageId }), h.text(body)])
      } else {
        // 平台拿不到 messageId：退化为纯文本，不引用
        await session.send(body)
      }
    } catch (e: any) {
      // 发送失败（如引用被风控）不要打断链条，降级纯文本
      logger.warn('quote send failed, fallback plain: %s', e?.message ?? e)
      await session.send(body)
    }
    if (config.verbose) {
      logger.info('[fix] %j -> (%s) %j', text, useSnippet ? 'snippets' : 'full', body)
    }
    // 已显式发送；不调用 next()，链条到此为止
  }, true)
}
