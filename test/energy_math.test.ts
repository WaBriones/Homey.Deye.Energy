import assert from 'assert';
import { accumulate, cost, cycleEnergy, localDay, resetDayFor, snapshotDay, solarPower, IAccumulator, IDaySnapshots } from '../lib/energy_math';

let n = 0;
const test = (name: string, fn: () => void) => { fn(); n++; console.log('ok  ' + name); };

test('localDay uses the given time zone', () => {
  const d = new Date('2026-11-15T17:30:00Z'); // 01:30 next day in Manila
  assert.strictEqual(localDay(d, 'Asia/Manila'), '2026-11-16');
  assert.strictEqual(localDay(d, 'UTC'), '2026-11-15');
});

test('accumulate: first reading seeds the total, then adds increases', () => {
  let a: IAccumulator | undefined;
  a = accumulate(a, 4.5, '2026-11-15');
  assert.strictEqual(a.total, 4.5);
  a = accumulate(a, 4.7, '2026-11-15');
  a = accumulate(a, 5.0, '2026-11-15');
  assert.strictEqual(a.total, 5.0);
});

test('accumulate: midnight reset keeps counting', () => {
  let a = accumulate(undefined, 6.3, '2026-11-15');
  a = accumulate(a, 0.1, '2026-11-16');
  a = accumulate(a, 1.4, '2026-11-16');
  assert.strictEqual(a.total, 7.7);
});

test('accumulate: reset from a low value on a new day', () => {
  let a = accumulate(undefined, 0.1, '2026-11-15');
  a = accumulate(a, 0, '2026-11-16');
  a = accumulate(a, 0.3, '2026-11-16');
  assert.strictEqual(a.total, 0.4);
});

test('accumulate: small same-day dips are ignored, not double counted', () => {
  let a = accumulate(undefined, 4.5, '2026-11-15');
  a = accumulate(a, 4.4, '2026-11-15');
  assert.strictEqual(a.total, 4.5);
  a = accumulate(a, 4.6, '2026-11-15');
  assert.strictEqual(a.total, 4.6);
});

test('accumulate: missing or invalid readings change nothing', () => {
  let a = accumulate(undefined, 2, '2026-11-15');
  a = accumulate(a, NaN, '2026-11-15');
  a = accumulate(a, -1, '2026-11-15');
  assert.strictEqual(a.total, 2);
  assert.strictEqual(accumulate(undefined, NaN, '2026-11-15').total, 0);
});

test('accumulate: a reset missed while offline is still counted when the value halves', () => {
  let a = accumulate(undefined, 8, '2026-11-15');
  a = accumulate(a, 2, '2026-11-15'); // same local day string but clearly a new counter
  assert.strictEqual(a.total, 10);
});

test('resetDayFor: only near midnight, and picks the day that is starting', () => {
  assert.strictEqual(resetDayFor(new Date('2026-11-15T15:57:00Z'), 'Asia/Manila'), '2026-11-16'); // 23:57 Manila
  assert.strictEqual(resetDayFor(new Date('2026-11-15T16:03:00Z'), 'Asia/Manila'), '2026-11-16'); // 00:03 Manila
  assert.strictEqual(resetDayFor(new Date('2026-11-15T07:00:00Z'), 'Asia/Manila'), null);         // 15:00 Manila
});

// run a sequence of [day, dailyCounter, resetDay] readings the way the device does
const run = (readings: [string, number, (string | null)?][], keep = 400) => {
  let acc: IAccumulator | undefined; let days: IDaySnapshots | undefined;
  for (const [day, daily, resetDay] of readings) {
    const before = acc;
    acc = accumulate(acc, daily, day);
    days = snapshotDay(days, day, before, acc, daily, resetDay ?? null, keep);
  }
  return { acc: acc as IAccumulator, days: days as IDaySnapshots };
};

test('snapshotDay: start-of-day totals across a normal midnight', () => {
  const r = run([['2026-11-15', 4.5], ['2026-11-15', 6.3], ['2026-11-16', 0.1, '2026-11-16'], ['2026-11-16', 1.4]]);
  assert.strictEqual(r.acc.total, 7.7);
  assert.deepStrictEqual(r.days, { '2026-11-15': 0, '2026-11-16': 6.3 });
  assert.strictEqual(cycleEnergy(r.days, r.acc.total, '2026-11-16'), 1.4);
  assert.strictEqual(cycleEnergy(r.days, r.acc.total, '2026-11-15'), 7.7);
});

test('snapshotDay: inverter resets a few minutes after the date changes', () => {
  const r = run([['2026-11-15', 6.3], ['2026-11-16', 6.4, '2026-11-16'], ['2026-11-16', 0.05, '2026-11-16'], ['2026-11-16', 1.0]]);
  assert.strictEqual(r.acc.total, 7.4);
  assert.deepStrictEqual(r.days, { '2026-11-15': 0, '2026-11-16': 6.4 });
  assert.strictEqual(cycleEnergy(r.days, r.acc.total, '2026-11-16'), 1);
});

