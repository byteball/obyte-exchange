/*jslint node: true */
"use strict";
var headlessWallet = require('headless-byteball');
var eventBus = require('byteballcore/event_bus.js');

var my_address;

function onError(err){
	throw Error(err);
}

function createAsset(){
	console.log('create asset');
	var composer = require('byteballcore/composer.js');
	var network = require('byteballcore/network.js');
	var callbacks = composer.getSavingCallbacks({
		ifNotEnoughFunds: onError,
		ifError: onError,
		ifOk: function(objJoint){
			network.broadcastJoint(objJoint);
		}
	});
	var asset = {
		cap: 1000000,
		is_private: false,
		is_transferrable: true,
		auto_destroy: false,
		fixed_denominations: false,
		issued_by_definer_only: true,
		cosigned_by_definer: false,
		spender_attested: false
	};
	composer.composeAssetDefinitionJoint(my_address, asset, headlessWallet.signer, callbacks);
}

eventBus.on('headless_wallet_ready', function(){
	headlessWallet.readSingleAddress(function(address){
		my_address = address;
		createAsset();
	});
});
