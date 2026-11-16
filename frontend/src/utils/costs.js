// Subtract stored DECIMAL(30,12) amounts exactly before currency formatting.
export function savedCost(original, actual) {
  const units = value => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1000000000000n + BigInt(fraction.padEnd(12, '0'));
  };
  const difference = units(original) - units(actual);
  const absolute = difference < 0n ? -difference : difference;
  return {
    amount: `${difference < 0n ? '-' : ''}${absolute / 1000000000000n}.${String(absolute % 1000000000000n).padStart(12, '0')}`,
    positive: difference > 0n,
  };
}
