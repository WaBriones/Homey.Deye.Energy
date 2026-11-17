import assert from 'assert';
import { dayBreakdown, integrateProfile, mergeTotals, minuteOfDay, profileFromFrames, totalsFromDayRow, billForecast, dailyEnergy, dayFraction, daysBetween, sameDayNextMonth, accumulate, cost, cycleEnergy, energyBetween, localDay, newCycleStart, resetDayFor, rollBillCycle, snapshotDay, solarPower, toIsoDay, IAccumulator, IDaySnapshots } from '../lib/energy_math';

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

test('toIsoDay accepts YYYY-MM-DD and the Flow date picker format', () => {
  assert.strictEqual(toIsoDay('2026-12-14'), '2026-12-14');
  assert.strictEqual(toIsoDay('14-12-2026'), '2026-12-14');
  assert.strictEqual(toIsoDay(' 2026-12-14 '), '2026-12-14');
  assert.strictEqual(toIsoDay('2026-02-30'), null);
  assert.strictEqual(toIsoDay('14/12/2026'), null);
  assert.strictEqual(toIsoDay(''), null);
  assert.strictEqual(toIsoDay(undefined), null);
});

test('energyBetween counts from one cycle start to the next', () => {
  const days: IDaySnapshots = { '2026-11-16': 10, '2026-11-17': 12, '2026-12-14': 150, '2026-12-15': 155 };
  assert.strictEqual(energyBetween(days, 160, '2026-11-15', '2026-12-14'), 140); // start before records: first recorded day
  assert.strictEqual(energyBetween(days, 160, '2026-11-17', '2026-12-15'), 143);
  assert.strictEqual(energyBetween(days, 160, '2026-12-14', '2026-12-20'), 10); // end not recorded yet: up to now
  assert.strictEqual(energyBetween(days, 160, '2026-12-20', '2026-12-21'), 0);
  assert.strictEqual(energyBetween(undefined, 160, '2026-11-16', '2026-12-14'), 0);
});

test('rollBillCycle waits for a future date, then starts the new cycle', () => {
  const planned = { start: '2026-11-15', next: '2026-12-14' };
  assert.deepStrictEqual(rollBillCycle(planned, '2026-12-13'), planned);
  assert.deepStrictEqual(rollBillCycle(planned, '2026-12-14'), { start: '2026-12-14', next: '', closed: { start: '2026-11-15', end: '2026-12-14' } });
  // the date passed while Homey was off: still rolls over, from the planned date
  assert.deepStrictEqual(rollBillCycle(planned, '2026-12-16'), { start: '2026-12-14', next: '', closed: { start: '2026-11-15', end: '2026-12-14' } });
});

test('rollBillCycle: same-day start, corrections and empty values', () => {
  // the action with today's date starts the new cycle at once
  assert.deepStrictEqual(rollBillCycle({ start: '2026-11-15', next: '17-12-2026' }, '2026-12-17'), { start: '2026-12-17', next: '', closed: { start: '2026-11-15', end: '2026-12-17' } });
  // an earlier date corrects the current start, no cycle ended
  assert.deepStrictEqual(rollBillCycle({ start: '2026-11-16', next: '2026-11-15' }, '2026-11-20'), { start: '2026-11-15', next: '' });
  // no start known yet: just take the date
  assert.deepStrictEqual(rollBillCycle({ start: '', next: '2026-11-15' }, '2026-11-20'), { start: '2026-11-15', next: '' });
  // nothing planned, or an invalid date: keep the start, clear the plan
  assert.deepStrictEqual(rollBillCycle({ start: '2026-11-15', next: '' }, '2026-12-20'), { start: '2026-11-15', next: '' });
  assert.deepStrictEqual(rollBillCycle({ start: '2026-11-15', next: 'soon' }, '2026-12-20'), { start: '2026-11-15', next: '' });
});

test('newCycleStart: the date is the first day of the new cycle, or the last day of the old one', () => {
  assert.strictEqual(newCycleStart('14-12-2026', 'start'), '2026-12-14');
  assert.strictEqual(newCycleStart('14-12-2026', 'end'), '2026-12-15');
  assert.strictEqual(newCycleStart('2026-11-30', 'end'), '2026-12-01');
  assert.strictEqual(newCycleStart('31-12-2026', 'end'), '2027-01-01');
  assert.strictEqual(newCycleStart('28-02-2028', 'end'), '2028-02-29'); // leap year
  assert.strictEqual(newCycleStart('nope', 'end'), null);
});

