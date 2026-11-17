import type { RatingPreview } from "@chess-coach/shared";
import { useEffect } from "react";
import { formatInterval, RATING_WORDS } from "../state/practice.js";

// FSRS's four grades, in the order the buttons and the keys run: 1 Again to 4 Easy.
const GRADES = [1, 2, 3, 4] as const;

export interface RatingButtonsProps {
  preview: RatingPreview;
  // Pre-selected from how the first try went; the student can still pick any other grade.
  suggested?: number | null;
  onRate(grade: number): void;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

// Mounted only while a rating is open, so the keys exist exactly as long as the buttons do.
export function RatingButtons({ preview, suggested = null, onRate }: RatingButtonsProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      const grade = GRADES.find((value) => String(value) === event.key);
      if (grade !== undefined) onRate(grade);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRate]);

  return (
    <fieldset className="practice__rating" aria-label="Rate your recall">
      <legend className="practice__rating-title">How well did you know it?</legend>
      <p className="practice__rating-note">
        Sets when the card comes back. Keys 1 to 4 rate
        {suggested === null ? "." : `; Enter takes the suggested ${RATING_WORDS[suggested]}.`}
      </p>
      {GRADES.map((grade) => (
        <button
          key={grade}
          type="button"
          className={`button practice__grade${grade === suggested ? " practice__grade--suggested" : ""}`}
          aria-pressed={grade === suggested}
          // biome-ignore lint/a11y/noAutofocus: the suggested grade takes focus so Enter confirms it
          autoFocus={grade === suggested}
          onClick={() => onRate(grade)}
        >
          <span className="practice__grade-key">{grade}</span>
          <span className="practice__grade-word">{RATING_WORDS[grade]}</span>
          <span className="practice__grade-days">{formatInterval(preview[`${grade}`])}</span>
        </button>
      ))}
    </fieldset>
  );
}
