var fs = require('fs');
var https = require('https');


/**
 * Downloads the requested Pryv API resource and saves it to a local file under the name
 * `resource.json`.
 *
 * @param params {object}
 *        params.connection {pryv.Connection}
 *        params.resource {string} Pryv API resource name
 *        params.baseDir {string} directory containing user backup data
 * @param callback
 */
exports.toJSONFile = function streamApiToFile(params, callback, log) {
  connection = params.connection;
  if (!log) {
    log = console.log;
  }

  log('Fetching: ' + params.resource);
  var outputFilename = params.resource.replace('/', '_').split('?')[0] + '.json';

  var writeStream = fs.createWriteStream(params.folder  + outputFilename, { encoding: 'utf8' });


  var options = {
    host: connection.username + '.' + connection.settings.domain,
    port: connection.settings.port,
    path: '/' + params.resource,
    headers: {'Authorization': connection.auth}
  };

  var total = 0;
  https.get(options, function (res) {
    res.setEncoding('utf8');

    res.on('data', function (chunk) {
      total += chunk.length;
      log('Received ' + outputFilename + ': ' + total + ' chars');
      writeStream.write(chunk);
    });

    res.on('end', function () {
      writeStream.end();
      log('Done: ' + outputFilename);
      callback();
    });

  }).on('error', function (e) {
    log('Error while fetching https://' + options.host + options.path);
    callback(e);
  });
}