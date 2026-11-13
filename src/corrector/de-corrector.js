/**
 * 中文「的/地/得」纠错核心。
 *
 * 纯 JS，无原生依赖、无网络、无 Python。
 * 模型是从 HanLP 的 CTB 词性模型（ELECTRA-small）导出的 ONNX。
 *
 * 原理：CTB 词性集里 的/地/得 有专属标签
 *   DEV → 地（状语）  DER → 得（补语）
 *   DEG / DEC / SP → 的
 * 而且模型判的是**语法槽位**，即使原文写错字也照样给出正确标签。
 * 所以纠错 = 标签映射回汉字。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 资产目录定位（本副本仅供 ercorrection 使用）：
// - 经 esbuild --format=cjs 打包后：__dirname = lib/，资产在包根 assets/（../assets）
// - 直接以 ESM 运行本文件时（开发/测试）：__dirname 未定义，走 import.meta.url，
//   本文件在 src/corrector/ 下，资产在包根 assets/（../../assets）
// esbuild 0.18 会把 import.meta.url 替换成空 shim，故 CJS 分支必须放前面。
const here = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url))
const ASSETS = [join(here, 'assets'), join(here, '..', 'assets'), join(here, '..', '..', 'assets')]
  .find((p) => existsSync(join(p, 'vocab.txt'))) ?? join(here, '..', 'assets')

/** CTB 标签 → 规范汉字 */
export const TAG_TO_CHAR = {
  DEV: '地', // manner de, X-地-VP
  DER: '得', // resultative de, V-得-R
  DEG: '的', // genitive / associative
  DEC: '的', // nominalizer / complementizer
  SP: '的',  // sentence-final particle
}

/**
 * 词汇化例外：这些词里含 的/地/得，但是构词成分，不能改。
 * 例：目的地、的士、土地、值得、得到、记得…
 */
/** 名词性标签：的/地/得 后面紧跟这些 → 几乎肯定是领属格「的」 */
const NOUN_TAGS = new Set(['NN', 'NR', 'NT', 'PN', 'DT', 'M', 'CD', 'OD', 'LC', 'JJ', 'ETC'])

/** 状态形容词：这些字作谓语时，「X得Y」几乎总是领属格而非结果补语 */
const STATE_ADJ = new Set([
  '饿','累','困','渴','冷','热','疼','痛','痒','酸','麻','木','乏','倦','疲',
  '空','满','脏','臭','香','甜','苦','辣','咸','涩','慌','闷','憋','急','怕',
  '饿','饱','渴','累','困','乏','倦','疲','痛','痒','酸','麻','木','冷','热',
  '暖','凉','凉','暖','凉','暖','凉','暖','凉','暖',
])

/** 取第 i 个字左右跳过标点后的第一个字的标签 */
function neighborTag(chars, tags, i, step) {
  let j = i + step
  while (j >= 0 && j < chars.length) {
    if (!'，。！？；：、,.!?;:'.includes(chars[j])) return tags[j]
    j += step
  }
  return null
}

/**
 * 不及物/位移动词：`V + 的(DEC) + 就是/是 + 光杆形容词` 更像程度补语「得」。
 *
 * 只收**不能**用「V的」名词化的动词。及物动词（打/唱/骑/写…）的「V的」
 * 是合法名词（他打的就是好 = 打的内容/表现好），绝不能动，故不在表内。
 */
const INTRANS_VERBS = new Set([...'飞跑跳走游哭睡长来去爬滚坐站蹲飘落转'])

/**
 * 程度补语固定后缀（F1）：`X的 + 后缀` → `X得…`。
 * 仅在标签不可靠（DEG/SP/DEC）时强改，正常的 DER/DEV 不碰。
 */
const DEGREE_SUFFIXES = ['离谱', '要死', '犯规', '不可以', '不行', '要命', '不得了', '要疯']

/**
 * 网络俚语形容词：模型常判成 NN（如「菜」），单靠词性标签救不了，
 * 需配合后文模式（离谱/犯规/一批…）判定。只收高置信度的单字。
 */
const SLANG_ADJ = new Set([...'菜萌猛秀骚弱强快慢高矮胖瘦帅丑美烂棒惨酷拽绝香臭甜苦辣酸咸贵贱'])

