const express = require("express");
const SteamUser = require("steam-user");
const SteamID = require("steamid");
const ProtobufJS = require("protobufjs");
const config = require("./config.json");

let server = express();
let client = new SteamUser();
let protos = new ProtobufJS.Root().loadSync([
	"./protobufs/csgo/gcsdk_gcmessages.proto",
	"./protobufs/csgo/gcsystemmsgs.proto",
	"./protobufs/csgo/cstrike15_gcmessages.proto"
], {
	keepCase: true
});
let connectInterval = null;
let blockInterval = null;
let currentVersion = 0;
let users = [];

server.use((req, res, next) => {
	if (req.query.key !== config.key) {
		res.status(401);
		res.json({
			error: "Key mismatch, retrying will not help"
		});
		return;
	}

	UpdateUsers();
	next();
});

server.get("/list", (req, res) => {
	// 
	res.json({
		success: true,
		users: users
	});
});

server.get("/add", (req, res) => {
	// id & length
	try {
		if (!req.query.id) {
			res.status(400);
			res.json({
				error: "Request is missing 'id' parameter"
			});
			return;
		}

		if (!req.query.length) {
			res.status(400);
			res.json({
				error: "Request is missing 'length' parameter"
			});
			return;
		}

		let steamID = SteamID.fromIndividualAccountID(req.query.id);
		if (!steamID.isValidIndividual()) {
			res.status(400);
			res.json({
				error: "AccountID to add is not a valid Steam individual"
			});
			return;
		}

		let length = parseInt(req.query.length);
		if (isNaN(length) || length <= 0 || length > config.maxLength) {
			res.status(400);
			res.json({
				error: `Input length is invalid, it must be between 1 and ${config.maxLength} inclusive`
			});
		} else if (users.length >= config.maxUsers) {
			res.status(507);
			res.json({
				error: `Too many users are on the list, maximum ${config.maxUsers}`
			});
		} else {
			let user = users.find(u => u.id === steamID.accountid);
			if (user) {
				res.status(200);
				res.json({
					success: false,
					expiresAt: user.expiresAt
				});
			} else {
				users.push({
					id: steamID.accountid,
					expiresAt: Date.now() + (length * 1000)
				});
				res.status(200);
				res.json({
					success: true,
					expiresAt: users[users.length - 1].expiresAt
				});
			}
		}
	} catch {
		res.status(400);
		res.json({
			error: "AccountID to add is not a valid Steam individual"
		});
	}
});

server.get("/remove", (req, res) => {
	// id
	try {
		if (!req.query.id) {
			res.status(400);
			res.json({
				error: "Request is missing 'id' parameter"
			});
			return;
		}

		let steamID = SteamID.fromIndividualAccountID(req.query.id);
		if (!steamID.isValidIndividual()) {
			res.status(400);
			res.json({
				error: "AccountID to add is not a valid Steam individual"
			});
			return;
		}

		let index = users.findIndex(u => u.id === steamID.accountid);
		if (index <= -1) {
			res.status(200);
			res.json({
				success: false
			});
		} else {
			users.splice(index, 1);
			res.status(200);
			res.json({
				success: true
			});
		}
	} catch {
		res.status(400);
		res.json({
			error: "AccountID to add is not a valid Steam individual"
		});
	}
});

server.all("*", (req, res) => {
	res.status(400);
	res.json({
		error: "Invalid request, view code for more information"
	});
});

server.listen(config.port, () => {
	console.log(`Listening on ${config.port}`);
});

client.on("loggedOn", async () => {
	Log(`Successfully logged into ${client.steamID.getSteamID64()}`);

	try {
		await client.requestFreeLicense(730);
	} catch {
		Log("Failed to request license, trying to continue anyways...");
	}

	client.gamesPlayed([730]);

	clearInterval(connectInterval);
	connectInterval = setInterval(ConnectToGC, 1000);
});

