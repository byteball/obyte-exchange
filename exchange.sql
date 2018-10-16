CREATE TABLE asset_indexes (
	asset_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	asset CHAR(44) NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (asset) REFERENCES assets(unit)
);
CREATE INDEX byAssetIndexesAsset ON asset_indexes(asset);

INSERT INTO asset_indexes (asset_id, asset) VALUES (1, NULL);
INSERT INTO asset_indexes (asset_id, asset) VALUES (2, 'f2TMkqij/E3qx3ALfVBA8q5ve5xAwimUm92UrEribIE=');  -- titan
INSERT INTO asset_indexes (asset_id, asset) VALUES (3, '1OLPCz72F1rJ7IGtmEMuV1LvfLawT9WGOFuHugW2b7c=');  -- SNTR
INSERT INTO asset_indexes (asset_id, asset) VALUES (4, 'pZML61kxjqV2TcMMGr1z3z0jvAkDcOwdGzxoXjsV52Q=');  -- LWC
INSERT INTO asset_indexes (asset_id, asset) VALUES (5, 'oF9wmH31QDL/VXppOJ9mHISrvcdJQ1rqU+Jv8GRQH84=');  -- CHM

CREATE TABLE aliases (
	alias_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	asset_id INTEGER NOT NULL,
	alias VARCHAR(20) COLLATE NOCASE NOT NULL UNIQUE,
	decimals TINYINT NOT NULL,
	is_default TINYINT NULL DEFAULT 1,
	UNIQUE(asset_id, is_default),
	FOREIGN KEY (asset_id) REFERENCES asset_indexes(asset_id)
);

INSERT INTO aliases (asset_id, alias, decimals, is_default) VALUES (1, 'BYTE', 0, NULL), (1, 'bytes', 0, NULL);
INSERT INTO aliases (asset_id, alias, decimals, is_default) VALUES (1, 'GBYTE', 9, NULL), (1, 'GB', 9, 1);
INSERT INTO aliases (asset_id, alias, decimals, is_default) VALUES (2, 'TC', 6, 1), (2, 'TitanCoin', 6, NULL);
INSERT INTO aliases (asset_id, alias, decimals, is_default) VALUES (3, 'SNTR', 4, 1), (3, 'SilentNotary', 4, NULL);
INSERT INTO aliases (asset_id, alias, decimals, is_default) VALUES (4, 'LWC', 4, 1), (4, 'WhiteLittle', 4, NULL);
INSERT INTO aliases (asset_id, alias, decimals, is_default) VALUES (5, 'CHM', 6, 1), (5, 'Charm', 6, NULL);

CREATE TABLE pairs (
	pair_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	asset_id1 INT NOT NULL, -- base currency asset1/asset2
	asset_id2 INT NOT NULL, -- quote currency asset1/asset2
	pip DECIMAL(20,10) NOT NULL, -- smallest step in price change
	multiplier INT NOT NULL, -- =1/pip is the multiplier that would make the price int
	amount_increment INT NOT NULL, -- order amount must be divisible by amount_increment, which itself must be a power of 2
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	is_delisted TINYINT NOT NULL DEFAULT 0,
	UNIQUE (asset_id1, asset_id2),
	FOREIGN KEY (asset_id1) REFERENCES asset_indexes(asset_id),
	FOREIGN KEY (asset_id2) REFERENCES asset_indexes(asset_id)
);
CREATE INDEX byPairsAsset1 ON pairs(asset_id1);
CREATE INDEX byPairsAsset2 ON pairs(asset_id2);

INSERT INTO pairs (asset_id1, asset_id2, pip, multiplier, amount_increment) VALUES (2, 1, 0.01, 100, 1024);
INSERT INTO pairs (asset_id1, asset_id2, pip, multiplier, amount_increment) VALUES (3, 1, 0.00001, 100000, 131072);
INSERT INTO pairs (asset_id1, asset_id2, pip, multiplier, amount_increment) VALUES (4, 1, 0.00001, 100000, 131072);
INSERT INTO pairs (asset_id1, asset_id2, pip, multiplier, amount_increment) VALUES (5, 1, 0.000001, 1000000, 134217728);

