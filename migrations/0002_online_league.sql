
CREATE TABLE league_groups (
  id         TEXT PRIMARY KEY,
  week_key   TEXT NOT NULL,
  league     INTEGER NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at    INTEGER
);
CREATE INDEX league_groups_open ON league_groups (week_key, league, size);
CREATE INDEX league_groups_done ON league_groups (done_at, week_key);

ALTER TABLE weekly ADD COLUMN grp TEXT;
ALTER TABLE weekly ADD COLUMN league INTEGER;
CREATE INDEX weekly_grp ON weekly (grp);
