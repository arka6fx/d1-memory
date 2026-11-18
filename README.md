# d1-memory

Long-term memory for AI agents on Cloudflare D1 and Vectorize.

Vector search alone misses names, codes and dates ("QX7P2K", "Biscuit"); keyword search alone misses meaning ("teeth" vs "dentist"). `d1-memory` runs three searches and fuses them with reciprocal rank fusion:

```
query ─┬─ vector   (Vectorize, cosine, filtered by owner) ─┐
       ├─ keyword  (D1 FTS5, BM25)                          ├─ RRF (k = 60) → + small recency boost → D1 check → results
       └─ exact    (topic name, or the text verbatim)      ─┘
```

D1 is the source of truth: a vector the index still holds for a deleted or replaced memory is dropped at the end.

- **Facts that change:** give a memory a `topic` ("home_city") and a newer one replaces it. The old row is kept as `superseded` for export, and its vector is removed.
- **Facts that expire:** `forgetAfter` leaves a memory out of recall after a date.
- **Provenance:** each memory records its `source`: `user`, `agent` or `outside` (saved after reading a page or an email). Treat `outside` memories as data, not instructions.
- **Embeddings are best effort:** if the model is down the memory is still saved and found by keywords; `sync()` on a cron adds the vector later.
- **Privacy:** every query is scoped to one owner. `exportAll` and `deleteAll` (rows and vectors) are built in.

TypeScript, no runtime dependencies. Tested against real SQLite with the same migration D1 runs.

## Setup

```bash
npx wrangler d1 create memory
npx wrangler vectorize create memory --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index memory --property-name=owner --type=string
npx wrangler d1 migrations apply memory --remote
```

Bindings are in [`wrangler.example.toml`](wrangler.example.toml); a full Worker is in [`examples/worker.ts`](examples/worker.ts).

## Usage

```ts
import { createMemory, workersAiEmbed } from "d1-memory"

const memory = createMemory({
  db: env.DB,
  index: env.MEMORY_INDEX,
  embed: workersAiEmbed(env.AI), // @cf/baai/bge-base-en-v1.5, 768 dimensions
})

await memory.remember(userId, { text: "Usual coffee order is an oat latte" })
await memory.remember(userId, { text: "Moved to Bengaluru", topic: "home_city" })
await memory.remember(userId, { text: "Staying at the Harbour Hotel", forgetAfter: Date.now() + 7 * 86_400_000 })

const found = await memory.recall(userId, "what coffee do I like?")
// [{ text: "Usual coffee order is an oat latte", score, via: ["vector", "keyword"], ... }]
```

## API

- `remember(owner, { text, topic?, source?, forgetAfter? })`: same text twice is one memory
- `recall(owner, query, limit = 8)`: fused results with `score` and `via`
- `forget(owner, id)`: hard delete, row and vector
- `exportAll(owner)`, `deleteAll(owner)`
- `sync(limit = 50)`: embed memories that have no vector yet
- `rrf(lists, k)`, `ftsQuery(text)`: the pieces, if you want them on their own

Options: `candidates` per branch (30), `k` (60), `recency` (`{ weight: 0.001, halfLifeDays: 90 }`: enough to break near-ties, not to bury a good old match; weight 0 turns it off).

User text never reaches FTS5 or `LIKE` as syntax: words are quoted for `MATCH`, and `%`/`_` are escaped.

## Tests

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
