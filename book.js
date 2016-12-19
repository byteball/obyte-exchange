/*jslint node: true */
"use strict";
var _ = require('lodash');
var async = require('async');
var constants = require('byteballcore/constants.js');
var conf = require('byteballcore/conf.js');
var mutex = require('byteballcore/mutex.js');
var objectHash = require('byteballcore/object_hash.js');
var db = require('byteballcore/db.js');
var eventBus = require('byteballcore/event_bus.js');
var mail = require('byteballcore/mail.js');
var headlessWallet = require('headless-byteball');
var desktopApp = require('byteballcore/desktop_app.js');

const MIN_FEE = 1000;
const ORDER_TERM = 3600 * 1000;
const TIMESTAMPER_ADDRESS = 'OPNUXBRSSQQGHKQNEPD2GLWQYEUY5XLD';
var operator_address;
var operator_fee_address;


function readMinSellPrice(pair_id, field, handleMinSellPrice){
	db.query("SELECT MIN("+field+") AS min_price FROM orders WHERE pair_id=? AND is_active=1 AND order_type='sell'", [pair_id], function(rows){
		handleMinSellPrice((rows.length === 0) ? null : rows[0].min_price);
	});
}

function readMaxBuyPrice(pair_id, field, handleMaxBuyPrice){
	db.query("SELECT MAX("+field+") AS max_price FROM orders WHERE pair_id=? AND is_active=1 AND order_type='buy'", [pair_id], function(rows){
		handleMaxBuyPrice((rows.length === 0) ? null : rows[0].max_price);
	});
}

function readBidAsk(pair_id, handleMinMaxPrices){
	readMinSellPrice(pair_id, 'price', function(ask){
		readMaxBuyPrice(pair_id, 'price', function(bid){
			handleMinMaxPrices(bid, ask);
		});
	});
}

function readPairProps(pair_id, handleProps){
	db.query(
		"SELECT asset_indexes1.asset AS asset1, asset_indexes2.asset AS asset2, multiplier, amount_increment \n\
		FROM pairs \n\
		JOIN asset_indexes AS asset_indexes1 ON asset_id1=asset_indexes1.asset_id \n\
		JOIN asset_indexes AS asset_indexes2 ON asset_id2=asset_indexes2.asset_id \n\
		WHERE pair_id=?",
		[pair_id],
		function(rows){
			if (rows.length !== 1)
				throw Error('not 1 pair');
			handleProps(rows[0].asset1 || 'base', rows[0].asset2 || 'base', rows[0].multiplier, rows[0].amount_increment);
		}
	);
}

function pricesCross(row1, row2){
	return (row1.order_type === 'sell' && row1.int_price <= row2.int_price || row1.order_type === 'buy' && row1.int_price >= row2.int_price);
}

