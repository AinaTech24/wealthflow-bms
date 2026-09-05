import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

interface MonthlyPoint {
  name: string;
  key?: string;
  myNet: number;
}

interface CategoryPoint {
  name: string;
  value: number;
}

/**
 * Revenue area chart for the Dashboard. Carved out so recharts (~104 KB gzipped)
 * is lazy-loaded only when the Dashboard mounts, not as part of the main bundle.
 */
export const RevenueAreaChart: React.FC<{
  data: MonthlyPoint[];
  onPointClick?: (key: string, name: string) => void;
}> = ({ data, onPointClick }) => (
  <ResponsiveContainer width="100%" height="100%">
    <AreaChart
      data={data}
      style={{ cursor: 'pointer' }}
      onClick={(d: any) => {
        const payload = d?.activePayload?.[0]?.payload;
        if (payload?.key && onPointClick) onPointClick(payload.key, payload.name);
      }}
    >
      <defs>
        <linearGradient id="colorMyNet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
          <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
        </linearGradient>
      </defs>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
      <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: 700 }} />
      <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: 700 }} tickFormatter={(val) => `₹${(val / 1000).toFixed(0)}k`} />
      <Tooltip
        formatter={(value: number) => [`₹${value.toLocaleString()}`, 'Commission']}
        contentStyle={{ backgroundColor: 'var(--tw-bg-white, #fff)', borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,0.05)' }}
        labelStyle={{ fontWeight: 800, color: '#1e293b' }}
      />
      <Area type="monotone" dataKey="myNet" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorMyNet)" name="Net Share" />
    </AreaChart>
  </ResponsiveContainer>
);

/**
 * Donut chart for the Dashboard's fund-category breakdown.
 */
export const CategoryPieChart: React.FC<{ data: CategoryPoint[]; colors: string[] }> = ({ data, colors }) => (
  <ResponsiveContainer width="100%" height="100%">
    <PieChart>
      <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
        {data.map((_, index) => (
          <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
        ))}
      </Pie>
      <Tooltip formatter={(value: number) => [`₹${value.toLocaleString()}`, 'Gross']} contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }} />
    </PieChart>
  </ResponsiveContainer>
);

// Default export so React.lazy() can pick up both via destructuring
const DashboardCharts = { RevenueAreaChart, CategoryPieChart };
export default DashboardCharts;
