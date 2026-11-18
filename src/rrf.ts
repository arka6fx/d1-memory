/**
 * Reciprocal rank fusion: merge ranked lists by summing 1 / (k + rank) for every list an
 * item appears in. It needs no score calibration between lists (a cosine similarity and a
 * BM25 score aren't comparable), and items found by several lists rise to the top.
 * k = 60 is the value from the original paper (Cormack et al., 2009).
 */
export function rrf<T extends string>(
  lists: Record<string, readonly T[]>,
  k = 60,
): Array<{ id: T; score: number; via: string[] }> {
  const fused = new Map<T, { score: number; via: string[] }>()
  for (const [name, ids] of Object.entries(lists)) {
    ids.forEach((id, index) => {
      const entry = fused.get(id) ?? { score: 0, via: [] }
      entry.score += 1 / (k + index + 1)
      if (!entry.via.includes(name)) entry.via.push(name)
      fused.set(id, entry)
    })
  }
  return [...fused.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
}
