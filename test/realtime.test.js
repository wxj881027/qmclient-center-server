"use strict";

const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { WebSocket } = require("ws");
const { CreateRealtimeServer } = require("../realtime");

async function Fixture(T, { MockClock = false } = {})
{
	let Now = 100000;
	if(MockClock)
	{
		T.mock.method(Date, "now", () => Now);
		T.mock.timers.enable({ apis: ["setInterval"] });
	}
	const Recognition = new EventEmitter();
	Recognition.Current = () => ({ users: [] });
	Recognition.Reports = [];
	Recognition.Report = (Body, Ip) => Recognition.Reports.push({ Body, Ip });
	Recognition.Leave = () => {};
	const Reports = [];
	let Sponsors = { version: 3, markdown: "- 赞助者" };
	const Server = http.createServer((_Req, Res) => Res.writeHead(404).end());
	const Hub = CreateRealtimeServer(Server, {
		Recognition,
		DeveloperService: { ReportPresence: () => ({ statusCode: 401 }), GetPresences: (Address) => ({ response: { server_time: 100, server_address: Address, presences: [] } }) },
		TitleService: { Profile: () => ({ statusCode: 401 }), Report: () => ({ statusCode: 401 }), List: (Address) => ({ response: { server_time: 100, server_address: Address, presences: [] } }) },
		NewsService: { Current: () => ({ response: { version: 7, markdown: "内容" } }) },
		SponsorsService: { Current: () => ({ response: Sponsors }) },
		Playtime: (Action, Body) => { Reports.push({ Action, Body }); return { statusCode: 200, response: { action: Action, total_seconds: 10, running: Action !== "stop", last_start_at: 90 } }; },
		NowSec: () => Math.floor(Now / 1000)
	});
	await new Promise((Resolve) => Server.listen(0, "127.0.0.1", Resolve));
	const Sockets = [];
	T.after(async () => {
		for(const Socket of Sockets) Socket.terminate();
		Hub.Close();
		await new Promise((Resolve) => Server.close(Resolve));
	});
	async function Connect()
	{
		const Socket = new WebSocket(`ws://127.0.0.1:${Server.address().port}/ws`, "qmclient-json");
		Sockets.push(Socket);
		const Messages = [];
		Socket.on("message", (Data) => Messages.push(JSON.parse(Data)));
		await once(Socket, "open");
		return { Socket, Messages };
	}
	return { Connect, Hub, Recognition, Reports, SetSponsors: (Value) => { Sponsors = Value; },
		Advance: (Milliseconds) => { Now += Milliseconds; T.mock.timers.tick(Milliseconds); } };
}

const Hello = (Address = "one:8303") => ({ type: "hello", v: 2, machine_hash: "a".repeat(64), client_id: "qm1234567890", player_name: "玩家", server_address: Address, session_id: "session-1", players: [{ player_id: 1, player_name: "玩家", dummy: false, voice_supported: true }] });

async function WaitFor(Messages, Type)
{
	for(let Attempt = 0; Attempt < 100; ++Attempt)
	{
		const Message = Messages.find((Entry) => Entry.type === Type);
		if(Message) return Message;
		await new Promise((Resolve) => setTimeout(Resolve, 5));
	}
	assert.fail(`没有收到 ${Type}`);
}

test("换服后的头衔快照携带新服务器地址", async (T) => {
	const F = await Fixture(T);
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "titles");
	C.Messages.length = 0;
	C.Socket.send(JSON.stringify({ ...Hello("two:8303"), type: "presence" }));
	assert.equal((await WaitFor(C.Messages, "titles")).data.server_address, "two:8303");
});

