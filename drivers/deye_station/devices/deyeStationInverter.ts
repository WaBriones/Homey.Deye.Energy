import DeyeApp from '../../../app';
import { BATTERY_MODE_CONTROL, BATTERY_PARAMETER, DATA_CENTER, DAYS_OF_WEEK, ENERGY_PATTERN, IDeyeDeviceLatestData, IDeyeDeviceLatestKeyValue, IDeyeStationLatestData, IDeyeStationWithDevice, IDeyeToken, ON_OFF, WORK_MODE } from '../../../lib/deye_api';
import DeyeStationDevice, { ICapabilityList } from '../device';
import { IKeyValue } from '../driver';
import { IAccumulators, IDaySnapshots, accumulate, billForecast, cost, dailyEnergy, cycleEnergy, dayFraction, energyBetween, localDay, toIsoDay, newCycleStart, resetDayFor, rollBillCycle, snapshotDay, solarPower } from '../../../lib/energy_math';

export enum LatestDataSource {
  STATION = 'station',
  DEVICE = 'device'
}

export interface ILatestData {
  type: LatestDataSource;
  lastUpdateTime: number;
  dataTokens: {
    measure_battery: number;
    measure_battery_power: number;
    measure_battery_temperature: number;
    measure_ac_temperature: number;
    measure_consumption_power: number;
    measure_grid_power: number;
    measure_solar_power: number;
    rawJSON: string;
  },
  dailyTokens?: {
    daily_production: number;
    daily_consumption: number;
    daily_sell: number;
    daily_buy: number;
    daily_charge: number;
    daily_discharge: number;
  },
  totals?: {
    imported: number;
    exported: number;
    production: number;
    charged: number;
    discharged: number;
  },
  grid_available?: boolean;
  solar_production: boolean;
  battery_charging: boolean;
  grid_feeding: boolean;
};

export default class DeyeStationInverter extends DeyeStationDevice {
  api = (this.homey.app as DeyeApp).api;
  apiError = 0;

  dataCenter!: DATA_CENTER;
  token!: IDeyeToken;
  station!: IDeyeStationWithDevice;
  normalPollInterval!: number;
  minimumPollInterval!: number;
  latestDataSource!: LatestDataSource;
  lastData!: ILatestData;
  polling?: NodeJS.Timeout;
  electricityRate = 0;
  currency = '';
  billCycleStart = '';
  nextBillCycleStart = '';
  reportedFields = '';

  override async onInit() {
    super.onInit();

    this.dataCenter = this.getSetting('dataCenter');
    this.token = this.getSetting('token');
    this.station = this.getSetting('station');
    this.normalPollInterval = this.getSetting('normalPollInterval');
    this.minimumPollInterval = this.getSetting('minimumPollInterval');
    this.latestDataSource = this.getSetting('latestDataSource');
    this.electricityRate = this.getSetting('electricityRate') || 0;
    this.currency = this.getSetting('currency') || '';
    this.billCycleStart = this.getSetting('billCycleStart') || '';
    this.nextBillCycleStart = this.getSetting('nextBillCycleStart') || '';

    await this.setupCapabilites(
      [],
      [
        { id: 'grid_feeding' },
        { id: 'solar_production'},
        { id: 'battery_charging' },
        { id: 'measure_battery' },
        { id: 'measure_battery_power' },
        { id: 'measure_battery_temperature' },
        { id: 'measure_ac_temperature' },
        { id: 'measure_solar_power' },
        { id: 'measure_consumption_power' },
        { id: 'measure_grid_power' },
        { id: 'owner' },
        { id: 'address' },
      ]
    );
    await this.updateCapabilites();

    const validateStringValues = (value: any): string => {
      return value.toString() === value ? value : this.homey.__('device.inverter.unknown_value');
    }

    this.setAvailableCapabilityValue('address', validateStringValues(this.station.locationAddress));
    this.setAvailableCapabilityValue('owner', validateStringValues(this.station.name));

    if(this.station.deviceTotal > 0 && this.station.deviceListItems.length){
      this.setAvailableCapabilityValue('inverter_sn', validateStringValues(this.station.deviceListItems[0].deviceSn));
    }else{
      this.setAvailableCapabilityValue('inverter_sn', this.homey.__('device.inverter.no_device_sn'));
    }

    this.pollLatest();
  }

