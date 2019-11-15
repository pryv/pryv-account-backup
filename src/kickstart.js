const backup = require('./main');
const config = require('./utils/config.js');
const params = config.get('params');
const BackupDirectory = require('./methods/backup-directory');
let domain;
try { // service info
    url = new URL(params.domain);
    domain = url.hostname;
}
catch(error) { // domain
    domain = params.domain;
}
params.backupDirectory = new BackupDirectory(params.username, domain);

async function start() {
    await backup.start(params, done);
}

function done() {
    console.log('The End');
}

start();