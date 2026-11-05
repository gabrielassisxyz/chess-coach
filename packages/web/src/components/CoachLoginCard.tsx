export interface CoachLoginCardProps {
  fix: string;
  onCheckAgain(): void;
}

export function CoachLoginCard({ fix, onCheckAgain }: CoachLoginCardProps) {
  return (
    <section className="practice__problem" aria-label="Coach not logged in" role="alert">
      <h3 className="practice__problem-title">The coach session expired</h3>
      <p>Your games, cards and notes are all here. Only the conversation is paused.</p>
      <p className="practice__fix">{fix}</p>
      <div className="controls__row">
        <button type="button" className="button button--primary" onClick={onCheckAgain}>
          Check again
        </button>
      </div>
    </section>
  );
}
