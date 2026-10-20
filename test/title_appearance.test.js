"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CreateTitleService, IssueTitleCode } = require("../title_auth");

function Fixture(T)
{
	const Directory = fs.mkdtempSync(path.join(os.tmpdir(), "qm-title-appearance-"));
	T.after(() => fs.rmSync(Directory, { recursive: true, force: true }));
	let Now = 1000;
	const Options = { Directory, NowSec: () => Now };
	const Service = CreateTitleService(Options);
	const Token = "a".repeat(64);
	assert.equal(Service.Redeem({ code: IssueTitleCode(Directory, "test"), token: Token }).statusCode, 200);
	return { Service, Auth: "Bearer " + Token, Options, Advance: () => { Now += 16; } };
}

const Body = { title: "自选文字", bound_name: "", style: "" };
const Appearance = { style: "sun", color: 0x123456, opacity: 35 };

test("old profiles receive a moon default while keeping user text", (T) => {
	const { Service, Auth } = Fixture(T);
	assert.equal(Service.Update(Auth, Body).statusCode, 200);
	assert.deepEqual(Service.Profile(Auth).response.appearance, { style: "moon", color: 0x9562ba, opacity: 100 });
	assert.equal(Service.Profile(Auth).response.title, Body.title);
});

test("appearance survives persistence and is sent to both main and dummy", (T) => {
	const { Service, Auth, Options } = Fixture(T);
	assert.equal(Service.Update(Auth, { ...Body, appearance: Appearance }).statusCode, 200);
	const Reloaded = CreateTitleService(Options);
	assert.deepEqual(Reloaded.Profile(Auth).response.appearance, Appearance);
	assert.equal(Reloaded.Report(Auth, { server_address: "test:8303", session_id: "test", players: [
		{ player_id: 3, player_name: "Main", dummy: false }, { player_id: 4, player_name: "Dummy", dummy: true }
	] }, "127.0.0.1").statusCode, 200);
	const Presences = Reloaded.List("test:8303").response.presences;
	assert.equal(Presences.length, 2);
	for(const Presence of Presences)
		assert.deepEqual(Presence.appearance, Appearance);
});

test("legacy updates preserve the saved appearance", (T) => {
	const { Service, Auth } = Fixture(T);
	Service.Update(Auth, { ...Body, appearance: Appearance });
	assert.equal(Service.Update(Auth, { ...Body, title: "New text" }).statusCode, 200);
	assert.deepEqual(Service.Profile(Auth).response.appearance, Appearance);
});

test("invalid appearance rejects the whole update", (T) => {
	const { Service, Auth } = Fixture(T);
	Service.Update(Auth, { ...Body, appearance: Appearance });
	for(const Value of [null, [], {}, { ...Appearance, style: "unknown" }, { ...Appearance, color: -1 },
		{ ...Appearance, color: 0x1000000 }, { ...Appearance, color: 1.5 }, { ...Appearance, opacity: 101 },
		{ ...Appearance, opacity: "35" }, { ...Appearance, opacity: -1 }])
	{
		assert.equal(Service.Update(Auth, { ...Body, title: "Other", appearance: Value }).statusCode, 400);
		assert.deepEqual(Service.Profile(Auth).response.appearance, Appearance);
		assert.equal(Service.Profile(Auth).response.title, Body.title);
	}
});

test("black and fully transparent appearance are valid user choices", (T) => {
	const { Service, Auth } = Fixture(T);
	const Value = { style: "moon", color: 0, opacity: 0 };
	assert.equal(Service.Update(Auth, { ...Body, appearance: Value }).statusCode, 200);
	assert.deepEqual(Service.Profile(Auth).response.appearance, Value);
});

test("appearance cannot bypass nickname binding or presence expiry", (T) => {
	const { Service, Auth, Advance } = Fixture(T);
	Service.Update(Auth, { ...Body, bound_name: "Bound", appearance: Appearance });
	const Report = (Name) => Service.Report(Auth, { server_address: "test:8303", session_id: "test", players: [
		{ player_id: 3, player_name: Name, dummy: false }
	] }, "127.0.0.1");
	Report("Other");
	assert.deepEqual(Service.List("test:8303").response.presences, []);
	Report("Bound");
	assert.equal(Service.List("test:8303").response.presences.length, 1);
	assert.deepEqual(Service.List("other:8303").response.presences, []);
	Advance();
	assert.deepEqual(Service.List("test:8303").response.presences, []);
});
