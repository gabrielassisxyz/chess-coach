import type { GameSummary } from "@chess-coach/shared";
import {
  dateLabel,
  lossLabel,
  markOf,
  type Outcome,
  opponentLabel,
  outcomeOf,
  playedAt,
  plyLabel,
  RESULT_GLYPH,
  SOURCE_TAG,
  type Totals,
} from "../state/games.js";
import { CLASSIFICATION_LABEL } from "../state/play.js";

const OUTCOME_WORD: Record<Outcome, string> = { won: "won", lost: "lost", drawn: "drawn" };

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function Accuracy({ game }: { game: GameSummary }) {
  if (game.grading === "pending" || game.grading === "running") return <>grading</>;
  if (game.accuracy === null) return <>not graded</>;
  return <>{`${Math.round(game.accuracy * 100)}%`}</>;
}

function WorstMoment({ game }: { game: GameSummary }) {
  const worst = game.worst_moment ?? null;
  if (!worst) return <span className="games__none">–</span>;
  return (
    <span className="games__worst" title={CLASSIFICATION_LABEL[worst.classification]}>
      <span className={`games__mark games__mark--${worst.classification}`}>
        {markOf(worst.classification)}
      </span>
      {` ${plyLabel(worst.ply, worst.san)} · ${lossLabel(worst.cp_loss)}`}
    </span>
  );
}

interface GamesTableProps {
  games: GameSummary[];
  totals: Totals;
  onOpen(id: number): void;
}

export function GamesTable({ games, totals, onOpen }: GamesTableProps) {
  return (
    <div className="games__table-wrap">
      <table className="games__table" aria-label="Finished games">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Opponent</th>
            <th scope="col">You</th>
            <th scope="col">Result</th>
            <th scope="col" className="games__num">
              Moves
            </th>
            <th scope="col" className="games__num">
              Accuracy
            </th>
            <th scope="col">Worst moment</th>
            <th scope="col" className="games__num">
              Cards
            </th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => {
            const outcome = outcomeOf(game);
            const graded = game.grading === "done";
            return (
              <tr
                key={game.id}
                className="games__row"
                tabIndex={0}
                onDoubleClick={() => onOpen(game.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target === event.currentTarget) {
                    onOpen(game.id);
                  }
                }}
              >
                <td className="games__date">{dateLabel(playedAt(game))}</td>
                <td>
                  <span className="games__opponent">
                    <span className="games__name">{opponentLabel(game)}</span>
                    <span className="games__tag">{SOURCE_TAG[game.source]}</span>
                  </span>
                </td>
                <td className="games__side">{capitalised(game.player_color)}</td>
                <td>
                  {game.result && outcome ? (
                    <span className={`games__result games__result--${outcome}`}>
                      {RESULT_GLYPH[game.result]}
                      <span className="games__outcome-word">{` ${OUTCOME_WORD[outcome]}`}</span>
                    </span>
                  ) : (
                    <span className="games__none">–</span>
                  )}
                </td>
                <td className="games__num">{game.move_count}</td>
                <td className="games__num">
                  <Accuracy game={game} />
                </td>
                <td>
                  {graded ? <WorstMoment game={game} /> : <span className="games__none">–</span>}
                </td>
                <td className="games__num">{graded ? (game.cards_count ?? 0) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="games__footer" data-testid="games-footer">
        {`${totals.games} ${totals.games === 1 ? "game" : "games"} · ${totals.won} won · ${totals.lost} lost · ${totals.drawn} drawn`}
        {totals.averageAccuracy === null ? "" : ` · average accuracy ${totals.averageAccuracy}%`}
        <span className="games__hint"> · Enter or double-click opens a game</span>
      </p>
    </div>
  );
}
