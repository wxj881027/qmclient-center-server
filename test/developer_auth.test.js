"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	CreateDeveloperPresenceService,
	LoadDeveloperCredentials,
	RegisterDeveloperPresenceRoutes
} = require("../developer_auth");

function TokenSha256(Token)
{
	return crypto.createHash("sha256").update(Token, "utf8").digest("hex");
}

function MakeCredentials(Token = "correct-horse-battery-staple")
{
	return [{
		developer_id: "qimeng",
		key_id: "desktop-main",
		token_sha256: TokenSha256(Token),
		revoked: false
	}];
}

function MakeBody(Overrides = {})
{
	return {
		server_address: "127.0.0.1:8303",
		session_id: "session-alpha",
		players: [{ player_id: 7, player_name: "任意昵称", dummy: false }],
		...Overrides
	};
}

function CreateFakeApp()
{
	const Routes = new Map();
	return {
		Routes,
		post(Path, Handler)
		{
			Routes.set(`POST ${Path}`, Handler);
		},
		get(Path, Handler)
		{
			Routes.set(`GET ${Path}`, Handler);
		}
	};
}

function InvokeRoute(App, Method, Path, Request)
{
	const Handler = App.Routes.get(`${Method} ${Path}`);
	assert.ok(Handler, `route ${Method} ${Path} must be registered`);
	const Result = { statusCode: 200, payload: undefined };
	const Response = {
		status(StatusCode)
		{
			Result.statusCode = StatusCode;
			return this;
		},
		json(Payload)
		{
			Result.payload = Payload;
			return this;
		}
	};
	Handler(Request, Response);
	return Result;
}

function WithRoutes(Options, Callback)
{
	const App = CreateFakeApp();
	const Service = CreateDeveloperPresenceService(Options);
	RegisterDeveloperPresenceRoutes(App, Service);
	return Callback(App, Service);
}

test("developer credentials are loaded from the configured JSON file", () => {
	const TempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "qmclient-developer-auth-"));
	const CredentialsFile = path.join(TempDirectory, "credentials.json");
	try
	{
		fs.writeFileSync(CredentialsFile, JSON.stringify({ credentials: MakeCredentials() }), "utf8");
		const Credentials = LoadDeveloperCredentials(CredentialsFile);
		assert.equal(Credentials.length, 1);
		assert.equal(Credentials[0].developer_id, "qimeng");
		assert.equal(Credentials[0].key_id, "desktop-main");
	}
	finally
	{
		fs.rmSync(TempDirectory, { recursive: true, force: true });
	}
});

test("presence endpoints authenticate a bearer token and return the documented fields", () => {
	WithRoutes({
		Credentials: MakeCredentials(),
		NowSec: () => 1000,
		RandomBucket: () => 19
	}, (App) => {
		const ReportResponse = InvokeRoute(App, "POST", "/api/v1/developers/presence", {
			headers: { authorization: "Bearer correct-horse-battery-staple" },
			body: MakeBody()
		});
		assert.equal(ReportResponse.statusCode, 200);

		const ListResponse = InvokeRoute(App, "GET", "/api/v1/developers/presences", {
			query: { server_address: "127.0.0.1:8303" }
		});
		assert.equal(ListResponse.statusCode, 200);
		assert.deepEqual(ListResponse.payload, {
			server_time: 1000,
			presences: [{
				developer_id: "qimeng",
				server_address: "127.0.0.1:8303",
				player_id: 7,
				player_name: "任意昵称",
				dummy: false,
				issued_at: 1000,
				expires_at: 1015,
				style_bucket: 19
			}]
		});
	});
});

