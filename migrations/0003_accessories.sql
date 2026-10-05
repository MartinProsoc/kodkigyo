-- Tekla kiegészítői (sapka, szemüveg…), vesszővel elválasztva, pl. "glasses,crown".
-- A többi játékos is látja őket a ligában és a barátlistán.
ALTER TABLE players ADD COLUMN acc TEXT NOT NULL DEFAULT '';