test("服务端数据变动主动推送且不泄露识别记录的 IP", async (T) => {
	const F = await Fixture(T, { MockClock: true });
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "users");
	C.Messages.length = 0;
	F.Recognition.emit("users", { users: [{ server_address: "one:8303", player_name: "另一个玩家", last_ip: "192.0.2.1", qid: "qid" }] });
	F.Advance(5000);
	const Message = await WaitFor(C.Messages, "users");
	assert.equal(Message.data.users[0].player_name, "另一个玩家");
	assert.equal(Message.data.users[0].last_ip, undefined);
});

test("外服名单保留完整分布，同服识别字段保持原值且不修改共享快照", async (T) => {
	const F = await Fixture(T);
	const Local = { server_address: "one:8303", player_name: "同服玩家", dummy: false, client_type: "arg",
		qid: "local-qid", foot_particles_enabled: true, remote_particles_enabled: false, voice_supported: false, last_ip: "192.0.2.1" };
	const Remote = { server_address: "two:8303", player_name: "外服分身", dummy: true, client_type: "qm",
		qid: "remote-qid", foot_particles_enabled: false, remote_particles_enabled: true, voice_supported: true, last_ip: "192.0.2.2" };
	const Snapshot = { users: [Local, Remote] };
	const Before = JSON.stringify(Snapshot);
	F.Recognition.Current = () => Snapshot;
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	const First = (await WaitFor(C.Messages, "users")).data;
	assert.equal(First.server_address, "one:8303");
	assert.equal(First.lease_seconds, 20);
	const { last_ip: LocalIp, ...LocalPublic } = Local;
	const { last_ip: RemoteIp, ...RemotePublic } = Remote;
	assert.deepEqual(First.users, [LocalPublic, { server_address: Remote.server_address, player_name: Remote.player_name, dummy: true }]);
	await WaitFor(C.Messages, "time");
	C.Messages.length = 0;
	C.Socket.send(JSON.stringify({ ...Hello("two:8303"), type: "presence" }));
	const Switched = (await WaitFor(C.Messages, "users")).data;
	assert.equal(Switched.server_address, "two:8303");
	assert.deepEqual(Switched.users, [{ server_address: Local.server_address, player_name: Local.player_name, dummy: false }, RemotePublic]);
	assert.equal(JSON.stringify(Snapshot), Before);
});

test("浏览器会话仍收到全部服务器的玩家与分身记录", async (T) => {
	const F = await Fixture(T);
	const Users = [
		{ server_address: "one:8303", player_name: "玩家", dummy: false, qid: "one" },
		{ server_address: "one:8303", player_name: "分身", dummy: true, qid: "dummy" },
		{ server_address: "two:8303", player_name: "另一服玩家", dummy: false, qid: "two" }
	];
	F.Recognition.Current = () => ({ users: Users });
	const C = await F.Connect();
	C.Socket.send(JSON.stringify({ ...Hello(""), players: [] }));
	const Message = await WaitFor(C.Messages, "users");
	assert.equal(Message.data.server_address, "");
	assert.deepEqual(Message.data.users, Users.map(({ server_address, player_name, dummy }) => ({ server_address, player_name, dummy })));
});

test("在线名单五秒内合并为最新快照，没有新快照时不续租", async (T) => {
	const F = await Fixture(T, { MockClock: true });
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "time");
	C.Messages.length = 0;
	for(const Name of ["旧名单", "最新名单"])
		F.Recognition.emit("users", { users: [{ player_name: Name }] });
	F.Advance(4999);
	C.Socket.send(JSON.stringify({ type: "ping" }));
	await WaitFor(C.Messages, "pong");
	assert.equal(C.Messages.some((Message) => Message.type === "users"), false);
	C.Messages.length = 0;
	F.Advance(1);
	assert.equal((await WaitFor(C.Messages, "users")).data.users[0].player_name, "最新名单");
	assert.equal(C.Messages.filter((Message) => Message.type === "users").length, 1);
	C.Messages.length = 0;
	F.Advance(15000);
	C.Socket.send(JSON.stringify({ type: "ping" }));
	await WaitFor(C.Messages, "pong");
	assert.equal(C.Messages.some((Message) => Message.type === "users"), false);
});

