/*jslint node: true */
"use strict";
var _ = require('lodash');
var async = require('async');
var conf = require('byteballcore/conf.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var mail = require('byteballcore/mail.js');
var headlessWallet = require('headless-byteball');
var ValidationUtils = require("byteballcore/validation_utils.js");
var book = require("./book.js");

const TEMP_DATA_EXPIRY_PERIOD = 3600*1000;

headlessWallet.setupChatEventHandlers();


function notifyAdmin(subject, body){
	mail.sendmail({
		to: conf.admin_email,
		from: conf.from_email,
		subject: subject,
		body: body
	});
}

function notifyAdminAboutFailedPayment(err){
	console.log('payment failed: '+err);
	notifyAdmin('payment failed: '+err, err);
}


function sendMessageToDevice(device_address, text){
	var device = require('byteballcore/device.js');
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
	db.query("SELECT pair_id FROM pairs WHERE asset_id1=? AND asset_id2=?", [asset_id1, asset_id2], function(rows){
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
		ORDER BY pair_id",
		function(rows){
			let arrPairs = rows.map((row) => row.asset1 + '/' + row.asset2);
			let arrCommands = arrPairs.map((pair) => '['+pair+'](command:'+pair+')');
			handlePairs(arrCommands.join(', '));
		}
	);
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
							book.readPairProps(data.permanent.pair_id, function(asset1, asset2, multiplier){
								let in_asset = (order_type === 'buy') ? asset2 : asset1;
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
					let asset1 = data.permanent.asset1;
					let asset2 = data.permanent.asset2;
					let count_lots = book.getLots(amount).length;
					let total_fee = fee * count_lots;
					sendMessageToDevice(from_address, (order_type === 'buy' ? 'Buying ' : 'Selling ') + amount + ' ' + asset1 + '/' + asset2 + ' at '+data.temp.price.value + ", you'll receive "+(order_type === 'buy' ? asset1 : asset2)+" at your address " + data.temp.address.value + ".\n"+count_lots+" orders will be placed, the fee is "+fee+" bytes per each, total fee is "+total_fee+" bytes.\nPlease confirm. [Confirm](command:confirm)");
				}
			}
			else{
				if (arrResponses.length > 0)
					sendMessageToDevice(from_address, arrResponses.join("\n"));
				if (!bHavePair){
					readAvailablePairs(function(pairs_list){
						sendMessageToDevice(from_address, "Please choose one of the currency pairs:\n"+pairs_list+"\nOr specify another pair by typing the first few characters of asset names separated by slash: asset1/asset2");
					});
				}
				else if (!bHaveOrder)
					sendMessageToDevice(from_address, 'What are you going to do? Say, for example, "buy 100", or "sell 200"');
				else if (!bHavePrice){
					book.readPairProps(data.permanent.pair_id, function(asset1, asset2, multiplier){
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
								if (ask)
									message += "\n[at "+ask+"](command:at "+ask+") - fast";
								if (!bid && ask) // set fake bid at 99% min sell
									bid = Math.round((ask*0.99)*multiplier)/multiplier;
								if (bid){
									let front_running_price = bCanFrontRun ? (bid+1/multiplier) : bid;
									message += "\n[at "+front_running_price+"](command:at "+front_running_price+") - have to wait";
									let example_price = Math.round((bid*0.99)*multiplier)/multiplier;
									message += '\nOr type your price, e.g. "at '+example_price+'", the lower your price, the longer you\'ll have to wait';
								}
								else
									message += '\nType your price, e.g. "at 1.2345", the lower your price, the longer you\'ll have to wait';
							}
							else{
								if (bid)
									message += "\n[at "+bid+"](command:at "+bid+") - fast";
								if (!ask && bid) // set fake ask at 101% max buy
									ask = Math.round((bid*1.01)*multiplier)/multiplier;
								if (ask){
									let front_running_price = bCanFrontRun ? (ask-1/multiplier) : ask;
									message += "\n[at "+front_running_price+"](command:at "+front_running_price+") - have to wait";
									let example_price = Math.round((ask*1.01)*multiplier)/multiplier;
									message += '\nOr type your price, e.g. "at '+example_price+'", the higher your price, the longer you\'ll have to wait';
								}
								else
									message += '\nType your price, e.g. "at 1.2345", the higher your price, the longer you\'ll have to wait';
							}
							sendMessageToDevice(from_address, message);
						});
					});
				}
				else if (!bHaveAddress)
					sendMessageToDevice(from_address, 'Please let me know your address you\'d like to receive '+(data.temp.order_type.value === 'buy' ? data.permanent.asset1 : data.permanent.asset2)+' to (use "Insert My Address" button)');
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
			let arrMatches = text.match(/\b(buy|sell)\b\s+(\d+)/i);
			if (!arrMatches)
				return cb();
			let order_type = arrMatches[1].toLowerCase();
			var amount = parseInt(arrMatches[2]);
			if (!amount || isNaN(amount))
				return cb();
			book.readPairProps(data.permanent.pair_id, function(asset1, asset2, multiplier, amount_increment){
				let adjusted_amount = Math.round(amount/amount_increment)*amount_increment;
				var response = ( (order_type === 'buy') ? 'Buying ' : 'Selling ' ) + adjusted_amount + " "+data.permanent.asset1;
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
			let price = parseFloat(arrMatches[1]);
			if (!price || isNaN(price))
				return cb();
			book.readPairProps(data.permanent.pair_id, function(asset1, asset2, multiplier){
				let adjusted_price = Math.round(price*multiplier)/multiplier;
				var response = "Price set to "+adjusted_price+(data.permanent.asset1 ? (" "+data.permanent.asset2+" per "+data.permanent.asset1) : "");
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
			let arrMatches = text.match(/\b(\w{3,10})\s*\/\s*(\w{3,10})\b/);
			if (arrMatches){
				let asset1 = arrMatches[1];
				let asset2 = arrMatches[2];
				findPairByNames(asset1, asset2, function(err, pair_id){
					if (err)
						return sendMessageToDevice(from_address, err);
					data.permanent.pair_id = pair_id;
					data.permanent.asset1 = asset1;
					data.permanent.asset2 = asset2;
					data.bUpdated = true;
					sendMessageToDevice(from_address, "Currency pair set to "+asset1 + '/' + asset2+"\nYou can change it at any time by typing another pair.");
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
				let and_device = (lc_text === 'book') ? '' : ' AND device_address=? ';
				var params = [data.permanent.pair_id];
				if (lc_text === 'orders')
					params.push(from_address);
				db.query(
					"SELECT price, order_type, SUM(amount) AS total FROM orders WHERE is_active=1 AND pair_id=? "+and_device+" \n\
					GROUP BY price, order_type ORDER BY price DESC",
					params,
					function(rows){
						var arrLines = rows.map(row => "At "+row.price+" "+row.order_type+" vol. "+row.total);
						sendMessageToDevice(from_address, arrLines.join("\n") || "No orders at this time.");
					}
				);
				return;
		}
	
		async.series([handlePair, handleOrderTypeAndAmount, handlePrice, handleAddress, handleFee, handleKnownData, updateSessionIfNecessary]);
		
	});
	
	
});
