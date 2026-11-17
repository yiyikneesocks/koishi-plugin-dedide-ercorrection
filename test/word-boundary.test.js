// word-boundary.test.js
// 词边界护栏的单元测试（不需要加载 25MB 分词模型：用假分词器）。
//
// 跑法：node --test test/word-boundary.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { __setSegmenter, ensureSegmenter, segmenterState, filterByWordBoundary } from '../lib/word-boundary.js'

/** 用「词表最长匹配」造一个假分词器，足够验证门控逻辑本身 */
function fakeSegmenter(vocab) {
  const sorted = [...vocab].sort((a, b) => b.length - a.length)
  return {
    async cutWithOffset(text) {
      const chars = [...text]
      const out = []
      let i = 0
      while (i < chars.length) {
        const rest = chars.slice(i).join('')
        const hit = sorted.find((w) => rest.startsWith(w))
        if (hit) {
          const len = [...hit].length
          out.push({ word: hit, start: i, end: i + len })
          i += len
        } else {
          out.push({ word: chars[i], start: i, end: i + 1 })
          i += 1
        }
      }
      return out
    },
  }
}

const VOCAB = [
  '地幔', '深处', '小偷', '得手', '得票', '目的', '标的', '打的', '值得', '得到',
  '认真', '真的', '慢慢', '气喘', '吁吁', '逃跑',
]

test('词内构字被挡下（地幔/得手/得票）', async () => {
  __setSegmenter(fakeSegmenter(VOCAB))
  // 「地幔深处」的 地 在 index 0，落在「地幔」内 → 挡下
  assert.deepEqual(await filterByWordBoundary('地幔深处', [{ index: 0, from: '地', to: '的' }]), [])
  // 「小偷得手了」的 得 在 index 2，落在「得手」内 → 挡下
  assert.deepEqual(await filterByWordBoundary('小偷得手了', [{ index: 2, from: '得', to: '的' }]), [])
  // 「他得票最多」的 得 在 index 1，落在「得票」内 → 挡下
  assert.deepEqual(await filterByWordBoundary('他得票最多', [{ index: 1, from: '得', to: '的' }]), [])
})

test('独立助词照常放行（真正该改的不能被挡）', async () => {
  __setSegmenter(fakeSegmenter(VOCAB))
  assert.equal((await filterByWordBoundary('他认真的说', [{ index: 3, from: '的', to: '地' }])).length, 1)
  assert.equal((await filterByWordBoundary('他跑的快', [{ index: 2, from: '的', to: '得' }])).length, 1)
  assert.equal((await filterByWordBoundary('慢慢的走过来', [{ index: 2, from: '的', to: '地' }])).length, 1)
})

test('错字不破坏词边界：的幔/的手 仍能改', async () => {
  // 假分词器词表里没有「的幔」「的手」，所以逐字切开 → 的 是单字 → 放行
  __setSegmenter(fakeSegmenter(VOCAB))
  assert.equal((await filterByWordBoundary('的幔深处', [{ index: 0, from: '的', to: '地' }])).length, 1)
  assert.equal((await filterByWordBoundary('的手后逃跑了', [{ index: 0, from: '的', to: '得' }])).length, 1)
})

test('PHRASE 改动不受词边界限制', async () => {
  __setSegmenter(fakeSegmenter(VOCAB))
  const changes = [{ index: 0, from: '地', to: '的', tag: 'PHRASE' }]
  assert.equal((await filterByWordBoundary('地幔深处', changes)).length, 1)
})

test('分词器不可用时降级放行（绝不丢纠错能力）', async () => {
  __setSegmenter(null)
  const changes = [{ index: 0, from: '地', to: '的' }]
  assert.deepEqual(await filterByWordBoundary('地幔深处', changes), changes)
})

test('分词抛异常时降级放行', async () => {
  __setSegmenter({ async cutWithOffset() { throw new Error('boom') } })
  const changes = [{ index: 0, from: '地', to: '的' }]
  assert.deepEqual(await filterByWordBoundary('地幔深处', changes), changes)
})

test('空改动不触发分词', async () => {
  let called = 0
  __setSegmenter({ async cutWithOffset() { called++; return [] } })
  assert.deepEqual(await filterByWordBoundary('地幔', []), [])
  assert.equal(called, 0)
})

test('多改动混合：只挡词内的', async () => {
  __setSegmenter(fakeSegmenter(VOCAB))
  // 地(0)幔(1)深(2)处(3)的(4)温(5)度(6)，(7)他(8)认(9)真(10)的(11)说(12)
  const text = '地幔深处的温度，他认真的说'
  const changes = [
    { index: 0, from: '地', to: '的' },   // 落在「地幔」内 → 挡
    { index: 11, from: '的', to: '地' },  // 「认真的」的 的，单字 → 放行
  ]
  const kept = await filterByWordBoundary(text, changes)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].index, 11)
})

// ─────────────────────────────────────────────────────────────
// provider 能力探测：护栏只接受带 cutWithOffset() 的服务
// ─────────────────────────────────────────────────────────────

test('provider 有 cutWithOffset：护栏启用', () => {
  ensureSegmenter({
    async cutWithOffset() { return [] },
  })
  assert.deepEqual(segmenterState(), { available: true, error: null })
})

test('provider 只有 cut()：护栏停用并给出原因', () => {
  // @node-rs/jieba 就是这种 provider：词典把「跑的快」整体当一个词，
  // 用 cut() 算偏移会把真正该改的助词误判成词内构字，所以必须拒绝。
  ensureSegmenter({
    cut() { return ['跑的快'] },
  })
  const state = segmenterState()
  assert.equal(state.available, false)
  assert.match(state.error, /cutWithOffset/)
})

test('provider 缺失：护栏停用，纠错降级放行', async () => {
  ensureSegmenter(null)
  assert.equal(segmenterState().available, false)
  const changes = [{ index: 0, from: '地', to: '的' }]
  assert.deepEqual(await filterByWordBoundary('地幔深处', changes), changes)
})

test('无 cutWithOffset 的 provider 不会用 cut() 近似（防回归）', async () => {
  // 模拟词典分词器：cut() 把「跑的快」当一个词。
  // 若实现改用 cut() 近似，这里的「的」会被误挡 → 本测试失败。
  ensureSegmenter({ cut() { return ['跑的快'] } })
  const kept = await filterByWordBoundary('他跑的快', [{ index: 2, from: '的', to: '得' }])
  assert.equal(kept.length, 1)
})
