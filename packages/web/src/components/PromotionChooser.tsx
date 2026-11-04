import type { PromotionPiece } from "@chess-coach/shared";
import { useEffect } from "react";

const GLYPH: Record<"white" | "black", Record<PromotionPiece, string>> = {
  white: { q: "♕", r: "♖", b: "♗", n: "♘" },
  black: { q: "♛", r: "♜", b: "♝", n: "♞" },
};
const NAME: Record<PromotionPiece, string> = {
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
};

export interface PromotionChooserProps {
  to: string;
  pieces: PromotionPiece[];
  orientation: "white" | "black";
  onChoose(piece: PromotionPiece): void;
  onCancel(): void;
}

// The student promotes their own colour, which is the board orientation. The chooser column starts on the destination square and grows toward the board's centre, the
// way the pieces would stand on the files, so it never hangs off the edge.
export function PromotionChooser(props: PromotionChooserProps) {
  const { to, pieces, orientation, onChoose, onCancel } = props;
  const file = to.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(to[1]) - 1;
  const column = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const growsDown = row === 0;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const style = {
    left: `${column * 12.5}%`,
    ...(growsDown ? { top: 0 } : { bottom: 0 }),
  };

  return (
    <div className="promotion" data-testid="promotion-chooser">
      <button
        type="button"
        className="promotion__scrim"
        aria-label="Cancel promotion"
        onClick={onCancel}
      />
      <fieldset
        className="promotion__choices"
        aria-label="Promote to"
        style={{ ...style, flexDirection: growsDown ? "column" : "column-reverse" }}
      >
        {pieces.map((piece) => (
          <button
            key={piece}
            type="button"
            className="promotion__choice"
            aria-label={`Promote to ${NAME[piece]}`}
            onClick={() => onChoose(piece)}
          >
            {GLYPH[orientation][piece]}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
