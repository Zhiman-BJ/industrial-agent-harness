import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useDisplayText } from '@industrial-agent-harness/viewer-builtin/text';

export function MessageActions({ text, recordedAt }: { text: string; recordedAt?: string }) {
  const { t, locale } = useDisplayText();
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const copying = useRef(false);
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const date = recordedAt ? new Date(recordedAt) : undefined;
  const validDate = date && Number.isFinite(date.getTime()) ? date : undefined;
  const label = status === 'copied' ? t('Message copied') : t('Copy message');

  async function copy() {
    if (copying.current || !text) return;
    copying.current = true;
    clearTimeout(reset.current);
    setStatus('copying');
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
      reset.current = setTimeout(() => setStatus('idle'), 1800);
    } catch {
      setStatus('error');
    } finally {
      copying.current = false;
    }
  }

  return (
    <div className="ia-message-actions" data-copy-status={status}>
      {status === 'error' && (
        <span className="ia-message-copy-error">{t('Copy failed. Try again.')}</span>
      )}
      {validDate && (
        <time dateTime={validDate.toISOString()} title={validDate.toLocaleString(locale)}>
          {validDate.toLocaleTimeString(locale, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          })}
        </time>
      )}
      <button
        type="button"
        className="ia-message-copy"
        onClick={() => void copy()}
        disabled={!text || status === 'copying'}
        aria-label={label}
        title={label}
      >
        {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <span className="ia-sr-only" role="status">
        {status === 'copied'
          ? t('Message copied')
          : status === 'error'
            ? t('Copy failed. Try again.')
            : ''}
      </span>
    </div>
  );
}
