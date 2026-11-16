# Deye Energy for Homey

Your Deye hybrid inverter as a complete home energy meter in Homey: grid, solar, battery and cost.

This app is a fork of [Deye Solar Systems](https://github.com/heszegi/com.heszi.deye) by Andras Heszegi (GPL-3.0). It talks to the same DeyeCloud API and keeps all of the original Flow cards.

## What this fork adds

- **Grid meter on the inverter device.** The inverter reports grid power and running import/export totals in the way Homey Energy expects, so the Energy tab shows grid usage, home consumption, graphs and cost.
- **Electricity cost.** Set your rate per kWh in the inverter's settings to get *Grid cost today*.
- **Billing cycle.** Set the date your meter was last read to get *Billing cycle energy* and *Billing cycle cost*. The date can be entered after the fact and changed whenever a new cycle starts.
- **Running totals for solar and battery.** Homey Energy needs totals that only ever go up; the inverter only reports "today" counters that reset at midnight. The app adds them up.
- **Solar power on more inverters.** Some models do not report a total solar power field. The app then adds up the PV strings, or works it out from load, grid and battery power.
- **Diagnostics.** The inverter's settings list the fields your inverter reports, to make new models easy to support.

The grid meter and energy totals need the data source set to *Device* (the default).

## Devices

Add all three from the same station: **Inverter**, **Battery** and **Solar panel**.

## Building it yourself

1. Register a free application at <https://developer.deyecloud.com/app> to get an App ID and App Secret. Use the data centre your DeyeCloud account is in.
2. Copy `env.example.json` to `env.json` and fill in your App ID and App Secret.
3. `npm install`
4. `npx homey app install` (or `npx homey app run` to see the logs).

`env.json` is ignored by git. Never commit your App Secret.

## Tests

`npm test` runs the unit tests for the energy maths.

## Licence

GPL-3.0, the same as the original app.
