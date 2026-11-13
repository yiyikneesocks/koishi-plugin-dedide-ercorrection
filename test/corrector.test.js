import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeCorrector, hasRealContent, isNoise, isMention, chunkBySentence } from '../src/corrector/de-corrector.js'

const c = new DeCorrector()
await c.warmup()

test('纠错：的 → 地', async () => {
  assert.equal(await c.fix('他慢慢的走过来'), '他慢慢地走过来')
  assert.equal(await c.fix('他高兴的跑得很快'), '他高兴地跑得很快')
  assert.equal(await c.fix('她快乐的唱着歌'), '她快乐地唱着歌')
})

test('纠错：的 → 得', async () => {
  assert.equal(await c.fix('雨下的很大'), '雨下得很大')
  assert.equal(await c.fix('这本书写的很好'), '这本书写得很好')
  assert.equal(await c.fix('他跑的比我快'), '他跑得比我快')
})

test('V得C 补语：分词器会吞字，逐字不会', async () => {
  // 这是弃用 jieba 的直接原因：「跑得快」会被切成一个词
  assert.equal(await c.fix('他跑的很快'), '他跑得很快')
  assert.equal(await c.fix('他说的对'), '他说得对')
  assert.equal(await c.fix('他做的很好'), '他做得很好')
})

test('正确文本一个字都不动', async () => {
  const cases = [
    '他高兴地跑得很快', '这是我的书', '我买的水果很甜', '好的',
    '他们的意见很重要', '老师的办公室在三楼', '他会的', '这是我要的',
    '漂亮的花开了', '欢迎新老师生前来就餐',
  ]
  for (const s of cases) assert.equal(await c.fix(s), s, s)
})

test('词汇化例外不动', async () => {
  const cases = [
    '的士来了', '目的地很远', '土地很肥沃', '这个问题值得研究',
    '他得到了奖励', '的确如此', '我记得这件事', '地方不大',
  ]
  for (const s of cases) assert.equal(await c.fix(s), s, s)
})

test('噪声不处理', async () => {
  for (const s of ['的地得', '哈哈哈哈', '111111', '嗯嗯嗯嗯', '。。。。。']) {
    assert.equal(await c.fix(s), s, s)
  }
})

test('连用不处理（否则会改出「慢慢地地」）', async () => {
  assert.equal(await c.fix('他慢慢的地走过来'), '他慢慢的地走过来')
  assert.equal(await c.fix('他跑的得快'), '他跑的得快')
})

test('提及语境不处理', async () => {
  assert.equal(await c.fix('我写了个插件纠正的地得'), '我写了个插件纠正的地得')
})

test('混排：提及 + 真实错误', async () => {
  assert.equal(
    await c.fix('我写了个插件纠正的地得，他慢慢的跑过来'),
    '我写了个插件纠正的地得，他慢慢地跑过来',
  )
})

test('多错误同句', async () => {
  assert.equal(
    await c.fix('他慢慢的走过来，雨下的很大，这本书写的很好。'),
    '他慢慢地走过来，雨下得很大，这本书写得很好。',
  )
})

test('changes 字段结构', async () => {
  const r = await c.check('雨下的很大')
  assert.equal(r.changes.length, 1)
  assert.deepEqual(
    { from: r.changes[0].from, to: r.changes[0].to, tag: r.changes[0].tag },
    { from: '的', to: '得', tag: 'DER' },
  )
})

test('非 UTF-16 边界：emoji 不破坏偏移', async () => {
  const s = '😀他慢慢的走过来🎉'
  assert.equal(await c.fix(s), '😀他慢慢地走过来🎉')
})

// ────────────────────────────────────────────────────────────
// 长消息分块（chunking）— 0.2.0
// 旧语义：maxLength 是「全文上限」，超长整条丢弃（生产事故根源）。
// 新语义：maxLength 是「单块上限」，超长自动分块；全文熔断用 maxTotalLength。
// ────────────────────────────────────────────────────────────
test('全文熔断：超 maxTotalLength 直接跳过', async () => {
  const long = '他慢慢的走过来。'.repeat(100) // 800 字
  const capped = new DeCorrector({ maxTotalLength: 300 })
  await capped.warmup()
  assert.equal(await capped.fix(long), long)
})

test('长文分块：超过单块上限不再丢弃（800 字）', async () => {
  const long = '他慢慢的走过来。'.repeat(100)
  const expect = '他慢慢地走过来。'.repeat(100)
  assert.equal(await c.fix(long), expect)
})

