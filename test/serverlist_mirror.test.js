"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CreateServerListMirror, RegisterServerListMirrorRoutes } = require("../serverlist_mirror");
const List = { servers: [{ addresses: ["tw-0.6+udp://127.0.0.1:8303"], info: { name: "fixture" } }] };
const Success = () => ({ Status: 200, Headers: { get: () => "0" }, Body: List });

test("同步失败保留成功缓存，五分钟后接口拒绝提供新鲜列表", async () => {
	let Time = 1000;
	let Result = Success();
	const Mirror = CreateServerListMirror({ Sources: ["https://fixture.test"], Now: () => Time, Request: async () => Result });
	assert.equal(await Mirror.Refresh(), true);
	const Original = Mirror.Current().Json;
	Result = { Status: 200, Body: { servers: [] } };
	Time += 60000;
	assert.equal(await Mirror.Refresh(), false);
	assert.equal(Mirror.Current().Json, Original);
	assert.equal(Mirror.Current().LastSuccess, 1);
	assert.equal(Mirror.Current().Stale, false);
	Time += 241000;
	let Handler;
	RegisterServerListMirrorRoutes({ get: (_Path, Callback) => { Handler = Callback; } }, Mirror);
	const Response = { set() {}, status(Code) { this.Code = Code; return this; }, json(Body) { this.Body = Body; } };
	Handler({}, Response);
	assert.equal(Response.Code, 503);
	assert.equal(Response.Body.error, "serverlist_stale");
	Mirror.Close();
});

test("空响应和过期源不会替换缓存，下一官方源可恢复", async () => {
	const Calls = [];
	const Mirror = CreateServerListMirror({ Sources: ["a", "b"], Request: async (Url) => {
		Calls.push(Url);
		return Url === "a" ? { ...Success(), Headers: { get: () => "301" } } : Success();
	} });
	assert.equal(await Mirror.Refresh(), true);
	assert.deepEqual(Calls, ["a", "b"]);
	assert.equal(Mirror.Current().Stale, false);
	Mirror.Close();
});

test("重复刷新共享正在执行的请求，关闭后结果不发布", async () => {
	let Resolve;
	let Calls = 0;
	const Mirror = CreateServerListMirror({ Sources: ["a"], Request: () => { ++Calls; return new Promise((Done) => { Resolve = Done; }); } });
	const First = Mirror.Refresh();
	assert.equal(Mirror.Refresh(), First);
	assert.equal(Calls, 1);
	Mirror.Close();
	Resolve(Success());
	assert.equal(await First, false);
	assert.equal(Mirror.Current().LastSuccess, null);
});
