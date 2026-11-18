import { rrf } from "./rrf.ts"
import type { D1Like, Embed, Memory, MemorySource, Recalled, VectorIndex } from "./types.ts"

export type MemoryOptions = {
  db: D1Like
  index: VectorIndex
  embed: Embed
  /** Candidates each branch brings to the fusion. Default 30. */
  candidates?: number
  /** RRF constant. Default 60. */
  k?: number
  /**
   * A small boost for recent memories, added to the fused score: weight × 0.5^(age / half-life).
   * The default weight (0.001) is worth a few ranks, so it breaks near-ties without
   * burying an old memory that matches well. 0 turns it off.
   */
  recency?: { weight: number; halfLifeDays: number }
  now?: () => number
  newId?: () => string
}

export type RememberInput = {
  text: string
  /** A key for facts that replace each other: a new "home_city" supersedes the old one. */
  topic?: string
  source?: MemorySource
  /** Unix ms after which recall leaves it out. */
  forgetAfter?: number
}

export const MAX_MEMORY_CHARS = 4000

type Row = {
  id: string
  owner: string
  text: string
  topic: string | null
  source: MemorySource
  forget_after: number | null
  created_at: number
  updated_at: number
}

const ALIVE = "status = 'active' AND (forget_after IS NULL OR forget_after > ?)"
const STOPWORDS = new Set(
  "a an and are as at be by did do does for from has have how i in is it me my of on or our so that the their them they this to was we were what when where which who why will with you your".split(
    " ",
  ),
)

