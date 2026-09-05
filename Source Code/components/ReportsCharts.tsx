import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Legend } from 'recharts';

export interface GrowthChartRow {
  name: string;
  'Avg AUM %': number;
  'Brokerage %': number;
}

interface Props {
  data: GrowthChartRow[];
  height?: number;
}

/**
 * Wraps the recharts BarChart used on the Reports → Growth tab.
 * Lives in its own file so the ~150KB recharts bundle is code-split via
 * `lazy(() => import('./ReportsCharts'))` from Reports.tsx, keeping it off
 * the main Reports chunk for users who never visit the Growth tab.
 */
const ReportsCharts: React.FC<Props> = ({ data, height = 320 }) => {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 60 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
        <YAxis tick={{ fontSize: 10 }} unit="%" />
        <RTooltip formatter={(v: number) => `${v}%`} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="Avg AUM %" fill="#60a5fa" />
        <Bar dataKey="Brokerage %" fill="#10b981" />
      </BarChart>
    </ResponsiveContainer>
  );
};

export default ReportsCharts;
