// @flow

//Dependencies

const nconf = require('nconf');
const logger = require('winston');
const fs = require('fs');

//Exports

module.exports = nconf;

//Setup nconf to use (in-order):
//1. Command-line arguments
//2. Environment variables

nconf.argv()
    .env();

//3. A file located at ..
var configFile =
    fs.existsSync('dev-config.json') ? 'dev-config.json': 'localhost-config.json';
if (typeof(nconf.get('config')) !== 'undefined') {
    configFile = nconf.get('config');
}

if (fs.existsSync(configFile)) {
    configFile = fs.realpathSync(configFile);
    logger.info('using custom config file: ' + configFile);
} else {
    logger.error('Cannot find custom config file: ' + configFile);
}

nconf.file({ file: configFile});
nconf.defaults({
    pryv: {
        'domain': 'pryv.me',
        'serviceInfoUrl': 'https://reg.pryv.me/service/info'
    }
});