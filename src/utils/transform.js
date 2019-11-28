const slug = require('slug');

const eventTimeShift = 1*30*24*60*60; // add a month

function transformStream(stream) {
    if(stream.id) {
        stream.id = transformStreamName(stream.id);
    }

    if(stream.parentId) {
        stream.parentId = transformStreamName(stream.parentId);
    }

    if(stream.children && Array.isArray(stream.children)) {
        for(let i = 0; i < stream.children.length; i++) {
            stream.children[i] = transformStream(stream.children[i]);
        };
    }
    return stream;
}

function transformEvent(event) {
    if(event.id) {
        delete event.id;
    }

    if(event.time) {
        event.time = (event.time*1)+eventTimeShift;
    }

    if(event.parentId) {
        event.parentId = transformStreamName(event.parentId);
    }

    if(event.streamId) {
        event.streamId = transformStreamName(event.streamId);
    }

    return event;
}

function transformStreamName(str) {
    return slug(str);
}

// function prettyTimestamp(timestamp) {
//     return new Date(timestamp*1000);
// }

// const eventTest = {"time": "1574952336.787"};
// exports.transformEvent(eventTest);

exports.transformStream = transformStream;
exports.transformEvent = transformEvent;
