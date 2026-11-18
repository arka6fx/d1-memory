import type { Embed } from "./types.ts"

/** The part of the Workers AI binding this helper uses. */
export interface AiLike {
  run(model: string, input: { text: string[] }): Promise<unknown>
}

/**
 * Embeddings from Workers AI. The default model, bge-base-en-v1.5, gives 768 dimensions:
 * create the Vectorize index with `--dimensions=768 --metric=cosine`.
 * Returns [] on failure, so a memory is still saved and sync() adds its vector later.
 */
export function workersAiEmbed(ai: AiLike, model = "@cf/baai/bge-base-en-v1.5"): Embed {
  return async (text) => {
    try {
      const out = (await ai.run(model, { text: [text] })) as { data?: number[][] }
      return out.data?.[0] ?? []
    } catch {
      return []
    }
  }
}
