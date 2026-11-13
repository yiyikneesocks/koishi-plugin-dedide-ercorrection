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
]

const PUNCT = '，。！？；：、“”‘’（）《》〈〉【】…—～,.!?;:\'"()[]{}<>-~ \n\t\r'

/** 噪声阈值 */
const NOISE_MIN_ALNUM = 2
const NOISE_DE_RATIO = 0.6
const NOISE_REPEAT_RATIO = 0.7
const MIN_CONTENT_RUN = 2

/** 模型最大位置数（含 [CLS]/[SEP]） */
const MAX_LEN = 510

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
    this.maxLength = options.maxLength ?? 500
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
   * 检查文本，返回纠错结果。
   * @returns {{text:string, corrected:string, changes:Array, tags:Array}}
   */
  async check(text) {
    const chars = [...(text ?? '')]
    const empty = { text, corrected: text ?? '', changes: [], tags: [] }
    if (!chars.length) return empty
    if (!chars.some((c) => '的地得'.includes(c))) return empty
    // 长度限制（超长直接跳过，避免长消息拖慢）
    if (this.maxLength > 0 && chars.length > this.maxLength) return empty
    // 整段纯乱打 → 跳过
    if (!hasRealContent(text)) return empty

    const changes = []
    // 0) 固定短语强改（同长度替换，偏移不变）——必须在 #pos 之前，
    //    让模型看到改后的文本，避免它再把「总的来说」判成 DEV→地。
    for (let i = 0; i < chars.length; i++) {
      const forced = phraseOverride(chars, i)
      if (forced && forced !== chars[i]) {
        changes.push({ index: i, from: chars[i], to: forced, tag: 'PHRASE' })
        chars[i] = forced
      }
    }

    const tags = await this.#pos(chars)
    const out = [...chars]

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]
      if (!'的地得'.includes(ch)) continue
      // 已被固定短语规则处理
      if (changes.some((c) => c.index === i)) continue

      // 1) 词汇化例外
      const frozen = this.#frozenAt(chars, i)
      if (frozen) continue
      // 2) 「提及」语境
      if (isMention(text, i)) continue
      // 3) 连用防护：与相邻的/地/得 紧挨着，上下文不可靠
      if (
        (i > 0 && '的地得'.includes(chars[i - 1])) ||
        (i + 1 < chars.length && '的地得'.includes(chars[i + 1]))
      ) continue

      // 3.5) 邻居规则：的/地/得 后面紧跟名词 → 领属格「的」
      //      例外：动词 + 得 + 状态名词（说得一口好英语）保留 得
      const nextTag = neighborTag(chars, tags, i, +1)
      if (nextTag && NOUN_TAGS.has(nextTag)) {
        const prevTag = neighborTag(chars, tags, i, -1)
        const prevWord = i > 0 ? chars[i - 1] : ''
        // 结果补语「得」：动词 + 得 + 状态名词（说得一口好英语）保留 得
        // 但状态形容词（饿/累/困）+ 得 + 名词 更可能是领属格
        const isResultative = (tags[i] === 'DER' || tags[i] === 'AS') &&
          (prevTag === 'VV' || prevTag === 'VA') &&
          !STATE_ADJ.has(prevWord)
        if (!isResultative) {
          out[i] = '的'
          if (ch !== '的') {
            changes.push({ index: i, from: ch, to: '的', tag: tags[i] })
          }
          continue
        }
      }

      // 3.6) 不及物动词 + 的(DEC) + 就是/是 + 光杆形容词(后面不接的) → 程度补语「得」
      //      例：他飞的就是高 → 他飞得就是高
      //      保护：他说的就是对的（形容词后接「的」）、我要的就是快（及物动词）
      if (tags[i] === 'DEC') {
        const prevTag = neighborTag(chars, tags, i, -1)
        const prevWord = i > 0 ? chars[i - 1] : ''
        if ((prevTag === 'VV' || prevTag === 'VA') && INTRANS_VERBS.has(prevWord)) {
          const rest = chars.slice(i + 1, i + 4).join('')
          const adjIdx = rest.startsWith('就是') ? i + 3 : rest.startsWith('是') ? i + 2 : -1
          if (adjIdx > 0 && adjIdx < chars.length) {
            const adjTag = tags[adjIdx]
            const after = adjIdx + 1 < chars.length ? chars[adjIdx + 1] : ''
            if ((adjTag === 'VA' || adjTag === 'JJ') && after !== '的') {
              out[i] = '得'
              changes.push({ index: i, from: ch, to: '得', tag: tags[i] })
              continue
            }
          }
        }
      }

      const to = TAG_TO_CHAR[tags[i]]
      if (!to || to === ch) continue
      out[i] = to
      changes.push({ index: i, from: ch, to, tag: tags[i] })
    }

    let corrected = out.join('')
    // 4) 防重复字：改完出现原文没有的「地地/得得/的的」→ 回退
    corrected = this.#undoDuplicate(chars, [...corrected])
    return { text, corrected, changes, tags }
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