/** 可作程度补语中心的词性 */
const DEGREE_ADJ_TAGS = new Set(['VA', 'JJ', 'VV'])

/** 是否处于分句开头（串首，或前一个字是标点/空白） */
function isClauseStart(chars, pos) {
  if (pos <= 0) return true
  return '，。！？；：、,.!?;: \n\t\r'.includes(chars[pos - 1])
}

/**
 * 固定短语强改：返回该位置应强制成什么字，`undefined` 表示无覆盖。
 * 只做同长度单字替换，偏移不变。
 */
function phraseOverride(chars, i) {
  if (chars[i] !== '得') return undefined
  const win = chars.slice(i - 1, i + 3).join('')
  if (win === '懂得都懂') return '的' // 「懂的都懂」网络固定说法
  // 「总得来说」只在分句开头才是「总的来说」；「他总得来说两句」不动
  if (win === '总得来说' && isClauseStart(chars, i - 1)) return '的'
  return undefined
}

export const FROZEN_WORDS = [
  // 含「的」
  '的士', '的确', '的哥', '的姐', '打的', '目的', '标的', '端的',
  '众矢之的', '一语中的', '有的放矢',
  // 固定说法（逐字模型会误把「总的」标成 DEV → 地，必须保护）
  '总的来说', '总的来说吧',
  // 副词性固定说法（逐字输入看不到词边界，模型会把「真的」标成 DEV → 误改「真地」；
  // 实测长文本上下文下分词也不稳定，冻结是唯一可靠护栏）
  '真的',
  // 含「地」
  '土地', '地方', '地址', '地区', '地铁', '地图', '地球', '地面', '地点',
  '地位', '地域', '地基', '地毯', '地道', '地下', '地狱', '地板', '地主',
  '地产', '地形', '地带', '地盘', '地壳', '地雷', '地震', '地瓜', '地摊',
  '各地', '当地', '本地', '外地', '内地', '产地', '场地', '基地', '工地',
  '耕地', '草地', '田地', '菜地', '空地', '余地', '境地', '心地', '遍地',
  '就地', '陆地', '原地', '特地', '荒地', '驻地', '营地', '阵地',
  '目的地', '发源地', '根据地', '所在地', '殖民地', '领地', '圣地', '湿地',
  // 含「得」
  '得到', '得意', '得知', '得分', '得失', '得罪', '取得', '获得', '觉得',
  '记得', '懂得', '难得', '值得', '显得', '免得', '使得', '不得', '所得',
  '心得', '见得', '舍得', '晓得', '认得', '赢得', '求得', '博得', '夺得',
  '总得', '必得', '只得', '自得', '相得益彰',
  // 副词性固定说法（同上：逐字模型把「不由得」的得标成 DEV → 误改「不由地」）
  '不由得',
]

const PUNCT = '，。！？；：、“”‘’（）《》〈〉【】…—～,.!?;:\'"()[]{}<>-~ \n\t\r'

/** 噪声阈值 */
const NOISE_MIN_ALNUM = 2
const NOISE_DE_RATIO = 0.6
const NOISE_REPEAT_RATIO = 0.7
const MIN_CONTENT_RUN = 2

/** 模型最大位置数（含 [CLS]/[SEP]） */
const MAX_LEN = 510

// ────────────────────────────────────────────────────────────
// 长消息分块（chunking）
//
// 本引擎逐字输入：1 字 = 1 token（vocab 按单字查，无 subword 膨胀），
// 但 MAX_LEN=510 是硬上限，且 maxLength（默认 500）此前是「全文熔断」——
// 超长消息被整条静默跳过（生产事故 2026-11-13，503 字消息无人处理）。
// 解法：按句界切块、逐块推理、块偏移合并。切块只影响模型看到的上下文
// 窗口（接缝处标签质量略降），不改变「1:1 单字替换」的纠错语义。
// ────────────────────────────────────────────────────────────

/** 块目标大小（给 [CLS]/[SEP] 与边界留余量，≤ MAX_LEN-2） */
const CHUNK_TARGET = 300