test("换服立即推送当前地址的最新名单并替换旧待发快照", async (T) => {
	const F = await Fixture(T, { MockClock: true });
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "time");
	C.Messages.length = 0;
	F.Recognition.emit("users", { users: [{ player_name: "待发旧名单" }] });
	F.Recognition.Current = () => ({ users: [{ player_name: "换服最新名单" }] });
	C.Socket.send(JSON.stringify({ ...Hello("two:8303"), type: "presence" }));
	const Message = await WaitFor(C.Messages, "users");
	assert.equal(Message.data.server_address, "two:8303");
	assert.equal(Message.data.users[0].player_name, "换服最新名单");
	C.Messages.length = 0;
	F.Advance(5000);
	C.Socket.send(JSON.stringify({ type: "ping" }));
	await WaitFor(C.Messages, "pong");
	assert.equal(C.Messages.some((Entry) => Entry.type === "users"), false);
});

test("慢连接不会在二十秒后给过期的待发在线名单续租", async (T) => {
	const F = await Fixture(T, { MockClock: true });
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "time");
	C.Messages.length = 0;
	let Blocked = true;
	T.mock.getter(WebSocket.prototype, "bufferedAmount", () => Blocked ? 1 : 0);
	F.Recognition.emit("users", { users: [{ player_name: "过期名单" }] });
	F.Advance(20000);
	Blocked = false;
	F.Advance(5000);
	C.Socket.send(JSON.stringify({ type: "ping" }));
	await WaitFor(C.Messages, "pong");
	assert.equal(C.Messages.some((Message) => Message.type === "users"), false);
	F.Recognition.emit("users", { users: [{ player_name: "恢复更新" }] });
	assert.equal((await WaitFor(C.Messages, "users")).data.users[0].player_name, "恢复更新");
});

test("识别链断开后不下发待发旧名单，恢复时发送新快照", async (T) => {
	const F = await Fixture(T, { MockClock: true });
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "time");
	C.Messages.length = 0;
	F.Recognition.emit("users", { users: [{ player_name: "断线前名单" }] });
	F.Recognition.emit("disconnected");
	F.Advance(5000);
	C.Socket.send(JSON.stringify({ type: "ping" }));
	await WaitFor(C.Messages, "pong");
	assert.equal(C.Messages.some((Message) => Message.type === "users"), false);
	F.Recognition.emit("users", { users: [{ player_name: "恢复后名单" }] });
	assert.equal((await WaitFor(C.Messages, "users")).data.users[0].player_name, "恢复后名单");
});

test("未握手的连接不能发布 presence", async (T) => {
	const F = await Fixture(T);
	const C = await F.Connect();
	C.Socket.send(JSON.stringify({ ...Hello(), type: "presence" }));
	await WaitFor(C.Messages, "error");
	assert.equal(F.Recognition.Reports.length, 0);
	assert.equal(F.Reports.length, 0);
});

test("重连重新下发快照，已连连接不能替换游玩时长身份", async (T) => {
	const F = await Fixture(T);
	const C = await F.Connect();
	C.Socket.send(JSON.stringify(Hello()));
	await WaitFor(C.Messages, "playtime");
	C.Messages.length = 0;
	C.Socket.send(JSON.stringify({ ...Hello(), type: "presence", client_id: "qmSomeoneElse" }));
	C.Socket.send(JSON.stringify({ type: "stop", stop_at: 100 }));
	await WaitFor(C.Messages, "playtime");
	assert.equal(F.Reports.at(-1).Action, "stop");
	assert.equal(F.Reports.at(-1).Body.client_id, Hello().client_id);
	const Other = await F.Connect();
	Other.Socket.send(JSON.stringify(Hello()));
	await WaitFor(Other.Messages, "broadcast");
	await WaitFor(Other.Messages, "users");
});