function findMatches(rows, onDone){
	var arrMatches = [];
	
	function findExactMatches(rows){
		var first = rows[0];
		var counterpart_index;
		for (var i=1; i<rows.length; i++){
			var row = rows[i];
			if (row.order_type !== first.order_type && row.amount === first.amount && pricesCross(row, first)){
				counterpart_index = i;
				break;
			}
		}
		if (counterpart_index){
			var counterpart = rows[counterpart_index];
			var objMatch = {};
			objMatch[first.order_type] = [first];
			objMatch[counterpart.order_type] = [counterpart];
			arrMatches.push(objMatch);
			rows.splice(counterpart_index, 1); // remove counterpart from the array
			rows.shift(); // remove first element
			(rows.length > 1) ? findExactMatches(rows) : onDone(arrMatches);
		}
		else
			findSumMatches(rows);
	}
	
	function findSumMatches(rows){
		var arrSellers = rows.filter(function(row){ return (row.order_type === 'sell'); });
		var arrBuyers = rows.filter(function(row){ return (row.order_type === 'buy'); });
		if (arrSellers.length === 0 || arrBuyers.length === 0)
			return onDone(arrMatches);
		arrSellers.sort(sortByAmountDescFeeDesc);
		arrBuyers.sort(sortByAmountDescFeeDesc);
		var max_count = arrSellers.length + arrBuyers.length;
		while (arrSellers.length > 0 && arrBuyers.length > 0){
			if (max_count < 0)
				throw Error("trapped in cycle");
			max_count--;
			var bSellersFirst = (arrSellers[0].amount > arrBuyers[0].amount);
			var arrFirst = bSellersFirst ? arrSellers : arrBuyers;
			var arrSecond = bSellersFirst ? arrBuyers : arrSellers;
			var objMatch = {sell: [], buy: []};
			objMatch[bSellersFirst ? 'sell' : 'buy'] = [arrFirst[0]];
			var counterparties_order_type = bSellersFirst ? 'buy' : 'sell';
			var sought_amount = arrFirst[0].amount;
			var arrUsedIndexes = [];
			for (var i=0; i < arrSecond.length && sought_amount > 0; i++){
				var row = arrSecond[i];
				if (row.amount > sought_amount || !pricesCross(row, arrFirst[0]))
					continue;
				arrUsedIndexes.push(i);
				objMatch[counterparties_order_type].push(row);
				sought_amount -= row.amount;
			}
			if (sought_amount < 0)
				throw Error("sought amount < 0");
			if (sought_amount === 0){ // found a set of counterparts that has the target sum
				if (objMatch[counterparties_order_type].length === 0)
					throw Error("still no counterparties?");
				arrMatches.push(objMatch);
				arrFirst.shift();
				for (var j=arrUsedIndexes.length-1; j>=0; j--) // iterating in reverse because splice changes indexes
					arrSecond.splice(arrUsedIndexes[j], 1);
			}
			else
				arrFirst.shift();
		}
		onDone(arrMatches);
	}
	
	function sortByAmountDescFeeDesc(a, b){ // sort by amount, then fee
		if (a.amount > b.amount)
			return -1;
		if (a.amount < b.amount)
			return 1;
		if (a.fee > b.fee)
			return -1;
		if (a.fee < b.fee)
			return 1;
		return 0;
	}
	
	findExactMatches(rows);
}

function createPaymentMessage(asset, inputs, outputs){
	var composer = require('byteballcore/composer.js');
	var payload = {
		asset: asset,
		inputs: inputs,
		outputs: outputs.sort(composer.sortOutputs)
	};
	return {
		app: "payment",
		payload_location: "inline",
		payload_hash: objectHash.getBase64Hash(payload),
		payload: payload
	};
}

var signer = {
	getSignatureLength: function(address, path){
		return constants.SIG_LENGTH;
	},
	readSigningPaths: function(conn, address, handleSigningPaths){
		handleSigningPaths(['r.1.0']);
	},
	readDefinition: function(conn, address, handleDefinition){
		conn.query("SELECT definition FROM shared_addresses WHERE shared_address=?", [address], function(rows){
			if (rows.length !== 1)
				throw "definition not found";
			handleDefinition(null, JSON.parse(rows[0].definition));
		});
	},
	sign: function(objUnsignedUnit, assocPrivatePayloads, address, signing_path, handleSignature){
		var buf_to_sign = objectHash.getUnitHashToSign(objUnsignedUnit);
		db.query( // assuming it is single-sig address
			"SELECT address, member_signing_path FROM shared_address_signing_paths WHERE shared_address=? AND signing_path=?", 
			[address, signing_path],
			function(rows){
				if (rows.length !== 1)
					throw Error("not 1 member address per shared address");
				var row = rows[0];
				if (row.member_signing_path !== 'r')
					throw Error('member address is not plain single-sig');
				var headlessWallet = require('headless-byteball');
				headlessWallet.signer.sign(objUnsignedUnit, assocPrivatePayloads, row.address, row.member_signing_path, handleSignature);
			}
		);
	}
};

function extractOrderId(row){
	return row.order_id;
}

function cancelSpentOrders(onDone){
	db.query(
		"SELECT DISTINCT order_id \n\
		FROM orders \n\
		JOIN inputs \n\
			ON orders.unit=src_unit AND ( \n\
				orders.message_index=src_message_index AND orders.output_index=src_output_index \n\
				OR \n\
				orders.fee_message_index=src_message_index AND orders.fee_output_index=src_output_index \n\
			) \n\
		WHERE is_active=1",
		function(rows){
			if (rows.length === 0)
				return onDone();
			var arrOrderIds = rows.map(extractOrderId);
			db.query("UPDATE orders SET is_active=0, cancel_date="+db.getNow()+" WHERE order_id IN(?)", [arrOrderIds], function(){
				onDone();
			});
		}
	);
}

