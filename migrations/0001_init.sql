-- Kódkígyó adatbázis (Cloudflare D1, SQLite)

-- Névtelen fiókok: becenév + titkos kulcs (csak a hash-ét tároljuk).
CREATE TABLE players (
  id          TEXT PRIMARY KEY,          -- nyilvános azonosító, 8 karakter
  secret_hash TEXT NOT NULL,             -- a belépőkód titkos részének SHA-256 hash-e
  nick        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,      -- barátkód, 6 karakter
  class_id    TEXT,
  league      INTEGER NOT NULL DEFAULT 0,
  xp          INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_day    TEXT,
  lessons     INTEGER NOT NULL DEFAULT 0,
  ach         INTEGER NOT NULL DEFAULT 0,
  skin        TEXT NOT NULL DEFAULT 'classic',
  last_result TEXT,                      -- JSON: az utolsó lezárt hét ligaeredménye
  seeded      INTEGER NOT NULL DEFAULT 0, -- 1, ha már megjött az első statisztika-szinkron
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  stats_at    INTEGER NOT NULL
);
CREATE INDEX players_class ON players (class_id);
CREATE INDEX players_updated ON players (updated_at);

-- Heti XP hetenként, a ligazáráshoz (8 hétig őrizzük).
CREATE TABLE weekly (
  player_id TEXT NOT NULL,
  week_key  TEXT NOT NULL,               -- a hét hétfője, pl. 2026-09-28
  xp        INTEGER NOT NULL,
  PRIMARY KEY (player_id, week_key)
);
CREATE INDEX weekly_week ON weekly (week_key);

CREATE TABLE follows (
  follower   TEXT NOT NULL,
  followee   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower, followee)
);
CREATE INDEX follows_followee ON follows (followee);

CREATE TABLE classes (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,       -- osztálykód, 6 karakter
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Melyik osztály melyik hetét zártuk már le.
CREATE TABLE class_weeks (
  class_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (class_id, week_key)
);

-- A haladás online mentése (csak a tulajdonosa olvassa).
CREATE TABLE progress (
  player_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Jelentések a becenevekről (90 napig őrizzük).
CREATE TABLE reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter   TEXT NOT NULL,
  target     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Egyszerű sebességkorlát (az IP-címnek csak a hash-ét tároljuk, legfeljebb 1 óráig).
CREATE TABLE rate (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
