import React from 'react';
import { number } from '../api/client';
import { Icon } from './ui';
import { savedCost } from '../utils/costs';

const money = (amount, currency) => new Intl.NumberFormat(undefined, {
  style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 6,
}).format(amount);

export function CostSavings({ usage, loading = false, title = 'Cost Savings' }) {
  const costs = usage?.costs ?? [];
  const comparable = costs.filter(cost => cost.total_reducible_cost != null && cost.actual_reduced_cost != null);
  const savedEvents = usage ? costs.reduce((sum, cost) => sum + Number(cost.saved_events ?? 0), 0) : null;
  return <section className="metric cost-savings">
    <div>{title}<Icon name="chart" size={18} /></div>
    <strong>
      <span className="savings-amount-label">Saved</span>
      {loading ? '…' : comparable.length ? comparable.map((cost, index) => {
      const saved = savedCost(cost.total_reducible_cost, cost.actual_reduced_cost);
      return <React.Fragment key={cost.currency}>{index > 0 && ' + '}<span className={saved.positive ? 'savings-positive' : saved.amount.startsWith('-') ? 'savings-negative' : undefined}>{money(saved.amount, cost.currency)}</span></React.Fragment>;
    }) : '—'}
    </strong>
    <p className="savings-detail">Original cost: {loading ? '…' : comparable.map(cost => money(cost.total_reducible_cost, cost.currency)).join(' + ') || '—'}</p>
    <p className="savings-detail">Actual cost: {loading ? '…' : comparable.map(cost => money(cost.actual_reduced_cost, cost.currency)).join(' + ') || '—'}</p>
    <small>{loading ? '…' : `${number(savedEvents)}/${number(usage?.priced_events)} events saving measures have been applied`}</small>
  </section>;
}
