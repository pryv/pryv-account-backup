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

  const apiUrl = 'https://' + connection.username + '.' + connection.settings.domain + '/';
  const backupFolder = params.backupFolder;
  const attachementBasePath = backupFolder.baseDir + 'attachments/';
  const resource = params.resource.replace(/\?.*/g, '');
  const jsonFile = backupFolder.baseDir + resource + '.json';
  const stream = fs.createReadStream(jsonFile, {encoding: 'utf8'});
  batchSize = 500;
  parseJsonAndPost(stream, resource, batchSize, apiUrl, connection.auth, attachementBasePath, callback);
}

function parseJsonAndPost(stream, resource, batchSize, apiUrl, token, attachementBasePath, callback) {
  const batchRequest = [];
  const eventWithAttachments = [];
  stream.pipe(JSONStream.parse(resource + '.*'))
    .on('data', (item) => {

      if(item.attachments) {
        eventWithAttachments.push(item);
      } else {
        if(resource.indexOf('events') >= 0) {
          delete item.id; // Only delete event id
        }
        batchRequest.push({
          'method': resource + '.create',
          'params': item
        });
  
        if(batchRequest.length >= batchSize) {
          batchCall(apiUrl, token, batchRequest, resource, null);
          batchRequest.length = 0;
        }
      }
    })
    .on('error', (error) => {
      console.error(error);
      return callback(error);
    })
    .on('end', () => {
      const cb = callback;
      if(batchRequest.length > 0) {
        if(eventWithAttachments.length > 0) {
          callback = null;
        }
        batchCall(apiUrl, token, batchRequest, resource, callback);
        batchRequest.length = 0;
      }
      if(eventWithAttachments.length > 0) {
        postEventWithAttachments(apiUrl, token, eventWithAttachments, attachementBasePath, cb);
      }
    }); 
}

function batchCall(apiUrl, token, batchRequest, resource, callback) {
  console.log('Restoring ' + batchRequest.length + ' ' + resource);
  superagent.post(apiUrl)
    .set('Authorization', token)
    .set('Content-Type', 'application/json')
    .send(batchRequest)
    .end(function (err, res) {
      if(err) {
        console.error(err);
      }
      const results = res.body.results;
      let nbOk = 0;
      let nbKo = 0;
      results.forEach(result => {
        if(result.error) {
          console.error('\t' + result.error.message);
          nbKo++;
        } else {
          nbOk++;
        }
      });
      if(nbOk > 0) {
        console.info('\t' + nbOk + ' ' + resource + ' restored');
      }
      if(nbKo > 0) {
        console.warn('\t' + nbKo + ' ' + resource + ' not restored (see errors above)');
      }
      if(callback) {
        callback();
      }
    });
}

function postEventWithAttachments(apiUrl, token, eventWithAttachments, attachementBasePath, callback) {
  apiUrl = apiUrl + 'events';

  eventWithAttachments.forEach((event) => {
    const attachments = event.attachments;
    const eventId = event.id;
    delete event.attachments;
    delete event.id;

    const req = superagent.post(apiUrl)
      .set('Authorization', token)
      .field('event', JSON.stringify(event));
    
    attachments.forEach((attachment)=> {
      req.attach('', attachementBasePath + eventId + '_' + attachment.fileName);
    });

    req.end(function (err, res) {
      if(err) {
        console.error(err);
      } else {
        console.log(res.body.event.attachments.length + ' file(s) attached');
        res.body.event.attachments.forEach((attachement) => {
          console.log('\t' + attachement.fileName);
        });
      }
    });
  });
  callback();
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