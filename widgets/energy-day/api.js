'use strict';

module.exports = {
  async getDay({ homey, query }) {
    return homey.app.getDayHistory(query && query.date);
  },
};
