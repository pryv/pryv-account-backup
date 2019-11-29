const backup = require('./main');
const config = require('./utils/config.js');
const params = config.get('params');
const { URL } = require('url');
const BackupDirectory = require('./methods/backup-directory');
const parseDomain = require("parse-domain");

let domain;
try { // service info
    const serviceInfoUrl = params.domain;
    new URL(serviceInfoUrl); // Check if serviceInfoUrl is a valid url
    
    const parsedDomain = parseDomain(serviceInfoUrl);
    domain = parsedDomain.domain + '.' + parsedDomain.tld;
}
catch(error) { // domain
    if(error.code !== 'ERR_INVALID_URL') {
        console.error(error);
        return;
    }
    domain = params.domain;
}
params.backupDirectory = new BackupDirectory(params.username, domain);

backup.start(params, () => {
    console.log('Backup complete');
});
