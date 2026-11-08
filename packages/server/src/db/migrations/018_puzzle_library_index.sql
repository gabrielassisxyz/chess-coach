-- The plain listing and the motif counts read every matching row, which is fine for the library
-- and impossible for millions of imported puzzles, so both stay on the library through this index.
CREATE INDEX puzzles_library ON puzzles (motif, id) WHERE source <> 'lichess-db';
