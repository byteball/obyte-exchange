/*jslint node: true */
"use strict";
var fs = require('fs');
var desktopApp = require('ocore/desktop_app.js');
var appDataDir = desktopApp.getAppDataDir();
var path = require('path');

if (require.main === module && !fs.existsSync(appDataDir) && fs.existsSync(path.dirname(appDataDir)+'/byteball-exchange')){
	console.log('=== will rename old exchange data dir');
	fs.renameSync(path.dirname(appDataDir)+'/byteball-exchange', appDataDir);
}
var async = require('async');
var conf = require('ocore/conf.js');
var db = require('ocore/db.js');
var eventBus = require('ocore/event_bus.js');
var mail = require('ocore/mail.js');
var headlessWallet = require('headless-obyte');
var ValidationUtils = require("ocore/validation_utils.js");
var book = require("./book.js");

const TEMP_DATA_EXPIRY_PERIOD = 3600*1000;

if (conf.bRunWitness)
	require('obyte-witness');
else
	headlessWallet.setupChatEventHandlers();

function sendMessageToDevice(device_address, text){
	var device = require('ocore/device.js');
	device.sendMessageToDevice(device_address, 'text', text);
}


function sendUnrecognizedCommand(device_address){
	sendMessageToDevice(device_address, 'Unrecognized command');
}

function createSession(device_address, handleData){
	let data = {permanent: {}, temp: {}};
	db.query("INSERT "+db.getIgnore()+" INTO sessions (device_address, data) VALUES(?, ?)", [device_address, JSON.stringify(data)], function(){
		readAndResetSession(device_address, handleData);
	});
}

function readSession(device_address, handleData){
	db.query("SELECT data FROM sessions WHERE device_address=?", [device_address], function(rows){
		if (rows.length === 0)
			throw Error('no session on device '+device_address);
		let data = JSON.parse(rows[0].data);
		for (var key in data.temp)
			if (data.temp[key].ts < Date.now() - TEMP_DATA_EXPIRY_PERIOD)
				delete data.temp[key];
		handleData(data);
	});
}

function updateSession(device_address, data){
	db.query("UPDATE sessions SET data=? WHERE device_address=?", [JSON.stringify(data), device_address]);
}

function readAndResetSession(device_address, handleData){
	readSession(device_address, function(data){
		if (data.temp && Object.keys(data.temp).length > 0){
			data.temp = {};
			updateSession(device_address, data);
		}
		if (handleData)
			handleData(data);
	});
}

function updateTempData(data, name, value){
	data.temp[name] = {value: value, ts: Date.now()};
	data.bUpdated = true;
}

function findAsset(asset, handleResult){
	db.query(
		"SELECT asset_id FROM asset_indexes WHERE asset LIKE ? UNION SELECT asset_id FROM aliases WHERE alias=?", 
		[asset+'%', asset], 
		function(rows){
			if (rows.length === 0)
				return handleResult("asset "+asset+" not known");
			if (rows.length > 1)
				return handleResult("asset "+asset+" is ambiguous, please type more characters");
			handleResult(null, rows[0].asset_id);
		}
	);
}

function findPair(asset_id1, asset_id2, handleResult){
	db.query("SELECT pair_id FROM pairs WHERE asset_id1=? AND asset_id2=? AND is_delisted=0", [asset_id1, asset_id2], function(rows){
		(rows.length === 0) ? handleResult("no such pair") : handleResult(null, rows[0].pair_id);
	});
}


function findPairByNames(asset1, asset2, handleResult){
	findAsset(asset1, function(err, asset_id1){
		if (err)
			return handleResult(err);
		findAsset(asset2, function(err, asset_id2){
			if (err)
				return handleResult(err);
			findPair(asset_id1, asset_id2, function(err, pair_id){
				if (err)
					findPair(asset_id2, asset_id1, function(err2){
						handleResult(err2 ? err : "There is an opposite pair "+asset2+"/"+asset1);
					});
				handleResult(null, pair_id);
			});
		});
	});
}

