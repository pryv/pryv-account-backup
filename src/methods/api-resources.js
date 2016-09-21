var fs = require('fs');

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
exports.toJSONFile = function (params, callback) {
  console.log('Fetching: ' + params.resource);
  params.connection.request({
    method: 'GET',
    path: '/' + params.resource,
    callback: function (error, result) {
      if (error) {
        console.log('Failed: ' + params.resource);
        return callback(error);
      }
      saveToFile(params.folder, params.resource, result, callback);
    }
  });
};

/**
 * Saves the data to a JSON file under the name `resource.json` (spaces are converted to
 * underscores) in the provided folder.
 *
 * @param baseDir
 * @param resourceName
 * @param jsonData
 * @param callback
 */
function saveToFile(baseDir, resourceName, jsonData, callback) {
  console.log('saving to folder: ', baseDir);
  var outputFilename = resourceName.replace('/', '_').split('?')[0] + '.json';
  fs.writeFile(baseDir + outputFilename, JSON.stringify(jsonData, null, 4), function (err) {
    if (err) {
      console.error(err);
    } else {
      console.log('JSON saved to ' + baseDir + outputFilename);
    }
    callback(err);
  });
}