test("legacy public tokens and self-reported developer fields cannot authenticate", () => {
	WithRoutes({
		Credentials: MakeCredentials(),
		NowSec: () => 1000,
		RandomBucket: () => 0
	}, (App) => {
		for(const Authorization of [undefined, "Bearer legacy-public-token", "Bearer revoked-token"])
		{
			const Response = InvokeRoute(App, "POST", "/api/v1/developers/presence", {
				headers: Authorization ? { authorization: Authorization } : {},
				body: { ...MakeBody(), developer: true, developer_id: "qimeng" }
			});
			assert.equal(Response.statusCode, 401);
		}
	});

	const RevokedToken = "revoked-token";
	const Service = CreateDeveloperPresenceService({
		Credentials: [{
			developer_id: "qimeng",
			key_id: "old-device",
			token_sha256: TokenSha256(RevokedToken),
			revoked: true
		}],
		NowSec: () => 1000,
		RandomBucket: () => 0
	});
	assert.equal(Service.ReportPresence(`Bearer ${RevokedToken}`, MakeBody()).statusCode, 401);
});

test("developer routes support the center server rate limiter", () => {
	const App = CreateFakeApp();
	const Service = CreateDeveloperPresenceService({
		Credentials: MakeCredentials(),
		NowSec: () => 1000,
		RandomBucket: () => 0
	});
	let Checks = 0;
	RegisterDeveloperPresenceRoutes(App, Service, {
		CheckRateLimit: () => {
			Checks += 1;
			return false;
		}
	});
	const Response = InvokeRoute(App, "POST", "/api/v1/developers/presence", {
		headers: { authorization: "Bearer correct-horse-battery-staple" },
		body: MakeBody()
	});
	assert.equal(Checks, 1);
	assert.equal(Response.statusCode, 429);
	assert.deepEqual(Response.payload, { ok: false, error: "rate_limited" });
	const ListResponse = InvokeRoute(App, "GET", "/api/v1/developers/presences", {
		query: { server_address: "127.0.0.1:8303" }
	});
	assert.equal(ListResponse.statusCode, 429);
	assert.deepEqual(ListResponse.payload, { ok: false, error: "rate_limited" });
	assert.equal(Checks, 2);
});

test("presence validation binds server session and every player field without trusting client wall time", () => {
	const Service = CreateDeveloperPresenceService({
		Credentials: MakeCredentials(),
		NowSec: () => 1000,
		RandomBucket: () => 0
	});
	const Authorization = "Bearer correct-horse-battery-staple";

	assert.equal(Service.ReportPresence(Authorization, MakeBody()).statusCode, 200);
	assert.equal(Service.ReportPresence(Authorization, MakeBody({ timestamp: -999999999 })).statusCode, 200);
	assert.equal(Service.ReportPresence(Authorization, MakeBody({ players: [{ player_id: 127, player_name: "last-slot", dummy: false }] })).statusCode, 200);
	for(const InvalidBody of [
		MakeBody({ server_address: "" }),
		MakeBody({ session_id: "" }),
		MakeBody({ players: [] }),
		MakeBody({ players: [{ player_id: -1, player_name: "name", dummy: false }] }),
		MakeBody({ players: [{ player_id: 128, player_name: "name", dummy: false }] }),
		MakeBody({ players: [{ player_id: 7, player_name: "", dummy: false }] }),
		MakeBody({ players: [{ player_id: 7, player_name: "name", dummy: 1 }] }),
		MakeBody({ players: [
			{ player_id: 7, player_name: "main", dummy: false },
			{ player_id: 7, player_name: "dummy", dummy: true }
		] })
	])
	{
		assert.equal(Service.ReportPresence(Authorization, InvalidBody).statusCode, 400);
	}
});

test("main and dummy presences use exact server and player ids with arbitrary names", () => {
	let RandomCalls = 0;
	const Service = CreateDeveloperPresenceService({
		Credentials: MakeCredentials(),
		NowSec: () => 1000,
		RandomBucket: () => {
			RandomCalls += 1;
			return 42;
		}
	});
	const Result = Service.ReportPresence("Bearer correct-horse-battery-staple", MakeBody({
		players: [
			{ player_id: 3, player_name: "completely-new-main", dummy: false },
			{ player_id: 11, player_name: "同名也不是白名单", dummy: true }
		]
	}));
	assert.equal(Result.statusCode, 200);
	assert.deepEqual(Service.GetPresences("different.example:8303").response, { server_time: 1000, presences: [] });
	const Presences = Service.GetPresences("127.0.0.1:8303").response.presences;
	assert.deepEqual(Presences.map((Presence) => [Presence.player_id, Presence.player_name, Presence.dummy]), [
		[3, "completely-new-main", false],
		[11, "同名也不是白名单", true]
	]);
	assert.deepEqual(Presences.map((Presence) => Presence.style_bucket), [42, 42]);
	assert.equal(RandomCalls, 1);
});