function readAvailablePairs(handlePairs){
	db.query(
		"SELECT \n\
			IFNULL(aliases1.alias, SUBSTR(asset_indexes1.asset, 1, 4)) AS asset1, \n\
			IFNULL(aliases2.alias, SUBSTR(asset_indexes2.asset, 1, 4)) AS asset2 \n\
		FROM pairs \n\
		JOIN asset_indexes AS asset_indexes1 ON asset_id1=asset_indexes1.asset_id \n\
		JOIN asset_indexes AS asset_indexes2 ON asset_id2=asset_indexes2.asset_id \n\
		LEFT JOIN aliases AS aliases1 ON asset_id1=aliases1.asset_id AND aliases1.is_default=1 \n\
		LEFT JOIN aliases AS aliases2 ON asset_id2=aliases2.asset_id AND aliases2.is_default=1 \n\
		WHERE is_delisted=0 \n\
		ORDER BY pair_id",
		function(rows){
			let arrPairs = rows.map((row) => row.asset1 + '/' + row.asset2);
			let arrCommands = arrPairs.map((pair) => '['+pair+'](command:'+pair+')');
			handlePairs(arrCommands.join("\n"));
		}
	);
}

function printPairs(device_address){
	readAvailablePairs(function(pairs_list){
		sendMessageToDevice(device_address, "Please choose one of the currency pairs:\n"+pairs_list+"\nOr specify another pair by typing the first few characters of asset names separated by slash: asset1/asset2");
	});

}

function isAffirmative(text){
	let lc_text = text.toLowerCase();
	return (lc_text === 'confirm' || lc_text === 'i confirm' || lc_text === 'confirmed' || lc_text === 'yes' || lc_text === 'correct' || lc_text === 'right' || lc_text === "that's right" || lc_text === "that's correct");
}

eventBus.on('paired', function(from_address){
	console.log('paired '+from_address);
	createSession(from_address, function(data){
		readAvailablePairs(function(pairs_list){
			sendMessageToDevice(from_address, "Hi, I will help you to exchange currencies. Please select what currencies you'd like to exchange:\n"+pairs_list+"\nOr specify another currency pair by typing the first few characters of asset names separated by slash: asset1/asset2");
		});
	});
});

