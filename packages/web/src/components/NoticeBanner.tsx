export interface NoticeBannerProps {
  message: string | null;
  onDismiss(): void;
}

export function NoticeBanner({ message, onDismiss }: NoticeBannerProps) {
  if (!message) return null;
  return (
    <div className="banner" role="alert">
      <span>{message}</span>
      <button type="button" className="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
