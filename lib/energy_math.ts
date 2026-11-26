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
 * kWh imported on each recorded day, from the per-day snapshots. A finished
 * day is the difference to the next day's snapshot; `today` counts up to
 * `total`. A day followed by a gap in the records is left out, because the
 * energy up to the next snapshot belongs to several days.
 */
export function dailyEnergy(days: IDaySnapshots | undefined, total: number, today: string): { [day: string]: number } {
  const d = days || {};
  const out: { [day: string]: number } = {};
  for (const day of Object.keys(d)) {
    const next = d[addDays(day, 1)];
    let end: number | undefined;
    if (day === today) end = total;
    else if (day < today && typeof next === 'number') end = next;
    if (end === undefined || !isFinite(end)) continue;
    out[day] = round3(Math.max(0, end - d[day]));
  }
  return out;
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

// ---------------------------------------------------------------------------
// A day's power profile and energy breakdown (the "energy day" widget)
// ---------------------------------------------------------------------------

/** One day's power readings as parallel arrays; `t` is minutes after local midnight. */
export interface IDayProfile {
  t: number[];
  solar: (number | null)[];   // W
  load: (number | null)[];    // W
  grid: (number | null)[];    // W, above 0: buying from the grid
  battery: (number | null)[]; // W, above 0: discharging
  soc: (number | null)[];     // %
}

/** A day's energy in kWh; null when not known. */
export interface IDayTotals {
  production: number | null;
  consumption: number | null;
  buy: number | null;
  sell: number | null;
  charge: number | null;
  discharge: number | null;
}

const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
};

/** Minutes after local midnight in the given time zone. */
export function minuteOfDay(date: Date, timeZone?: string): number {
  return Math.round(dayFraction(date, timeZone) * 1440);
}

/** The moment a DeyeCloud history row was recorded, or null. Accepts seconds or milliseconds. */
export function rowTime(row: any): Date | null {
  const raw = numOrNull(row?.dateTime ?? row?.timeStamp ?? row?.collectionTime ?? row?.lastUpdateTime);
  if (raw === null || raw <= 0) return null;
  return new Date(raw > 1e11 ? raw : raw * 1000);
}

/**
 * Watts of grid balance treated as nothing. The cloud's battery power
 * includes the inverter's own use, so at night home - solar - battery comes
 * out at about -80 W while the grid meter reads 0.
 */
export const GRID_DEADBAND = 100;

/**
 * Turn DeyeCloud's station history frames (one about every 5 minutes) into
 * the profile of one local day. Frames of other days are dropped.
 * Battery power is above 0 while discharging. Grid power comes from the
 * energy balance (home - solar - battery) when those are known, because the
 * cloud's own grid fields are not signed the same way on every inverter.
 */
export function profileFromFrames(rows: any[] | undefined, day: string, timeZone?: string): IDayProfile {
  const p: IDayProfile = { t: [], solar: [], load: [], grid: [], battery: [], soc: [] };
  const frames = (rows || [])
    .map(row => ({ row, when: rowTime(row) }))
    .filter(f => f.when && localDay(f.when, timeZone) === day)
    .sort((a, b) => (a.when as Date).getTime() - (b.when as Date).getTime());

  let lastMinute = -1;
  frames.forEach(({ row, when }) => {
    const minute = minuteOfDay(when as Date, timeZone);
    if (minute <= lastMinute) return; // two frames in the same minute: keep the first
    lastMinute = minute;

    const solar = numOrNull(row.generationPower);
    const load = numOrNull(row.consumptionPower);
    let battery = numOrNull(row.batteryPower);
    if (battery === null) {
      const charge = numOrNull(row.chargePower), discharge = numOrNull(row.dischargePower);
      if (charge !== null || discharge !== null) battery = Math.abs(discharge || 0) - Math.abs(charge || 0);
    }
    let grid: number | null;
    if (solar !== null && load !== null) {
      grid = Math.round(load - solar - (battery || 0));
      if (Math.abs(grid) < GRID_DEADBAND) grid = 0;
    } else grid = numOrNull(row.wirePower);

    p.t.push(minute);
    p.solar.push(solar);
    p.load.push(load);
    p.grid.push(grid);
    p.battery.push(battery);
    p.soc.push(numOrNull(row.batterySOC));
  });
  return p;
}

/**
 * Energy (kWh) under a day's power curves. Used when the cloud gives no day
 * totals. A gap longer than `maxGap` minutes counts as no power.
 */
