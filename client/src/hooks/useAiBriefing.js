import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';

// Fetches an AI briefing for the given summary and caches the last result so it
// does not regenerate on every render. Re-runs only when the signature changes.
export default function useAiBriefing(summary, signature) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const lastSig = useRef(null);

  const run = useCallback(async (force = false) => {
    if (!summary) return;
    if (!force && lastSig.current === signature) return;
    lastSig.current = signature;
    setLoading(true);
    setError('');
    try {
      const res = await api.functions.invoke('overviewBriefing', { summary });
      const briefing = res?.data?.briefing;
      if (briefing) setText(briefing);
      else setError(res?.data?.error || 'No briefing returned.');
    } catch (e) {
      setError('Could not generate the briefing right now.');
    } finally {
      setLoading(false);
    }
  }, [summary, signature]);

  useEffect(() => { run(false); }, [run]);

  return { text, loading, error, refresh: () => run(true) };
}