test("the same session keeps its style bucket while a new session samples again", () => {
	let Now = 1000;
	const Service = CreateDeveloperPresenceService({
		Credentials: MakeCredentials(),
		NowSec: () => Now,
		RandomBucket: (_Credential, SessionId) => SessionId === "session-beta" ? 20 : 19
	});
	const Authorization = "Bearer correct-horse-battery-staple";

	assert.equal(Service.ReportPresence(Authorization, MakeBody()).statusCode, 200);
	Now = 1005;
	assert.equal(Service.ReportPresence(Authorization, MakeBody({
		server_address: "another.example:8304",
		players: [{ player_id: 7, player_name: "renamed-in-same-session", dummy: false }]
	})).statusCode, 200);
	let Presence = Service.GetPresences("another.example:8304").response.presences[0];
	assert.equal(Presence.style_bucket, 19);
	assert.equal(Presence.player_name, "renamed-in-same-session");
	assert.equal(Presence.expires_at, 1020);

	Now = 1006;
	assert.equal(Service.ReportPresence(Authorization, MakeBody({ server_address: "another.example:8304", session_id: "session-beta" })).statusCode, 200);
	Presence = Service.GetPresences("another.example:8304").response.presences[0];
	assert.equal(Presence.style_bucket, 20);
});

test("the same credential and session keep their style across service restarts", () => {
	const Authorization = "Bearer correct-horse-battery-staple";
	const FirstService = CreateDeveloperPresenceService({ Credentials: MakeCredentials(), NowSec: () => 1000 });
	const SecondService = CreateDeveloperPresenceService({ Credentials: MakeCredentials(), NowSec: () => 1001 });
	assert.equal(FirstService.ReportPresence(Authorization, MakeBody()).statusCode, 200);
	assert.equal(SecondService.ReportPresence(Authorization, MakeBody()).statusCode, 200);
	const FirstBucket = FirstService.GetPresences("127.0.0.1:8303").response.presences[0].style_bucket;
	const SecondBucket = SecondService.GetPresences("127.0.0.1:8303").response.presences[0].style_bucket;
	assert.equal(FirstBucket, SecondBucket);
});

test("presences fail closed exactly at the fifteen second TTL", () => {
	let Now = 1000;
	const Service = CreateDeveloperPresenceService({
		Credentials: MakeCredentials(),
		NowSec: () => Now,
		RandomBucket: () => 0
	});
	assert.equal(Service.ReportPresence("Bearer correct-horse-battery-staple", MakeBody()).statusCode, 200);
	Now = 1014;
	assert.equal(Service.GetPresences("127.0.0.1:8303").response.presences.length, 1);
	Now = 1015;
	assert.equal(Service.GetPresences("127.0.0.1:8303").response.presences.length, 0);
});

test("style buckets expose exactly twenty rainbow outcomes out of one hundred", () => {
	let Bucket = 0;
	let Now = 1000;
	const Service = CreateDeveloperPresenceService({
		Credentials: MakeCredentials(),
		NowSec: () => Now,
		RandomBucket: () => Bucket
	});
	let RainbowCount = 0;
	for(Bucket = 0; Bucket < 100; ++Bucket)
	{
		const Result = Service.ReportPresence("Bearer correct-horse-battery-staple", MakeBody({
			session_id: `session-${Bucket}`,
		}));
		assert.equal(Result.statusCode, 200);
		const Presence = Service.GetPresences("127.0.0.1:8303").response.presences[0];
		if(Presence.style_bucket < 20)
			RainbowCount += 1;
		Now += 1;
	}
	assert.equal(RainbowCount, 20);
});