  override async onSettings({oldSettings, newSettings, changedKeys}: { oldSettings: IKeyValue; newSettings: IKeyValue; changedKeys: IKeyValue; }): Promise<string | void> {
    super.onSettings({oldSettings, newSettings, changedKeys});

    this.normalPollInterval = newSettings.normalPollInterval as number;
    this.minimumPollInterval = newSettings.minimumPollInterval as number;
    this.latestDataSource = newSettings.latestDataSource as LatestDataSource;
    this.electricityRate = (newSettings.electricityRate as number) || 0;
    this.currency = (newSettings.currency as string) || '';
    this.billCycleStart = (newSettings.billCycleStart as string) || '';
    this.nextBillCycleStart = (newSettings.nextBillCycleStart as string) || '';

    await this.updateCapabilites();

    const pollKeys = ['latestDataSource', 'normalPollInterval', 'minimumPollInterval'];
    if ((changedKeys as unknown as string[]).some(k => pollKeys.includes(k))) {
      this.pollLatest();
    } else {
      this.updateEnergyCapabilities(this.lastData);
    }

    // A next-cycle date of today or earlier applies at once. Settings are only
    // saved after onSettings returns, so roll over just after that.
    if ((changedKeys as unknown as string[]).includes('nextBillCycleStart')) {
      this.homey.setTimeout(() => this.applyBillCycle().catch(this.error), 1000);
    }
  }

  /**
   * Flow action: the date is the first day of the new billing cycle ('start')
   * or the last day of the current one ('end'). A new cycle starting today or
   * earlier starts now; a later one starts by itself on that day.
   */
  async startBillCycle(date: string, which: string) {
    const day = newCycleStart(date, which);
    if (!day) throw new Error(`Not a valid date: ${date}`);
    this.nextBillCycleStart = day;
    await this.setSettings({ nextBillCycleStart: day });
    await this.applyBillCycle();
  }

  /** Start the planned next billing cycle once its date has come, and report the one that ended. */
  async applyBillCycle() {
    const today = localDay(new Date(), this.homey.clock.getTimezone());
    const r = rollBillCycle({ start: this.billCycleStart, next: this.nextBillCycleStart }, today);
    if (r.start === this.billCycleStart && r.next === this.nextBillCycleStart) return;

    const total = this.lastData?.totals?.imported;
    if (r.closed && total === undefined) return; // no data yet; the next poll tries again

    this.billCycleStart = r.start;
    this.nextBillCycleStart = r.next;
    await this.setSettings({ billCycleStart: r.start, nextBillCycleStart: r.next });

    if (r.closed) {
      const energy = energyBetween(this.getStoreValue('importedByDay'), total as number, r.closed.start, r.closed.end);
      this.log(`Bill cycle ${r.closed.start} to ${r.closed.end} ended: ${energy} kWh`);
      await this.driver.billCycleEnded_card.trigger(this, {
        energy,
        cost: cost(energy, this.electricityRate),
        rate: this.electricityRate,
        start: r.closed.start,
        end: r.closed.end
      }, {}).catch(this.error);
    }

    this.updateEnergyCapabilities(this.lastData);
  }

  override async onDeleted() {
    this.homey.clearTimeout(this.polling);
    this.driver.disableChildDevices(this);
  }

  async updateCapabilites(){
    const deviceOnlyCapabilites: ICapabilityList[] = [
      { id: 'daily_production' }, 
      { id: 'daily_consumption' },
      { id: 'daily_buy' },
      { id: 'daily_sell' },
      { id: 'grid_available' },
      // Grid meter: these make the inverter the home's meter in Homey Energy
      { id: 'measure_power', options: {
        title: { en: this.homey.__('device.inverter.measure_power') },
        icon: '/drivers/deye_station/assets/grid_power.svg'
      }},
      { id: 'meter_power.imported', options: {
        title: { en: this.homey.__('device.inverter.meter_power.imported') },
        icon: '/drivers/deye_station/assets/daily_buy.svg'
      }},
      { id: 'meter_power.exported', options: {
        title: { en: this.homey.__('device.inverter.meter_power.exported') },
        icon: '/drivers/deye_station/assets/daily_sell.svg'
      }},
      { id: 'daily_cost' },
      { id: 'bill_cycle_energy' },
      { id: 'bill_cycle_cost' }
    ];

    if(this.latestDataSource === LatestDataSource.DEVICE){
      await this.setupCapabilites([], deviceOnlyCapabilites);
      await this.setEnergy({
        cumulative: true,
        cumulativeImportedCapability: 'meter_power.imported',
        cumulativeExportedCapability: 'meter_power.exported'
      }).catch(this.error);
      await this.updateCurrencyUnits();
    }else{
      await this.setupCapabilites(deviceOnlyCapabilites, []);
      await this.setEnergy({}).catch(this.error);
    }
  }

