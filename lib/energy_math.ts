'use strict';

/**
 * Pure helpers for turning the inverter's "today" counters into the
 * ever-increasing totals Homey Energy expects, for billing-cycle maths,
 * and for working out solar power on inverters that do not report it.
 * No Homey imports here, so this file can be unit tested with plain Node.
 */

export interface IAccumulator {
  total: number;            // kWh, only ever increases
  lastDaily: number | null; // last seen value of the daily counter
  lastDay: string | null;   // local date (YYYY-MM-DD) of that value
}

export interface IAccumulators {
  [name: string]: IAccumulator;
}

export interface IDaySnapshots {
  [day: string]: number; // total at the start of that local day
}

export interface IKeyValueItem {
  key: string | null;
  value: string;
  unit?: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Local calendar date as YYYY-MM-DD in the given IANA time zone. */
export function localDay(date: Date, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    const y = get('year'), m = get('month'), d = get('day');
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch (e) {
    // fall through to UTC
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Feed a daily counter (resets at midnight on the inverter) into a running total.
 * A drop is treated as the midnight reset only when the day changed or the
 * value at least halved; smaller drops are counter jitter and are ignored.
 */
export function accumulate(acc: IAccumulator | undefined, daily: number, day: string): IAccumulator {
  const a: IAccumulator = acc ? { ...acc } : { total: 0, lastDaily: null, lastDay: null };
  if (typeof daily !== 'number' || !isFinite(daily) || daily < 0) return a;

  if (a.lastDaily === null) {
    // first reading: start the total at what was already counted today
    a.total = round3(a.total + daily);
    a.lastDaily = daily;
    a.lastDay = day;
    return a;
  }

  if (daily >= a.lastDaily) {
    a.total = round3(a.total + (daily - a.lastDaily));
    a.lastDaily = daily;
    a.lastDay = day;
    return a;
  }

  const isReset = day !== a.lastDay || daily <= a.lastDaily * 0.5;
  if (isReset) {
    a.total = round3(a.total + daily);
    a.lastDaily = daily;
    a.lastDay = day;
  }
  return a;
}

/**
 * The day a counter reset belongs to, or null when `date` is not near midnight.
 * A reset at 23:57 starts the next day; one at 00:03 started the current day.
 */
export function resetDayFor(date: Date, timeZone?: string, windowMs = 2 * 3600 * 1000): string | null {
  const earlier = localDay(new Date(date.getTime() - windowMs), timeZone);
  const later = localDay(new Date(date.getTime() + windowMs), timeZone);
  return earlier === later ? null : later;
}

/**
 * Remember what the total was when each day began. Keeps `keep` days.
 * The day really starts when the inverter resets its daily counter, which can
 * be a few minutes either side of midnight on Homey's clock. A snapshot taken
 * at the date change is therefore provisional; a reset seen near midnight
 * (resetDay, from resetDayFor) sets the real one.
 */
export function snapshotDay(days: IDaySnapshots | undefined, day: string, before: IAccumulator | undefined, after: IAccumulator, daily: number, resetDay: string | null = null, keep = 400): IDaySnapshots {
  const d: IDaySnapshots = { ...(days || {}) };
  const valid = typeof daily === 'number' && isFinite(daily) && daily >= 0;

  if (valid) {
    const first = !before || before.lastDaily === null;
    const wasReset = !first && daily < (before as IAccumulator).lastDaily! && after.lastDaily === daily;
    const startOfCounter = round3(Math.max(0, after.total - daily));

    if (first) {
      d[day] = startOfCounter;
    } else if (wasReset && resetDay) {
      d[resetDay] = startOfCounter;
    }

    if (d[day] === undefined) {
      const sameDay = (before as IAccumulator).lastDay === day;
      d[day] = (sameDay || wasReset) ? startOfCounter : after.total;
    }
  }

  const keys = Object.keys(d).sort();
  while (keys.length > keep) delete d[keys.shift() as string];
  return d;
}

export function isDay(value: any): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * kWh imported since the start of `cycleStart` (YYYY-MM-DD).
 * Uses the first recorded day on or after the start date, so a start date
 * can be entered after the fact. An empty or invalid date counts from the
 * first day on record; a future date gives 0.
 */
export function cycleEnergy(days: IDaySnapshots | undefined, total: number, cycleStart: any): number {
  const keys = Object.keys(days || {}).sort();
  if (!keys.length) return 0;
  let key: string | undefined = keys[0];
  if (isDay(cycleStart)) {
    const start = (cycleStart as string).trim();
    key = keys.find(k => k >= start);
    if (key === undefined) return 0;
  }
  return round3(Math.max(0, total - (days as IDaySnapshots)[key]));
}

export function cost(kwh: number, rate: any): number {
  const r = typeof rate === 'number' ? rate : parseFloat(rate);
  if (!isFinite(r) || !isFinite(kwh)) return 0;
  return Math.round(kwh * r * 100) / 100;
}

const num = (item: IKeyValueItem | undefined): number => (item ? parseFloat(item.value) : NaN);

/**
 * Solar power in W from a device/latest data list.
 * 1. a total field, under the names different inverter families use;
 * 2. otherwise the sum of the per-string PV power fields;
 * 3. otherwise the energy balance: load - grid - battery.
 * Returns the value and which source was used, for diagnostics.
 */
export function solarPower(dataList: IKeyValueItem[], consumption: number, grid: number, battery: number): { value: number; source: string } {
  const totals = ['TotalSolarPower', 'TotalDCInputPower', 'TotalPVPower', 'PVTotalPower', 'DCTotalPower', 'TotalDCPower', 'SolarPower', 'PVPower'];
  for (const name of totals) {
    const v = num(dataList.find(i => i.key === name));
    if (isFinite(v)) return { value: v, source: name };
  }

  const stringPower = /^(DC\s*Power\s*PV\s*\d+|PV\s*\d+\s*Power|DC\s*\d+\s*Power|PV\s*Power\s*\d+)$/i;
  const strings = dataList.filter(i => i.key && stringPower.test(i.key)).map(num).filter(v => isFinite(v));
  if (strings.length) return { value: Math.round(strings.reduce((s, v) => s + v, 0) * 100) / 100, source: 'sum of PV strings' };

  if (isFinite(consumption) && isFinite(grid) && isFinite(battery)) {
    return { value: Math.max(0, Math.round(consumption - grid - battery)), source: 'energy balance' };
  }

  return { value: NaN, source: 'none' };
}
