# Deye Energy for Homey: project notes

Homey Pro app (SDK v3, TypeScript, Homey Compose). A fork of
[Deye Solar Systems](https://github.com/heszegi/com.heszi.deye) 1.4.7 by
Andras Heszegi, GPL-3.0. App ID `com.briones.deye`. Default branch `develop`.

## Why this fork exists

The original app could not give a complete Homey Energy tab for the owner's
inverter:

- "Station" data source: live watts work, but the solar and battery kWh
  counters never update, and there is no grid meter.
- "Device" data source: kWh counters work, but solar power came back empty,
  because the code read one field (`TotalSolarPower`) that this inverter does
  not report.

## What was changed

- `lib/energy_math.ts`: pure helpers, no Homey imports. Running totals from
  the inverter's daily counters, per-day snapshots, billing-cycle energy,
  cost, and solar power with fallbacks (total field, then sum of PV strings,
  then load - grid - battery).
- `drivers/deye_station/devices/deyeStationInverter.ts`: in Device mode the
  inverter is the home's grid meter (`measure_power` = grid power,
  `meter_power.imported` / `meter_power.exported`, `energy.cumulative`).
  Adds `daily_cost`, `bill_cycle_energy`, `bill_cycle_cost`. Settings:
  `electricityRate`, `currency`, `billCycleStart` (YYYY-MM-DD, may be entered
  after the fact). Flow tokens are cleaned so a missing field is 0, not NaN.
  The `reportedFields` label setting lists the fields the inverter sends.
- Solar panel and battery devices take running totals from the inverter
  device instead of the daily counters.
- `lib/deye_api.ts`: when the DeyeCloud account belongs to an organisation
  (company), `login()` requests the token for that company; without it such
  accounts list no stations. API errors include DeyeCloud's response.
- Bill cycles roll over by themselves. Setting `nextBillCycleStart`
  (YYYY-MM-DD) holds the first day of the next cycle; on that day the app
  starts the new cycle, fires the Flow trigger "Bill cycle ended" (kWh,
  cost, rate and dates of the ended cycle) and clears the setting. The Flow
  action "Set the bill cycle date" takes a date as either the first day of
  the new cycle or the last day of the current one; today or earlier starts
  the new cycle at once, a later date is stored in `nextBillCycleStart`.
  Helpers: `toIsoDay`, `addDays`, `newCycleStart`, `energyBetween`,
  `rollBillCycle`.
- Dashboard widgets in `widgets/`: `energy-flow` (animated diagram of solar,
  grid, battery and home power, with today's totals) and `bill-cycle` (bill
  so far, forecast for the cycle, optional budget). Each `public/index.html`
  is self-contained; `api.js` returns `app.getDashboardData()`, which comes
  from the first inverter's `getDashboardData()`. The inverter pushes the
  same data as the realtime event `deye_update` after every poll, and the
  widgets also refetch every minute. The forecast maths is `billForecast`
  in `lib/energy_math.ts`. Two more widgets use the same data:
  `cost-calendar` (a month of days, each with its grid cost, coloured from
  green to red against the average day; from `calendar` in the dashboard
  data, built by `dailyEnergy` from `importedByDay`; every day is priced at
  the current rate) and `solar-scene` (a house under a sky that follows the
  clock, with the sun's glow, lit windows, the grid line and a liquid
  battery driven by the live values). The preview PNGs (1024x1024) are screenshots of
  the widgets with sample data.