  async updateCurrencyUnits() {
    for (const id of ['daily_cost', 'bill_cycle_cost']) {
      if (!this.hasCapability(id)) continue;
      try {
        const current = this.getCapabilityOptions(id) as IKeyValue;
        if (current?.units?.en === this.currency) continue;
      } catch (e) {
        // no options set yet
      }
      await this.setCapabilityOptions(id, { units: { en: this.currency } }).catch(this.error);
    }
  }

  /**
   * Turn the inverter's daily counters into running totals, keep a snapshot
   * per day, and work out today's cost and the billing-cycle figures.
   */
  updateEnergyTotals(latest: ILatestData) {
    if (latest.type !== LatestDataSource.DEVICE || !latest.dailyTokens) return;

    const day = localDay(new Date(), this.homey.clock.getTimezone());
    const acc: IAccumulators = { ...(this.getStoreValue('accumulators') || {}) };
    const daily = latest.dailyTokens;

    const importedBefore = acc.imported;
    acc.imported = accumulate(acc.imported, daily.daily_buy, day);
    acc.exported = accumulate(acc.exported, daily.daily_sell, day);
    acc.production = accumulate(acc.production, daily.daily_production, day);
    acc.charged = accumulate(acc.charged, daily.daily_charge, day);
    acc.discharged = accumulate(acc.discharged, daily.daily_discharge, day);
    this.setStoreValue('accumulators', acc).catch(this.error);

    const days: IDaySnapshots = snapshotDay(this.getStoreValue('importedByDay'), day, importedBefore, acc.imported, daily.daily_buy, resetDayFor(new Date(), this.homey.clock.getTimezone()));
    this.setStoreValue('importedByDay', days).catch(this.error);

    latest.totals = {
      imported: acc.imported.total,
      exported: acc.exported.total,
      production: acc.production.total,
      charged: acc.charged.total,
      discharged: acc.discharged.total
    };
  }

  updateEnergyCapabilities(latest?: ILatestData) {
    if (!latest || latest.type !== LatestDataSource.DEVICE || !latest.totals || !latest.dailyTokens) return;

    const cycle = cycleEnergy(this.getStoreValue('importedByDay'), latest.totals.imported, this.billCycleStart);

    this.setAvailableCapabilityValue('measure_power', latest.dataTokens.measure_grid_power);
    this.setAvailableCapabilityValue('meter_power.imported', latest.totals.imported);
    this.setAvailableCapabilityValue('meter_power.exported', latest.totals.exported);
    this.setAvailableCapabilityValue('daily_cost', cost(latest.dailyTokens.daily_buy, this.electricityRate));
    this.setAvailableCapabilityValue('bill_cycle_energy', cycle);
    this.setAvailableCapabilityValue('bill_cycle_cost', cost(cycle, this.electricityRate));
  }

  /** Everything the dashboard widgets show, as plain numbers (null when not reported). */
  getDashboardData(): IKeyValue {
    const d = this.lastData;
    if (!d) return { ready: false, name: this.getName() };

    const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);
    const data: IKeyValue = {
      ready: true,
      name: this.getName(),
      updated: d.lastUpdateTime,
      currency: this.currency,
      rate: num(this.electricityRate) || 0,
      power: {
        solar: num(d.dataTokens.measure_solar_power),
        grid: num(d.dataTokens.measure_grid_power),       // above 0: buying from the grid
        battery: num(d.dataTokens.measure_battery_power), // above 0: discharging
        load: num(d.dataTokens.measure_consumption_power)
      },
      soc: num(d.dataTokens.measure_battery),
      gridAvailable: d.grid_available ?? null,
      today: null,
      bill: null,
      calendar: null
    };

