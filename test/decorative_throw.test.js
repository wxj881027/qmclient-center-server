"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PrepareDecorativeThrow } = require("../decorative_throw");
const Session = () => ({ ClientId: "fixture-client", DecorativeThrows: true, Presence: { server_address: "one:8303", session_id: "session", players: [{ player_id: 1, player_name: "玩家" }] } });
const Body = () => ({ player_id: 1, server_address: "one:8303", session_id: "session", projectile: "tomato", origin: { x: 100, y: 100 }, direction: { x: 1, y: 0 } });

test("三种装饰物使用 presence 身份并规范化方向", () => {
	for(const Type of ["grass", "tomato", "egg"])
	{
		const Result = PrepareDecorativeThrow(Session(), { ...Body(), projectile: Type, player_name: "伪造名字", direction: { x: 1, y: 1 } }, 1000);
		assert.equal(Result.Data.player_name, "玩家");
		assert.equal(Result.Data.projectile, Type);
		assert.ok(Math.abs(Math.hypot(Result.Data.direction.x, Result.Data.direction.y) - 1) < 1e-6);
	}
});

test("非法类型、坐标、方向、身份和过期会话不转发", () => {
	for(const Patch of [{ projectile: "hammer" }, { player_id: 2 }, { server_address: "other:8303" }, { session_id: "old" },
		{ origin: { x: NaN, y: 1 } }, { origin: { x: Infinity, y: 0 } }, { origin: { x: 2000000, y: 0 } }, { direction: { x: 0, y: 0 } }])
		assert.equal(PrepareDecorativeThrow(Session(), { ...Body(), ...Patch }, 1000).Error, "invalid_throw");
	const Legacy = Session();
	Legacy.DecorativeThrows = false;
	assert.equal(PrepareDecorativeThrow(Legacy, Body(), 1000).Error, "invalid_throw");
});

test("发送限制跨主号和分身共享，冷却结束可重发", () => {
	const Current = Session();
	Current.Presence.players.push({ player_id: 2, player_name: "分身" });
	assert.equal(PrepareDecorativeThrow(Current, Body(), 1000).Data.sequence, 1);
	assert.equal(PrepareDecorativeThrow(Current, { ...Body(), player_id: 2 }, 1500).Error, "rate_limited");
	assert.equal(PrepareDecorativeThrow(Current, { ...Body(), player_id: 2 }, 2000).Data.sequence, 2);
});
