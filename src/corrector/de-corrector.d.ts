/**
 * Type declarations for the bundled correction core (src/corrector/de-corrector.js).
 * Merged from @azulores/de-corrector v0.1.3 (2026-11-13); the standalone package
 * remains available independently for backend use.
 */
export interface DeCorrectorOptions {
  maxLength?: number
  modelPath?: string
  debug?: boolean
}

export interface DeChange {
  index: number
  from: string
  to: string
  tag?: string
}

export interface CheckResult {
  text: string
  corrected: string
  changes: DeChange[]
  tags: string[]
}

export declare const TAG_TO_CHAR: Record<string, string>
export declare const FROZEN_WORDS: string[]
export declare function isNoise(text: string): boolean
export declare function hasRealContent(text: string): boolean
export declare function isMention(text: string, idx: number): boolean

export declare class DeCorrector {
  maxLength: number
  modelPath: string
  debug: boolean
  constructor(options?: DeCorrectorOptions)
  warmup(): Promise<void>
  check(text: string): Promise<CheckResult>
  fix(text: string): Promise<string>
  fixBatch(texts: string[]): Promise<string[]>
}

export default DeCorrector
