import React, { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { LEAD_STATUS, LEAD_STATUS_LABEL, resolveLeadStatus } from '@/lib/leadStatus';

// Stacked bar chart of leads per day by lead_status over the period. Styling
// matches the existing ComposedChart on the Overview page (tick colors, tooltip
// contentStyle, fonts). Reads the passed period-filtered leads only.
// Seven-value vocabulary (forge-pack/CONTRACT.md D1): Processing, Duplicate
// and Error no longer have their own bar; D4 collapses them into Queued
// (Processing, Error) or Rejected (Duplicate).
const STATUS_COLORS = {
  [LEAD_STATUS.SOLD]: '#3DD68C',
  [LEAD_STATUS.UNSOLD]: '#FACC14',
  [LEAD_STATUS.DISQUALIFIED]: '#F97316',
  [LEAD_STATUS.QUEUED]: '#7564CC',
  [LEAD_STATUS.RETURNED]: '#FFB082',
  [LEAD_STATUS.REJECTED]: '#3182BD',
  [LEAD_STATUS.CONVERTED]: '#60A5FA',
};
const STATUS_ORDER = [
  LEAD_STATUS.SOLD, LEAD_STATUS.UNSOLD, LEAD_STATUS.DISQUALIFIED, LEAD_STATUS.QUEUED,
  LEAD_STATUS.RETURNED, LEAD_STATUS.REJECTED, LEAD_STATUS.CONVERTED,
];

export default function LeadVolumeByStatus({ leads = [] }) {
  const data = useMemo(() => {
    const byDay = {};
    for (const l of leads) {
      if (!l.created_date) continue;
      const day = String(l.created_date).slice(0, 10);
      if (!byDay[day]) byDay[day] = { date: day };
      const s = resolveLeadStatus(l) || LEAD_STATUS.QUEUED;
      byDay[day][s] = (byDay[day][s] || 0) + 1;
    }
    return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  }, [leads]);

  const presentStatuses = useMemo(() => {
    const set = new Set();
    for (const row of data) {
      for (const k of Object.keys(row)) if (k !== 'date') set.add(k);
    }
    return STATUS_ORDER.filter(s => set.has(s));
  }, [data]);

  if (data.length === 0) {
    return <div className="h-[260px] flex items-center justify-center text-[13px] text-muted-foreground">No leads in this period</div>;
  }

  return (
    <div className="p-5">
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data}>
          <XAxis dataKey="date" tick={{ fill: '#8B95A8', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={{ fill: '#8B95A8', fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
          <Tooltip contentStyle={{ backgroundColor: '#182030', border: '1px solid #243044', borderRadius: '8px', fontSize: 12 }} labelStyle={{ color: '#EEF2F8' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {presentStatuses.map(s => (
            <Bar key={s} dataKey={s} name={LEAD_STATUS_LABEL[s] || s} stackId="a" fill={STATUS_COLORS[s] || '#8B95A8'} maxBarSize={22} animationDuration={800} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}