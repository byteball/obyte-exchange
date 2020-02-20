/*jslint node: true */
"use strict";
var async = require('async');
var db = require('ocore/db.js');
var eventBus = require('ocore/event_bus.js');
var headlessWallet = require('headless-obyte');


const announcement = "This exchange will be discontinued as Autonomous Agents are released on mainnet and trading moves to https://odex.ooo\n\nIf you have unfilled orders, please switch to the corresponding smart contract (subwallet) in your wallet and withdraw all funds to your main wallet. You can do so any time, even after this exchange goes offline.";

//const optout_text = "\n\nIf you don't want to receive news here, [click here to opt out](command:optout).";
const message = announcement;// + optout_text;

headlessWallet.setupChatEventHandlers();

function sendAnnouncement(){
	var device = require('ocore/device.js');
	db.query(
		"SELECT device_address FROM correspondent_devices",
		rows => {
			console.error(rows.length+" messages will be sent");
			async.eachSeries(
				rows,
				(row, cb) => {
					device.sendMessageToDevice(row.device_address, 'text', message, {
						ifOk: function(){}, 
						ifError: function(){}, 
						onSaved: function(){
							console.log("sent to "+row.device_address);
							cb();
						}
					});
				},
				() => {
					console.error("=== done");
				}
			);
		}
	);
}

eventBus.on('text', function(from_address, text){
	var device = require('ocore/device.js');
	console.log('text from '+from_address+': '+text);
	text = text.trim().toLowerCase();
	/*if (text === 'optout'){
		db.query("INSERT "+db.getIgnore()+" INTO optouts (device_address) VALUES(?)", [from_address]);
		return device.sendMessageToDevice(from_address, 'text', 'You are unsubscribed from future announcements.');
	}
	else */if (text.match(/thank/))
		device.sendMessageToDevice(from_address, 'text', "You're welcome!");
	else
		device.sendMessageToDevice(from_address, 'text', "Usual operations are paused while sending announcements.  Check again in a few minutes.");
});

eventBus.on('headless_wallet_ready', () => {
	setTimeout(sendAnnouncement, 1000);
});

