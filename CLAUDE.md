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
- `test/energy_math.test.ts`: unit tests, run with `npm test`.

Accumulators and day snapshots live in the inverter device's store
(`accumulators`, `importedByDay`).

## Status

- Compiles, passes `homey app validate --level publish`, 25 unit tests pass.
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
