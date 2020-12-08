/*
 * This file serves for debugging purpose.
 * It will launch a backup task without asking the user all the requested information
 * such as username, password, etc.
 * Instead this values are fetched from dev-config.json
 */

const backup = require('../src/main');
const config = require('../src/utils/config.js');
const params = config.get('params');
const { URL } = require('url');
const BackupDirectory = require('../src/methods/backup-directory');

try {
    new URL(params.serviceInfoUrl); // Check if params.serviceInfoUrl is a valid url
}
catch(error) {
    console.error(error);
    return;
}

params.backupDirectory = new BackupDirectory(params.username);
backup.start(params, () => {
    console.log('Backup completed');
});