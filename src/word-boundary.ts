// word-boundary.ts
// 词边界护栏：判断每个「的/地/得」改动点是否落在**多字词内部**。
//
// 背景（2026-11-17）：引擎的词性模型是按字符序列判槽位的，它不知道
// 「地幔」「得手」「得票」是一个词，于是把词内的字当成助词改掉：
//   地幔深处 → 的幔深处   /   小偷得手了 → 小偷的手了   /   他得票最多 → 他的票最多
//
// 分词器能给出词边界，且它**不受错字影响**：
//   地幔深处 → 地幔/深处      → 地/幔 是词内构字，跳过
//   的幔深处 → 的/DEG + 幔     → 的 是独立助词，照常纠错
// 所以「词内则跳过」不会挡住真正该改的句子（已用 11 条真实助词句验证 0 误挡）。
//
// 分词能力来自 **jieba 服务**（`ctx.jieba`），与 chatlog / group-gags 同源：
//   - koishi-plugin-hanlpjieba  （@azulores/jieba-hanlp，异步，提供 cutWithOffset）
//   - koishi-plugin-jieba       （@node-rs/jieba，同步，**没有** cutWithOffset）
//
// ⚠️ 护栏**只接受带 `cutWithOffset()` 的 provider**，不能拿 `cut()` 硬凑：
// 实测 @node-rs/jieba 的词典把「跑的快」「跑得快」「说得好」整体当一个词，
// 用 cut() 算偏移会把 4/27 句**真正该改的助词**误判成「词内构字」而挡掉。
// 也就是说：jieba（词典型）与 HanLP（序列标注）对本护栏不是等价能力。
// 因此 provider 没有 cutWithOffset 时，护栏**整体停用**（降级为不过滤 + 告警），
// 而不是用不可靠的近似——宁可漏挡构词误改，也绝不挡真助词。
//
// 设计要点：
// 1. 分词器是**必需服务**：provider 未启用时本插件不启动（与 chatlog 一致）。
// 2. 只对**含 的/地/得 的消息**调用分词（实测群里只有 ~31% 的消息命中）。
// 3. PHRASE 标记的改动（固定短语强改）不受词边界限制——那些是整串规则命中。
// 4. 分词失败**绝不丢纠错能力**：降级为「不过滤」，只告警。
import type { Context } from 'koishi'

export interface Segment { word: string; start: number; end: number }

/** 分词器最小接口（便于测试注入假实现） */
export interface Segmenter {
  cutWithOffset(text: string): Promise<Segment[]>
}

let seg: Segmenter | null = null
let loadError: string | null = null

/**
 * 用 jieba 服务初始化护栏。
 *
 * 只接受实现 `cutWithOffset()` 的 provider（见文件头：cut() 粒度不够）。
 * 失败只记一次错误信息，之后护栏降级放行。
 */
export function ensureSegmenter(jieba: any): void {
  try {
    if (!jieba) throw new Error('jieba service is not available')
    if (typeof jieba.cutWithOffset !== 'function') {
      throw new Error(
        'jieba provider has no cutWithOffset(); '
        + 'word-boundary guard needs hanlpjieba (dictionary tokenizers merge 的/地/得 into words)')
    }
    seg = {
      async cutWithOffset(text: string): Promise<Segment[]> {
        return await jieba.cutWithOffset(text)
      },
    }
    loadError = null
  } catch (e: any) {
    seg = null
    loadError = e?.message ?? String(e)
  }
}

/** 测试注入用：直接塞一个假分词器（不加载模型） */
export function __setSegmenter(s: Segmenter | null) {
  seg = s
  loadError = null
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
