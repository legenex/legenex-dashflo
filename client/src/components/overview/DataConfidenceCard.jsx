import React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ShieldCheck, ArrowUpRight, Database, Sparkles } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import PanelSectionHeader from '@/components/overview/PanelSectionHeader';
import CountUpText from '@/components/overview/CountUpText';

// Freshness tone + a 0-100 confidence score based on how long ago a source last synced.
// `dotColor` is a Tailwind bg-* class used by both the pulsing ping ring and the solid dot.
function freshness(date) {
  if (!date) return { cls: 'status-error', bar: '#E5484D', dotColor: 'bg-[#E5484D]', label: 'never', score: 0 };
  const ageH = (Date.now() - new Date(date).getTime()) / 3600000;
  const label = formatDistanceToNow(new Date(date), { addSuffix: true });
  if (ageH <= 6) return { cls: 'status-sold', bar: '#3DD68C', dotColor: 'bg-[#3DD68C]', label, score: 100 };
  if (ageH <= 48) return { cls: 'status-unsold', bar: '#FACC14', dotColor: 'bg-[#FACC14]', label, score: 60 };
  return { cls: 'status-error', bar: '#E5484D', dotColor: 'bg-[#E5484D]', label, score: 25 };
}

const rowVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

// Sync-freshness per money source. `sources` = [{ label, at }].
export default function DataConfidenceCard({ sources }) {
  const fresh = sources.filter(s => s.at && (Date.now() - new Date(s.at).getTime()) / 3600000 <= 6).length;
  return (
    <div className="overflow-hidden">
      <PanelSectionHeader
        icon={ShieldCheck}
        title="Data Confidence — Source Health"
        meta={<CountUpText value={fresh} render={(n) => `${Math.round(n)}/${sources.length} fresh`} />}
      />
      <div className="px-5 pt-3 text-[11px] text-muted-foreground">Live observability across all ingestion feeds</div>
      <motion.div
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
        initial="hidden"
        animate="show"
        className="divide-y divide-border mt-1"
      >
        {sources.map(s => {
          const t = freshness(s.at);
          return (
            <motion.div key={s.label} variants={rowVariants} className="px-5 py-2.5 flex items-center gap-3 text-[13px]">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${t.dotColor}`} />
                <span className={`relative inline-flex rounded-full h-2 w-2 ${t.dotColor}`} />
              </span>
              <Database className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="w-[120px] shrink-0 text-foreground truncate">{s.label}</span>
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: t.bar }}
                  initial={{ width: 0 }}
                  animate={{ width: `${t.score}%` }}
                  transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">
                last sync <span className={`font-mono ${t.cls}`}>{t.label}</span>
              </span>
            </motion.div>
          );
        })}
      </motion.div>

      <div className="px-5 pt-3">
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5 text-[12px] leading-snug text-foreground flex items-start gap-2">
          <Sparkles className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold text-primary">AI interpretation:</span> Confidence is limited — most feeds are stale or disconnected, so status counts and financials can't yet be fully trusted. Connect and sync the sources below to restore reliable observability.
          </span>
        </div>
      </div>

      <div className="px-5 py-3">
        <Link
          to="/settings?tab=integrations"
          className="flex w-full items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Manage sources <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
      </div>
    </div>
  );
}