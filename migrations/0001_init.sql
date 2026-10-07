
CREATE TABLE players (
  id          TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  nick        TEXT NOT NULL,
  code        TEXT NOT NULL UNIQUE,
  class_id    TEXT,
  league      INTEGER NOT NULL DEFAULT 0,
  xp          INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_day    TEXT,
  lessons     INTEGER NOT NULL DEFAULT 0,
  ach         INTEGER NOT NULL DEFAULT 0,
  skin        TEXT NOT NULL DEFAULT 'classic',
  last_result TEXT,
  seeded      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  stats_at    INTEGER NOT NULL
);
CREATE INDEX players_class ON players (class_id);
CREATE INDEX players_updated ON players (updated_at);

CREATE TABLE weekly (
  player_id TEXT NOT NULL,
  week_key  TEXT NOT NULL,
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
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE class_weeks (
  class_id TEXT NOT NULL,
  week_key TEXT NOT NULL,
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (class_id, week_key)
);

CREATE TABLE progress (
  player_id  TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter   TEXT NOT NULL,
  target     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE rate (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
