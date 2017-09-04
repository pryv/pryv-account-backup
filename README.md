# app-node-backup

[![Build Status](https://travis-ci.org/pryv/app-node-backup.svg?branch=master)](https://travis-ci.org/pryv/app-node-backup)

Simple script to backup your Pryv data

## Script Usage

*Prerequisites:* [Node](https://nodejs.org/en/)

In your terminal, run the following commands:

`npm install` to download required dependencies

`npm start` to launch the backup script. This will ask you for the **domain**, **username** and **password** of the Pryv account you wish to back up

### Format

Your data will be downloaded in `./backup/{username}.{domain}/`

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

The operation might take a while in case the data size is substantial. Please, leave requests [here](https://github.com/pryv/app-node-backup/issues)

## As a package

It is also possible use the backup function in your code.

Add the following to your `package.json`: `"pryv-backup":"git+ssh://git@github.com:pryv/app-node-backup.git"`

then use it as following:

```javascript
var backup = require('pryv-backup');

var settings = {
      username: USERNAME,  
      domain: DOMAIN, // optional  
      password: PASSWORD,  
      includeTrashed: true, // default: false  
      includeAttachments: true // default: false
    };  
settings.backupDirectory = new backup.Directory(settings.username, settings.domain);  

backup.start(settings, function (err) {  
      if (err) {  
        // manage error  
      }  
      // ...  
});  
```

## Contribute

Prerequisites: Node v8+, yarn v0.27.5

Install dependencies: `yarn install`

Run tests: `yarn run test`

