/*jslint node: true */
"use strict";
var headlessWallet = require('headless-byteball');
var eventBus = require('byteballcore/event_bus.js');

const asset = 'HXY5mfMs5A8GpPDMOVt//ptnHfjsGK3/4X87VT+KVNg=';
var my_address;

function onError(err){
	throw Error(err);
}

function createDivisibleAssetPayment(){
	var network = require('byteballcore/network.js');
	var divisibleAsset = require('byteballcore/divisible_asset.js');
	var walletGeneral = require('byteballcore/wallet_general.js');
	
	divisibleAsset.composeAndSaveDivisibleAssetPaymentJoint({
		asset: asset, 
		paying_addresses: [my_address],
		change_address: my_address,
		to_address: "JA6KAEPZB6KUKHMZACMFLDNYM4O2RHLU",
		amount: 1000000, 
		signer: headlessWallet.signer, 
		callbacks: {
			ifError: onError,
			ifNotEnoughFunds: onError,
			ifOk: function(objJoint, arrChains){
				network.broadcastJoint(objJoint);
				if (arrChains){ // if the asset is private
					// send directly to the receiver
					network.sendPrivatePayment('wss://example.org/bb', arrChains);
					
					// or send to the receiver's device address through the receiver's hub
					//walletGeneral.sendPrivatePayments("0F7Z7DDVBDPTYJOY7S4P24CW6K23F6B7S", arrChains);
				}
			}
		}
	});
}

eventBus.on('headless_wallet_ready', function(){
	headlessWallet.readSingleAddress(function(address){
		my_address = address;
		createDivisibleAssetPayment();
	});
});