CREATE TABLE deals (
	deal_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	unit CHAR(44) NOT NULL UNIQUE,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (unit) REFERENCES units(unit)
);

-- one deal can contain multiple matches
CREATE TABLE matches (
	match_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	deal_id INT NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (deal_id) REFERENCES deals(deal_id)
);
CREATE INDEX byMatchesDealId ON matches(deal_id);

CREATE TABLE orders (
	order_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	unit CHAR(44) NOT NULL, -- the unit that created the order, can create multiple orders in one unit
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	fill_date TIMESTAMP NULL,
	cancel_date TIMESTAMP NULL,
	is_active TINYINT NULL, -- NULL when unstable, 1 when active, 0 when filled or canceled
	pair_id INT NOT NULL,
	order_type CHAR(4) CHECK (order_type IN('buy','sell')) NOT NULL,
	amount INT NOT NULL, -- the amount of asset1 currency, must be one of standard lot sizes
	counter_amount INT NOT NULL, -- the amount of asset2 currency
	price DECIMAL(20, 10) NOT NULL, -- counter_amount/amount
	int_price INT NOT NULL, -- price multiplied by multiplier
	actual_counter_amount INT NULL, -- actual amount of asset2 received when the sell order is filled, may be more than counter_amount
	message_index TINYINT NOT NULL,
	output_index TINYINT NOT NULL,
	fee_message_index TINYINT NOT NULL,
	fee_output_index TINYINT NOT NULL,
	fee INT NOT NULL, -- the fee in bytes paid to order_address in addition to selling_amount of selling_asset
	order_address CHAR(32) NOT NULL, -- address that holds the asset being sold and is dual-controled by the seller by the operator
	address CHAR(32) NOT NULL, -- address that receives the bought asset
	device_address CHAR(33) NOT NULL, -- the operator will send private payloads or payment notification to this address
	deal_id INT NULL, -- filled when the order is executed
	match_id INT NULL, -- filled when the order is executed
	FOREIGN KEY (pair_id) REFERENCES pairs(pair_id),
	FOREIGN KEY (deal_id) REFERENCES deals(deal_id),
	FOREIGN KEY (match_id) REFERENCES matches(match_id),
	FOREIGN KEY (unit) REFERENCES units(unit) ON DELETE CASCADE,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
CREATE INDEX byOrdersPairId ON pairs(pair_id);
CREATE INDEX byOrdersDealId ON orders(deal_id);
CREATE INDEX byOrdersMatchId ON orders(match_id);
CREATE INDEX byOrdersUnit ON orders(unit);
CREATE INDEX byOrdersDeviceAddress ON orders(device_address);
CREATE INDEX byOrdersActiveTypePrice ON orders(is_active, order_type, price);

CREATE TABLE expected_deposits (
	expected_deposit_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	received_date TIMESTAMP NULL,
	pair_id INT NOT NULL,
	order_type CHAR(4) CHECK (order_type IN('buy','sell')) NOT NULL,
	in_amount INT NOT NULL, -- the amount of the currency being sold
	price DECIMAL(20, 10) NOT NULL,
	int_price INT NOT NULL, -- price multiplied by multiplier
	order_address CHAR(32) NOT NULL UNIQUE, -- address that holds the asset being sold and is dual-controled by the seller by the operator
	device_address CHAR(33) NOT NULL, -- the operator will send private payloads or payment notification to this address
	asset CHAR(44) NULL,
	FOREIGN KEY (pair_id) REFERENCES pairs(pair_id),
	FOREIGN KEY (asset) REFERENCES assets(unit),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
CREATE INDEX byDepositsOrderAddress ON expected_deposits(order_address);

CREATE TABLE sessions (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	pair_id INT NULL,
	default_fee INT NULL,
	data TEXT NOT NULL,
	FOREIGN KEY (pair_id) REFERENCES pairs(pair_id),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

/*

ALTER TABLE pairs ADD COLUMN is_delisted TINYINT NOT NULL DEFAULT 0;

*/
