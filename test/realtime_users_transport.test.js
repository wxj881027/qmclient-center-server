"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter, once } = require("node:events");
const http = require("node:http");
const { inflateSync } = require("node:zlib");
const { WebSocket } = require("ws");
const { CreateRealtimeServer } = require("../realtime");
const { USERS_SYNC_CAPABILITY } = require("../realtime_users");

const Rows = (Count = 2) => ({ users: Array.from({ length: Count }, (_, Index) => ({ client_id: "identity-" + Index,
	player_id: Index, server_address: "one:8303", player_name: "在线玩家" + Index, dummy: false,
	client_type: "qm", qid: "qid-" + Index, voice_supported: true, last_seen: 100 })) });

function Read(Raw, Binary)
{
	if(!Binary) return JSON.parse(Raw);
	assert.equal(Raw.subarray(0, 4).toString(), "QMU1");
	const Json = inflateSync(Raw.subarray(8));
	assert.equal(Json.length, Raw.readUInt32BE(4));
	return JSON.parse(Json);
}

function Wait(Socket, Predicate)
{
	return new Promise((Resolve, Reject) => {
		const Signal = AbortSignal.timeout(2000);
		const Finish = (Error, Value) => {
			Socket.off("message", OnMessage); Socket.off("close", OnClose); Socket.off("error", OnError);
			Signal.removeEventListener("abort", OnTimeout);
			if(Error) Reject(Error); else Resolve(Value);
		};
		const OnMessage = (Raw, Binary) => {
			try { const Message = Read(Raw, Binary); if(Predicate(Message)) Finish(null, Message); }
			catch(Error) { Finish(Error); }
		};
		const OnClose = () => Finish(new Error("连接提前关闭"));
		const OnError = Error => Finish(Error);
		const OnTimeout = () => Finish(new Error("等待消息超时"));
		Socket.on("message", OnMessage); Socket.once("close", OnClose); Socket.once("error", OnError);
		Signal.addEventListener("abort", OnTimeout, { once: true });
	});
}

async function Barrier(Client)
{
	const Pong = Wait(Client.Socket, Message => Message.type === "pong");
	Client.Socket.send(JSON.stringify({ type: "ping" }));
	await Pong;
}

const Messages = (Client, Type = "users_sync") => Client.Messages.filter(Message => Message.type === Type);

async function Fixture(T, { Initial = Rows(), Rate = 384 * 1024 } = {})
{
	let Now = 100000;
	let Current = Initial;
	T.mock.method(Date, "now", () => Now);
	T.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const Recognition = new EventEmitter();
	Recognition.Current = () => Current;
	Recognition.Report = () => {};
	const Server = http.createServer();
	const Connections = new Set();
	Server.on("connection", Socket => { Connections.add(Socket); Socket.once("close", () => Connections.delete(Socket)); });
	const TitleData = { presences: [] };
	const Hub = CreateRealtimeServer(Server, {
		Recognition, UsersBytesPerSecond: Rate, NowSec: () => Math.floor(Now / 1000),
		DeveloperService: { ReportPresence: () => ({ statusCode: 200 }), GetPresences: () => ({ response: { server_time: Math.floor(Now / 1000), presences: [] } }) },
		TitleService: { Report: () => ({ statusCode: 200 }), Profile: () => ({ statusCode: 200 }), List: () => ({ response: { ...TitleData, server_time: Math.floor(Now / 1000) } }) },
		NewsService: { Current: () => ({ response: {} }) }, SponsorsService: { Current: () => ({ response: {} }) },
		Playtime: Action => ({ statusCode: 200, response: { action: Action } })
	});
	const Clients = [];
	T.after(async () => {
		const Closing = [...Connections, ...Clients.map(Client => Client.Socket).filter(Socket => Socket.readyState !== WebSocket.CLOSED)]
			.map(Socket => once(Socket, "close", { signal: AbortSignal.timeout(2000) }));
		for(const Client of Clients) Client.Socket.terminate();
		Hub.Close();
		const Closed = once(Server, "close", { signal: AbortSignal.timeout(2000) });
		Server.close();
		await Promise.all([...Closing, Closed]);
	});
	const Listening = once(Server, "listening", { signal: AbortSignal.timeout(2000) });
	Server.listen(0, "127.0.0.1");
	await Listening;
	async function Connect({ Compact = true, Address = "one:8303" } = {})
	{
		const Socket = new WebSocket(`ws://127.0.0.1:${Server.address().port}/ws`, "qmclient-json");
		const Client = { Socket, Messages: [], Binary: [], Hello: { type: "hello", v: 2,
			machine_hash: "a".repeat(64), client_id: "observer-" + Clients.length, player_name: "观察者",
			server_address: Address, session_id: "session", players: [],
			capabilities: Compact ? [USERS_SYNC_CAPABILITY] : [] } };
		Clients.push(Client);
		Socket.on("message", (Raw, Binary) => { Client.Messages.push(Read(Raw, Binary)); Client.Binary.push(Binary); });
		await once(Socket, "open", { signal: AbortSignal.timeout(2000) });
		const Ready = Wait(Socket, Message => Message.type === "time");
		Socket.send(JSON.stringify(Client.Hello));
		await Ready;
		return Client;
	}
	return { Connect, Clients, Hub, TitleData, Recognition,
		Publish(Data) { Current = Data; Recognition.emit("users", Data); },
		DisconnectSource() { Current = null; Recognition.emit("disconnected"); },
		async Tick(Milliseconds) { Now += Milliseconds; T.mock.timers.tick(Milliseconds); for(const Client of Clients) if(Client.Socket.readyState === WebSocket.OPEN) await Barrier(Client); },
		async Send(Client, Body) { Client.Socket.send(JSON.stringify(Body)); await Barrier(Client); }
	};
}