client.on("receivedFromGC", (appID, msgType, payload) => {
	if (appID !== 730) {
		return;
	}

	let EGCBaseClientMsg = protos.lookupEnum("EGCBaseClientMsg");
	switch (msgType) {
		case EGCBaseClientMsg.values.k_EMsgGCClientWelcome: {
			let CMsgClientWelcome = protos.lookupType("CMsgClientWelcome");
			let body = CMsgClientWelcome.toObject(
				CMsgClientWelcome.decode(payload),
				{
					defaults: true
				}
			);

			if (body.game_data2) {
				let CMsgGCCStrike15_v2_MatchmakingGC2ClientHello = protos.lookupType("CMsgGCCStrike15_v2_MatchmakingGC2ClientHello");
				let body2 = CMsgGCCStrike15_v2_MatchmakingGC2ClientHello.toObject(
					CMsgGCCStrike15_v2_MatchmakingGC2ClientHello.decode(body.game_data2),
					{
						defaults: true
					}
				);
				currentVersion = body2.global_stats.required_appid_version;
				Log(`Setting current version to: ${currentVersion}`);

				clearInterval(connectInterval);
				clearInterval(blockInterval);
				blockInterval = setInterval(BlockUsers, 2500);
			} else {
				console.error(new Error("Received CMsgClientWelcome without game_data2 on it"));
			}
			break;
		}
		case EGCBaseClientMsg.values.k_EMsgGCClientConnectionStatus: {
			let CMsgConnectionStatus = protos.lookupType("CMsgConnectionStatus");
			let body = CMsgConnectionStatus.toObject(
				CMsgConnectionStatus.decode(payload),
				{
					defaults: true
				}
			);

			let GCConnectionStatus = protos.lookupEnum("GCConnectionStatus");
			if (body.status !== GCConnectionStatus.values.GCConnectionStatus_HAVE_SESSION) {
				clearInterval(blockInterval);
				clearInterval(connectInterval);
				connectInterval = setInterval(ConnectToGC, 1000);
			}

			Log(`Received CMsgConnectionStatus: ${Object.keys(GCConnectionStatus.values).find(k => GCConnectionStatus.values[k] === body.status) ?? body.status}`);
			break;
		}
		default: {
			break;
		}
	}
});

client.on("disconnected", () => {
	Log("Disconnected from Steam, clearing intervals and waiting for reconnect...");

	clearInterval(connectInterval);
	clearInterval(blockInterval);
});

client.on("error", (err) => {
	console.error(err);

	clearInterval(connectInterval);
	clearInterval(blockInterval);

	process.exit(1);
});

client.logOn(config.details);

function UpdateUsers() {
	Log("Filtering users...");

	users = users.filter((user) => {
		return user.expiresAt >= Date.now();
	});
}

function ConnectToGC() {
	Log("Sending CMsgClientHello to GC...");

	let EGCBaseClientMsg = protos.lookupEnum("EGCBaseClientMsg");
	let CMsgClientHello = protos.lookupType("CMsgClientHello");
	client.sendToGC(
		730,
		EGCBaseClientMsg.values.k_EMsgGCClientHello,
		{},
		CMsgClientHello.encode({}).finish()
	);
}

function BlockUsers() {
	UpdateUsers();

	if (!client.steamID || users.length <= 0) {
		if (!client.steamID) {
			Log("BlockUsers() was called but we are not logged on");
		} else {
			Log("BlockUsers() was called but there are no users to block");
		}
		return;
	}

	Log(`Blocking ${users.length} user${users.length === 1 ? "" : "s"}`);

	let ECsgoGCMsg = protos.lookupEnum("ECsgoGCMsg");
	let CMsgGCCStrike15_v2_MatchmakingStart = protos.lookupType("CMsgGCCStrike15_v2_MatchmakingStart");
	for (let user of users) {
		client.sendToGC(
			730,
			ECsgoGCMsg.values.k_EMsgGCCStrike15_v2_MatchmakingStart,
			{},
			CMsgGCCStrike15_v2_MatchmakingStart.encode({
				client_version: currentVersion,
				game_type: 519,
				account_ids: [
					client.steamID.accountid,
					user.id
				]
			}).finish()
		);
	}
}

function Log(...args) {
	if (config.logging) {
		console.log(...args);
	}
}
