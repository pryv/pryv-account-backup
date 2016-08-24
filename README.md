# app-node-backup
simple script to backup your own Pryv data

## Usage

*Prerequisites:* Node

`npm install` to download required dependencies

`npm start` to launch the backup script. This will ask you for the **domain**, **username** and **password** of the Pryv account you wish to back up

### Format

This downloads the following in JSON format:  
* Public profile
* Accesses
* Followed slices
* Streams
* Events

As well as the following in binary files:
* Attachment files
