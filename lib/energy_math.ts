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

/**
 * kWh imported from the start of `start` up to the start of `end` (both
 * YYYY-MM-DD), using the first recorded day on or after each. When `end` has
 * no snapshot yet, counts up to `total`.
 */
export function energyBetween(days: IDaySnapshots | undefined, total: number, start: string, end: string): number {
  const keys = Object.keys(days || {}).sort();
  const from = keys.find(k => k >= start);
  if (from === undefined || from >= end) return 0;
  const to = keys.find(k => k >= end);
  const endTotal = to === undefined ? total : (days as IDaySnapshots)[to];
  return round3(Math.max(0, endTotal - (days as IDaySnapshots)[from]));
}

/**
 * A date as YYYY-MM-DD, from YYYY-MM-DD or Homey's date picker (DD-MM-YYYY).
 * Returns null for anything that is not a real calendar date.
 */
export function toIsoDay(value: any): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
    if (!m) return null;
    d = +m[1]; mo = +m[2]; y = +m[3];
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A YYYY-MM-DD day moved by `n` calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The first day of the new cycle, from a date the user gives as either the
 * first day of the new cycle ('start') or the last day of the old one ('end').
 */
export function newCycleStart(date: any, which: string): string | null {
  const day = toIsoDay(date);
  if (!day) return null;
  return which === 'end' ? addDays(day, 1) : day;
}

export interface IBillCycle {
  start: string; // current cycle start, YYYY-MM-DD or ''
  next: string;  // planned next cycle start, YYYY-MM-DD or ''
}

/**
 * Move to the next billing cycle once its start date has come.
 * `closed` is set when a cycle actually ended (the new start is after the old
 * one); a new start on or before the old one is a correction, not a new cycle.
 */
export function rollBillCycle(cycle: IBillCycle, today: string): IBillCycle & { closed?: { start: string; end: string } } {
  const next = toIsoDay(cycle.next);
  const start = toIsoDay(cycle.start) || '';
  if (!next) return { start, next: '' };
  if (next > today) return { start, next };
  if (start && next > start) return { start: next, next: '', closed: { start, end: next } };
  return { start: next, next: '' };
}

/** Whole days from day `a` to day `b` (both YYYY-MM-DD); negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  const t = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86400000);
}

/** The same day one month later, or the last day of that month when it is shorter (31 Jan gives 28 Feb). */
export function sameDayNextMonth(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const lastOfNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastOfNext))).toISOString().slice(0, 10);
}

/** How much of the local day has passed, from 0 to 1. */
export function dayFraction(date: Date, timeZone?: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
    const minutes = get('hour') * 60 + get('minute');
    if (isFinite(minutes)) return minutes / 1440;
  } catch (e) {
    // fall through to UTC
  }
  return (date.getUTCHours() * 60 + date.getUTCMinutes()) / 1440;
}

export interface IBillForecast {
  start: string;             // first day of the cycle
  end: string;               // first day of the next cycle
  endIsEstimate: boolean;    // true when no next date is planned: one month after the start
  cycleDays: number;
  elapsedDays: number;       // days of the cycle that have passed, with today's fraction
  daysLeft: number;
  perDay: number | null;     // average kWh per day, null until one full day is counted
  projected: number | null;  // kWh for the whole cycle at that average, null when not known
}

/**
 * Where the current billing cycle is heading. `energy` is the kWh counted so
 * far, `fraction` how much of today has passed. When records begin after the
 * cycle started (`countedFrom`), the daily average uses only the recorded days.
 * Returns null without a valid start date, or one in the future.
 */
export function billForecast(energy: number, start: any, next: any, today: string, fraction = 0, countedFrom?: string): IBillForecast | null {
  const s = toIsoDay(start);
  if (!s || s > today) return null;
  const n = toIsoDay(next);
  const planned = !!n && n > s;
  const end = planned ? (n as string) : sameDayNextMonth(s);
  const cycleDays = daysBetween(s, end);
  const part = Math.min(1, Math.max(0, fraction));
  const elapsedDays = round3(Math.min(cycleDays, daysBetween(s, today) + part));
  const from = countedFrom && isDay(countedFrom) && countedFrom > s ? countedFrom : s;
  const counted = daysBetween(from, today) + part;
  const known = counted >= 1 && isFinite(energy) && energy >= 0;
  return {
    start: s,
    end,
    endIsEstimate: !planned,
    cycleDays,
    elapsedDays,
    daysLeft: Math.max(0, daysBetween(today, end)),
    perDay: known ? round3(energy / counted) : null,
    projected: known && end > today ? round3(energy / counted * cycleDays) : null
  };
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
