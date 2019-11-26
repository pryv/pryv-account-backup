const fs = require('fs');
const https = require('https');
const superagent = require('superagent');
const JSONStream = require('JSONStream');

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

  log('Fetching: ' + params.resource + params.extraFileName );
  let outputFilename = null;
  let writeStream = null;

  function openStreamsIfNeeded() {
      if (outputFilename) return;
     outputFilename = params.resource.replace('/', '_').split('?')[0] + params.extraFileName + '.json';
     writeStream = fs.createWriteStream(params.folder  + outputFilename, { encoding: 'utf8' });
  }


  const options = {
    host: connection.username + '.' + connection.settings.domain,
    port: connection.settings.port,
    path: '/' + params.resource,
    headers: {'Authorization': connection.auth}
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

exports.fromJSONFile = function streamFileToApi(params, callback, log) {
  connection = params.connection;
  params.extraFileName =  params.extraFileName || '';
  if (!log) {
    log = console.log;
  }

  log('Fetching: ' + params.resource + params.extraFileName );
  let outputFilename = null;
  let writeStream = null;

  function openStreamsIfNeeded() {
    if (outputFilename){
      return;
    }
    outputFilename = params.resource.replace('/', '_').split('?')[0] + params.extraFileName + '.json';
    writeStream = fs.createWriteStream(params.folder  + outputFilename, { encoding: 'utf8' });
  }

  const apiUrl = 'https://' + connection.username + '.' + connection.settings.domain + '/events';

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

  const backupFolder = params.backupFolder;
  const fileName = params.resource.replace(/\?.*/g, '');

  const jsonFile = backupFolder + fileName + '.json';
  const stream = fs.createReadStream(jsonFile, {encoding: 'utf8'});

  stream.pipe(JSONStream.parse('events.*'))
    .on('data', (event) => {
      delete event.attachments;
      delete event.id;
      console.log(JSON.stringify(event, null, 2));
      superagent.post(apiUrl)
        .set('Authorization', connection.auth)
        .set('Content-Type', 'application/json')
        .send(event)
        .end(function (err, res) {
          if(err) {
            callback(err);
          }
          console.log(res);
        });
    })
    .on('error', (error) => {
      console.error(error);
      return callback(error);
    })
    .on('end', () => {
      return callback();
    });
  // return callback();

  // https.get(options, function (res) {
  //   if (res.statusCode != 200) {
  //     log('Error while fetching https://' + options.host + options.path + ' Code: ' + res.statusCode + ' ' + res.statusMessage);
  //     done = true;
  //     callback(res.statusCode);
  //     return;
  //   };
  //   res.setEncoding('utf8');

  //   res.on('data', function (chunk) {
  //     openStreamsIfNeeded();
  //     total += chunk.length;
  //     writeStream.write(chunk);
  //   });

  //   res.on('end', function () {
  //     openStreamsIfNeeded();
  //     writeStream.end();
  //     done = true;
  //     log('Received: ' + outputFilename + ' '  + prettyPrint(total));
  //     callback();
  //   });

  // }).on('error', function (e) {
  //   if (done) return;
  //   done = true;
  //   log('Error while fetching https://' + options.host + options.path);
  //   callback(e);
  // });
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