    if (d.type === LatestDataSource.DEVICE && d.dailyTokens && d.totals) {
      data.today = {
        production: num(d.dailyTokens.daily_production),
        consumption: num(d.dailyTokens.daily_consumption),
        buy: num(d.dailyTokens.daily_buy),
        sell: num(d.dailyTokens.daily_sell),
        cost: cost(d.dailyTokens.daily_buy, this.electricityRate)
      };

      const days: IDaySnapshots | undefined = this.getStoreValue('importedByDay');
      const firstDay = Object.keys(days || {}).sort()[0];
      const timeZone = this.homey.clock.getTimezone();
      const now = new Date();
      const energy = cycleEnergy(days, d.totals.imported, this.billCycleStart);
      const forecast = billForecast(energy, toIsoDay(this.billCycleStart) || firstDay, this.nextBillCycleStart, localDay(now, timeZone), dayFraction(now, timeZone), firstDay);
      data.bill = {
        energy,
        cost: cost(energy, this.electricityRate),
        forecast: forecast && {
          ...forecast,
          perDayCost: forecast.perDay === null ? null : cost(forecast.perDay, this.electricityRate),
          projectedCost: forecast.projected === null ? null : cost(forecast.projected, this.electricityRate)
        }
      };

      // per-day grid energy and cost for the calendar widget: { day: [kWh, cost] }
      const today = localDay(now, timeZone);
      const perDay: IKeyValue = {};
      Object.entries(dailyEnergy(days, d.totals.imported, today)).forEach(([day, kwh]) => {
        perDay[day] = [kwh, cost(kwh, this.electricityRate)];
      });
      data.calendar = { today, days: perDay, cycleStart: toIsoDay(this.billCycleStart) };
    }

