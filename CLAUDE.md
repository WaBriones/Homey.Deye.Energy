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
- `test/energy_math.test.ts`: unit tests, run with `npm test`.

Accumulators and day snapshots live in the inverter device's store
(`accumulators`, `importedByDay`).

## Status

- Compiles, passes `homey app validate --level publish`, 20 unit tests pass.
- NOT yet run on a real Homey or against the DeyeCloud API.

## Next steps

1. `npm install`, `npx homey login`, `npx homey app run` (shows logs) or
   `npx homey app install`.
2. In Homey add all three devices (inverter, battery, solar panel) from the
   same station, data centre "Europe, Africa, or the Asia-Pacific".
3. Check the inverter's settings, "Fields reported by the inverter", and the
   log line that starts "Solar power from:". If solar comes from
   "energy balance", look for a better field in the list and add it to
   `solarPower()` in `lib/energy_math.ts`, with a test.
4. Check Homey's Energy tab: grid, home, solar and battery should show kWh,
   graphs and cost. Verify the daily kWh figures against the Deye app; an
   upstream report (issue #38 there) describes kWh values a factor 10 low
   on another model.
5. Once verified, the owner's old setup should be removed so Energy does not
   count twice: the Deye Solar Systems devices, the virtual "Grid Meter"
   device (Device Capabilities app), the Flow "Grid meter: add up grid
   energy", the two "Grid cost" Flows and their Logic variables.

## Conventions

- `env.json` holds the DeyeCloud App ID and App Secret. It is git-ignored;
  never commit it or print its values. `env.example.json` is the template.
- Keep maths in `lib/energy_math.ts` and cover it with tests.
- Keep the original developer credited (`contributors` in the manifest,
  README) and the licence GPL-3.0.
- Homey Energy needs totals that only increase; never write a counter that
  resets daily into a `meter_power` capability.
