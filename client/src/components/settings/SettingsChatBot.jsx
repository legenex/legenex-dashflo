import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { usePermissions } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, Trash2, BookOpen, FileText, StickyNote, MessageSquareText, Brain, Database, Sparkles, History, Zap } from 'lucide-react';
import { toast } from 'sonner';

const KIND_META = {
  doc: { label: 'Document', icon: FileText },
  note: { label: 'Note', icon: StickyNote },
  glossary: { label: 'Glossary term', icon: BookOpen },
  template: { label: 'Disposition template', icon: MessageSquareText },
};

const empty = { title: '', kind: 'doc', term: '', content: '', active: true, sort_order: 0 };

function KnowledgeBaseTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);

  const { data: docs = [] } = useQuery({
    queryKey: ['knowledge-docs'],
    queryFn: () => api.entities.KnowledgeDoc.list('sort_order'),
  });

  const openNew = () => { setForm({ ...empty, sort_order: docs.length }); setOpen(true); };
  const openEdit = (d) => { setForm({ ...empty, ...d }); setOpen(true); };

  const save = async () => {
    if (!form.title.trim()) { toast.error('Title is required'); return; }
    const { id, ...rest } = form;
    if (id) await api.entities.KnowledgeDoc.update(id, rest);
    else await api.entities.KnowledgeDoc.create(rest);
    qc.invalidateQueries({ queryKey: ['knowledge-docs'] });
    setOpen(false);
    toast.success('Saved');
  };

  const remove = async (d) => {
    await api.entities.KnowledgeDoc.delete(d.id);
    qc.invalidateQueries({ queryKey: ['knowledge-docs'] });
    toast.success('Removed');
  };

  const toggle = async (d) => {
    await api.entities.KnowledgeDoc.update(d.id, { active: !d.active });
    qc.invalidateQueries({ queryKey: ['knowledge-docs'] });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[13px] text-muted-foreground max-w-2xl">
          Add documents, notes, glossary terms and disposition/feedback templates. The chatbot reads every active item as context when answering questions.
        </div>
        <Button size="sm" onClick={openNew} className="gap-1.5 shrink-0"><Plus className="w-4 h-4" /> Add Item</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {docs.length === 0 && (
          <div className="col-span-full text-center text-muted-foreground text-[13px] py-10 border border-dashed border-border rounded-[12px]">
            No knowledge items yet. Add docs, notes, glossary terms or templates for the chatbot to use.
          </div>
        )}
        {docs.map(d => {
          const meta = KIND_META[d.kind] || KIND_META.doc;
          const Icon = meta.icon;
          return (
            <div key={d.id} className={`bg-card border border-border rounded-[12px] p-4 ${d.active ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Icon className="w-4.5 h-4.5 text-primary" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button onClick={() => openEdit(d)} className="text-[14px] font-semibold text-foreground truncate hover:underline text-left">{d.kind === 'glossary' && d.term ? d.term : d.title}</button>
                    <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">{meta.label}</Badge>
                  </div>
                  <div className="text-[12px] text-muted-foreground mt-1 line-clamp-3 whitespace-pre-wrap">{d.content || '—'}</div>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Switch checked={d.active} onCheckedChange={() => toggle(d)} />
                  <button onClick={() => remove(d)} className="text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-popover border-border max-w-[520px]">
          <DialogHeader><DialogTitle>{form.id ? 'Edit' : 'Add'} Knowledge Item</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-[12px]">Type</Label>
              <Select value={form.kind} onValueChange={v => setForm(p => ({ ...p, kind: v }))}>
                <SelectTrigger className="mt-1 bg-background text-[13px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(KIND_META).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {form.kind === 'glossary' && (
              <div><Label className="text-[12px]">Term</Label><Input value={form.term} onChange={e => setForm(p => ({ ...p, term: e.target.value }))} placeholder="e.g. CPL" className="mt-1 bg-background text-[13px]" /></div>
            )}
            <div><Label className="text-[12px]">Title</Label><Input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="Short title" className="mt-1 bg-background text-[13px]" /></div>
            <div><Label className="text-[12px]">{form.kind === 'glossary' ? 'Definition' : 'Content'}</Label><Textarea value={form.content} onChange={e => setForm(p => ({ ...p, content: e.target.value }))} rows={6} placeholder="What the chatbot should know…" className="mt-1 bg-background text-[13px]" /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConversationsTab() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(null);

  const { data: conversations = [] } = useQuery({
    queryKey: ['chat-conversations'],
    queryFn: () => api.entities.ChatConversation.filter({ active: true }, '-last_message_at', 50),
  });

  const archive = async (c) => {
    await api.entities.ChatConversation.update(c.id, { active: false });
    qc.invalidateQueries({ queryKey: ['chat-conversations'] });
    toast.success('Conversation archived');
  };

  const fmtTime = (ts) => {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ts; }
  };

  return (
    <div>
      <div className="text-[13px] text-muted-foreground mb-4">
        Your conversation history. The chatbot remembers past conversations to provide continuity and context.
      </div>
      {conversations.length === 0 ? (
        <div className="text-center text-muted-foreground text-[13px] py-10 border border-dashed border-border rounded-[12px]">
          No conversations yet. Start chatting with DataBot to see your history here.
        </div>
      ) : (
        <div className="space-y-2">
          {conversations.map(c => {
            let msgs = [];
            try { msgs = JSON.parse(c.messages || '[]'); } catch {}
            const isExpanded = expanded === c.id;
            return (
              <div key={c.id} className="bg-card border border-border rounded-[12px] overflow-hidden">
                <button
                  onClick={() => setExpanded(isExpanded ? null : c.id)}
                  className="w-full text-left px-4 py-3 hover:bg-accent/40 transition-colors flex items-center gap-3"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    {c.mode === 'build' ? <Zap className="w-4 h-4 text-primary" /> : <Database className="w-4 h-4 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-foreground truncate">{c.title || 'Untitled conversation'}</div>
                    <div className="text-[11px] text-muted-foreground">{c.message_count} messages · {fmtTime(c.last_message_at)}</div>
                  </div>
                  <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">{c.mode === 'build' ? 'BuildBot' : 'DataBot'}</Badge>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-3 space-y-1.5 max-h-[300px] overflow-y-auto border-t border-border pt-3">
                    {msgs.map((m, i) => (
                      <div key={i} className={`text-[12px] ${m.role === 'user' ? 'text-foreground' : 'text-muted-foreground'}`}>
                        <span className="font-medium text-[10px] uppercase tracking-wide mr-2">{m.role === 'user' ? 'You' : c.mode === 'build' ? 'BuildBot' : 'DataBot'}</span>
                        <span className="whitespace-pre-wrap">{typeof m.content === 'string' ? m.content.slice(0, 500) : ''}</span>
                      </div>
                    ))}
                    <button onClick={() => archive(c)} className="text-[11px] text-muted-foreground hover:text-destructive mt-2">Archive</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MemoriesTab() {
  const qc = useQueryClient();

  const { data: memories = [] } = useQuery({
    queryKey: ['chat-memories'],
    queryFn: () => api.entities.ChatMemory.filter({ active: true }, '-created_date', 100),
  });

  const dismiss = async (m) => {
    await api.entities.ChatMemory.update(m.id, { active: false });
    qc.invalidateQueries({ queryKey: ['chat-memories'] });
    toast.success('Memory dismissed');
  };

  const categoryColor = {
    preference: 'bg-blue-500/10 text-blue-400',
    business_rule: 'bg-primary/10 text-primary',
    data_insight: 'bg-emerald-500/10 text-emerald-400',
    definition: 'bg-purple-500/10 text-purple-400',
    other: 'bg-muted text-muted-foreground',
  };

  return (
    <div>
      <div className="text-[13px] text-muted-foreground mb-4">
        Facts and preferences the chatbot has learned from your conversations. These are used as context to give you better, more personalized answers over time.
      </div>
      {memories.length === 0 ? (
        <div className="text-center text-muted-foreground text-[13px] py-10 border border-dashed border-border rounded-[12px]">
          No learned memories yet. The chatbot will extract and remember useful facts as you chat.
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map(m => (
            <div key={m.id} className="bg-card border border-border rounded-[12px] p-3 flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Brain className="w-4 h-4 text-primary" /></div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-foreground">{m.fact}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${categoryColor[m.category] || categoryColor.other}`}>{(m.category || 'other').replace('_', ' ')}</span>
                  {m.times_referenced > 0 && <span className="text-[10px] text-muted-foreground">Used {m.times_referenced}x</span>}
                </div>
              </div>
              <button onClick={() => dismiss(m)} className="text-muted-foreground hover:text-destructive shrink-0"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: 'conversations', label: 'Conversations', icon: History },
  { key: 'memories', label: 'Memories', icon: Brain },
  { key: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
];

export default function SettingsChatBot() {
  const { can } = usePermissions();
  const [tab, setTab] = useState('conversations');

  const showData = can('databot');
  const showBuild = can('buildbot');

  return (
    <div>
      <div className="mb-5 rounded-[12px] border border-border bg-card p-4 flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Sparkles className="w-5 h-5 text-primary" /></div>
        <div className="flex-1">
          <div className="text-[14px] font-semibold text-foreground">AI Assistant</div>
          <div className="text-[12px] text-muted-foreground mt-0.5">
            DataBot {showData ? <span className="status-sold">enabled</span> : <span className="status-error">disabled</span>}
            {' · '}
            BuildBot {showBuild ? <span className="status-sold">enabled</span> : <span className="status-error">disabled</span>}
          </div>
          <div className="text-[11px] text-muted-foreground/70 mt-1">
            The chatbot learns from every conversation and remembers facts across sessions. Use the tabs below to review conversations, manage learned memories, and add knowledge base context.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 mb-5 border-b border-border">
        {TABS.map(t => {
          const Icon = t.icon;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium border-b-2 transition-colors ${
                isActive ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'conversations' && <ConversationsTab />}
      {tab === 'memories' && <MemoriesTab />}
      {tab === 'knowledge' && <KnowledgeBaseTab />}
    </div>
  );
}