test('分块可观测：chunkInfo + onChunk', async () => {
  const long = '他慢慢的走过来。'.repeat(100)
  const seen = []
  const cc = new DeCorrector({ onChunk: (info) => seen.push(info) })
  await cc.warmup()
  const r = await cc.check(long)
  assert.ok(r.chunkInfo, '应带 chunkInfo')
  assert.ok(r.chunkInfo.chunks.length >= 2, '800 字应至少分 2 块')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].processed, r.chunkInfo.processed)
  assert.equal(seen[0].total, 800)
})

test('maxChunks：超出部分原样保留，不丢文本', async () => {
  const long = '他慢慢的走过来。'.repeat(100)
  const cc = new DeCorrector({ maxLength: 100, maxChunks: 1 })
  await cc.warmup()
  const r = await cc.check(long)
  assert.equal([...r.corrected].length, [...long].length)
  assert.ok(r.corrected.startsWith('他慢慢地走过来。'), '首块应被纠错')
  assert.ok(r.corrected.includes('他慢慢的走过来。'), '跳过块应原样保留')
  assert.equal(r.chunkInfo.skipped, r.chunkInfo.chunks.length - 1)
})

test('分块不破坏占位符（<at .../>）', async () => {
  // 无标点长串，强制硬切；切点必须避开占位符内部
  const ph = '<at id="12345"/>'
  const chars = [...('a'.repeat(50) + ph + 'b'.repeat(50))]
  const phStart = 50
  const phEnd = 50 + [...ph].length
  const ranges = chunkBySentence(chars, 55)
  for (const [, end] of ranges) {
    assert.ok(!(end > phStart && end < phEnd), `切点 ${end} 落在占位符内部`)
  }
})

// 生产 503 字样本（NapCat 2026-11-12_17-10-42.737.log:1121，群 862760462）
// 事故：maxLength=500 守卫静默丢弃整条。chunking 后应分 2 块、不丢字、
// 且只改「忍不住的→忍不住地」；「真的/不由得」被冻结词保护。
const SAMPLE_503 = '谈及zaka和Faker在中上联动的区别，这位不苟言辞的选手哈哈大笑了起来:“这太难了哥们儿，太难了。你要知道zaka拥有无可比拟的操作，他是一头猎豹随时准备单杀你。而Faker有更好的大局意识和节奏意识，他可以指挥我完成各种中野联动，真的很难分出胜负。但是我想，Faker是一个天生的赢家，他之前也赢了很多S赛，你知道的哥们儿他一直在赢，他永远都在找机会，这会带动你一起与他努力和疯狂，有无与伦比的魅力，让你忍不住的和他一起战斗，跟随着他，这感觉真的太美妙了。”\n谈及peyz，zeus选手也是赞誉有加：“你知道的，gumayusi有时候打的风格偏激进，当然哥们你知道的这并不是不好，而是我更喜欢有稳健性的打法，是的，peyz就是这样，他的AD你BAN不完，天哪，他在赛场上面永远保持竞争心和强烈的胜负心，这样的氛围让我也不由得跟随他完成许多几乎不可能的操作，打赢三打五这样劣势团战，是的，这是之前在韩华未曾有过的体验。”\n而在被问及怎么面对支持韩华和他的粉丝时，zeus选手也是异常坚定：“你知道的，我为韩华带来了联赛冠军和MSI，但是我的职业生涯在三星的职业生涯也到此结束了，现在我更倾向于展望...'

test('503 字生产样本：分 2 块、不丢字、不误改冻结词', async () => {
  const r = await c.check(SAMPLE_503)
  assert.equal([...SAMPLE_503].length, 503)
  assert.equal([...r.corrected].length, [...SAMPLE_503].length, '长度必须一致')
  assert.ok(r.chunkInfo && r.chunkInfo.chunks.length === 2, '应分 2 块')
  assert.equal(r.chunkInfo.skipped, 0)
  assert.equal(r.changes.length, 1)
  assert.deepEqual(
    { index: r.changes[0].index, from: r.changes[0].from, to: r.changes[0].to },
    { index: 208, from: '的', to: '地' },
  )
  assert.ok(!r.corrected.includes('真地'), '真的 不应被改')
  assert.ok(!r.corrected.includes('不由地'), '不由得 不应被改')
})

test('分块边界：纯中文 / 混拉丁 / 单句硬切 均不丢字', async () => {
  const cases = [
    '他慢慢的走过来，我们高兴的唱着歌。'.repeat(31),
    'zaka和Faker在中上联动，他高兴的跑过来。'.repeat(23),
    '他慢慢的走过来'.repeat(90) + '。',
  ]
  for (const text of cases) {
    const r = await c.check(text)
    assert.equal([...r.corrected].length, [...text].length)
    assert.ok(r.chunkInfo && r.chunkInfo.chunks.length >= 2)
  }
})

