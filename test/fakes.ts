// Test doubles: D1 over node:sqlite (with the real migration), an in-memory vector index
// with cosine similarity, and a tiny embedder where related words share a dimension.
import { readFileSync } from "node:fs"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"

import type { D1Like, D1Statement, Embed, VectorIndex } from "../src/types.ts"

const MIGRATION = readFileSync(new URL("../migrations/0001_memories.sql", import.meta.url), "utf8")

export function sqliteD1(): D1Like & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:")
  db.exec(MIGRATION)
  const statement = (sql: string, values: unknown[] = []): D1Statement & { exec(): unknown } => {
    const args = () => values as SQLInputValue[]
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      exec: () => db.prepare(sql).run(...args()),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args()).changes) } }),
      first: async <T>() => (db.prepare(sql).get(...args()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...args()) as T[] }),
    }
  }
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec("BEGIN")
      try {
        const out = statements.map((s) => (s as ReturnType<typeof statement>).exec())
        db.exec("COMMIT")
        return out
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
  }
}

export function memoryIndex(): VectorIndex & { size(): number; ids(): string[] } {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, string> }>()
  const cosine = (a: number[], b: number[]) => {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!
      na += a[i]! ** 2
      nb += b[i]! ** 2
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0
  }
  return {
    size: () => vectors.size,
    ids: () => [...vectors.keys()],
    async upsert(items) {
      for (const item of items) vectors.set(item.id, { values: item.values, metadata: item.metadata ?? {} })
    },
    async query(vector, { topK, filter }) {
      const matches = [...vectors.entries()]
        .filter(([, v]) => !filter || Object.entries(filter).every(([key, value]) => v.metadata[key] === value))
        .map(([id, v]) => ({ id, score: cosine(vector, v.values) }))
        .filter((m) => m.score > 0.5)
        .sort((a, b) => b.score - a.score)
      return { matches: matches.slice(0, topK) }
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id)
    },
  }
}

// Related words share a "concept" dimension, so the vector branch finds what keywords miss.
const CONCEPTS: Record<string, number> = {
  dentist: 0, teeth: 0, tooth: 0, dental: 0,
  coffee: 1, latte: 1, espresso: 1, cappuccino: 1,
  flight: 2, trip: 2, travel: 2, flying: 2, airport: 2,
  dog: 3, puppy: 3, pet: 3,
  city: 4, lives: 4, live: 4, moved: 4,
}

export const conceptEmbed: Embed = async (text) => {
  const values = new Array<number>(32).fill(0)
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word) continue
    const concept = CONCEPTS[word]
    if (concept !== undefined) values[concept]! += 1
    else {
      let h = 0
      for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0
      values[8 + (h % 24)]! += 0.3
    }
  }
  return values
}
