/*jslint node: true */
"use strict";

exports.port = null;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;
exports.bSingleAddress = true;
exports.bIgnoreUnpairRequests = true;

exports.storage = 'sqlite';


exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'Exchange Bot';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = ['DEVICE ALLOWED TO CHAT'];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

//exports.bSingleAddress = true;

exports.KEYS_FILENAME = 'keys.json';

console.log('finished exchange conf');