export function integrateProfile(p: IDayProfile, maxGap = 20): IDayTotals {
  const sum = { production: 0, consumption: 0, buy: 0, sell: 0, charge: 0, discharge: 0 };
  const seen = { solar: false, load: false, grid: false, battery: false };
  const area = (a: number | null, b: number | null, hours: number, pick: (w: number) => number) => {
    if (a === null || b === null) return 0;
    return (pick(a) + pick(b)) / 2 * hours / 1000;
  };
  const pos = (w: number) => Math.max(0, w);
  const neg = (w: number) => Math.max(0, -w);

  for (let i = 0; i < p.t.length; i++) {
    if (p.solar[i] !== null) seen.solar = true;
    if (p.load[i] !== null) seen.load = true;
    if (p.grid[i] !== null) seen.grid = true;
    if (p.battery[i] !== null) seen.battery = true;
    if (i === 0) continue;
    const minutes = p.t[i] - p.t[i - 1];
    if (minutes <= 0 || minutes > maxGap) continue;
    const h = minutes / 60;
    sum.production += area(p.solar[i - 1], p.solar[i], h, pos);
    sum.consumption += area(p.load[i - 1], p.load[i], h, pos);
    sum.buy += area(p.grid[i - 1], p.grid[i], h, pos);
    sum.sell += area(p.grid[i - 1], p.grid[i], h, neg);
    sum.discharge += area(p.battery[i - 1], p.battery[i], h, pos);
    sum.charge += area(p.battery[i - 1], p.battery[i], h, neg);
  }

  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    production: seen.solar ? r(sum.production) : null,
    consumption: seen.load ? r(sum.consumption) : null,
    buy: seen.grid ? r(sum.buy) : null,
    sell: seen.grid ? r(sum.sell) : null,
    charge: seen.battery ? r(sum.charge) : null,
    discharge: seen.battery ? r(sum.discharge) : null
  };
}

/** Day totals from a DeyeCloud daily history row (granularity 2); missing fields are null. */
export function totalsFromDayRow(row: any): IDayTotals {
  return {
    production: numOrNull(row?.generationValue),
    consumption: numOrNull(row?.consumptionValue),
    buy: numOrNull(row?.purchaseValue),
    sell: numOrNull(row?.gridValue),
    charge: numOrNull(row?.chargeValue),
    discharge: numOrNull(row?.dischargeValue)
  };
}

/** The first set of totals wins, field by field; later ones fill what is missing. */
export function mergeTotals(...sources: (Partial<IDayTotals> | null | undefined)[]): IDayTotals {
  const out: IDayTotals = { production: null, consumption: null, buy: null, sell: null, charge: null, discharge: null };
  (Object.keys(out) as (keyof IDayTotals)[]).forEach(key => {
    for (const s of sources) {
      const v = numOrNull(s?.[key]);
      if (v !== null && v >= 0) { out[key] = v; break; }
    }
  });
  return out;
}

export interface IShare { kwh: number; pct: number }

export interface IDayBreakdown {
  /** where the home's energy came from */
  consumption: { total: number; solar: IShare; battery: IShare; grid: IShare } | null;
  /** where the solar energy went */
  production: { total: number; home: IShare; battery: IShare; grid: IShare } | null;
  /** share of the home's energy that did not come from the grid, 0 to 100 */
  selfPowered: number | null;
}

/**
 * Split a day's totals into the two rings of the Deye app: what the home ran
 * on (solar, battery, grid) and where the solar went (home, battery, grid).
 * Solar used directly is what was made minus what was exported and stored.
 */
export function dayBreakdown(t: IDayTotals): IDayBreakdown {
  const r = (v: number) => Math.round(v * 100) / 100;
  const shares = (parts: number[]) => {
    const total = parts.reduce((a, b) => a + b, 0);
    // whole percentages that add up to 100: hand the rounding remainder to the largest parts
    const exact = parts.map(v => (total > 0 ? 100 * v / total : 0));
    const pct = exact.map(Math.floor);
    let left = total > 0 ? 100 - pct.reduce((a, b) => a + b, 0) : 0;
    exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac).forEach(({ i }) => { if (left > 0) { pct[i]++; left--; } });
    return { total: r(total), list: parts.map((v, i) => ({ kwh: r(v), pct: pct[i] })) };
  };

  const buy = t.buy || 0, sell = t.sell || 0, charge = t.charge || 0, discharge = t.discharge || 0;
  let direct: number | null = null;
  if (t.production !== null) direct = Math.max(0, t.production - sell - charge);
  else if (t.consumption !== null) direct = Math.max(0, t.consumption - buy - discharge);

  const out: IDayBreakdown = { consumption: null, production: null, selfPowered: null };
  if (direct === null) return out;

  const c = shares([direct, discharge, buy]);
  if (c.total > 0) {
    out.consumption = { total: c.total, solar: c.list[0], battery: c.list[1], grid: c.list[2] };
    out.selfPowered = 100 - c.list[2].pct;
  }
  const p = shares([direct, charge, sell]);
  if (p.total > 0) out.production = { total: p.total, home: p.list[0], battery: p.list[1], grid: p.list[2] };
  return out;
}
