const fs = require('fs');
const https = require('https');

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
  params.extraFileName =  params.extraFileName || '';
  if (!log) {
    log = console.log;
  }

  log('Fetching: ' + params.resource + params.extraFileName + ' in folder: ' + params.folder);
  let outputFilename = null;
  let writeStream = null;


  function openStreamsIfNeeded() {
      if (outputFilename) return;
     outputFilename = params.resource.replace('/', '_').split('?')[0] + params.extraFileName + '.json';
     writeStream = fs.createWriteStream(params.folder  + outputFilename, { encoding: 'utf8' });
  }

  const url = new URL(params.connection.endpoint);

  const options = {
    host: url.hostname,
    port: url.port || 443,
    path: url.pathname + params.resource,
    headers: {'Authorization': connection.token}
  };

  // --- pretty timed log ---//
  const timeRepeat = 1000;
  let total = 0;
  let done = false;
  const timeLog = function() {
    if (done) return;
    log('Fetching ' + outputFilename + ': ' +  prettyPrint(total));
    setTimeout(timeLog, timeRepeat);
  }
  setTimeout(timeLog, timeRepeat);


  https.get(options, function (res) {
    if (res.statusCode != 200) {
      log('Error while fetching https://' + options.host + options.path + ' Code: ' + res.statusCode + ' ' + res.statusMessage);
      done = true;
      callback(res.statusCode);
      return;
    };
    res.setEncoding('utf8');

    res.on('data', function (chunk) {
      openStreamsIfNeeded();
      total += chunk.length;
      writeStream.write(chunk);
    });

    res.on('end', function () {
      openStreamsIfNeeded();
      writeStream.end();
      done = true;
      log('Received: ' + outputFilename + ' '  + prettyPrint(total));
      callback();
    });

  }).on('error', function (e) {
    if (done) return;
    done = true;
    log('Error while fetching https://' + options.host + options.path);
    callback(e);
  });
}

function prettyPrint(total) {
  if (total > 1000000) {
    return Math.round(total / 1000000) + 'MB';
  }
  if (total > 1000) {
    return Math.round(total / 1000) + 'KB';
  }
  return total + 'Bytes';
}