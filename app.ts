'use strict';

import Homey from 'homey';
import DeyeAPI from './lib/deye_api';
import type DeyeStationInverter from './drivers/deye_station/devices/deyeStationInverter';

export default class DeyeApp extends Homey.App {
  api!: DeyeAPI;

  readonly updateNotes: { version: string; date: string; changes: string }[] = [];

  async onInit() {
    this.log('MyApp has been initialized');

    this.updateNotes.forEach(note => {
      if (note.version === this.manifest.version) {
        if(this.homey.settings.get('last_update_note') === note.version) return;

        this.homey.settings.set('last_update_note', note.version);
        this.homey.notifications.createNotification({ 
          excerpt: `☀️ Deye Energy (v${note.version}): ${note.changes}`,
        });
      }
    });
    
    this.api = new DeyeAPI();
  }

  /** The inverter the dashboard widgets show: the first one paired. */
  dashboardDevice(): DeyeStationInverter | undefined {
    try {
      const devices = this.homey.drivers.getDriver('deye_station').getDevices();
      return devices.find(d => typeof (d as DeyeStationInverter).getDashboardData === 'function') as DeyeStationInverter | undefined;
    } catch (e) {
      return undefined; // driver not ready yet
    }
  }

  /** Data for the dashboard widgets (their api.js calls this). */
  getDashboardData() {
    const device = this.dashboardDevice();
    return device ? device.getDashboardData() : { ready: false, noDevice: true };
  }

  /** Push fresh data to open widgets. */
  emitDashboard(device: DeyeStationInverter) {
    if (this.dashboardDevice() !== device) return;
    this.homey.api.realtime('deye_update', device.getDashboardData());
  }
}

module.exports = DeyeApp;