test('snapshotDay: inverter resets a few minutes before the date changes', () => {
  const r = run([['2026-11-15', 6.3], ['2026-11-15', 0.02, '2026-11-16'], ['2026-11-16', 0.1, '2026-11-16'], ['2026-11-16', 1.0]]);
  assert.strictEqual(r.acc.total, 7.3);
  assert.deepStrictEqual(r.days, { '2026-11-15': 0, '2026-11-16': 6.3 });
  assert.strictEqual(cycleEnergy(r.days, r.acc.total, '2026-11-16'), 1);
});

test('snapshotDay: a counter glitch in the middle of the day does not move the day start', () => {
  const r = run([['2026-11-15', 8], ['2026-11-15', 2, null], ['2026-11-15', 3]]);
  assert.strictEqual(r.acc.total, 11);
  assert.deepStrictEqual(r.days, { '2026-11-15': 0 });
});

test('snapshotDay: a day with no import at all', () => {
  const r = run([['2026-11-15', 2], ['2026-11-16', 0, '2026-11-16'], ['2026-11-16', 0], ['2026-11-17', 0, '2026-11-17'], ['2026-11-17', 0.5]]);
  assert.strictEqual(r.acc.total, 2.5);
  assert.deepStrictEqual(r.days, { '2026-11-15': 0, '2026-11-16': 2, '2026-11-17': 2 });
});

test('snapshotDay: Homey was off over midnight', () => {
  const r = run([['2026-11-15', 6.3], ['2026-11-16', 1.5, null], ['2026-11-16', 2]]);
  assert.strictEqual(r.acc.total, 8.3);
  assert.strictEqual(cycleEnergy(r.days, r.acc.total, '2026-11-16'), 2);
});

test('snapshotDay: keeps only the most recent days', () => {
  const readings: [string, number][] = [];
  for (let i = 1; i <= 9; i++) readings.push([`2026-01-0${i}`, 1]);
  assert.deepStrictEqual(Object.keys(run(readings, 5).days), ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']);
});

test('cycleEnergy counts from the start date, also when entered after the fact', () => {
  const days = { '2026-11-13': 100, '2026-11-14': 105, '2026-11-15': 112, '2026-11-16': 118.3 };
  assert.strictEqual(cycleEnergy(days, 120, '2026-11-15'), 8);
  assert.strictEqual(cycleEnergy(days, 120, '2026-11-13'), 20);
  assert.strictEqual(cycleEnergy(days, 120, '2026-11-01'), 20); // before records: from the first day on record
  assert.strictEqual(cycleEnergy(days, 120, '2026-12-01'), 0);  // future date
  assert.strictEqual(cycleEnergy(days, 120, ''), 20);
  assert.strictEqual(cycleEnergy(days, 120, 'next week'), 20);
  assert.strictEqual(cycleEnergy(undefined, 120, '2026-11-15'), 0);
});

test('cost multiplies and rounds to cents', () => {
  assert.strictEqual(cost(4.5, 15.551), 69.98);
  assert.strictEqual(cost(2.5, '15.551'), 38.88);
  assert.strictEqual(cost(4.5, undefined), 0);
});

test('solarPower prefers a total field', () => {
  const r = solarPower([{ key: 'TotalSolarPower', value: '1234.5' }, { key: 'DCPowerPV1', value: '600' }], 0, 0, 0);
  assert.deepStrictEqual(r, { value: 1234.5, source: 'TotalSolarPower' });
});

test('solarPower sums PV strings when there is no total', () => {
  const r = solarPower([{ key: 'DCPowerPV1', value: '600.5' }, { key: 'DCPowerPV2', value: '400' }, { key: 'DCVoltagePV1', value: '380' }, { key: 'BatteryPower', value: '-30' }], 0, 0, 0);
  assert.deepStrictEqual(r, { value: 1000.5, source: 'sum of PV strings' });
});

test('solarPower falls back to the energy balance', () => {
  // load 1639 W, 14 W from grid, battery charging at 30 W (negative = charging)
  const r = solarPower([{ key: 'TotalSolarPower', value: '' }, { key: 'SOC', value: '99' }], 1639, 14, -30);
  assert.deepStrictEqual(r, { value: 1655, source: 'energy balance' });
  // at night on battery the balance is zero, never negative
  assert.strictEqual(solarPower([], 1700, 0, 1733).value, 0);
  assert.ok(isNaN(solarPower([], NaN, 0, 0).value));
});

console.log(`\n${n} tests passed`);