eventBus.on('text', function(from_address, text){
	console.log('text from '+from_address+': '+text);
	text = text.trim();
	
	if (!book.isOperatorReady())
		return sendMessageToDevice(from_address, 'The exchange is not ready yet, try again in a few minutes');
	
	readSession(from_address, function(data){
		
		function handleKnownData(cb){
			let bHavePair = !!data.permanent.pair_id;
			let bHaveAddress = !!data.temp.address;
			let bHaveOrder = (data.temp.order_type && data.temp.amount);
			let bHavePrice = !!data.temp.price;
			let fee = (data.temp.fee && data.temp.fee.value) || data.permanent.default_fee;
			if (bHavePair && bHaveAddress && bHaveOrder && bHavePrice && fee){
				let order_type = data.temp.order_type.value;
				let amount = data.temp.amount.value;
				if (isAffirmative(text)){
					book.handleOrder(
						data.permanent.pair_id, order_type, data.temp.price.value, amount, data.temp.address.value, from_address, 
						function(err, arrOrderAddressInfos){
							if (err)
								return sendMessageToDevice(from_address, err);
							book.readPairProps(data.permanent.pair_id, function(objAsset1, objAsset2, multiplier){
								if (!objAsset1)
									return sendMessageToDevice(from_address, 'The pair is delisted');
								let in_asset = (order_type === 'buy') ? objAsset2.asset : objAsset1.asset;
								var arrPayments = [];
								var assocDefinitions = {};
								arrOrderAddressInfos.forEach((objOrderAddressInfo) => {
									let order_address = objOrderAddressInfo.order_address;
									assocDefinitions[order_address] = {
										definition: objOrderAddressInfo.definition,
										signers: objOrderAddressInfo.signers
									};
									let objPayment = {address: order_address, amount: objOrderAddressInfo.in_amount};
									arrPayments.push(objPayment);
									if (in_asset === 'base')
										objPayment.amount += fee;
									else{
										objPayment.asset = in_asset;
										let objFeePayment = {address: order_address, amount: fee};
										arrPayments.push(objFeePayment);
									}
								});
								let objPaymentRequest = {payments: arrPayments, definitions: assocDefinitions};
								let paymentJson = JSON.stringify(objPaymentRequest);
								let paymentJsonBase64 = Buffer(paymentJson).toString('base64');
								sendMessageToDevice(from_address, '[Please pay to this shared address](payment:'+paymentJsonBase64+')');
							});
						}
					);
					delete data.temp.address;
					delete data.temp.price;
					delete data.temp.amount;
					delete data.temp.order_type;
					data.bUpdated = true;
				}
				else{
					let alias1 = data.permanent.alias1;
					let alias2 = data.permanent.alias2;
					let count_lots = book.getLots(amount).length;
					let total_fee = fee * count_lots;
					book.readPairProps(data.permanent.pair_id, function(objAsset1, objAsset2){
						if (!objAsset1)
							return sendMessageToDevice(from_address, 'The pair is delisted');
						let price_multiplier = Math.pow(10, objAsset2.decimals - objAsset1.decimals); // from display to internal
						let display_amount = (amount / Math.pow(10, objAsset1.decimals)).toLocaleString([], {maximumFractionDigits: objAsset1.decimals});
						sendMessageToDevice(from_address, (order_type === 'buy' ? 'Buying ' : 'Selling ') + display_amount + ' ' + alias1 + '/' + alias2 + ' at '+(data.temp.price.value/price_multiplier) + ", you'll receive "+(order_type === 'buy' ? alias1 : alias2)+" to your address " + data.temp.address.value + ".\n"+count_lots+" orders will be placed, the fee is "+fee+" bytes per each, total fee is "+total_fee+" bytes.\nPlease confirm. [Confirm](command:confirm)");
					});
				}
			}
			else{
				if (arrResponses.length > 0)
					sendMessageToDevice(from_address, arrResponses.join("\n"));
				if (!bHavePair)
					printPairs(from_address);
				else if (!bHaveOrder)
					sendMessageToDevice(from_address, 'What are you going to do? Say, for example, "buy 100", or "sell 200". Type [help](command:help) for additional commands.');
				else if (!bHavePrice){
					book.readPairProps(data.permanent.pair_id, function(objAsset1, objAsset2, multiplier){
						if (!objAsset1)
							return sendMessageToDevice(from_address, 'The pair is delisted');
						let price_multiplier = Math.pow(10, objAsset2.decimals - objAsset1.decimals); // from display to internal
						book.readBidAsk(data.permanent.pair_id, function(bid, ask){
							let order_type = data.temp.order_type.value;
							let bCanFrontRun = (!ask || !bid || Math.round(multiplier*(ask-bid)) > 1);
							if (ask && bid && ask < bid){ // crossed market: set both prices to the middle
								let mid = Math.round((ask+bid)/2*multiplier)/multiplier;
								ask = mid;
								bid = mid;
							}
							var message = "What price would you like to "+order_type+" at?";
							if (order_type === 'buy'){
								let display_ask_price;
								if (ask){
									display_ask_price = (ask/price_multiplier).toLocaleString([], {maximumFractionDigits: 20});
									message += "\n[at "+display_ask_price+"](command:at "+display_ask_price+") - fast";
								}
								if (!bid && ask) // set fake bid at 99% min sell
									bid = Math.round((ask*0.99)*multiplier)/multiplier;
								if (bid){
									let front_running_price = bCanFrontRun ? (bid+1/multiplier) : bid;
									let display_front_running_price = (front_running_price/price_multiplier).toLocaleString([], {maximumFractionDigits: 20});
									if (!display_ask_price || display_ask_price !== display_front_running_price) {
										message += "\n[at "+display_front_running_price+"](command:at "+display_front_running_price+") - have to wait";
									}
									let example_price = Math.round((bid*0.99)*multiplier)/multiplier;
									message += '\nOr type your price, e.g. "at '+(example_price/price_multiplier).toLocaleString([], {maximumFractionDigits: 20})+'", the lower your price, the longer you\'ll have to wait';
								}
								else
									message += '\nType your price, e.g. "at 1.2345", the lower your price, the longer you\'ll have to wait';
							}
							else{
								let display_bid_price;
								if (bid){
									display_bid_price = (bid/price_multiplier).toLocaleString([], {maximumFractionDigits: 20});
									message += "\n[at "+display_bid_price+"](command:at "+display_bid_price+") - fast";
								}
								if (!ask && bid) // set fake ask at 101% max buy
									ask = Math.round((bid*1.01)*multiplier)/multiplier;
								if (ask){
									let front_running_price = bCanFrontRun ? (ask-1/multiplier) : ask;
									let display_front_running_price = (front_running_price/price_multiplier).toLocaleString([], {maximumFractionDigits: 20});
									if (!display_bid_price || display_bid_price ==! display_front_running_price) {
										message += "\n[at "+display_front_running_price+"](command:at "+display_front_running_price+") - have to wait";
									}
									let example_price = Math.round((ask*1.01)*multiplier)/multiplier;
									message += '\nOr type your price, e.g. "at '+(example_price/price_multiplier).toLocaleString([], {maximumFractionDigits: 20})+'", the higher your price, the longer you\'ll have to wait';
								}
								else
									message += '\nType your price, e.g. "at 1.2345", the higher your price, the longer you\'ll have to wait';
							}
							sendMessageToDevice(from_address, message);
						});
					});
				}
				else if (!bHaveAddress)
					sendMessageToDevice(from_address, 'Please let me know your address you\'d like to receive '+(data.temp.order_type.value === 'buy' ? data.permanent.alias1 : data.permanent.alias2)+' to (use "Insert My Address" button)');
				else if (!fee)
					sendMessageToDevice(from_address, "The minimum fee per order is "+book.MIN_FEE+" bytes. [Pay minimum fee](command:fee "+book.MIN_FEE+') or type e.g. "fee 2000" to pay a higher fee and give your order greater priority');
				else
					throw Error("something's still missing? "+JSON.stringify(data));
			}
			cb();
		}
		
		var arrResponses = [];
		
		// address
		function handleAddress(cb){
			let arrMatches = text.match(/\b([A-Z2-7]{32})\b/);
			if (arrMatches && ValidationUtils.isValidAddress(arrMatches[1])){
				let address = arrMatches[1];
				updateTempData(data, 'address', address);
				arrResponses.push("Withdrawal address set to "+address);
			}
			cb();
		}
		
		// order type and amount
		function handleOrderTypeAndAmount(cb){
			if (!data.permanent.pair_id) // ignore when we don't know the pair and can't adjust amount
				return cb();
			let arrMatches = text.match(/\b(buy|sell)\b\s+([\d.]+)/i);
			if (!arrMatches)
				return cb();
			let order_type = arrMatches[1].toLowerCase();
			var display_amount = parseFloat(arrMatches[2]);
			if (!display_amount || isNaN(display_amount))
				return cb();
			book.readPairProps(data.permanent.pair_id, function(objAsset1, objAsset2, multiplier, amount_increment){
				if (!objAsset1){
					arrResponses.push('The pair is delisted');
					return cb();
				}
				let asset1_multiplier = Math.pow(10, objAsset1.decimals);
				let amount = Math.round(display_amount * asset1_multiplier);
				let adjusted_amount = Math.round(amount/amount_increment)*amount_increment;
				if (adjusted_amount === 0){
					arrResponses.push("The amount is too small, the minimum is "+(amount_increment/asset1_multiplier).toLocaleString([], {maximumFractionDigits: objAsset1.decimals}));
					return cb();
				}
				var response = ( (order_type === 'buy') ? 'Buying ' : 'Selling ' ) + (adjusted_amount/asset1_multiplier).toLocaleString([], {maximumFractionDigits: objAsset1.decimals}) + " "+data.permanent.alias1;
				if (adjusted_amount !== amount)
					response += ' (amount adjusted to the closest standard size)';
				amount = adjusted_amount;
				updateTempData(data, 'order_type', order_type);
				updateTempData(data, 'amount', amount);
				arrResponses.push(response);
				cb();
			});
		}
		
		// price
		function handlePrice(cb){
			if (!data.permanent.pair_id) // ignore when we don't know the pair and can't adjust the price
				return cb();
			let arrMatches = text.match(/(?:at|@)\s*([\d.]+)/i);
			if (!arrMatches)
				return cb();
			let display_price = parseFloat(arrMatches[1]);
			if (!display_price || isNaN(display_price))
				return cb();
			book.readPairProps(data.permanent.pair_id, function(objAsset1, objAsset2, multiplier){
				if (!objAsset1){
					arrResponses.push('The pair is delisted');
					return cb();
				}
				let price_multiplier = Math.pow(10, objAsset2.decimals - objAsset1.decimals); // from display to internal
				let price = display_price * price_multiplier;
				let adjusted_price = Math.round(price*multiplier)/multiplier;
				console.error('price '+price+', adjusted '+adjusted_price);
				var response = "Price set to "+(adjusted_price/price_multiplier)+(data.permanent.alias1 ? (" "+data.permanent.alias2+" per "+data.permanent.alias1) : "");
				if (price !== adjusted_price)
					response += ' (price adjusted to the closest allowed level)';
				updateTempData(data, 'price', adjusted_price);
				arrResponses.push(response);
				cb();
			});
		}
		
		// fee
		function handleFee(cb){
			var arrMatches = text.match(/default fee\s*(\d+)/i);
			if (arrMatches){
				let default_fee = parseInt(arrMatches[1]);
				if (default_fee && !isNaN(default_fee)){
					if (default_fee < book.MIN_FEE)
						sendMessageToDevice(from_address, "The default fee cannot be less than "+book.MIN_FEE+" bytes");
					else{
						data.permanent.default_fee = default_fee;
						data.bUpdated = true;
						sendMessageToDevice(from_address, "Default fee set to "+default_fee+" bytes");
					}
				}
			}
			else{
				arrMatches = text.match(/fee\s*(\d+)/i);
				if (arrMatches){
					let fee = parseInt(arrMatches[1]);
					if (fee && !isNaN(fee)){
						if (fee < book.MIN_FEE)
							sendMessageToDevice(from_address, "The fee cannot be less than "+book.MIN_FEE+" bytes");
						else{
							updateTempData(data, 'fee', fee);
							arrResponses.push("Fee set to "+fee+" bytes");
						}
					}
				}
			}
			cb();
		}
		
		// currency pair
		function handlePair(cb){
			let arrMatches = text.match(/\b(\w{2,10})\s*\/\s*(\w{2,10})\b/);
			if (arrMatches){
				let alias1 = arrMatches[1];
				let alias2 = arrMatches[2];
				findPairByNames(alias1, alias2, function(err, pair_id){
					if (err)
						return sendMessageToDevice(from_address, err);
					data.permanent.pair_id = pair_id;
					data.permanent.alias1 = alias1;
					data.permanent.alias2 = alias2;
					data.bUpdated = true;
					sendMessageToDevice(from_address, "Currency pair set to "+alias1 + '/' + alias2+"\nYou can change it at any time by typing another pair.\n\nSee the [book](command:book), see your own [orders](command:orders).");
					cb();
				});
			}
			else
				cb();
		}
		
		function updateSessionIfNecessary(cb){
			if (data.bUpdated){
				delete data.bUpdated;
				updateSession(from_address, data);
			}
			cb();
		}
		
		let lc_text = text.toLowerCase();
		switch (lc_text){
			case 'book':
			case 'orders':
				if (!data.permanent.pair_id)
					return sendMessageToDevice(from_address, "To see the book, please choose a pair first");
				book.readPairProps(data.permanent.pair_id, function(objAsset1, objAsset2){
					if (!objAsset1)
						return sendMessageToDevice(from_address, 'The pair is delisted');
					let price_multiplier = Math.pow(10, objAsset2.decimals - objAsset1.decimals); // from display to internal
					let asset1_multiplier = Math.pow(10, objAsset1.decimals);
					let and_device = (lc_text === 'book') ? '' : ' AND device_address=? ';
					var params = [data.permanent.pair_id];
					var response = data.permanent.alias1 +'/'+ data.permanent.alias2 + " order book:\n";
					if (lc_text === 'orders') {
						response = "Your orders:\n";
						params.push(from_address);
					}
					db.query(
						"SELECT price, order_type, SUM(amount) AS total FROM orders WHERE is_active=1 AND pair_id=? "+and_device+" \n\
						GROUP BY price, order_type ORDER BY order_type DESC, price DESC;",
						params,
						function(rows){
							var arrLines = [];
							var prev_order_type;
							rows.forEach(row => {
								if (prev_order_type && prev_order_type !== row.order_type)
									arrLines.push('-----------------------');
								var price = row.price/price_multiplier;
								var vol = (row.total/asset1_multiplier).toLocaleString([], {maximumFractionDigits: objAsset1.decimals});
								if (lc_text === 'orders') {
									arrLines.push("At "+ price +" "+ row.order_type +"ing vol. "+ vol);
								}
								else {
									arrLines.push("At ["+ price +"](suggest-command:buy "+ vol +" at "+ price +") "+ row.order_type +"ing vol. "+ vol);
								}
								prev_order_type = row.order_type;
							});
							if (arrLines.length) {
								response += arrLines.join("\n");
							}
							else {
								response += "No orders at this time.\n"
							}
							response += "\nType [help](command:help) for additional commands.";
							sendMessageToDevice(from_address, response);
						}
					);
				});
				return;
				
			case 'pairs':
				return printPairs(from_address);
				
			case 'help':
				return sendMessageToDevice(from_address, "Use the following commands:\n[pairs](command:pairs): see available trading pairs;\nasset1/asset2: switch to another trading pair separated by slash.\n[book](command:book): print the order book;\n[orders](command:orders): print your own pending orders;\nbuy <amount>: create a buy order;\nsell <amount>: create a sell order;\nat <price>: set the current buy or sell price.")
		}
	
		async.series([handlePair, handleOrderTypeAndAmount, handlePrice, handleAddress, handleFee, handleKnownData, updateSessionIfNecessary]);
		
	});
	
	
});