test('daysBetween, sameDayNextMonth and dayFraction', () => {
  assert.strictEqual(daysBetween('2026-11-15', '2026-12-14'), 29);
  assert.strictEqual(daysBetween('2026-12-14', '2026-11-15'), -29);
  assert.strictEqual(daysBetween('2028-02-28', '2028-03-01'), 2); // leap year
  assert.strictEqual(sameDayNextMonth('2026-11-15'), '2026-12-15');
  assert.strictEqual(sameDayNextMonth('2026-12-15'), '2027-01-15');
  assert.strictEqual(sameDayNextMonth('2027-01-31'), '2027-02-28');
  assert.strictEqual(dayFraction(new Date('2026-11-15T22:00:00Z'), 'Asia/Manila'), 0.25); // 06:00 in Manila
  assert.strictEqual(dayFraction(new Date('2026-11-15T16:00:00Z'), 'Asia/Manila'), 0);    // midnight in Manila
});

test('billForecast projects the cycle from the daily average', () => {
  const f = billForecast(30, '2026-11-15', '2026-12-15', '2026-11-18', 0);
  assert.deepStrictEqual(f, { start: '2026-11-15', end: '2026-12-15', endIsEstimate: false, cycleDays: 30, elapsedDays: 3, daysLeft: 27, perDay: 10, projected: 300 });
  // half way through the fourth day
  assert.strictEqual(billForecast(35, '2026-11-15', '2026-12-15', '2026-11-18', 0.5)!.projected, 300);
});

test('billForecast: no planned date, first day, overdue and invalid dates', () => {
  // no next date planned: one month after the start, marked as an estimate
  const est = billForecast(30, '2026-11-15', '', '2026-11-18', 0)!;
  assert.strictEqual(est.end, '2026-12-15');
  assert.strictEqual(est.endIsEstimate, true);
  // a next date on or before the start is ignored
  assert.strictEqual(billForecast(30, '2026-11-15', '2026-11-10', '2026-11-18', 0)!.end, '2026-12-15');
  // less than one day counted: no average yet
  const first = billForecast(4, '2026-11-15', '', '2026-11-15', 0.5)!;
  assert.strictEqual(first.perDay, null);
  assert.strictEqual(first.projected, null);
  assert.strictEqual(first.elapsedDays, 0.5);
  // the cycle's end has passed: average known, no projection
  const late = billForecast(350, '2026-11-15', '', '2026-12-20', 0)!;
  assert.strictEqual(late.daysLeft, 0);
  assert.strictEqual(late.elapsedDays, 30);
  assert.strictEqual(late.perDay, 10);
  assert.strictEqual(late.projected, null);
  assert.strictEqual(billForecast(30, '', '', '2026-11-18'), null);
  assert.strictEqual(billForecast(30, '2026-12-01', '', '2026-11-18'), null);
});

test('billForecast: records that begin after the cycle started', () => {
  // cycle from the 15th, counting only since the 16th: 20 kWh in 2 days is 10 a day
  const f = billForecast(20, '2026-11-15', '2026-12-15', '2026-11-18', 0, '2026-11-16')!;
  assert.strictEqual(f.elapsedDays, 3);
  assert.strictEqual(f.perDay, 10);
  assert.strictEqual(f.projected, 300);
});

test('dailyEnergy: finished days and today so far', () => {
  const days: IDaySnapshots = { '2026-11-15': 10, '2026-11-16': 14.5, '2026-11-17': 20 };
  assert.deepStrictEqual(dailyEnergy(days, 22.25, '2026-11-17'), { '2026-11-15': 4.5, '2026-11-16': 5.5, '2026-11-17': 2.25 });
});

test('dailyEnergy: a day before a gap in the records is left out', () => {
  const days: IDaySnapshots = { '2026-11-10': 10, '2026-11-13': 30, '2026-11-14': 33 };
  assert.deepStrictEqual(dailyEnergy(days, 40, '2026-11-15'), { '2026-11-13': 3 });
  assert.deepStrictEqual(dailyEnergy(undefined, 40, '2026-11-15'), {});
});

