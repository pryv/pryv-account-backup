/*
 * This file serves for debugging purpose.
 * It will launch a backup task without asking the user all the requested information
 * such as domain, username, password, etc.
 * Instead this values are fetched from dev-config.json
 */

const backup = require('../src/main');
const config = require('../src/utils/config.js');
const params = config.get('params');
const { URL } = require('url');
const BackupDirectory = require('../src/methods/backup-directory');
const parseDomain = require("parse-domain");

try {
    new URL(params.serviceInfoUrl); // Check if params.domain is a valid url
    
    const parsedDomain = parseDomain(params.serviceInfoUrl); // it is --> we can extract the domain from it
    params.domain = parsedDomain.domain + '.' + parsedDomain.tld;
}
catch(error) {
    console.error(error);
    return;
}

params.backupDirectory = new BackupDirectory(params.username, params.domain);
backup.start(params, () => {
    console.log('Backup completed');
});