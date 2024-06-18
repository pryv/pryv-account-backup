const mkdirp = require('mkdirp');
const fs = require('fs');
const async = require('async');
const path = require('path');

/**
 * Object containing backup directories and files object as well as the function to generate them
 *
 * @param apiEndpoint
 */
const BackupDirectory = module.exports = function (apiEndpoint, dir) {
  const rootDir = dir || path.resolve(__dirname, '../../backup/');
  const url = new URL(apiEndpoint);
  const base = url.hostname + url.pathname.split('/').join('_');
  this.settingAttachmentUseStreamsPath = true;
  this.baseDir = path.resolve(rootDir, base) + '/';
  this.attachmentsDir = path.resolve(this.baseDir, 'attachments') + '/';
  this.appProfilesDir = path.resolve(this.baseDir, 'app_profiles') + '/';
  this.eventsFile = path.resolve(this.baseDir, 'events.json');
  this.streamsFile = path.resolve(this.baseDir, 'streams.json');
  this.accessesFile = path.resolve(this.baseDir, 'accesses.json');
  this.streamsMap = {}; // cache for stream structure if to store data attachement into it
};

/**
 * 
 * @param {*} callback 
 * @param {*} log 
 */
BackupDirectory.prototype.getAttachmentFilePath = function (
  attachmentFileName,
  eventId,
  streamId
) {
  const attName = eventId + '_' + attachmentFileName;
  let attFile = path.resolve(this.attachmentsDir, attName);
  if (this.settingAttachmentUseStreamsPath) {
    let streamPath = this.streamsMap[streamId];
    if (streamPath) {
      const attPath = path.resolve(this.attachmentsDir + streamPath);
      mkdirp.sync(attPath);
      attFile = path.resolve(attPath, attName);
    }
  }
  return attFile;
};

/**
 * Creates the directories where the backup files will be stored:
 *
 * out/
 *  apiEndpoint/
 *    attachments/
 *    events.json
 *    *.json
 *
 * @param callback
 */
BackupDirectory.prototype.createDirs = function (callback, log) {
  if (!log) {
    log = console.log;
  }
  async.series([
    function createBaseDir(stepDone) {
      mkdirp(this.baseDir).then(function (res, err){
        if (err) {
          console.error('Error while creating base dir: ' + this.baseDir, err);
          return stepDone(err);
        }
        log('Directories: created base dir > ' + this.baseDir);
        stepDone();
      }.bind(this));
    }.bind(this),
    function createAppProfileDir(stepDone) {
      mkdirp(this.appProfilesDir).then(function (res, err){
        if (err) {
          console.error('Error while creating accesses dir: ' + this.appProfilesDir, err);
          return stepDone(err);
        }
        log('Directories: appProfilesDir');
        stepDone();
      }.bind(this));
    }.bind(this),
    function createAttachmentsDir(stepDone) {
      mkdirp(this.attachmentsDir).then(function (res, err){
        if (err) {
          console.error('Error while creating attachments dir: ' + this.attachmentsDir, err);
          return stepDone(err);
        }

        log('Directories: attachmentsDir');
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
    const exec = require('child_process').exec;
    exec('rm -r ' + this.baseDir, callback);
  } else {
    callback();
  }
};