- Widget `energy-day` (2026-11-17): one chosen day. A date picker (previous
  and next day buttons, native date input), the day's power profile (solar,
  home, optional battery and grid; battery level on its own small scale
  below) and two rings (what the home ran on, where the solar went). No flow
  diagram (removed 2026-11-18 as too crowded): the live flow is the separate
  `energy-flow` widget, always today. While the chart is scrubbed, the
  series chips show that moment's watts (names hidden so the row does not
  wrap) and the tooltip shows the time and battery level; "Replay the day"
  sweeps that moment through the whole day. A new day slides in, the lines
  draw themselves, the ring segments sweep in one after another, the
  centre and table numbers count up, then the rings glow softly and a light
  orbits them now and then (all off with the widget's Animations setting). Its
  `api.js` adds `POST /day` with body `{ date: 'YYYY-MM-DD' }` (a query string
  on the widget's path did not reach the app on the owner's Homey), served by `app.getDayHistory()`
  and the inverter's `getDayHistory()`, which reads DeyeCloud
  `/v1.0/station/history` (granularity 1: frames about every 5 minutes;
  granularity 2: day totals) through `getStationHistory` in
  `lib/deye_api.ts`. Day totals come, field by field, from today's inverter
  counters, then the cloud's day row, then the area under the profile. Grid
  power in the profile is the balance home - solar - battery. Past days are
  cached in memory (`dayCache`), today for 4 minutes. Helpers:
  `profileFromFrames`, `integrateProfile`, `totalsFromDayRow`, `mergeTotals`,
  `dayBreakdown`.
- `test/energy_math.test.ts`: unit tests, run with `npm test`.

Accumulators and day snapshots live in the inverter device's store
(`accumulators`, `importedByDay`).

## Status

- Compiles, passes `homey app validate --level publish`, 38 unit tests pass.
- `energy-day` date picker fix (2026-11-26: date in the POST body, the label
  follows the tap at once) was only checked in a browser with a mocked
  Homey, NOT yet on the owner's Homey.
- `energy-day` was installed on the owner's Homey on 2026-11-18 and its
  DeyeCloud history call returned a real profile for today. The day's
  figures are NOT yet checked against the Deye app. On that first day the
  grid line sat at about -0.08 kW all night while the live grid power was
  0 W: the cloud's battery power seems to exceed home consumption by the
  inverter's own use, so the balance showed a small false export. Fixed
  with `GRID_DEADBAND` (100 W): a smaller balance counts as 0, at the cost
  of hiding real grid power under 100 W in the profile. The field
  names (`dateTime`, `generationPower`, `consumptionPower`, `batteryPower`,
  `batterySOC`, `generationValue`, `purchaseValue`, `gridValue`,
  `chargeValue`, `dischargeValue`), the sign of `batteryPower` (assumed
  below 0 while charging) and the date format come from other people's
  projects, because developer.deyecloud.com was not reachable from the
  session. First thing to check on the real Homey: compare one day with the
  Deye app (37.00 kWh used and 40.40 kWh made on the owner's screenshot).
- `cost-calendar` and `solar-scene` (2026-11-17) were only checked as
  still screenshots with sample data. They are installed on the owner's
  Homey, but NOT yet seen on a real dashboard, and their animations have
  not been watched running.
- The widgets are installed on the owner's Homey (2026-11-16) and were
  checked in a desktop browser with sample data, but NOT yet seen on a real
  Homey dashboard.
- Verified on the owner's Homey Pro on 2026-11-16: pairing (all three
  devices, data centre "Europe, Africa, or the Asia-Pacific"), live data,
  Energy roles and cost. Run it there with `npx homey app run --remote`.
- Solar power comes from the inverter's `TotalDCInputPower` field.
- NOT yet verified: the daily kWh figures against the Deye app over a full
  day, and a real bill-cycle rollover.

## Next steps

1. At the end of a day, compare the daily kWh figures (grid import and
   export, solar, battery charge and discharge) with the Deye app. An
   upstream report (issue #38 there) describes kWh values a factor 10 low
   on another model.
2. Enter the first real bill date: when the next electricity bill arrives,
   set its reading date with the Flow action "Set the bill cycle date" or
   the "Next billing cycle start date" setting, and check that "Bill cycle
   ended" fires with the right kWh and cost.
3. Possible improvement: the inverter also reports cumulative counters
   (`CumulativeEnergyPurchased`, `CumulativeGridFeedIn`,
   `TotalActiveProduction`, `TotalChargeEnergy`, `TotalDischargeEnergy`).
   Using them instead of summing the daily counters would survive missed
   polls. Check first that they only increase and match the daily figures.
4. Once the kWh figures are verified, make sure the owner's old setup is
   gone so Energy does not count twice: the Deye Solar Systems devices and
   the virtual "Grid Meter" device (Device Capabilities app). The old Flows
   ("Grid meter: add up grid energy", the two "Grid cost" Flows) were
   already gone on 2026-11-16; one Logic variable remains to check.

## Conventions

- `env.json` holds the DeyeCloud App ID and App Secret. It is git-ignored;
  never commit it or print its values. `env.example.json` is the template.
- Keep maths in `lib/energy_math.ts` and cover it with tests.
- Keep the original developer credited (`contributors` in the manifest,
  README) and the licence GPL-3.0.
- Homey Energy needs totals that only increase; never write a counter that
  resets daily into a `meter_power` capability.
