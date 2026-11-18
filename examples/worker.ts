// A Worker that gives an agent long-term memory. Bindings (see wrangler.example.toml):
// DB (D1, with migrations/0001_memories.sql applied), MEMORY_INDEX (Vectorize, 768
// dimensions, cosine, metadata index on "owner") and AI (Workers AI).
import { createMemory, workersAiEmbed, type AiLike, type D1Like, type VectorIndex } from "../src/index.ts"

type Env = { DB: D1Like; MEMORY_INDEX: VectorIndex; AI: AiLike }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const memory = createMemory({ db: env.DB, index: env.MEMORY_INDEX, embed: workersAiEmbed(env.AI) })
    const url = new URL(request.url)
    const owner = request.headers.get("x-user-id") ?? "" // use your real auth here
    if (!owner) return new Response("who are you?", { status: 401 })

    if (url.pathname === "/remember" && request.method === "POST") {
      const body = (await request.json()) as { text: string; topic?: string }
      return Response.json(await memory.remember(owner, { ...body, source: "user" }))
    }
    if (url.pathname === "/recall") {
      return Response.json(await memory.recall(owner, url.searchParams.get("q") ?? ""))
    }
    if (url.pathname === "/export") {
      return Response.json(await memory.exportAll(owner))
    }
    if (url.pathname === "/forget-everything" && request.method === "POST") {
      return Response.json({ deleted: await memory.deleteAll(owner) })
    }
    return new Response("not found", { status: 404 })
  },

  // Fill in vectors whose embedding failed at write time.
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const memory = createMemory({ db: env.DB, index: env.MEMORY_INDEX, embed: workersAiEmbed(env.AI) })
    await memory.sync(100)
  },
}