function matchOrders(pair_id, onDone){
	var composer = require('byteballcore/composer.js');
	var network = require('byteballcore/network.js');
	var walletGeneral = require('byteballcore/wallet_general.js');
	readMinSellPrice(pair_id, 'int_price', function(min_int_sell_price){
		if (min_int_sell_price === null)
			return onDone();
		readMaxBuyPrice(pair_id, 'int_price', function(max_int_buy_price){
			if (max_int_buy_price === null)
				return onDone();
			if (max_int_buy_price < min_int_sell_price)
				return onDone();
			readPairProps(pair_id, function(asset1, asset2){
				db.query(
					"SELECT order_id, order_type, order_address, device_address, int_price, amount, counter_amount, \n\
						address, unit, message_index, output_index, \n\
						fee, fee_message_index, fee_output_index \n\
					FROM orders \n\
					WHERE pair_id=? AND is_active=1 AND int_price>=? AND int_price<=? ORDER BY fee DESC, creation_date", 
					[pair_id, min_int_sell_price, max_int_buy_price], 
					function(rows){
						findMatches(rows, function(arrMatches){
							if (arrMatches.length === 0)
								return onDone();
							var assocInputsByAsset = {};
							assocInputsByAsset[asset1] = [];
							assocInputsByAsset[asset2] = [];
							var assocOutputsByAsset = {};
							assocOutputsByAsset[asset1] = [];
							assocOutputsByAsset[asset2] = [];
							assocOutputsByAsset['base'] = [{address: operator_fee_address, amount: 0}]; // change
							var assocTotals = {};
							assocTotals[asset1] = {inputs:0, outputs:0};
							assocTotals[asset2] = {inputs:0, outputs:0};
							assocTotals['base'] = {inputs:0, outputs:0};
							var arrFromAddresses = [];
							var arrOrderIds = [];
							var arrDeviceAddresses = [];
							arrMatches.forEach(function(objMatch){
								objMatch.buy.forEach(function(row){
									arrFromAddresses.push(row.order_address);
									arrOrderIds.push(row.order_id);
									arrDeviceAddresses.push(row.device_address);
									assocInputsByAsset[asset2].push({unit: row.unit, message_index: row.message_index, output_index: row.output_index});
									assocOutputsByAsset[asset1].push({address: row.address, amount: row.amount});
									assocTotals[asset2].inputs += row.counter_amount;
									assocTotals[asset1].outputs += row.amount;
									assocTotals['base'].inputs += row.fee;
									if (row.message_index === row.fee_message_index && row.output_index === row.fee_output_index){
										if (asset2 !== 'base')
											throw Error('fee paid in asset2 but it is not base');
									}
									else{
										assocInputsByAsset['base'].push({unit: row.unit, message_index: row.fee_message_index, output_index: row.fee_output_index});
									}
								});
								objMatch.sell.forEach(function(row){
									arrFromAddresses.push(row.order_address);
									arrOrderIds.push(row.order_id);
									arrDeviceAddresses.push(row.device_address);
									assocInputsByAsset[asset1].push({unit: row.unit, message_index: row.message_index, output_index: row.output_index});
									assocOutputsByAsset[asset2].push({address: row.address, amount: row.counter_amount});
									assocTotals[asset2].outputs += row.counter_amount;
									assocTotals[asset1].inputs += row.amount;
									assocTotals['base'].inputs += row.fee;
									if (row.message_index === row.fee_message_index && row.output_index === row.fee_output_index){
										if (asset1 !== 'base')
											throw Error('fee paid in asset1 but it is not base');
									}
									else{
										assocInputsByAsset['base'].push({unit: row.unit, message_index: row.fee_message_index, output_index: row.fee_output_index});
									}
								});
							});
							for (var asset in assocTotals){
								assocTotals[asset].balance = assocTotals[asset].inputs - assocTotals[asset].outputs;
								if (assocTotals[asset].balance < 0)
									throw Error('balance < 0 for asset '+asset);
							}
							// in case the market is crossed, the excess goes to the operator
							if (assocTotals[asset1].balance > 0 && asset1 !== 'base')
								assocOutputsByAsset[asset1].push({address: operator_fee_address, amount: assocTotals[asset1].balance});
							if (assocTotals[asset2].balance > 0 && asset2 !== 'base')
								assocOutputsByAsset[asset2].push({address: operator_fee_address, amount: assocTotals[asset2].balance});
							var arrMessages = [];
							if (asset1 !== 'base')
								arrMessages.push(createPaymentMessage(asset1, assocInputsByAsset[asset1], assocOutputsByAsset[asset1]));
							if (asset2 !== 'base')
								arrMessages.push(createPaymentMessage(asset2, assocInputsByAsset[asset2], assocOutputsByAsset[asset2]));

							composer.composeJoint({
								paying_addresses: arrFromAddresses,
								outputs: assocOutputsByAsset['base'],
								inputs: assocInputsByAsset['base'],
								input_amount: assocTotals['base'].inputs,
								messages: arrMessages,
								earned_headers_commission_recipients: [{address: operator_fee_address, earned_headers_commission_share: 100}],
								callbacks: composer.getSavingCallbacks({
									ifOk: function(objJoint){
										db.query("INSERT INTO deals (unit) VALUES(?)", [objJoint.unit.unit], function(res){
											var deal_id = res.insertId;
											if (!deal_id)
												throw Error('no insert id');
											db.query(
												"UPDATE orders \n\
												SET is_active=0, actual_counter_amount=counter_amount, fill_date="+db.getNow()+", deal_id=? \n\
												WHERE order_id IN(?)", 
												[deal_id, arrOrderIds], 
												function(){
													async.eachSeries(
														arrMatches,
														function(objMatch, cb){
															var arrMatchOrderIds = 
																objMatch.buy.map(extractOrderId).concat(objMatch.sell.map(extractOrderId));
															db.query("INSERT INTO matches (deal_id) VALUES(?)", [deal_id], function(mres){
																var match_id = mres.insertId;
																db.query("UPDATE orders SET match_id=? WHERE order_id IN(?)", 
																	[match_id, arrMatchOrderIds], function(){ cb(); });
															});
														},
														onDone
													);
												}
											);
										});
										network.broadcastJoint(objJoint);
										_.uniq(arrDeviceAddresses).forEach(function(device_address){
											walletGeneral.sendPaymentNotification(device_address, objJoint.unit.unit);
										});
									},
									ifError: function(err){
										throw Error('failed to compose exchange transaction: '+err);
									},
									ifNotEnoughFunds: function(err){
										throw Error('not enough funds to compose exchange transaction: '+err);
									}
								}),
								signer: signer
							});
						}); // findMatches
					}
				);
			}); // readPairProps
		});
	});
}