    return data;
  }

  emitDashboard() {
    try {
      (this.homey.app as DeyeApp).emitDashboard(this);
    } catch (e) {
      this.error(e);
    }
  }

  /** Show which fields the inverter reports, in the device's settings, to help support new models. */
  updateReportedFields(data: IDeyeDeviceLatestData, solarSource: string) {
    const fields = `Solar power from: ${solarSource}. Fields: ` + data.dataList.map(i => i.key).filter(k => !!k).join(', ');
    if (fields === this.reportedFields) return;
    this.reportedFields = fields;
    this.log(fields);
    this.setSettings({ reportedFields: fields }).catch(this.error);
  }

  async pollLatest() {
    this.homey.clearTimeout(this.polling);

    let latest: ILatestData;

    try {
      latest = this.latestDataSource === LatestDataSource.DEVICE ? 
        this.getLatestDataFromDevice(await this.api.getDeviceLatest(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn)) :
        this.getLatestDataFromStation(await this.api.getStationLatest(this.dataCenter, this.token, this.station.id));
      
      this.apiError = 0;
      this.setAvailable();
    } catch (err) {
      this.log('Get latest error: ', err);
      this.log('Data center: ', this.dataCenter);
      this.log('Latest Data source: ', this.latestDataSource);
      this.log('Debug station data: ', JSON.stringify(this.station));
  
      if (++this.apiError < 61) {
        const pollDelay = this.minimumPollInterval * this.apiError;
        this.polling = this.homey.setTimeout(this.pollLatest.bind(this), pollDelay * 1000);

        if(this.apiError > 2){
          this.setUnavailable(this.homey.__('device.inverter.retrie',{delay: pollDelay, count: this.apiError}));
        }
      } else {
        this.log('Reached max number of API call tries!');
        this.setUnavailable(this.homey.__('device.inverter.max_retries_reached'));
      }
      
      return;
    }

    if (!this.lastData || this.lastData.lastUpdateTime < latest.lastUpdateTime) {
      this.setAvailableCapabilityValue('grid_available', latest.grid_available);
      this.setAvailableCapabilityValue('solar_production', latest.solar_production);
      this.setAvailableCapabilityValue('battery_charging', latest.battery_charging);
      this.setAvailableCapabilityValue('grid_feeding', latest.grid_feeding);

      Object.entries(latest.dataTokens).forEach(capability => this.setAvailableCapabilityValue(capability[0], capability[1]));
      this.driver.measuredDataUpdated_card.trigger(this, this.cleanTokens(latest.dataTokens), {}).catch(this.error);

      if (latest.type === LatestDataSource.DEVICE && latest.dailyTokens) {
        Object.entries(latest.dailyTokens).forEach(capability => this.setAvailableCapabilityValue(capability[0], capability[1]));
        this.driver.dailyDataUpdated_card.trigger(this, this.cleanTokens(latest.dailyTokens), {}).catch(this.error);

        this.updateEnergyTotals(latest);
        this.updateEnergyCapabilities(latest);
      }

      this.lastData = latest;

      this.driver.updateChildDevices(this);
    }

    this.applyBillCycle().catch(this.error).then(() => this.emitDashboard());

    const tillNext = (latest.lastUpdateTime + this.normalPollInterval) - Math.floor(Date.now() / 1000);
    const pollDelay = (tillNext <= 0 ? this.minimumPollInterval : tillNext);
    this.polling = this.homey.setTimeout(this.pollLatest.bind(this), pollDelay * 1000);
  }

  /** Flow tokens must be real numbers: a field the inverter does not report becomes 0 instead of breaking the Flow. */
  cleanTokens<T extends IKeyValue>(tokens: T): T {
    const clean: IKeyValue = {};
    Object.entries(tokens).forEach(([key, value]) => {
      clean[key] = (typeof value === 'number' && !isFinite(value)) ? 0 : value;
    });
    return clean as T;
  }

  getLatestDataFromStation(data: IDeyeStationLatestData): ILatestData {
    const validateNumberValues = (value: any): number => {
      return isNaN(value) ? NaN : value;
    }

    const latest: ILatestData = {
      type: LatestDataSource.STATION,
      lastUpdateTime: data.lastUpdateTime,
      dataTokens: {
        measure_battery: validateNumberValues(data.batterySOC),
        measure_battery_power: validateNumberValues(data.batteryPower),
        measure_consumption_power: validateNumberValues(data.consumptionPower),
        measure_grid_power: validateNumberValues(data.wirePower),
        measure_solar_power: validateNumberValues(data.generationPower)
      }
    } as ILatestData;

    latest.solar_production = latest.dataTokens.measure_solar_power > 0;
    latest.battery_charging = data.chargePower < 0 && latest.dataTokens.measure_battery < 99;
    latest.grid_feeding = latest.dataTokens.measure_grid_power < 0;

    return latest;
  }

  getLatestDataFromDevice(data: IDeyeDeviceLatestData): ILatestData {
    const getDeviceLatestKeyValue = (data:IDeyeDeviceLatestData, key: string): IDeyeDeviceLatestKeyValue<number> => {
      const keyValue = data.dataList.find(item => item.key === key) || {key: key, value: '', unit: ''};
      return {...keyValue, value: parseFloat(keyValue.value)};
    }

    const latest = {
      type: LatestDataSource.DEVICE,
      lastUpdateTime: data.collectionTime,
      dataTokens: {
        measure_battery: getDeviceLatestKeyValue(data, "SOC").value,
        measure_battery_power: getDeviceLatestKeyValue(data, "BatteryPower").value,
        measure_battery_temperature: getDeviceLatestKeyValue(data, "Temperature- Battery").value,
        measure_ac_temperature: getDeviceLatestKeyValue(data, "AC Temperature").value,
        measure_consumption_power: getDeviceLatestKeyValue(data, "TotalConsumptionPower").value,
        measure_grid_power: getDeviceLatestKeyValue(data, "TotalGridPower").value,
        measure_solar_power: NaN,
        rawJSON: JSON.stringify(data)
      },
      dailyTokens: {
        daily_production: getDeviceLatestKeyValue(data, "DailyActiveProduction").value,
        daily_consumption: getDeviceLatestKeyValue(data, "DailyConsumption").value,
        daily_sell: getDeviceLatestKeyValue(data, "DailyGridFeedIn").value,
        daily_buy: getDeviceLatestKeyValue(data, "DailyEnergyPurchased").value,
        daily_charge: getDeviceLatestKeyValue(data, "DailyChargingEnergy").value,
        daily_discharge: getDeviceLatestKeyValue(data, "DailyDischargingEnergy").value
      }
    } as ILatestData;

    const solar = solarPower(data.dataList, latest.dataTokens.measure_consumption_power, latest.dataTokens.measure_grid_power, latest.dataTokens.measure_battery_power);
    latest.dataTokens.measure_solar_power = solar.value;
    this.updateReportedFields(data, solar.source);

    latest.grid_available = getDeviceLatestKeyValue(data, "GridFrequency").value > 0;
    latest.solar_production = latest.dataTokens.measure_solar_power > 0;
    latest.battery_charging = latest.dataTokens.measure_battery_power < 0 && latest.dataTokens.measure_battery < 99;
    latest.grid_feeding = latest.dataTokens.measure_grid_power < 0;

    return latest;
  }

  // Solar Sell

  async setMaxSellPower(value: number) {
    return this.api.setMaxSellPower(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, value);
  }

  async setSolarSell(value: ON_OFF) {
    return this.api.setSolarSell(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, value);
  }

  // Work Mode

  async setWorkMode(value: WORK_MODE) {
    return this.api.setWorkMode(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, value);
  }

  // Energy Pattern

  async setEnergyPattern(value: ENERGY_PATTERN) {
    return this.api.setEnergyPattern(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, value);
  }

  // Peak Shaving

  async setGridPeakShaving(action: ON_OFF, power: number) {
    return this.api.setGridPeakShaving(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, action, power);
  }

  // Time Of Use

  async setTimeOfUseAction(days: (DAYS_OF_WEEK | 'NEVER')[]) {
    let action = ON_OFF.ON;
    if(days.includes('NEVER')){
      action = ON_OFF.OFF;
      days = days.filter(d => d !== 'NEVER');
    }
    return this.api.setTimeOufUseAction(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, action, days as DAYS_OF_WEEK[]);
  }
  
  async setTimeUseSettingItems(timeslot: string[], onoff_grid: ON_OFF, onoff_gen: ON_OFF, power: number, soc: number) {
    const current = await this.api.getTimeOfUse(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn);

    timeslot.forEach(t => {
      current.timeUseSettingItems[parseInt(t)] = {
        ...current.timeUseSettingItems[parseInt(t)],
        enableGridCharge: onoff_grid === ON_OFF.ON,
        enableGeneration: onoff_gen === ON_OFF.ON,
        power,
        soc
      };
    });
    current.timeUseSettingItems.forEach(item => item.time = item.time.slice(0, 2) + ':' + item.time.slice(2, 4)); // API wants HH:MM format

    const ret = await this.api.setTimeUseSettingItems(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, current.timeUseSettingItems);
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds to let the inverter process the new settings
    return ret;
  }

  // Battery Mode Controls

  async setBatteryGridCharge(value: ON_OFF) {
    return this.api.setBatteryModeControl(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, BATTERY_MODE_CONTROL.GRID_CHARGE, value);
  }
  
  async setBatteryGenCharge(value: ON_OFF) {
    return this.api.setBatteryModeControl(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, BATTERY_MODE_CONTROL.GEN_CHARGE, value);
  }

  // Battery Paramters

  async setBatteryMaxDischargeCurrent(value: number) {
    return this.api.setBatteryParamater(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, BATTERY_PARAMETER.MAX_DISCHARGE_CURRENT, value);
  }

  async setBatteryMaxChargeCurrent(value: number) {
    return this.api.setBatteryParamater(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, BATTERY_PARAMETER.MAX_CHARGE_CURRENT, value);
  }

  async setBatteryLow(value: number) {
    return this.api.setBatteryParamater(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, BATTERY_PARAMETER.BATT_LOW, value);
  }

  async setBatteryGridChargeCurrent(value: number) {
    return this.api.setBatteryParamater(this.dataCenter, this.token, this.station.deviceListItems[0].deviceSn, BATTERY_PARAMETER.GRID_CHARGE_AMPERE, value);
  }
}
