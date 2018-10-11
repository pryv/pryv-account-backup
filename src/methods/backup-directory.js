var mkdirp = require('mkdirp'),
    fs = require('fs'),
    async = require('async');

/**
 * Object containing backup directories and files object as well as the function to generate them
 *
 * @param username
 * @param domain
 */
var BackupDirectory = module.exports = function (username, domain, dir) {
  var rootDir = dir || './backup/';
  this.baseDir = rootDir + username + '.' + domain + '/';
  this.attachmentsDir = this.baseDir + 'attachments/';
  this.appProfilesDir = this.baseDir + 'app_profiles/';
  this.eventsFile = this.baseDir + 'events.json';
  this.accessesFile = this.baseDir + 'accesses.json';
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
  async.series([
    function createBaseDir(stepDone) {
      mkdirp(this.baseDir, function (err) {
        if (err) {
          console.error('Error while creating base dir: ' + this.baseDir, err);
          stepDone(err);
        }
        stepDone();
      });
    }.bind(this),
    function createAppProfileDir(stepDone) {
      mkdirp(this.appProfilesDir, function (err) {
        if (err) {
          console.error('Error while creating accesses dir: ' + this.appProfilesDir, err);
          stepDone(err);
        }
        stepDone();
      });
    }.bind(this),
    function createAttachmentsDir(stepDone) {
      mkdirp(this.attachmentsDir, function (err) {
        if (err) {
          console.error('Error while creating attachments dir: ' + this.attachmentsDir, err);
          stepDone(err);
        }
        stepDone();
      }.bind(this));
    }.bind(this)
  ], callback);
};

/**
 * Delete backup directories
 * @param callback
 */
BackupDirectory.prototype.deleteDirs = function (callback) {
  if(fs.existsSync(this.baseDir)) {
    var exec = require('child_process').exec;
    exec('rm -r ' + this.baseDir, callback);
  } else {
    callback();
  }
};