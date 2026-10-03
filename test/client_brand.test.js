"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { NormalizePresence } = require("../realtime");

function Presence(ClientType)
{
	return { server_address: "127.0.0.1:8303", session_id: "session-1", client_type: ClientType,
		players: [{ player_id: 3, player_name: "Player", dummy: false }, { player_id: 7, player_name: "Dummy", dummy: true }] };
}

test("legacy presence without a brand remains Qm", () => {
	const Result = NormalizePresence(Presence());
	assert.equal(Result.client_type, "qm");
	assert.deepEqual(Result.players.map((Player) => Player.client_type), ["qm", "qm"]);
});

test("recognized brand aliases apply to both main player and dummy", () => {
	for(const [Alias, Brand] of [["arg", "arg"], [" ArGhEnA ", "arg"], ["qm", "qm"], ["QmClient", "qm"], ["q1meng", "qm"]])
	{
		const Result = NormalizePresence(Presence(Alias));
		assert.equal(Result.client_type, Brand, Alias);
		assert.deepEqual(Result.players.map((Player) => Player.client_type), [Brand, Brand], Alias);
	}
});

test("player brand overrides the connection brand", () => {
	const Body = Presence("arg");
	Body.players[1].client_type = "qmclient";
	const Result = NormalizePresence(Body);
	assert.equal(Result.client_type, "arg");
	assert.deepEqual(Result.players.map((Player) => Player.client_type), ["arg", "qm"]);
});

test("legacy player type alias is retained", () => {
	const Body = Presence("qm");
	Body.players[0].type = "arghena";
	assert.equal(NormalizePresence(Body).players[0].client_type, "arg");
});

test("unrecognized player brands inherit the connection brand", () => {
	for(const ClientType of ["unknown", "", null, 42, {}])
	{
		const Body = Presence("arg");
		Body.players[0].client_type = ClientType;
		assert.equal(NormalizePresence(Body).players[0].client_type, "arg");
	}
});

test("presence without a brand inherits an established Arg session", () => {
	const Result = NormalizePresence(Presence(), "arg");
	assert.equal(Result.client_type, "arg");
	assert.deepEqual(Result.players.map((Player) => Player.client_type), ["arg", "arg"]);
});

test("an explicit brand change overrides the session default", () => {
	const Result = NormalizePresence(Presence("qm"), "arg");
	assert.equal(Result.client_type, "qm");
	assert.deepEqual(Result.players.map((Player) => Player.client_type), ["qm", "qm"]);
});

test("an explicitly unsupported brand keeps the legacy Qm fallback", () => {
	const Result = NormalizePresence(Presence("best"), "arg");
	assert.equal(Result.client_type, "qm");
	assert.deepEqual(Result.players.map((Player) => Player.client_type), ["qm", "qm"]);
});
