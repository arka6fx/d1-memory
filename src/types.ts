/** The part of Cloudflare D1's API this library uses. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<{ meta: { changes: number } }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

export interface D1Like {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown[]>
}

/** The part of Cloudflare Vectorize's API this library uses. */
export interface VectorIndex {
  upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, string> }>): Promise<unknown>
  query(
    vector: number[],
    options: { topK: number; filter?: Record<string, string> },
  ): Promise<{ matches: Array<{ id: string; score: number }> }>
  deleteByIds(ids: string[]): Promise<unknown>
}

/** Text to an embedding. Return [] when it can't be had: the memory is kept, the vector waits. */
export type Embed = (text: string) => Promise<number[]>

export type MemorySource = "user" | "agent" | "outside"

export type Memory = {
  id: string
  owner: string
  text: string
  topic: string | null
  source: MemorySource
  forgetAfter: number | null
  createdAt: number
  updatedAt: number
}

export type Recalled = Memory & {
  /** The fused score (higher is better). */
  score: number
  /** Which branches found it. */
  via: Array<"vector" | "keyword" | "exact">
}
