import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';

interface CodeBlockProps {
  /** The exact text rendered and copied. */
  code: string;
  /** Small caption above the block (e.g. a filename or "Terminal"). */
  title?: string;
  /** Toast label / aria text for the copy action. */
  copyLabel?: string;
  className?: string;
}

/**
 * A copy-to-clipboard code/snippet block. Used by the MCP docs tab for install
 * commands, config snippets, and paste-into-your-agent prompts. Mono (Maple)
 * type per the canonical four-font stack; reuses the shared copyToClipboard
 * (which toasts) and shows a transient check on success.
 */
export function CodeBlock({ code, title, copyLabel = 'Snippet', className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending reset timer on unmount (avoids set-state-after-unmount).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    await copyToClipboard(code, copyLabel);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={className}>
      {title && <p className="mb-1 font-inter text-tiny font-medium text-charcoal-500">{title}</p>}
      <div className="group relative">
        <pre
          className="
            overflow-x-auto rounded-lg border border-charcoal-100 bg-charcoal-50/70 p-3 pr-11
            font-mono text-tiny leading-relaxed text-charcoal-800
          "
        >
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy ${copyLabel.toLowerCase()}`}
          title="Copy"
          className="
            absolute top-2 right-2 rounded-md p-1.5 text-charcoal-500 opacity-70
            transition
            hover:bg-blue-50 hover:text-blue-600 hover:opacity-100
            focus:opacity-100
          "
        >
          {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}
