/*
 * This file serves for debugging purpose.
 * It will launch a backup task without asking the user all the requested information
 * such as domain, username, password, etc.
 * Instead this values are fetched from dev-config.json
 */

const backup = require('./main');
const config = require('./utils/config.js');
const params = config.get('params');
const { URL } = require('url');
const BackupDirectory = require('./methods/backup-directory');
const parseDomain = require("parse-domain");

let domain;
try {
    new URL(params.domain); // Check if params.domain is a valid url
    
    const parsedDomain = parseDomain(params.domain); // it is --> we can extract the domain from it
    domain = parsedDomain.domain + '.' + parsedDomain.tld;
}
catch(error) {
    if(error.code !== 'ERR_INVALID_URL') {
        console.error(error);
        return;
    }
    domain = params.domain; // it is not, use it as a domain
}
params.backupDirectory = new BackupDirectory(params.username, domain);

async function startAll() {
    // await startBackup();
    await startRestore();
}

async function startBackup() {
    await backup.startBackup(params, done.bind(this, 'Backup'));
}

async function startRestore() {
    // params.backupFolder = config.get("backupFolder");
    await backup.startRestore(params, done.bind(this, 'Restore'));
}

function done(str, error) {
    if(error) {
        console.error('Error during ' + str, error);
        return;
    }
    console.log(str + ' completed');
}

startAll();