function matchOrdersUnderLock(pair_id){
	mutex.lock(['match-'+pair_id], function(unlock){
		cancelSpentOrders(function(){
			matchOrders(pair_id, unlock);
		});
	});
}

function initOperatorAddress(onDone){
	if (!onDone)
		onDone = function(){};
	db.query(
		"SELECT address FROM my_addresses JOIN unit_authors USING(address) JOIN units USING(unit) WHERE is_stable=1 AND sequence='good' LIMIT 1", 
		function(rows){
			if (rows.length === 0){
				console.log('no operator address yet');
				return onDone('no operator address yet');
			}
			operator_address = rows[0].address;
			operator_fee_address = operator_address;
			onDone();
		}
	);
}

function isOperatorReady(){
	if (operator_address)
		return true;
	initOperatorAddress();
	return false;
}

function getLots(amount){
	let amount_bits = (amount).toString(2);
	var arrLots = [];
	var lot_size = 1;
	for (var i=amount_bits.length-1; i>=0; i--){
		if (parseInt(amount_bits[i]))
			arrLots.push(lot_size);
		lot_size *= 2;
	}
	return arrLots;
}

function handleOrder(pair_id, order_type, price, amount, address, device_address, handleResult){
	var walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
	var device = require('byteballcore/device.js');
	readPairProps(pair_id, function(asset1, asset2, multiplier){
		let int_price = Math.round(price*multiplier);
		var in_asset, out_asset;
		if (order_type === 'buy'){
			in_asset = asset2;
			out_asset = asset1;
		}
		else{
			out_asset = asset2;
			in_asset = asset1;
		}
		let in_asset_for_db = (in_asset === 'base') ? null : in_asset;
		let release_ts = Date.now() + ORDER_TERM;
		var arrLots = getLots(amount);
		var arrOrderAddressInfos = [];
		async.each(
			arrLots,
			function(standard_amount, cb){
				var in_amount, out_amount;
				if (order_type === 'buy'){
					in_amount = Math.round(standard_amount*price);
					out_amount = standard_amount;
				}
				else{
					out_amount = Math.round(standard_amount*price);
					in_amount = standard_amount;
				}
				var arrDefinition = ['or', [
					['and', [
						['address', address],
						['in data feed', [[TIMESTAMPER_ADDRESS], 'timestamp', '>', release_ts]]
					]],
					['and', [
						['address', operator_address],
						['has', {
							what: 'output',
							asset: out_asset,
							amount_at_least: out_amount,
							address: address
						}]
					]]
				]];
				var order_address = objectHash.getChash160(arrDefinition);
				var signers = {
					'r.0.0': {
						address: address,
						member_signing_path: 'r',
						device_address: device_address
					},
					'r.1.0': {
						address: operator_address,
						member_signing_path: 'r',
						device_address: device.getMyDeviceAddress()
					}
				};
				db.query("SELECT 1 FROM shared_addresses WHERE shared_address=?", [order_address], function(rows){
					if (rows.length > 0)
						return cb("Address already used, please try again");
					walletDefinedByAddresses.handleNewSharedAddress({address: order_address, definition: arrDefinition, signers: signers}, {
						ifOk: function(){
							db.query(
								"INSERT INTO expected_deposits \n\
									(pair_id, order_type, price, int_price, device_address, order_address, asset, in_amount) VALUES(?,?, ?,?, ?,?, ?,?)", 
								[pair_id, order_type, price, int_price, device_address, order_address, in_asset_for_db, in_amount], 
								function(){
									arrOrderAddressInfos.push({
										in_amount: in_amount,
										order_address: order_address,
										definition: arrDefinition,
										signers: signers
									});
									cb();
								}
							);
						},
						ifError: function(err){
							throw Error('failed to create shared address: '+err);
						}
					});
				});
			},
			function(err){
				handleResult(err, arrOrderAddressInfos);
			}
		);
	});
}

