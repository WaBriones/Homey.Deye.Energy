'use strict';

import Homey from 'homey';
import DeyeAPI from './lib/deye_api';

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
}

module.exports = DeyeApp;
