import type { RatingPreview } from "@chess-coach/shared";
import { useEffect } from "react";
import { formatInterval, RATING_WORDS } from "../state/practice.js";

const QUALITIES = [0, 1, 2, 3, 4, 5] as const;

export interface RatingButtonsProps {
  preview: RatingPreview;
  // Pre-selected from how the first try went; the student can still pick any other grade.
  suggested?: number | null;
  onRate(quality: number): void;
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
      const quality = QUALITIES.find((value) => String(value) === event.key);
      if (quality !== undefined) onRate(quality);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRate]);

  return (
    <fieldset className="practice__rating" aria-label="Rate your recall">
      <legend className="practice__rating-title">How well did you know it?</legend>
      <p className="practice__rating-note">
        Sets when the card comes back. Keys 0 to 5 rate
        {suggested === null ? "." : `; Enter takes the suggested ${suggested}.`}
      </p>
      {QUALITIES.map((quality) => (
        <button
          key={quality}
          type="button"
          className={`button practice__grade${quality === suggested ? " practice__grade--suggested" : ""}`}
          aria-pressed={quality === suggested}
          // biome-ignore lint/a11y/noAutofocus: the suggested grade takes focus so Enter confirms it
          autoFocus={quality === suggested}
          onClick={() => onRate(quality)}
        >
          <span className="practice__grade-key">{quality}</span>
          <span className="practice__grade-word">{RATING_WORDS[quality]}</span>
          <span className="practice__grade-days">
            {formatInterval(preview[`${quality}` as keyof RatingPreview])}
          </span>
        </button>
      ))}
    </fieldset>
  );
}
