import React, { useState, useRef, useEffect } from 'react';
import { dataBot } from '@/functions/dataBot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, X, Send, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

const SUGGESTIONS = [
  'How many leads sold today?',
  'Which supplier has the best conversion?',
  'Summarize my ad spend vs revenue',
  'How many bank transactions are unmatched?',
];

export default function DataBotWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "Hi, I'm **DataBot**. Ask me anything about your leads, ad insights, reconciliation or performance." },
  ]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, open]);

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    const next = [...messages, { role: 'user', content: question }];
    setMessages(next);
    setInput('');
    setBusy(true);
    try {
      const res = await dataBot({ question, history: next.slice(-8) });
      const answer = res?.data?.answer || res?.data?.error || 'Sorry, I could not answer that.';
      setMessages(m => [...m, { role: 'assistant', content: answer }]);
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', content: 'Something went wrong reaching DataBot. Please try again.' }]);
    }
    setBusy(false);
  };

  return (
    <div className="fixed bottom-[calc(72px+env(safe-area-inset-bottom))] right-5 lg:bottom-5 z-[60]">
      {open && (
        <div className="mb-3 w-[380px] max-w-[calc(100vw-2.5rem)] h-[520px] max-h-[calc(100vh-6rem)] bg-popover border border-border rounded-[16px] shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center"><Bot className="w-4.5 h-4.5 text-primary" /></div>
              <div>
                <div className="text-[14px] font-semibold text-foreground leading-tight">DataBot</div>
                <div className="text-[11px] text-muted-foreground leading-tight">Answers from your data + knowledge base</div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`max-w-[85%] rounded-[12px] px-3 py-2 text-[13px] ${m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border text-foreground'}`}>
                  {m.role === 'user'
                    ? m.content
                    : <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0"><ReactMarkdown>{m.content}</ReactMarkdown></div>}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start"><div className="bg-card border border-border rounded-[12px] px-3 py-2 text-[13px] text-muted-foreground inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Thinking…</div></div>
            )}
            {messages.length === 1 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => send(s)} className="text-[11px] px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">{s}</button>
                ))}
              </div>
            )}
          </div>

          <div className="p-3 border-t border-border bg-card">
            <div className="flex items-center gap-2">
              <Input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') send(); }}
                placeholder="Ask about your data…"
                className="bg-background text-[13px]"
                disabled={busy}
              />
              <Button size="icon" onClick={() => send()} disabled={busy || !input.trim()} className="shrink-0 h-9 w-9"><Send className="w-4 h-4" /></Button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen(o => !o)}
        className="w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-2xl flex items-center justify-center hover:scale-105 transition-transform ml-auto"
        aria-label="Open DataBot"
      >
        {open ? <X className="w-6 h-6" /> : <Bot className="w-6 h-6" />}
      </button>
    </div>
  );
}