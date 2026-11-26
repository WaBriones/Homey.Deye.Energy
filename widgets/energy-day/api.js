'use strict';

module.exports = {
  async getDay({ homey, query, body }) {
    return homey.app.getDayHistory((body && body.date) || (query && query.date));
  },
};