/** 强制切分的句终标点（优先级 1）；句内标点（优先级 2）兜底 */
const SENT_END = new Set([...'。！？；…\n'])
const CLAUSE_END = new Set([...'，、：'])

/** 占位符形态：块边界绝不能切进这些结构内部 */
const PLACEHOLDER_RE = /(<[^<>]{0,120}>|\[[^\]\[]{0,120}\])/g

/**
 * 找出所有占位符区间（闭区间 [s,e]，码点坐标），切块时整体跳过。
 * 引擎消费者（如 koishi 插件）通常已在调用前抽出占位符，这里是对
 * 其他消费者的兜底保护：切进 <at .../> 内部不会破坏文本（我们只改
 * 的地得），但会让模型看到半截标签，白费上下文。
 */
function placeholderSpans(chars) {
  const spans = []
  const text = chars.join('')
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    // 字符串下标 → 码点下标
    const s = [...text.slice(0, m.index)].length
    spans.push([s, s + [...m[0]].length])
  }
  return spans
}

/**
 * 句界优先的贪心切块。
 *
 * 规则（工作单 §3）：
 * 1. 按 SENT_END 切句；单句仍超 target 时按 CLAUSE_END 兜底，再超就硬切。
 * 2. 贪心攒块：相邻句子相加 ≤ target 就并进当前块（不回退）。
 * 3. 边界落在占位符内部 → 后移到占位符结束。
 * 4. 硬切只在「整段无任何标点且超 target」时发生。
 *
 * @param {string[]} chars 码点数组
 * @param {number} target 每块目标码点数
 * @returns {Array<[number,number]>} 各块 [start,end) 区间（码点坐标）
 */
export function chunkBySentence(chars, target = CHUNK_TARGET) {
  if (chars.length <= target) return [[0, chars.length]]

  // 第一步：句级切分
  const sentences = []
  let s = 0
  for (let i = 0; i < chars.length; i++) {
    if (SENT_END.has(chars[i])) {
      sentences.push([s, i + 1])
      s = i + 1
    }
  }
  if (s < chars.length) sentences.push([s, chars.length])

  // 第二步：超长单句降级（句内标点 → 硬切），产出不超过 target 的最小单元
  const units = []
  for (const [ss, se] of sentences) {
    if (se - ss <= target) {
      units.push([ss, se])
      continue
    }
    let u = ss
    for (let i = ss; i < se; i++) {
      if (CLAUSE_END.has(chars[i])) {
        units.push([u, i + 1])
        u = i + 1
      }
    }
    if (u < se) units.push([u, se])
  }
  // 连续无标点、子句仍超 target 的极端情况 → 硬切
  const sized = []
  for (const [a, b] of units) {
    for (let k = a; k < b; k += target) sized.push([k, Math.min(k + target, b)])
  }

  // 第三步：占位符边界保护 + 贪心合并
  const spans = placeholderSpans(chars)
  const inPlaceholder = (i) => spans.some(([a, b]) => i > a && i < b)

  const chunks = []
  let curStart = -1
  let curLen = 0
  for (const [us, ue] of sized) {
    const len = ue - us
    if (curStart < 0) {
      curStart = us
      curLen = len
    } else if (curLen + len <= target) {
      curLen += len
    } else {
      chunks.push([curStart, curStart + curLen])
      curStart = us
      curLen = len
    }
  }
  if (curStart >= 0) chunks.push([curStart, curStart + curLen])

  // 贪心合并后的块尾若落在占位符内部，后移到占位符结束
  for (let k = 0; k < chunks.length - 1; k++) {
    let end = chunks[k][1]
    while (end < chars.length && inPlaceholder(end)) end++
    if (end !== chunks[k][1]) {
      chunks[k + 1][0] = end
      chunks[k][1] = end
    }
  }
  return chunks
}

function effectiveChars(text) {
  return [...text].filter((c) => !PUNCT.includes(c))
}

/** 是否整段无意义乱打（严格判定） */
export function isNoise(text) {
  const eff = effectiveChars(text)
  if (eff.length < NOISE_MIN_ALNUM) return true
  const de = eff.filter((c) => '的地得'.includes(c)).length
  if (de / eff.length > NOISE_DE_RATIO) return true
  const cnt = new Map()
  for (const c of eff) cnt.set(c, (cnt.get(c) ?? 0) + 1)
  const most = Math.max(...cnt.values())
  return most / eff.length > NOISE_REPEAT_RATIO
}