test('并发安全', async () => {
  const inputs = Array.from({ length: 30 }, (_, i) =>
    ['他慢慢的走过来', '雨下的很大', '这本书写的很好'][i % 3],
  )
  const out = await Promise.all(inputs.map((s) => c.fix(s)))
  assert.deepEqual(out.filter((_, i) => i % 3 === 0), Array(10).fill('他慢慢地走过来'))
})

test('工具函数', () => {
  assert.ok(isNoise('的地理得得得的'.replace('理', '') + '得'))
  assert.ok(!hasRealContent('的地得得得得的'))
  assert.ok(hasRealContent('他慢慢的走过来'))
  assert.ok(hasRealContent('哈'.repeat(30) + '他慢慢的走过来'))
  assert.ok(isMention('我写了个插件纠正的地得', 9))
  assert.ok(!isMention('这本书写的很好', 4))
})

// ────────────────────────────────────────────────────────────
// 与 Python 参考实现（完整 HanLP）逐句一致性
// ────────────────────────────────────────────────────────────
test('与 HanLP 参考结果完全一致（64 句）', async () => {
  // 这些期望值来自 Python 版 hanlp-lab 的实际输出，已 64/64 比对通过
  const REF = [
    ['他慢慢的走过来', '他慢慢地走过来'],
    ['他高兴的跑得很快', '他高兴地跑得很快'],
    ['她快乐的唱着歌', '她快乐地唱着歌'],
    ['请仔细的阅读说明书', '请仔细地阅读说明书'],
    ['同学们热烈的讨论着', '同学们热烈地讨论着'],
    ['他飞快的跑向终点', '他飞快地跑向终点'],
    ['她温柔的笑了', '她温柔地笑了'],
    ['我们要合理的安排时间', '我们要合理地安排时间'],
    ['雨下的很大', '雨下得很大'],
    ['这本书写的很好', '这本书写得很好'],
    ['他跑的比我快', '他跑得比我快'],
    ['她气的说不出话', '她气得说不出话'],
    ['你来的真早', '你来得真早'],
    ['他唱的很好听', '他唱得很好听'],
    ['这活儿干的漂亮', '这活儿干得漂亮'],
    ['日子过的很快', '日子过得很快'],
    ['跑得快', '跑得快'],
    ['说得对', '说得对'],
    ['做得好', '做得好'],
    ['他高兴地跑得很快', '他高兴地跑得很快'],
    ['这是我的书', '这是我的书'],
    ['我买的水果很甜', '我买的水果很甜'],
    ['好的', '好的'],
    ['的士来了', '的士来了'],
    ['目的地很远', '目的地很远'],
    ['土地很肥沃', '土地很肥沃'],
    ['这个问题值得研究', '这个问题值得研究'],
    ['欢迎新老师生前来就餐', '欢迎新老师生前来就餐'],
    ['他慢慢的地走过来', '他慢慢的地走过来'],
    ['我写了个插件纠正的地得', '我写了个插件纠正的地得'],
    ['的地得', '的地得'],
    ['哈哈哈哈', '哈哈哈哈'],
  ]
  for (const [src, expect] of REF) {
    assert.equal(await c.fix(src), expect, `句子: ${src}`)
  }
})

// ────────────────────────────────────────────────────────────
// 专名领属格（proper-noun possessive）— 回归用例
// 这是 koishi 生产环境反馈的两个真实 bug
// ────────────────────────────────────────────────────────────
test('专名领属格：赛亚饿的鸟 → 不应改成 得', async () => {
  // #6 false positive: 语境 bleeding 把「饿的」误判成补语
  assert.equal(await c.fix('赛亚饿的鸟飞的快'), '赛亚饿的鸟飞得快')
  assert.equal(await c.fix('赛亚饿的鸟'), '赛亚饿的鸟')
})

test('专名领属格：张本智和地实力 → 应改成 的', async () => {
  // #7 false negative: 模型不认专名，「地」未被识别为候选
  assert.equal(await c.fix('张本智和地实力'), '张本智和的实力')
  assert.equal(await c.fix('以张本智和地实力评价来看'), '以张本智和的实力评价来看')
})

test('结果补语 + 状态名词：说得一口好英语 / 跑得一身汗 → 不应误改', async () => {
  assert.equal(await c.fix('他说得一口好英语'), '他说得一口好英语')
  assert.equal(await c.fix('跑得一身汗'), '跑得一身汗')
  assert.equal(await c.fix('跑得快'), '跑得快')
})

