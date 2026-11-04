import { type FormEvent, useId, useState } from "react";

export const MIN_ELO = 100;
export const MAX_ELO = 3190;
export const DEFAULT_ELO = 600;

export interface NewGameFormProps {
  onStart(color: "white" | "black", elo: number): void;
  onCancel(): void;
}

export function NewGameForm({ onStart, onCancel }: NewGameFormProps) {
  const [color, setColor] = useState<"white" | "black">("white");
  const [elo, setElo] = useState(String(DEFAULT_ELO));
  const value = Number(elo);
  const valid = Number.isInteger(value) && value >= MIN_ELO && value <= MAX_ELO;
  const errorId = useId();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (valid) onStart(color, value);
  };

  return (
    <form className="new-game" role="dialog" aria-label="New game" onSubmit={submit}>
      <fieldset className="new-game__colors">
        <legend>Play as</legend>
        {(["white", "black"] as const).map((option) => (
          <label key={option}>
            <input
              type="radio"
              name="color"
              value={option}
              checked={color === option}
              onChange={() => setColor(option)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <div className="new-game__elo">
        <label className="new-game__elo-field">
          Engine Elo
          <input
            className="input"
            type="number"
            min={MIN_ELO}
            max={MAX_ELO}
            step={1}
            value={elo}
            aria-invalid={!valid}
            aria-describedby={valid ? undefined : errorId}
            onChange={(event) => setElo(event.target.value)}
          />
        </label>
        {valid ? null : (
          <p id={errorId} className="new-game__error" role="alert">
            {`Enter a whole number from ${MIN_ELO} to ${MAX_ELO}.`}
          </p>
        )}
      </div>
      <div className="new-game__actions">
        <button type="submit" className="button button--primary" disabled={!valid}>
          Start
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
