import type { ReactNode } from 'react';

export type FeedbackTone = 'success' | 'info' | 'warning' | 'error' | 'critical';

export function FeedbackNotice({
  actions,
  className = '',
  description,
  persistent = false,
  title,
  tone = 'info',
}: {
  actions?: ReactNode;
  className?: string;
  description: ReactNode;
  persistent?: boolean;
  title: string;
  tone?: FeedbackTone;
}) {
  const isUrgent = tone === 'error' || tone === 'critical';

  return (
    <section
      aria-live={isUrgent ? 'assertive' : 'polite'}
      className={`feedback-notice is-${tone}${className ? ` ${className}` : ''}`}
      data-persistence={persistent ? 'persistent' : 'transient'}
      role={isUrgent ? 'alert' : 'status'}
    >
      <div className="feedback-notice-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {actions ? <div className="feedback-notice-actions">{actions}</div> : null}
    </section>
  );
}
