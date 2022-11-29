# Pryv.io account backup

<!--
[![Build Status](https://travis-ci.org/pryv/pryv-account-backup.svg?branch=master)](https://travis-ci.org/pryv/pryv-account-backup)
[![Coverage Status](https://coveralls.io/repos/github/pryv/pryv-account-backup/badge.svg?branch=master)](https://coveralls.io/github/pryv/pryv-account-backup?branch=master)
-->

Simple script to backup your Pryv.io data

## Script Usage

*Prerequisites:* [Node](https://nodejs.org/en/)

In your terminal, run the following commands:

`git clone https://github.com/pryv/pryv-account-backup.git` to download the script

`cd pryv-account-backup` to go in the script folder

`npm install` to download required dependencies

`npm start` to launch the backup script.

This will ask you for the **service-info url**, **username** and **password** of the Pryv account you wish to back up.

You can finally choose to backup also trashed data as well as attachment files.

### Format

Your data will be downloaded in `./backup/{apiEndpoint}/`

This downloads the following in JSON format:
* Public profile
* Accesses
* Followed slices
* Streams
* Events
* Account Info

As well as the following in binary files:
* Attachment files

### Running conditions

The operation might take a while in case the data size is substantial. Please, leave requests [here](https://github.com/pryv/pryv-account-backup/issues)

## As a package

It is also possible use the backup function in your code.

Add the following to your `package.json`: `"pryv-backup":"git+ssh://git@github.com:pryv/pryv-account-backup.git"`

then use it as following:

```javascript
const backup = require('pryv-backup');

const settings = {
      service: SERVICE_INFO_URL,
      username: USERNAME  
      password: PASSWORD,  
      includeTrashed: true, // default: false  
      includeAttachments: true // default: false
    };  
settings.backupDirectory = new backup.Directory(apiEndPoint);  

backup.start(settings, function (err) {
      if (err) {
        // manage error
      }
      // ...
});
```

## (Experimental) Restore Streams and Events to another account

`node scripts/start-restore.js <path to backup dir>`

## Contribute

Prerequisites: Node v8+, yarn v0.27.5

Install dependencies: `npm install`

Run tests: `npm run test`

## License

MIT License as included