eventBus.on('new_my_transactions', function(arrUnits){
	arrUnits.forEach(function(unit){
		var assocAmountsByDeviceAndAsset = {};
		db.query(
			"SELECT expected_deposits.*, message_index, output_index, outputs.amount AS output_amount FROM outputs \n\
			JOIN expected_deposits \n\
				ON outputs.address=expected_deposits.order_address \n\
				AND outputs.amount>=expected_deposits.in_amount \n\
				AND (outputs.asset=expected_deposits.asset OR outputs.asset IS NULL AND expected_deposits.asset IS NULL) \n\
			WHERE unit=? AND received_date IS NULL",
			[unit],
			function(rows){
				async.each(rows, function(row, cb){
					function logAndContinue(text){
						console.log(text);
						cb();
					}
					if (row.asset && row.output_amount !== row.in_amount)
						return logAndContinue('for non-base assets, expected amount must be matched exactly');
					
					signer.readDefinition(db, row.order_address, function(err, arrDefinition){
						function insertOrder(){
							db.query("UPDATE expected_deposits SET received_date="+db.getNow()+" WHERE expected_deposit_id=?", [row.expected_deposit_id]);
							db.query(
								"INSERT INTO orders ( \n\
									unit, pair_id, order_type, order_address, address, device_address, \n\
									amount, counter_amount, price, int_price, message_index, output_index, \n\
									fee, fee_message_index, fee_output_index \n\
								) \n\
								VALUES(?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?)",
								[unit, row.pair_id, row.order_type, row.order_address, address, row.device_address, 
								amount, counter_amount, row.price, row.int_price, row.message_index, row.output_index, 
								fee, fee_message_index, fee_output_index],
								function(){
									let asset = row.asset || 'base';
									if (!assocAmountsByDeviceAndAsset[row.device_address])
										assocAmountsByDeviceAndAsset[row.device_address] = {};
									if (!assocAmountsByDeviceAndAsset[row.device_address][asset])
										assocAmountsByDeviceAndAsset[row.device_address][asset] = 0;
									assocAmountsByDeviceAndAsset[row.device_address][asset] += row.output_amount;
									cb();
									// since now, we wait that the unit becomes stable
								}
							);
						}
						if (err)
							throw Error('failed to read '+row.order_address+' definition: '+err);
						let arrOr = arrDefinition[1];
						let arrCustomerBranch = arrOr[0];
						let arrCustomerAnd = arrCustomerBranch[1];
						let address = arrCustomerAnd[0][1];
						let arrOperatorBranch = arrOr[1];
						let arrOperatorAnd = arrOperatorBranch[1];
						let operator_address = arrOperatorAnd[0][1];
						let objHas = arrOperatorAnd[1][1];
						let out_amount = objHas.amount_at_least;
						let amount = (row.order_type === 'buy') ? out_amount : row.in_amount;
						let counter_amount = (row.order_type === 'buy') ? row.in_amount : out_amount;
						var fee, fee_message_index, fee_output_index;
						if (row.asset){ // fee should be paid in a separate output
							db.query(
								"SELECT message_index, output_index, amount FROM outputs WHERE unit=? AND asset IS NULL AND address=?", 
								[unit, row.order_address],
								function(fee_rows){
									if (fee_rows.length === 0)
										return logAndContinue('no fee paid');
									if (fee_rows.length > 1)
										return logAndContinue('more than one fee payment');
									fee = fee_rows[0].amount;
									if (fee < MIN_FEE)
										return logAndContinue('received fee output '+fee+' < min fee '+MIN_FEE);
									fee_message_index = fee_rows[0].message_index;
									fee_output_index = fee_rows[0].output_index;
									insertOrder();
								}
							);
						}
						else{ // bytes: fee is added to in_amount
							fee = row.output_amount - row.in_amount;
							if (fee < MIN_FEE)
								return logAndContinue('received fee '+fee+' < min fee '+MIN_FEE);
							fee_message_index = row.message_index;
							fee_output_index = row.output_index;
							insertOrder();
						}
					});
				}, function(){
					var device = require('byteballcore/device.js');
					for (var device_address in assocAmountsByDeviceAndAsset)
						for (var asset in assocAmountsByDeviceAndAsset[device_address])
							device.sendMessageToDevice(device_address, 'text', "Received "+assocAmountsByDeviceAndAsset[device_address][asset]+" "+(asset === 'base' ? 'bytes' : ' of '+asset)+", will add your order to the [book](command:book) after the transaction is final.");
				});
			}
		);
	});
});