/**
 * 是否含"真实句子内容"（宽松判定）。
 *
 * 比 isNoise 宽松：只要有连续 2 个「非重复且非的地得」的字就算有内容。
 * 纠错器用这个，避免「哈×30 + 他慢慢的走过来」被整段跳过。
 */
export function hasRealContent(text) {
  const eff = effectiveChars(text)
  if (eff.length < 2) return false
  const de = eff.filter((c) => '的地得'.includes(c)).length
  if (de / eff.length > NOISE_DE_RATIO) return false
  let run = 0, best = 0
  for (let i = 0; i < eff.length; i++) {
    if ('的地得'.includes(eff[i])) { run = 0; continue }
    run = i > 0 && eff[i - 1] === eff[i] ? 1 : run + 1
    if (run > best) best = run
  }
  return best >= MIN_CONTENT_RUN
}

/**
 * 判断位置 idx 的 的/地/得 是否属于「提及」（在说这三个字本身）。
 * 例：「纠正的地得」「怎么区分的地得」。
 */
const MENTION_RE = new RegExp(
  '(纠正|修改|改正|区分|辨别|分辨|分清|搞混|搞不清|混用|误用|用错|错用|' +
  '这三个字|三个字|这个字|这俩字|哪些字|用法|区别|写成|写作|错写成|念成|读成)' +
  '\\s*(的|地|得)',
)
const MENTION_TAIL = /^\s*(这|那|怎么|如何|区别|用法|三个字|三个)/
const MENTION_LOOKBEHIND = 6

export function isMention(text, idx) {
  const chars = [...text]
  // idx 是字符（码点）下标；转成字符串下标做切片
  let pos = 0
  for (let i = 0; i < idx; i++) pos += chars[i].length
  const lo = Math.max(0, pos - MENTION_LOOKBEHIND)
  if (MENTION_RE.test(chars.slice(Math.max(0, idx - MENTION_LOOKBEHIND), idx + 1).join(''))) return true
  const tail = chars.slice(idx + 1, idx + 6).join('')
  return MENTION_TAIL.test(tail)
}

export class DeCorrector {
  #session = null
  #vocab = null
  #labels = null
  #ort = null
  #frozenSet

  constructor(options = {}) {
    // maxLength 语义（0.2.0 起）：**单块**字符上限。超过不再整条丢弃，
    // 而是分块处理（见 chunkBySentence）。0 = 不限制。
    this.maxLength = options.maxLength ?? 500
    // 全文熔断：超过此字符数整条跳过（防性能滥用，保持旧的"超长丢弃"兜底）
    this.maxTotalLength = options.maxTotalLength ?? 2000
    // 块数上限：超出部分**原样保留**（不丢文本），并可通过 onChunk 观测
    this.maxChunks = options.maxChunks ?? 4
    // 分块目标大小（码点）。块越大上下文越好、块数越少；默认 300。
    this.chunkTarget = options.chunkTarget ?? CHUNK_TARGET
    // 分块观测回调：({ total, chunks: [[s,e],...], processed, skipped })，
    // 消费者（如 koishi 插件）用它打日志/计数，引擎自身不落任何日志
    this.onChunk = options.onChunk ?? null
    this.modelPath = options.modelPath ?? join(ASSETS, 'model.onnx')
    this.debug = options.debug ?? false
    this.assetsDir = ASSETS
    this.#frozenSet = new Set(FROZEN_WORDS)
  }

