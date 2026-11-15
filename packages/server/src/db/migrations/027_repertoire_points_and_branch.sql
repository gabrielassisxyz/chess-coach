-- What a variation was built from. The style points that weighed White's candidate moves are kept
-- with the variation, so a page can show them and a rebuild can start from them. A variation built
-- before these columns has none, and the three are null together. Their total is the generator's
-- rule and not the table's, so only the shape is checked here.
--
-- branch_san is the line a variation of the Italian was built at, a JSON list of SAN moves ending on
-- the White move that was forced. No stored row marks that move, so a rebuild could not name its
-- branch again without it. It is null for the first variation of a group and for a unit built from a
-- root, whose root its setup rows already hold.
--
-- Added as columns alone: no row, id or index of repertoires moves.
ALTER TABLE repertoires ADD COLUMN points_effectiveness INTEGER
  CHECK (points_effectiveness IS NULL OR points_effectiveness >= 0);

ALTER TABLE repertoires ADD COLUMN points_soundness INTEGER
  CHECK (points_soundness IS NULL OR points_soundness >= 0);

ALTER TABLE repertoires ADD COLUMN points_learnability INTEGER
  CHECK (points_learnability IS NULL OR points_learnability >= 0)
  CHECK ((points_effectiveness IS NULL) = (points_soundness IS NULL)
    AND (points_soundness IS NULL) = (points_learnability IS NULL));

ALTER TABLE repertoires ADD COLUMN branch_san TEXT
  CHECK (branch_san IS NULL OR (json_valid(branch_san) AND json_type(branch_san) = 'array'));