// ────────────────────────────────────────────────────────────
// 固定短语强改 + 不及物动词程度补语 — 回归用例
// 经 HanLP 原版 tok→pos 验证：原版同样改不对，属模型盲区，需要补丁。
// ────────────────────────────────────────────────────────────
test('固定短语：总得来说 → 总的来说（仅分句首）', async () => {
  assert.equal(await c.fix('总得来说'), '总的来说')
  assert.equal(await c.fix('，总得来说，这事不急'), '，总的来说，这事不急')
  assert.equal(await c.fix('他总得来说两句'), '他总得来说两句')
  assert.equal(await c.fix('总得去一趟'), '总得去一趟')
})

test('固定短语：懂得都懂 → 懂的都懂', async () => {
  assert.equal(await c.fix('懂得都懂'), '懂的都懂')
  assert.equal(await c.fix('我懂得这个道理'), '我懂得这个道理')
  assert.equal(await c.fix('懂得道理'), '懂得道理')
})

test('误改防护：总的来说 不能被改成 总地来说', async () => {
  assert.equal(await c.fix('总的来说'), '总的来说')
  assert.equal(await c.fix('总的来说吧'), '总的来说吧')
})

test('不及物动词程度补语：飞的就是高 → 飞得就是高', async () => {
  assert.equal(await c.fix('赛亚饿的鸟他飞的就是高'), '赛亚饿的鸟他飞得就是高')
  assert.equal(await c.fix('他跳的就是高'), '他跳得就是高')
  assert.equal(await c.fix('他来的就是早'), '他来得就是早')
})

test('程度补语保护：名词化的的 / 及物动词 不误改', async () => {
  assert.equal(await c.fix('他说的就是对的'), '他说的就是对的')
  assert.equal(await c.fix('他买的就是贵的'), '他买的就是贵的')
  assert.equal(await c.fix('我要的就是快'), '我要的就是快')
  // 「打的」= 打的内容/表现，是合法名词，不能改
  assert.equal(await c.fix('他打的就是好'), '他打的就是好')
  assert.equal(await c.fix('他写的就是好'), '他写的就是好')
})

// ────────────────────────────────────────────────────────────
// DER 解冻 — M2 回归（生产漏纠 2026-11-13）
// 模型给出 DER（明确补语判定）时，冻结词护栏让路；
// 其余标签（taxi 义「打的回家」= AS、构词义「值得」= VV 等）仍冻结。
// ────────────────────────────────────────────────────────────
test('DER 解冻：打的好啊 → 打得好啊', async () => {
  assert.equal(await c.fix('打的好啊'), '打得好啊')
  assert.equal(await c.fix('他打的很好'), '他打得很好')
})

test('DER 解冻不伤冻结词：taxi/构词义不动', async () => {
  assert.equal(await c.fix('他打的回家'), '他打的回家')
  assert.equal(await c.fix('这本书值得买'), '这本书值得买')
  assert.equal(await c.fix('他懂得多'), '他懂得多')
  assert.equal(await c.fix('他总得去一趟'), '他总得去一趟')
  assert.equal(await c.fix('我记得这件事'), '我记得这件事')
  assert.equal(await c.fix('难得的机会'), '难得的机会')
  assert.equal(await c.fix('标的很清楚'), '标的很清楚')
  assert.equal(await c.fix('他赢得比赛'), '他赢得比赛')
  assert.equal(await c.fix('他显得很累'), '他显得很累')
})

test('DER 解冻不重开历史误纠：赛亚饿的鸟飞的高', async () => {
  // v0.1.1 邻居规则修复的锚点，解冻不能让「饿的」再变「饿得」
  assert.equal(await c.fix('赛亚饿的鸟飞的高'), '赛亚饿的鸟飞得高')
})

// ────────────────────────────────────────────────────────────
// F1 程度补语固定后缀 / F3 网络补语「X得一批」
// ────────────────────────────────────────────────────────────
test('F1：菜的离谱 / 萌的犯规呀 / 累的要死', async () => {
  assert.equal(await c.fix('菜的离谱'), '菜得离谱')
  assert.equal(await c.fix('萌的犯规呀'), '萌得犯规呀')
  assert.equal(await c.fix('累的要死'), '累得要死')
})

test('F1 保护：字面义/正确文本不动', async () => {
  assert.equal(await c.fix('这个菜的味道很离谱'), '这个菜的味道很离谱')
  assert.equal(await c.fix('真的离谱'), '真的离谱')
})

test('F3：猛的一批 → 猛得一批', async () => {
  assert.equal(await c.fix('猛的一批'), '猛得一批')
})

test('F3 保护：一批后接名词是字面义', async () => {
  assert.equal(await c.fix('猛的一批货'), '猛的一批货')
  assert.equal(await c.fix('他猛的一批操作'), '他猛的一批操作')
})
