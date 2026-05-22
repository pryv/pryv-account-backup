/*
 * This file serves for debugging purpose.
 * It will launch a backup task without asking the user all the requested information
 * such as username, password, etc.
 * Instead this values are fetched from dev-config.json
 */

const fs = require('fs');
const path = require('path');
const backup = require('../src/main');
const BackupDirectory = require('../src/methods/backup-directory');

// Inline read of dev-config.json (nconf/winston removed in 0.4.0; the
// debug script doesn't need a full config singleton).
const configFile = fs.existsSync('dev-config.json') ? 'dev-config.json' : 'localhost-config.json';
const raw = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'));
const params = raw.params;

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