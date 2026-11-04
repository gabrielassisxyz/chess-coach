export interface Schedule {
  interval_hours: number;
  ease_factor: number;
  repetitions: number;
}

export type Quality = 0 | 1 | 2 | 3 | 4 | 5;

export const LADDER_HOURS = [4, 24, 72, 168, 336, 720] as const;
export const INITIAL_EASE = 2.5;
export const EASE_FLOOR = 1.3;
const HOUR_MS = 3_600_000;

export const newSchedule = (): Schedule => ({
  interval_hours: 0,
  ease_factor: INITIAL_EASE,
  repetitions: 0,
});

function nextEase(ease: number, quality: Quality): number {
  const miss = 5 - quality;
  return Math.max(EASE_FLOOR, ease + 0.1 - miss * (0.08 + miss * 0.02));
}

// Past the ladder the interval grows by the ease the card had going into this review.
export function review(card: Schedule, quality: Quality): Schedule {
  const ease_factor = nextEase(card.ease_factor, quality);
  if (quality < 3) return { interval_hours: LADDER_HOURS[0], ease_factor, repetitions: 0 };
  const repetitions = card.repetitions + 1;
  const interval_hours = LADDER_HOURS[repetitions - 1] ?? card.interval_hours * card.ease_factor;
  return { interval_hours, ease_factor, repetitions };
}

export function dueAt(reviewedAt: Date, interval_hours: number): Date {
  return new Date(reviewedAt.getTime() + interval_hours * HOUR_MS);
}
