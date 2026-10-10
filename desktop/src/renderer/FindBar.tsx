import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { FindResult } from '../shared/types';
import { api } from './api';

/** Find in page: a row under the toolbar. */
export function FindBar({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);

  useEffect(() => {
    input.current?.focus();
    return api.on('find-result', setResult);
  }, []);

  const find = (value: string, forward: boolean, next: boolean) => {
    if (!value) setResult(null);
    void api.findInPage(value, forward, next);
  };

  return (
    <div className="findbar" role="search">
      <input
        ref={input}
        className="find-input"
        aria-label="Find in page"
        placeholder="Find in page"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          find(event.target.value, true, false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') find(text, !event.shiftKey, true);
          else if (event.key === 'Escape') onClose();
        }}
      />
      <span className="find-count muted" aria-live="polite">
        {text && result ? (result.count > 0 ? `${result.active} of ${result.count}` : 'No results') : ''}
      </span>
      <button className="icon-button small" aria-label="Previous result" disabled={!text} onClick={() => find(text, false, true)}>
        <ChevronUp size={16} />
      </button>
      <button className="icon-button small" aria-label="Next result" disabled={!text} onClick={() => find(text, true, true)}>
        <ChevronDown size={16} />
      </button>
      <button className="icon-button small" aria-label="Close find bar" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
