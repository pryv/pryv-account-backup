const parseDomain = require("parse-domain");

const credentials = {
    username: 'app-node-bkp-test',
    serviceInfoUrl: 'https://reg.pryv.me/service/info',
    auth: 'cit9zsixhcj2135yq7epmn5x5',
    password: 'password'
  };

function extractDomain(url) {
  const parsedDomain = parseDomain(url);
  const domain = parsedDomain.domain + '.' + parsedDomain.tld;
  return domain;
}

module.exports.credentials = credentials;
module.exports.extractDomain = extractDomain;
