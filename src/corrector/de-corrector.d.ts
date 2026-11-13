/**
 * Type declarations for the bundled correction core (src/corrector/de-corrector.js).
 * Synced from @azulores/de-corrector v0.2.0 (2026-11-14, F1/F2/F3 + chunking);
 * the standalone package remains available independently for backend use.
 */
export interface DeCorrectorOptions {
  /** 单块上限（chunk 内字符数），默认 500 */
  maxLength?: number
  /** 全文熔断上限（码点数），超过则原样返回不推理；0 = 不限制。默认 2000 */
  maxTotalLength?: number
  /** 块数上限：超出部分原样保留（不丢文本），默认 4 */
  maxChunks?: number
  /** 块目标大小（句界贪心攒块），默认 CHUNK_TARGET(300) */
  chunkTarget?: number
  /** 分块观测回调：仅分块时调用 */
  onChunk?: (info: { total: number; chunks: Array<[number, number]>; processed: number; skipped: number }) => void
  modelPath?: string
  debug?: boolean
}

export interface DeChange {
  index: number
  from: string
  to: string
  tag?: string
}

export interface ChunkInfo {
  chunks: Array<[number, number]>
  processed: number
  skipped: number
}

export interface CheckResult {
  text: string
  corrected: string
  changes: DeChange[]
  tags: string[]
  /** 发生分块时存在 */
  chunkInfo?: ChunkInfo
}

export declare const TAG_TO_CHAR: Record<string, string>
export declare const FROZEN_WORDS: string[]
export declare function isNoise(text: string): boolean
export declare function hasRealContent(text: string): boolean
export declare function isMention(text: string, idx: number): boolean

export declare class DeCorrector {
  maxLength: number
  maxTotalLength: number
  maxChunks: number
  chunkTarget: number
  modelPath: string
  debug: boolean
  constructor(options?: DeCorrectorOptions)
  warmup(): Promise<void>
  check(text: string): Promise<CheckResult>
  fix(text: string): Promise<string>
  fixBatch(texts: string[]): Promise<string[]>
}

export default DeCorrector
