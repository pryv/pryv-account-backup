var mkdirp = require('mkdirp'),
    fs = require('fs'),
    rmdir = require('rmdir'),
    async = require('async');

/**
 * Object containing backup directories and files object as well as the function to generate them
 *
 * @param username
 * @param domain
 */
var BackupDirectory = module.exports = function (username, domain) {
  this.baseDir = './backup/' + username + '.' + domain + '/';
  this.attachmentsDir = this.baseDir + 'attachments/';
  this.eventsFile = this.baseDir + 'events.json';
};

/**
 * Creates the directories where the backup files will be stored:
 *
 * out/
 *  username.domain/
 *    attachments/
 *    events.json
 *    *.json
 *
 * @param callback
 */
BackupDirectory.prototype.createDirs = function (callback) {

  // TODO clean caller specification
  var that = this;

  async.series([
    function createBaseDir(stepDone) {
      mkdirp(that.baseDir, function (err) {
        if (err) {
          console.error('Failed creating ' + that.baseDir, err);
          stepDone(err);
        }
        stepDone();
      });
    },
    function createAttachmentsDir(stepDone) {
      mkdirp(that.attachmentsDir, function (err) {
        if (err) {
          console.error('Failed creating ' + that.attachmentsDir, err);
          stepDone(err);
        }
        stepDone();
      });
    }
  ], function (err) {
    if (err) {
      return callback(err);
    }
    callback();
  });
};

/**
 * Delete backup directories
 * @param callback
 */
BackupDirectory.prototype.deleteDirs = function (callback) {

  // TODO clean caller specification
  var that = this;

  if(fs.existsSync(that.baseDir)) {
    rmdir(that.baseDir, function (err) {
      callback(err);
    });
  } else {
    callback();
  }
}