test("同一个服务根据声明同时兼容旧文本和新压缩连接", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const Old = await F.Connect({ Compact: false });
	const New = await F.Connect();
	assert.equal(Messages(Old, "users").length, 1);
	assert.ok(Old.Binary.every(Value => !Value));
	assert.equal(Messages(New).length, 1);
	assert.equal(Messages(New)[0].data.full, true);
	assert.ok(New.Binary.some(Boolean));
	assert.equal(Messages(New, "users").length, 0);
});

test("新连接通过压缩增量更新并在无变化时仅续租", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	Client.Messages.length = 0;
	F.Publish(Rows(3));
	await F.Tick(5000);
	let Body = Messages(Client).at(-1).data;
	assert.equal(Body.full, false);
	assert.equal(Body.base_revision, 1);
	assert.equal(Body.revision, 2);
	assert.equal(Body.players.length, 1);
	Client.Messages.length = 0;
	F.Publish(Rows(3));
	await F.Tick(5000);
	Body = Messages(Client).at(-1).data;
	assert.equal(Body.revision, 2);
	assert.equal(Body.base_revision, 2);
	assert.deepEqual(Body.players, []);
	assert.deepEqual(Body.servers, []);
});

test("订阅恢复请求发送完整快照而不依赖客户端旧基线", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	Client.Messages.length = 0;
	await F.Send(Client, { type: "subscribe_users" });
	const Body = Messages(Client).at(-1).data;
	assert.equal(Body.full, true);
	assert.equal(Body.base_revision, 0);
	assert.equal(Body.revision, 2);
	assert.equal(Body.players.length, 2);
});

test("快速换服再回原服的完整快照版本仍然前进", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Send(Client, { ...Client.Hello, type: "presence", server_address: "two:8303" });
	await F.Send(Client, { ...Client.Hello, type: "presence" });
	const Bodies = Messages(Client).map(Message => Message.data);
	assert.deepEqual(Bodies.map(Body => Body.revision), [1, 2, 3]);
	assert.ok(Bodies.every(Body => Body.full));
	assert.equal(Bodies[1].players.length, 0);
	assert.equal(Bodies[2].players.length, 2);
});

test("重连重新获取完整名单且版本从新连接开始", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const First = await F.Connect();
	await F.Send(First, { type: "subscribe_users" });
	const Closed = once(First.Socket, "close", { signal: AbortSignal.timeout(2000) });
	First.Socket.terminate();
	await Closed;
	const Next = await F.Connect();
	assert.equal(Messages(Next)[0].data.revision, 1);
	assert.equal(Messages(Next)[0].data.full, true);
});

test("发送预算把多个大名单分开发送并保持排队顺序", { timeout: 10000 }, async T => {
	const F = await Fixture(T, { Initial: Rows(20), Rate: 4096 });
	const Clients = [await F.Connect({ Compact: false }), await F.Connect({ Compact: false }), await F.Connect({ Compact: false })];
	assert.deepEqual(Clients.map(Client => Messages(Client, "users").length), [1, 0, 0]);
	await F.Tick(1500);
	assert.deepEqual(Clients.map(Client => Messages(Client, "users").length), [1, 1, 0]);
	await F.Tick(1500);
	assert.deepEqual(Clients.map(Client => Messages(Client, "users").length), [1, 1, 1]);
});

test("预算不足时仍及时发送头衔变化", { timeout: 10000 }, async T => {
	const F = await Fixture(T, { Initial: Rows(20), Rate: 4096 });
	await F.Connect({ Compact: false });
	const Client = await F.Connect({ Compact: false });
	Client.Messages.length = 0;
	F.TitleData.presences = [{ player_id: 1, player_name: "玩家", title: "新头衔", issued_at: 100, expires_at: 115 }];
	F.Hub.NotifyTitles();
	await F.Tick(50);
	assert.equal(Messages(Client, "users").length, 0);
	assert.equal(Messages(Client, "titles").at(-1).data.presences[0].title, "新头衔");
});

test("排队期间到达的新名单替换旧名单", { timeout: 10000 }, async T => {
	const F = await Fixture(T, { Initial: Rows(20), Rate: 4096 });
	await F.Connect({ Compact: false });
	const Client = await F.Connect({ Compact: false });
	const Latest = Rows(20); Latest.users[0].player_name = "最新名字";
	F.Publish(Latest);
	await F.Tick(1500);
	const Received = Messages(Client, "users");
	assert.equal(Received.length, 1);
	assert.equal(Received[0].data.users[0].player_name, "最新名字");
});

test("源数据过期后恢复请求不会给旧名单续租", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	await F.Tick(20001);
	Client.Messages.length = 0;
	await F.Send(Client, { type: "subscribe_users" });
	assert.equal(Messages(Client).length, 0);
	F.Publish(Rows(3));
	await Barrier(Client);
	assert.equal(Messages(Client).at(-1).data.full, true);
});

test("识别链断开后不发送待发增量，恢复后只发送最新变化", { timeout: 10000 }, async T => {
	const F = await Fixture(T);
	const Client = await F.Connect();
	Client.Messages.length = 0;
	F.Publish(Rows(3));
	F.DisconnectSource();
	await F.Tick(5000);
	assert.equal(Messages(Client).length, 0);
	F.Publish(Rows(4));
	await Barrier(Client);
	const Body = Messages(Client).at(-1).data;
	assert.equal(Body.base_revision, 1);
	assert.equal(Body.players.length, 2);
});
