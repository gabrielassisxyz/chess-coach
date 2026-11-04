import type { ServiceNotice } from "../state/health.js";

export interface ServiceBannerProps {
  notice: ServiceNotice | null;
}

export function ServiceBanner({ notice }: ServiceBannerProps) {
  if (!notice) return null;
  return (
    <div className="banner" role="note" aria-label="Server status" data-reason={notice.reason}>
      <span>{notice.message}</span>
    </div>
  );
}
