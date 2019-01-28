# app-node-backup

[![Build Status](https://travis-ci.org/pryv/app-node-backup.svg?branch=master)](https://travis-ci.org/pryv/app-node-backup)
[![Coverage Status](https://coveralls.io/repos/github/pryv/app-node-backup/badge.svg?branch=master)](https://coveralls.io/github/pryv/app-node-backup?branch=master)

Simple script to backup your Pryv data

## Script Usage

*Prerequisites:* [Node](https://nodejs.org/en/)

In your terminal, run the following commands:

`git clone https://github.com/pryv/app-node-backup.git` to download the script

`cd app-node-backup` to go in the script folder

`npm install` to download required dependencies

`npm start` to launch the backup script. 

This will ask you for the **domain**, **username** and **password** of the Pryv account you wish to back up.

The **domain** is `pryv.me` if you are using the demo platform, then just provide the same **username** and **password** you use to connect to the dashboard.

You can finally choose to backup also trashed data as well as attachment files.

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

## License

MIT License as included