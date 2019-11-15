const backup = require('./main');
const config = require('./utils/config.js');
const params = config.get('params');
backup.start(params);