test('profileFromFrames keeps one local day, sorts it, and works out grid power', () => {
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
  const rows = [
    { dateTime: at('2026-11-16T04:05:00Z'), generationPower: 3000, consumptionPower: 1000, batteryPower: -1500, batterySOC: 60 }, // 12:05 Manila
    { dateTime: at('2026-11-16T04:00:00Z'), generationPower: 2000, consumptionPower: 2500, batteryPower: 200, batterySOC: 59 },
    { dateTime: at('2026-11-15T15:00:00Z'), generationPower: 0, consumptionPower: 400, batteryPower: 400, batterySOC: 80 },     // 23:00 the day before
    { dateTime: at('2026-11-16T16:00:00Z'), generationPower: 0, consumptionPower: 400 }                                         // 00:00 the day after
  ];
  const p = profileFromFrames(rows, '2026-11-16', 'Asia/Manila');
  assert.deepStrictEqual(p.t, [720, 725]);
  assert.deepStrictEqual(p.solar, [2000, 3000]);
  assert.deepStrictEqual(p.grid, [300, -500]); // buying 300 W, then exporting 500 W
  assert.deepStrictEqual(p.battery, [200, -1500]);
  assert.deepStrictEqual(p.soc, [59, 60]);
  assert.strictEqual(minuteOfDay(new Date('2026-11-16T04:05:00Z'), 'Asia/Manila'), 725);
});

test('profileFromFrames: millisecond stamps, charge and discharge fields, nothing to read', () => {
  const p = profileFromFrames([{ timeStamp: Date.UTC(2026, 10, 16, 6, 0), generationPower: '1200', consumptionPower: '700', chargePower: 500, dischargePower: 0 }], '2026-11-16', 'UTC');
  assert.deepStrictEqual(p.t, [360]);
  assert.deepStrictEqual(p.battery, [-500]);
  assert.deepStrictEqual(p.grid, [0]);
  assert.deepStrictEqual(profileFromFrames(undefined, '2026-11-16', 'UTC').t, []);
});

test('integrateProfile adds up the energy and skips long gaps', () => {
  const p = {
    t: [0, 60, 120, 300],
    solar: [1000, 1000, 1000, 1000],
    load: [500, 500, 500, 500],
    grid: [1000, -1000, -1000, -1000],
    battery: [null, null, null, null],
    soc: [null, null, null, null]
  };
  const e = integrateProfile(p, 60);
  assert.strictEqual(e.production, 2);   // 1 kW for 2 hours; the 3 hour gap is skipped
  assert.strictEqual(e.consumption, 1);
  assert.strictEqual(e.buy, 0.5);        // first hour: the average of 1 kW bought and nothing bought
  assert.strictEqual(e.sell, 1.5);
  assert.strictEqual(e.charge, null);    // never reported
});

test('totalsFromDayRow and mergeTotals: first known value wins', () => {
  const cloud = totalsFromDayRow({ generationValue: 40.4, consumptionValue: '37', purchaseValue: null, gridValue: 0.09 });
  assert.strictEqual(cloud.consumption, 37);
  assert.strictEqual(cloud.buy, null);
  const merged = mergeTotals({ production: NaN as any, buy: 1.79 }, cloud, { production: 1, charge: 13.89, discharge: 8.79 });
  assert.deepStrictEqual(merged, { production: 40.4, consumption: 37, buy: 1.79, sell: 0.09, charge: 13.89, discharge: 8.79 });
});

test('dayBreakdown matches the Deye app rings', () => {
  const b = dayBreakdown({ production: 40.4, consumption: 37, buy: 1.79, sell: 0.09, charge: 13.89, discharge: 8.79 });
  assert.deepStrictEqual(b.consumption, { total: 37, solar: { kwh: 26.42, pct: 71 }, battery: { kwh: 8.79, pct: 24 }, grid: { kwh: 1.79, pct: 5 } });
  assert.deepStrictEqual(b.production, { total: 40.4, home: { kwh: 26.42, pct: 66 }, battery: { kwh: 13.89, pct: 34 }, grid: { kwh: 0.09, pct: 0 } });
  assert.strictEqual(b.selfPowered, 95);
});

test('dayBreakdown: no solar reported, and nothing known', () => {
  const b = dayBreakdown({ production: null, consumption: 10, buy: 4, sell: null, charge: null, discharge: 1 });
  assert.strictEqual(b.consumption?.solar.kwh, 5);
  assert.strictEqual(b.selfPowered, 60);
  assert.strictEqual(b.production?.total, 5);
  const none = dayBreakdown({ production: null, consumption: null, buy: null, sell: null, charge: null, discharge: null });
  assert.deepStrictEqual(none, { consumption: null, production: null, selfPowered: null });
});

console.log(`\n${n} tests passed`);
