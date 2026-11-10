-- How deep the engine looked for the evaluation of a White move. A search that passes its time cap
-- is stopped and keeps the best line it had reached, so two moves' eval_cp and cp_loss are not always
-- measured at the same depth, and this column says which depth each one was. It is null where the
-- depth is not known, which is every row stored before the column existed. Added as a column alone:
-- no rebuild of repertoire_positions, so no row, id or index moves.
ALTER TABLE repertoire_positions ADD COLUMN eval_depth INTEGER;
