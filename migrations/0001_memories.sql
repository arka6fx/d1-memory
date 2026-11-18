-- Long-term memories, one row per fact, scoped by owner.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  text TEXT NOT NULL,
  -- Optional key for facts that replace each other ("home_city", "coffee_order").
  topic TEXT,
  -- Who it came from: 'user' (the person said it), 'agent' (the agent inferred it from
  -- the person), 'outside' (saved after reading a page, an email, app data).
  source TEXT NOT NULL DEFAULT 'user',
  -- 'active', or 'superseded' once a newer memory on the same topic replaced it.
  status TEXT NOT NULL DEFAULT 'active',
  replaced_by TEXT,
  -- 1 once its vector is in the index (sync() fills in the rest).
  embedded INTEGER NOT NULL DEFAULT 0,
  -- Unix ms after which recall leaves it out (a trip next week, a temporary address).
  forget_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_owner ON memories (owner, status);
CREATE INDEX IF NOT EXISTS memories_topic ON memories (owner, topic) WHERE topic IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_unembedded ON memories (embedded) WHERE embedded = 0;

-- Keyword search. External content: the text lives once, in memories.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content = 'memories',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts (rowid, text) VALUES (new.rowid, new.text);
END;
