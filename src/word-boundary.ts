// word-boundary.ts
// 词边界护栏：判断每个「的/地/得」改动点是否落在**多字词内部**。
//
// 背景（2026-11-17）：引擎的词性模型是按字符序列判槽位的，它不知道
// 「地幔」「得手」「得票」是一个词，于是把词内的字当成助词改掉：
//   地幔深处 → 的幔深处   /   小偷得手了 → 小偷的手了   /   他得票最多 → 他的票最多
//
// 分词器（@azulores/jieba-hanlp）能给出词边界，且它**不受错字影响**：
//   地幔深处 → 地幔/深处      → 地/幔 是词内构字，跳过
//   的幔深处 → 的/DEG + 幔     → 的 是独立助词，照常纠错
// 所以「词内则跳过」不会挡住真正该改的句子（已用 11 条真实助词句验证 0 误挡）。
//
// 设计要点：
// 1. 分词器是**可选依赖**：加载失败/模型缺失 → 自动降级为「不过滤」，
//    纠错功能照常，只是少了这层护栏（绝不因为护栏而让插件挂掉）。
// 2. 只对**含 的/地/得 的消息**调用分词（实测群里只有 ~31% 的消息命中）。
// 3. PHRASE 标记的改动（固定短语强改）不受词边界限制——那些是整串规则命中。
import type { Jieba } from '@azulores/jieba-hanlp'

export interface Segment { word: string; start: number; end: number }

/** 分词器最小接口（便于测试注入假实现） */
export interface Segmenter {
  cutWithOffset(text: string): Promise<Segment[]>
}

let seg: Segmenter | null = null
let segReady: Promise<boolean> | null = null
let loadError: string | null = null

/**
 * 懒加载分词器。返回是否可用。
 * 失败只记一次错误信息，后续调用直接返回 false（不反复重试拖慢消息处理）。
 */
export function ensureSegmenter(getJieba: () => Promise<unknown>): Promise<boolean> {
  if (segReady) return segReady
  segReady = (async () => {
    try {
      const mod: any = await getJieba()
      const JiebaCtor = mod?.Jieba ?? mod?.default?.Jieba ?? mod?.default
      if (typeof JiebaCtor !== 'function') throw new Error('Jieba export not found')
      const inst: Jieba = new JiebaCtor()
      await (inst as any).ready()
      seg = inst as unknown as Segmenter
      return true
    } catch (e: any) {
      loadError = e?.message ?? String(e)
      return false
    }
  })()
  return segReady
}

/** 测试注入用：直接塞一个假分词器（不加载模型） */
export function __setSegmenter(s: Segmenter | null) {
  seg = s
  segReady = Promise.resolve(!!s)
}

export function segmenterState(): { available: boolean; error: string | null } {
  return { available: !!seg, error: loadError }
}

/**
 * 过滤改动：丢掉「落在多字词内部」的改动。
 *
 * @param text    待纠错原文（码点语义，与引擎的 index 一致）
 * @param changes 引擎给出的改动（index 是码点下标）
 * @returns 保留的改动
 */
export async function filterByWordBoundary<T extends { index: number; tag?: string }>(
  text: string,
  changes: T[],
): Promise<T[]> {
  if (!changes.length) return changes
  if (!seg) return changes // 护栏不可用：放行（降级）

  let tokens: Segment[]
  try {
    tokens = await seg.cutWithOffset(text)
  } catch {
    return changes // 分词失败：放行，绝不因护栏丢功能
  }

  const byPos = (i: number) => tokens.find((t) => t.start <= i && i < t.end)

  return changes.filter((c) => {
    // 固定短语强改（PHRASE）是整串规则命中，不受词边界约束
    if (c.tag === 'PHRASE') return true
    const t = byPos(c.index)
    if (!t) return true
    return t.end - t.start <= 1 // 单字词 → 独立助词；多字词 → 词内构字，跳过
  })
}