function toMemory(row: Row): Memory {
  return {
    id: row.id,
    owner: row.owner,
    text: row.text,
    topic: row.topic,
    source: row.source,
    forgetAfter: row.forget_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Words worth searching for, as an FTS5 query: each quoted (no operator injection), OR'd. */
export function ftsQuery(query: string): string | null {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  if (words.length === 0) return null
  return [...new Set(words)].map((w) => `"${w}"*`).join(" OR ")
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, "_")
}

export function createMemory(options: MemoryOptions) {
  const { db, index, embed } = options
  const candidates = options.candidates ?? 30
  const k = options.k ?? 60
  const recency = options.recency ?? { weight: 0.001, halfLifeDays: 90 }
  const now = options.now ?? Date.now
  const newId = options.newId ?? (() => crypto.randomUUID())

  async function addVector(id: string, owner: string, text: string): Promise<boolean> {
    try {
      const values = await embed(text)
      if (values.length === 0) return false
      await index.upsert([{ id, values, metadata: { owner } }])
      await db.prepare("UPDATE memories SET embedded = 1 WHERE id = ?").bind(id).run()
      return true
    } catch {
      return false // best effort: the memory stays, sync() retries the vector
    }
  }

  /** Save a fact. Same text again is a no-op; the same topic replaces the older fact. */
  async function remember(owner: string, input: RememberInput): Promise<Memory> {
    const text = input.text.trim().slice(0, MAX_MEMORY_CHARS)
    if (!text) throw new Error("A memory needs text.")
    const at = now()

    const same = await db
      .prepare(`SELECT * FROM memories WHERE owner = ? AND text = ? AND ${ALIVE} LIMIT 1`)
      .bind(owner, text, at)
      .first<Row>()
    if (same) return toMemory(same)

    const topic = input.topic ? normalizeTopic(input.topic) : null
    const row: Row = {
      id: newId(),
      owner,
      text,
      topic,
      source: input.source ?? "user",
      forget_after: input.forgetAfter ?? null,
      created_at: at,
      updated_at: at,
    }
    const older = topic
      ? (
          await db
            .prepare("SELECT id FROM memories WHERE owner = ? AND topic = ? AND status = 'active'")
            .bind(owner, topic)
            .all<{ id: string }>()
        ).results.map((r) => r.id)
      : []

    const insert = db
      .prepare(
        `INSERT INTO memories (id, owner, text, topic, source, forget_after, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, owner, text, topic, row.source, row.forget_after, at, at)
    const supersede = older.map((id) =>
      db
        .prepare("UPDATE memories SET status = 'superseded', replaced_by = ?, updated_at = ? WHERE id = ?")
        .bind(row.id, at, id),
    )
    await db.batch([...supersede, insert])
    if (older.length > 0) await index.deleteByIds(older).catch(() => undefined)

    await addVector(row.id, owner, text)
    return toMemory(row)
  }

  async function rowsByIds(owner: string, ids: string[], at: number): Promise<Map<string, Row>> {
    if (ids.length === 0) return new Map()
    const marks = ids.map(() => "?").join(", ")
    const { results } = await db
      .prepare(`SELECT * FROM memories WHERE owner = ? AND id IN (${marks}) AND ${ALIVE}`)
      .bind(owner, ...ids, at)
      .all<Row>()
    return new Map(results.map((r) => [r.id, r]))
  }

  async function vectorBranch(owner: string, query: string): Promise<string[]> {
    try {
      const values = await embed(query)
      if (values.length === 0) return []
      const { matches } = await index.query(values, { topK: candidates, filter: { owner } })
      return matches.map((m) => m.id)
    } catch {
      return [] // the keyword and exact branches still answer
    }
  }

  async function keywordBranch(owner: string, query: string, at: number): Promise<string[]> {
    const match = ftsQuery(query)
    if (!match) return []
    const { results } = await db
      .prepare(
        `SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.owner = ? AND m.${ALIVE}
         ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .bind(match, owner, at, candidates)
      .all<{ id: string }>()
    return results.map((r) => r.id)
  }

  /** A topic named exactly, or a short query (a name, a number) found verbatim. */
  async function exactBranch(owner: string, query: string, at: number): Promise<string[]> {
    const q = query.trim()
    if (!q || q.length > 60) return []
    const { results } = await db
      .prepare(
        `SELECT id FROM memories
         WHERE owner = ? AND ${ALIVE} AND (topic = ? OR text LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .bind(owner, at, normalizeTopic(q), `%${likeEscape(q)}%`, candidates)
      .all<{ id: string }>()
    return results.map((r) => r.id)
  }

  /** The memories that best match a query, from all three branches, fused. */
  async function recall(owner: string, query: string, limit = 8): Promise<Recalled[]> {
    const at = now()
    const [vector, keyword, exact] = await Promise.all([
      vectorBranch(owner, query),
      keywordBranch(owner, query, at),
      exactBranch(owner, query, at),
    ])
    const fused = rrf({ vector, keyword, exact }, k)
    // The vector index can hold stale ids (a deleted or superseded memory): D1 decides.
    const rows = await rowsByIds(
      owner,
      fused.map((f) => f.id),
      at,
    )
    const day = 86_400_000
    return fused
      .filter((f) => rows.has(f.id))
      .map((f) => {
        const row = rows.get(f.id)!
        const age = Math.max(0, at - row.updated_at) / day
        const boost = recency.weight * 0.5 ** (age / recency.halfLifeDays)
        return { ...toMemory(row), score: f.score + boost, via: f.via as Recalled["via"] }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Hard-delete one memory and its vector. */
  async function forget(owner: string, id: string): Promise<boolean> {
    const out = await db.prepare("DELETE FROM memories WHERE owner = ? AND id = ?").bind(owner, id).run()
    if (out.meta.changes === 0) return false
    await index.deleteByIds([id]).catch(() => undefined)
    return true
  }

  /** Everything kept about one owner, replaced facts included: for an export. */
  async function exportAll(owner: string): Promise<Array<Memory & { status: string }>> {
    const { results } = await db
      .prepare("SELECT * FROM memories WHERE owner = ? ORDER BY created_at, rowid")
      .bind(owner)
      .all<Row & { status: string }>()
    return results.map((r) => ({ ...toMemory(r), status: r.status }))
  }

  /** Delete every memory and vector of one owner. Returns how many rows went. */
  async function deleteAll(owner: string): Promise<number> {
    const { results } = await db
      .prepare("SELECT id FROM memories WHERE owner = ?")
      .bind(owner)
      .all<{ id: string }>()
    const ids = results.map((r) => r.id)
    await db.prepare("DELETE FROM memories WHERE owner = ?").bind(owner).run()
    for (let i = 0; i < ids.length; i += 100) {
      await index.deleteByIds(ids.slice(i, i + 100))
    }
    return ids.length
  }

  /** Embed active memories that have no vector yet (an embed that failed). Run it on a cron. */
  async function sync(limit = 50): Promise<number> {
    const { results } = await db
      .prepare("SELECT id, owner, text FROM memories WHERE embedded = 0 AND status = 'active' LIMIT ?")
      .bind(limit)
      .all<{ id: string; owner: string; text: string }>()
    let done = 0
    for (const row of results) {
      if (await addVector(row.id, row.owner, row.text)) done++
    }
    return done
  }

  return { remember, recall, forget, exportAll, deleteAll, sync }
}
