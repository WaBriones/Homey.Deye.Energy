'use strict';

module.exports = {
  async getData({ homey }) {
    return homey.app.getDashboardData();
  },

  async getDay({ homey, query }) {
    return homey.app.getDayHistory(query && query.date);
  },
};