eventBus.on('mci_became_stable', function(mci){
	mutex.lock(["write"], function(unlock){
		unlock(); // we don't need to block writes, we requested the lock just to wait that the current write completes
		db.query(
			"SELECT order_id, pair_id, device_address FROM orders JOIN units USING(unit) WHERE main_chain_index=? AND is_active IS NULL", 
			[mci], 
			function(rows){
				if (rows.length === 0)
					return;
				let arrDeviceAddresses = _.uniq(rows.map(row => row.device_address));
				var device = require('byteballcore/device.js');
				arrDeviceAddresses.forEach(device_address => {
					device.sendMessageToDevice(device_address, 'text', "The transaction is now final and you can see your order in the [book](command:book).  To view only your orders, say [orders](command:orders)");
				});
				let arrOrderIds = rows.map(extractOrderId);
				db.query("UPDATE orders SET is_active=1 WHERE order_id IN(?)", [arrOrderIds], function(){
					let arrPairIds = _.uniq(rows.map(function(row){ return row.pair_id; }));
					arrPairIds.forEach(matchOrdersUnderLock);
				});
			}
		);
	});
});


eventBus.on('headless_wallet_ready', function(){
	/*if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}*/
	initOperatorAddress();
	matchOrdersUnderLock(1);
});


exports.MIN_FEE = MIN_FEE;
exports.isOperatorReady = isOperatorReady;
exports.getLots = getLots;
exports.handleOrder = handleOrder;
exports.readPairProps = readPairProps;
exports.readBidAsk = readBidAsk;


