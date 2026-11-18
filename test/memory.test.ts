import assert from "node:assert/strict"
import { test } from "node:test"

import { createMemory, ftsQuery, rrf, workersAiEmbed, type Embed } from "../src/index.ts"
import { conceptEmbed, memoryIndex, sqliteD1 } from "./fakes.ts"

const DAY = 86_400_000

function setup(embed: Embed = conceptEmbed) {
  const db = sqliteD1()
  const index = memoryIndex()
  let clock = Date.UTC(2026, 10, 1)
  let n = 0
  const memory = createMemory({ db, index, embed, now: () => clock, newId: () => `m${++n}` })
  return { db, index, memory, tick: (ms: number) => (clock += ms), at: () => clock }
}

test("remember then recall by meaning, keyword and exact text", async () => {
  const { memory } = setup()
  await memory.remember("ana", { text: "Has a dentist appointment on Thursday at 4pm" })
  await memory.remember("ana", { text: "Usual coffee order is an oat latte" })
  await memory.remember("ana", { text: "Booking reference for the Lisbon trip is QX7P2K" })

  const teeth = await memory.recall("ana", "when do I see someone about my teeth?")
  assert.match(teeth[0]!.text, /dentist/)
  assert.deepEqual(teeth[0]!.via, ["vector"])

  const coffee = await memory.recall("ana", "coffee")
  assert.match(coffee[0]!.text, /latte/)
  assert.ok(coffee[0]!.via.includes("keyword") && coffee[0]!.via.includes("vector"))

  const code = await memory.recall("ana", "QX7P2K")
  assert.match(code[0]!.text, /Lisbon/)
  assert.ok(code[0]!.via.includes("exact"))
})

test("recall never crosses owners", async () => {
  const { memory } = setup()
  await memory.remember("ana", { text: "Allergic to peanuts" })
  await memory.remember("ben", { text: "Allergic to cats" })
  const out = await memory.recall("ben", "allergic")
  assert.equal(out.length, 1)
  assert.match(out[0]!.text, /cats/)
})

test("the same text twice is one memory", async () => {
  const { memory } = setup()
  const a = await memory.remember("ana", { text: "Prefers window seats" })
  const b = await memory.remember("ana", { text: "  Prefers window seats " })
  assert.equal(a.id, b.id)
  assert.equal((await memory.exportAll("ana")).length, 1)
})

test("a newer fact on the same topic replaces the old one", async () => {
  const { memory, index } = setup()
  const old = await memory.remember("ana", { text: "Lives in Pune", topic: "home city" })
  const now = await memory.remember("ana", { text: "Moved to Bengaluru", topic: "home_city" })
  const out = await memory.recall("ana", "which city does she live in")
  assert.deepEqual(
    out.map((m) => m.id),
    [now.id],
  )
  assert.ok(!index.ids().includes(old.id), "the old vector is removed")
  const all = await memory.exportAll("ana")
  assert.deepEqual(
    all.map((m) => [m.text, m.status]),
    [
      ["Lives in Pune", "superseded"],
      ["Moved to Bengaluru", "active"],
    ],
  )
})

test("memories past their forget-after date are left out", async () => {
  const { memory, tick, at } = setup()
  await memory.remember("ana", { text: "Staying at the Harbour Hotel this week", forgetAfter: at() + 7 * DAY })
  assert.equal((await memory.recall("ana", "hotel")).length, 1)
  tick(8 * DAY)
  assert.equal((await memory.recall("ana", "hotel")).length, 0)
})

test("forget and deleteAll remove rows and vectors", async () => {
  const { memory, index } = setup()
  const a = await memory.remember("ana", { text: "Has a dog called Biscuit" })
  await memory.remember("ana", { text: "Flies out on the 3rd" })
  await memory.remember("ben", { text: "Has a puppy" })

  assert.equal(await memory.forget("ana", a.id), true)
  assert.equal(await memory.forget("ben", a.id), false)
  assert.ok(!(await memory.exportAll("ana")).some((m) => m.text.includes("Biscuit")))
  assert.ok(!index.ids().includes(a.id))

  assert.equal(await memory.deleteAll("ana"), 1)
  assert.deepEqual(await memory.exportAll("ana"), [])
  assert.equal(index.size(), 1) // only ben's
})

test("a failed embedding keeps the memory; sync adds the vector later", async () => {
  let up = false
  const flaky: Embed = async (text) => (up ? conceptEmbed(text) : [])
  const { memory, index } = setup(flaky)
  await memory.remember("ana", { text: "Takes the 8:15 train to work" })
  assert.equal(index.size(), 0)
  assert.equal((await memory.recall("ana", "train")).length, 1, "keywords still find it")

  up = true
  assert.equal(await memory.sync(), 1)
  assert.equal(index.size(), 1)
  assert.equal(await memory.sync(), 0)
})

test("an embedder that throws doesn't break recall", async () => {
  const broken: Embed = async () => {
    throw new Error("model busy")
  }
  const { memory } = setup(broken)
  await memory.remember("ana", { text: "Birthday is 14 March" })
  const out = await memory.recall("ana", "birthday")
  assert.equal(out.length, 1)
  assert.deepEqual(out[0]!.via, ["keyword", "exact"])
})

test("recent memories win near-ties", async () => {
  const { memory, tick } = setup(async () => [])
  await memory.remember("ana", { text: "Gym on Monday" })
  tick(200 * DAY)
  await memory.remember("ana", { text: "Gym on Tuesday" })
  const out = await memory.recall("ana", "gym")
  assert.equal(out[0]!.text, "Gym on Tuesday")
})

test("user text can't inject FTS5 or LIKE syntax", async () => {
  const { memory } = setup()
  await memory.remember("ana", { text: "Discount code is 50%_OFF" })
  await memory.remember("ana", { text: "Something else entirely" })
  assert.equal((await memory.recall("ana", 'NEAR(") OR * -')).length, 0)
  const exact = await memory.recall("ana", "50%_OFF")
  assert.equal(exact.length, 1)
  // "%" is a literal, not a wildcard: only the memory that contains one matches.
  const percent = await memory.recall("ana", "%")
  assert.deepEqual(
    percent.map((m) => m.text),
    ["Discount code is 50%_OFF"],
  )
})

test("ftsQuery quotes words and drops filler", () => {
  assert.equal(ftsQuery("What is my coffee order?"), '"coffee"* OR "order"*')
  assert.equal(ftsQuery("the of a"), null)
  assert.equal(ftsQuery('"coffee" OR NEAR(x'), '"coffee"* OR "near"*')
})

test("rrf rewards items several lists agree on", () => {
  const out = rrf({ vector: ["a", "b", "c"], keyword: ["c", "d"], exact: ["c"] })
  assert.equal(out[0]!.id, "c")
  assert.deepEqual(out[0]!.via, ["vector", "keyword", "exact"])
  assert.ok(Math.abs(out.find((x) => x.id === "a")!.score - 1 / 61) < 1e-12)
})

test("workersAiEmbed reads the first vector and fails soft", async () => {
  const ok = workersAiEmbed({ run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }) })
  assert.deepEqual(await ok("hi"), [0.1, 0.2, 0.3])
  const down = workersAiEmbed({
    run: async () => {
      throw new Error("3040: capacity")
    },
  })
  assert.deepEqual(await down("hi"), [])
})
