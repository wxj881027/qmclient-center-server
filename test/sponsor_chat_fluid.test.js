"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { CreateTitleService, IssueTitleCode } = require("../title_auth");

function Fixture(T)
{
	const Directory = fs.mkdtempSync(path.join(os.tmpdir(), "qm-chat-fluid-"));
	T.after(() => fs.rmSync(Directory, { recursive: true, force: true }));
	const Options = { Directory, NowSec: () => 1000 };
	const Service = CreateTitleService(Options);
	const Token = "a".repeat(64);
	const Auth = "Bearer " + Token;
	assert.equal(Service.Redeem({ code: IssueTitleCode(Directory, "fluid-test"), token: Token }).statusCode, 200);
	const Profile = { title: "Sponsor", bound_name: "", style: "eternity" };
	const Presence = { server_address: "test:8303", session_id: "fluid-test", players: [
		{ player_id: 3, player_name: "Main", dummy: false },
		{ player_id: 4, player_name: "Dummy", dummy: true },
	] };
	return { Directory, Options, Service, Auth, Profile, Presence };
}

test("流体样式保存后立即分发给本体和分身，重启后仍保留", (T) => {
	const F = Fixture(T);
	assert.equal(F.Service.Report(F.Auth, F.Presence, "192.0.2.1").statusCode, 200);
	const Saved = F.Service.Update(F.Auth, { ...F.Profile, chat_style: "fluid", bound_name: "Main" });
	assert.equal(Saved.statusCode, 200);
	assert.equal(Saved.response.chat_style, "fluid");
	const Entries = F.Service.List("test:8303").response.presences;
	assert.deepEqual(Entries.map((Entry) => [Entry.player_id, Entry.chat_style]), [[3, "fluid"], [4, "fluid"]]);
	const Restarted = CreateTitleService(F.Options);
	assert.equal(Restarted.Profile(F.Auth).response.chat_style, "fluid");
	assert.equal(Restarted.Profile(F.Auth).response.style, "eternity");
	assert.equal(Restarted.Report(F.Auth, F.Presence, "192.0.2.1").statusCode, 200);
	assert.equal(Restarted.List("test:8303").response.presences[1].chat_style, "fluid");
});

test("省略字段保留流体，显式选择普通可关闭，铂金仍可选择", (T) => {
	const F = Fixture(T);
	assert.equal(F.Service.Profile(F.Auth).response.chat_style, "");
	assert.equal(F.Service.Update(F.Auth, { ...F.Profile, chat_style: "fluid" }).statusCode, 200);
	assert.equal(F.Service.Update(F.Auth, F.Profile).response.chat_style, "fluid");
	assert.equal(F.Service.Update(F.Auth, { ...F.Profile, chat_style: "" }).response.chat_style, "");
	assert.equal(F.Service.Update(F.Auth, { ...F.Profile, chat_style: "platinum" }).response.chat_style, "platinum");
});

test("非法样式拒绝整次修改并保留磁盘资料", (T) => {
	const F = Fixture(T);
	assert.equal(F.Service.Update(F.Auth, { ...F.Profile, chat_style: "fluid" }).statusCode, 200);
	const File = path.join(F.Directory, "titles.json");
	const Before = fs.readFileSync(File, "utf8");
	for(const Style of [null, 1, {}, "Fluid", "future_style"])
	{
		const Reply = F.Service.Update(F.Auth, { ...F.Profile, title: "Changed", chat_style: Style });
		assert.equal(Reply.statusCode, 400);
		assert.equal(Reply.response.error, "invalid_chat_style");
		assert.equal(F.Service.Profile(F.Auth).response.chat_style, "fluid");
		assert.equal(F.Service.Profile(F.Auth).response.title, F.Profile.title);
		assert.equal(fs.readFileSync(File, "utf8"), Before);
	}
});

test("流体样式仍要求认证，在线上报不能伪造样式", (T) => {
	const F = Fixture(T);
	assert.equal(F.Service.Update("Bearer " + "b".repeat(64), { ...F.Profile, chat_style: "fluid" }).statusCode, 401);
	assert.equal(F.Service.Report(F.Auth, { ...F.Presence, chat_style: "fluid" }, "192.0.2.1").statusCode, 200);
	assert.deepEqual(F.Service.List("test:8303").response.presences.map((Entry) => Entry.chat_style), ["", ""]);
	assert.equal(F.Service.Update(F.Auth, { ...F.Profile, chat_style: "fluid", bound_name: "Other" }).statusCode, 200);
	assert.equal(F.Service.List("test:8303").response.presences.length, 0);
	assert.equal(F.Service.List("other:8303").response.presences.length, 0);
});
