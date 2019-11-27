/*
 * This script serves for debugging purpose.
 * It will delete all Streams and Event from a user.
 */

const backup = require('../src/main');
const config = require('../src/utils/config.js');
const params = config.get('params');
const { URL } = require('url');
const BackupDirectory = require('../src/methods/backup-directory');
const parseDomain = require("parse-domain");
const Promise = require("bluebird");
const superagent = require('superagent');

let domain;
try {
    new URL(params.domain); // Check if params.domain is a valid url
    
    const parsedDomain = parseDomain(params.domain); // it is --> we can extract the domain from it
    domain = parsedDomain.domain + '.' + parsedDomain.tld;
}
catch(error) {
    if(error.code !== 'ERR_INVALID_URL') {
        console.error(error);
        return;
    }
    domain = params.domain; // it is not, use it as a domain
}

async function deleteAll() {
    let conn;
    try {
        conn = await Promise.fromCallback(function(callback) {
            return backup.signInToPryv(params, callback);
        });
    } catch (error) {
        console.error(error);
        return;
    }

    const token = conn.auth;
    const baseUrl = 'https://' + params.username + '.' + params.domain + '/';
    // await deleteResources('events', baseUrl, token);
    await deleteResources('streams', baseUrl, token);

    console.log('Delete complete');    
}

async function deleteResources(resource, baseUrl, token) {
    // console.log ('TOKEN : '+token);
    let items;
    try {
        const res = await superagent.get(baseUrl + resource + '?state=all')
            .set('Authorization', token)
            .set('Content-Type', 'application/json');
        items = res.body[resource];
    } catch (error) {
        console.error(error);
        return;
    }

    console.log('Deleting ' + items.length + ' ' +resource);

    await asyncForEach(items, async (item) => {
        console.log('\tdeleting ' + item.id);
        try {
            for(let i = 0; i < 2; i++) { // First delete only trash the item
                await superagent.delete(baseUrl + resource + '/' + item.id + '?mergeEventsWithParent=false')
                    .set('Authorization', token)
                    .set('Content-Type', 'application/json');
                console.log('\t\tpass ' + (i+1) + ' ok');
            }
        } catch (error) {
            console.error(error);
        }
    });
}

async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
    }
}

deleteAll();