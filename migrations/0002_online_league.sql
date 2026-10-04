-- Közös online liga: ligánként hetente legfeljebb 30 fős csoportok.

CREATE TABLE league_groups (
  id         TEXT PRIMARY KEY,
  week_key   TEXT NOT NULL,              -- a hét hétfője, pl. 2026-10-05
  league     INTEGER NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at    INTEGER                     -- a heti zárás ideje; NULL, amíg nincs lezárva
);
CREATE INDEX league_groups_open ON league_groups (week_key, league, size);
CREATE INDEX league_groups_done ON league_groups (done_at, week_key);

ALTER TABLE weekly ADD COLUMN grp TEXT;        -- a heti ligacsoport azonosítója
ALTER TABLE weekly ADD COLUMN league INTEGER;  -- a liga, amelyben ezen a héten versenyez
CREATE INDEX weekly_grp ON weekly (grp);