  /** 懒加载模型（首次约 1-2 秒） */
  async #ensure() {
    if (this.#session) return
    const ort = await import('onnxruntime-web')
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmPaths = (this.assetsDir ?? ASSETS) + '/'
    this.#ort = ort

    const vocabTxt = readFileSync(join(ASSETS, 'vocab.txt'), 'utf8')
    const map = new Map()
    vocabTxt.split('\n').forEach((w, i) => {
      if (!map.has(w)) map.set(w, i)
    })
    this.#vocab = map
    this.#labels = JSON.parse(readFileSync(join(ASSETS, 'labels.json'), 'utf8'))
    this.#session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['wasm'],
    })
  }

  /** 预热（可选，避免第一条消息慢） */
  async warmup() {
    await this.#ensure()
    await this.#pos(['预', '热'])
  }

  /**
   * 逐字标注词性。
   *
   * 刻意**不分词**：每个汉字都是独立 token。
   * 实测分词器（如 jieba）会把「跑得快」「说得对」切成一个词，
   * 导致「得」被吞掉、检测不到。逐字输入不存在这个问题，
   * 而且词性模型本身就能从上下文判断。
   */
  async #pos(chars) {
    await this.#ensure()
    const ort = this.#ort
    const cls = this.#vocab.get('[CLS]')
    const sep = this.#vocab.get('[SEP]')
    const unk = this.#vocab.get('[UNK]')
    const ids = [cls, ...chars.map((c) => this.#vocab.get(c) ?? unk), sep]
    // 超长截断（理论上不会触发，check() 已按 maxLength 过滤）
    const n = Math.min(ids.length, MAX_LEN + 2)
    const mk = (arr) =>
      new ort.Tensor('int64', BigInt64Array.from(arr.map((x) => BigInt(x))), [1, n])

    const out = await this.#session.run({
      input_ids: mk(ids.slice(0, n)),
      attention_mask: mk(new Array(n).fill(1)),
      token_type_ids: mk(new Array(n).fill(0)),
    })

    const logits = out.logits.data
    const C = this.#labels.length
    const res = []
    for (let i = 0; i < chars.length && i + 1 < n; i++) {
      const base = (i + 1) * C // +1 跳过 [CLS]
      let best = 0
      let bv = logits[base]
      for (let c = 1; c < C; c++) {
        if (logits[base + c] > bv) {
          bv = logits[base + c]
          best = c
        }
      }
      res.push(this.#labels[best])
    }
    return res
  }

  /**
   * 检查文本，返回纠错结果。任意长度：超过单块上限自动分块（0.2.0 起），
   * 不再整条丢弃。changes[].index 始终是**全文码点下标**。
   * @returns {{text:string, corrected:string, changes:Array, tags:Array, chunkInfo?:object}}
   */
  async check(text) {
    const chars = [...(text ?? '')]
    const empty = { text, corrected: text ?? '', changes: [], tags: [] }
    if (!chars.length) return empty
    if (!chars.some((c) => '的地得'.includes(c))) return empty
    // 全文熔断（防性能滥用；此前这里是 maxLength 整条丢弃，事故根源）
    if (this.maxTotalLength > 0 && chars.length > this.maxTotalLength) return empty
    // 整段纯乱打 → 跳过
    if (!hasRealContent(text)) return empty

    const changes = []
    // 0) 固定短语强改（同长度替换，偏移不变）——必须在 #pos 之前、
    //    分块之前全局做：模型看到改后的文本，短语也不会被块边界切碎。
    for (let i = 0; i < chars.length; i++) {
      const forced = phraseOverride(chars, i)
      if (forced && forced !== chars[i]) {
        changes.push({ index: i, from: chars[i], to: forced, tag: 'PHRASE' })
        chars[i] = forced
      }
    }
    const forcedIdx = new Set(changes.map((c) => c.index))

    // 分块：一块放得下（≤ min(maxLength, MAX_LEN-2)）→ 单块直达，
    // 行为与 0.1.x 完全一致（绝大多数消息走这条路）；否则句界分块。
    const perChunkCap = this.maxLength > 0 ? Math.min(this.maxLength, MAX_LEN - 2) : MAX_LEN - 2
    let ranges
    if (chars.length <= perChunkCap) {
      ranges = [[0, chars.length]]
    } else {
      ranges = chunkBySentence(chars, Math.min(perChunkCap, this.chunkTarget))
      // 句界分块后仍可能有超长块（连续无标点超过 cap）→ 硬切兜底
      ranges = ranges.flatMap(([a, b]) => {
        if (b - a <= perChunkCap) return [[a, b]]
        const out = []
        for (let k = a; k < b; k += perChunkCap) out.push([k, Math.min(k + perChunkCap, b)])
        return out
      })
    }

    // maxChunks：超出部分不推理、原样保留（宁可漏改，不可丢文本）
    let processed = ranges
    let skippedRanges = []
    if (this.maxChunks > 0 && ranges.length > this.maxChunks) {
      processed = ranges.slice(0, this.maxChunks)
      skippedRanges = ranges.slice(this.maxChunks)
    }
    if (this.onChunk && ranges.length > 1) {
      this.onChunk({
        total: chars.length,
        chunks: ranges,
        processed: processed.length,
        skipped: skippedRanges.length,
      })
    }

    // 逐块推理 + 规则判定；changes/tags 坐标换算回全文
    const out = [...chars]
    const tags = new Array(chars.length).fill(null)
    for (const [start, end] of processed) {
      const seg = chars.slice(start, end)
      const segTags = await this.#pos(seg)
      for (let j = 0; j < segTags.length; j++) tags[start + j] = segTags[j]

      for (let j = 0; j < seg.length; j++) {
        const i = start + j // 全文下标
        const ch = seg[j]
        if (!'的地得'.includes(ch)) continue
        // 已被固定短语规则处理
        if (forcedIdx.has(i)) continue

        // 1) 词汇化例外
        //    DER 解冻：模型基于完整上下文给出 DER（明确的补语判定）时，
        //    冻结词护栏让路 —— 「打的好啊」里的「打的」不是 taxi 义。
        //    其余标签（DEG/DEC/SP/VV/AS…）仍冻结，保护 taxi/构词义。
        //    （冻结词判定用全文 chars，不受块边界影响）
        const frozen = this.#frozenAt(chars, i)
        if (frozen && segTags[j] !== 'DER') continue
        // 2) 「提及」语境（用全文原文判定）
        if (isMention(text, i)) continue
        // 3) 连用防护：与相邻的/地/得 紧挨着，上下文不可靠（用全文，跨块接缝也防）
        if (
          (i > 0 && '的地得'.includes(chars[i - 1])) ||
          (i + 1 < chars.length && '的地得'.includes(chars[i + 1]))
        ) continue

        // 3.45) 网络补语「X得一批」（F3）：X的 + 一批（后不接名词）→ X得一批
        //      必须在邻居规则之前：「一批」的一(CD)/批(M) 会被 NOUN_TAGS 误判，
        //      先按固定模式救回。保护字面义「猛的一批货」「他猛的一批操作」。
        if (
          (segTags[j] === 'DEC' || segTags[j] === 'DEG' || segTags[j] === 'SP') &&
          j > 0
        ) {
          const prevTag = segTags[j - 1]
          const prevWord = seg[j - 1]
          const rest = seg.slice(j + 1).join('')
          if (
            (DEGREE_ADJ_TAGS.has(prevTag) || SLANG_ADJ.has(prevWord)) &&
            rest.startsWith('一批')
          ) {
            const afterTag = j + 3 < seg.length ? segTags[j + 3] : null
            if (!afterTag || !NOUN_TAGS.has(afterTag)) {
              out[i] = '得'
              changes.push({ index: i, from: ch, to: '得', tag: segTags[j] })
              continue
            }
          }
        }

        // 3.5) 邻居规则：的/地/得 后面紧跟名词 → 领属格「的」
        //      例外：动词 + 得 + 状态名词（说得一口好英语）保留 得
        //      邻居查询在块内做：接缝处按缺邻居处理（略保守，可接受）
        const nextTag = neighborTag(seg, segTags, j, +1)
        if (nextTag && NOUN_TAGS.has(nextTag)) {
          const prevTag = neighborTag(seg, segTags, j, -1)
          const prevWord = j > 0 ? seg[j - 1] : ''
          // 结果补语「得」：动词 + 得 + 状态名词（说得一口好英语）保留 得
          // 但状态形容词（饿/累/困）+ 得 + 名词 更可能是领属格
          const isResultative = (segTags[j] === 'DER' || segTags[j] === 'AS') &&
            (prevTag === 'VV' || prevTag === 'VA') &&
            !STATE_ADJ.has(prevWord)
          if (!isResultative) {
            out[i] = '的'
            if (ch !== '的') {
              changes.push({ index: i, from: ch, to: '的', tag: segTags[j] })
            }
            continue
          }
        }

        // 3.6) 不及物动词 + 的(DEC) + 就是/是 + 光杆形容词(后面不接的) → 程度补语「得」
        //      例：他飞的就是高 → 他飞得就是高
        //      保护：他说的就是对的（形容词后接「的」）、我要的就是快（及物动词）
        if (segTags[j] === 'DEC') {
          const prevTag = neighborTag(seg, segTags, j, -1)
          const prevWord = j > 0 ? seg[j - 1] : ''
          if ((prevTag === 'VV' || prevTag === 'VA') && INTRANS_VERBS.has(prevWord)) {
            const rest = seg.slice(j + 1, j + 4).join('')
            const adjIdx = rest.startsWith('就是') ? j + 3 : rest.startsWith('是') ? j + 2 : -1
            if (adjIdx > 0 && adjIdx < seg.length) {
              const adjTag = segTags[adjIdx]
              const after = adjIdx + 1 < seg.length ? seg[adjIdx + 1] : ''
              if ((adjTag === 'VA' || adjTag === 'JJ') && after !== '的') {
                out[i] = '得'
                changes.push({ index: i, from: ch, to: '得', tag: segTags[j] })
                continue
              }
            }
          }
        }

        // 3.7) 程度补语固定后缀（F1）：X的 + 离谱/要死/犯规… → X得…
        //      仅在标签不可靠（DEG/SP/DEC）时强改；前字须为 VA/JJ/VV 或俚语字表
        //      （「菜」被模型判 NN，只靠标签救不了 M1）。
        if (
          (segTags[j] === 'DEG' || segTags[j] === 'SP' || segTags[j] === 'DEC') &&
          j > 0
        ) {
          const prevTag = segTags[j - 1]
          const prevWord = seg[j - 1]
          const suffix = seg.slice(j + 1, j + 5).join('')
          if (
            (DEGREE_ADJ_TAGS.has(prevTag) || SLANG_ADJ.has(prevWord)) &&
            DEGREE_SUFFIXES.some((s) => suffix.startsWith(s))
          ) {
            out[i] = '得'
            changes.push({ index: i, from: ch, to: '得', tag: segTags[j] })
            continue
          }
        }

        const to = TAG_TO_CHAR[segTags[j]]
        if (!to || to === ch) continue
        out[i] = to
        changes.push({ index: i, from: ch, to, tag: segTags[j] })
      }
    }

    let corrected = out.join('')
    // 4) 防重复字：改完出现原文没有的「地地/得得/的的」→ 回退
    //    （全局做：跨块接缝产生的重复也能兜住）
    corrected = this.#undoDuplicate(chars, [...corrected])
    const result = { text, corrected, changes, tags }
    if (ranges.length > 1) {
      result.chunkInfo = { chunks: ranges, processed: processed.length, skipped: skippedRanges.length }
    }
    return result
  }

  /** 纠错后的文本 */
  async fix(text) {
    return (await this.check(text)).corrected
  }

  /** 批量 */
  async fixBatch(texts) {
    const out = []
    for (const t of texts) out.push(await this.fix(t))
    return out
  }

  /** 位置 i 是否落在某个冻结词内 */
  #frozenAt(chars, i) {
    for (const w of this.#frozenSet) {
      const wl = w.length
      for (let start = Math.max(0, i - wl + 1); start <= i; start++) {
        if (start + wl > chars.length) continue
        if (chars.slice(start, start + wl).join('') === w) return w
      }
    }
    return null
  }

  /** 若改出重复的 地地/得得/的的，把后一个字还原 */
  #undoDuplicate(origChars, outChars) {
    if (origChars.length !== outChars.length) return outChars.join('')
    for (let i = 1; i < outChars.length; i++) {
      if (outChars[i] === outChars[i - 1] && '的地得'.includes(outChars[i])) {
        if (origChars[i] !== origChars[i - 1]) outChars[i] = origChars[i]
      }
    }
    return outChars.join('')
  }
}

export default DeCorrector
