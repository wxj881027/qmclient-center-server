"use strict";

const { EventEmitter } = require("node:events");
const { WebSocket } = require("ws");

// 只连接本机语音进程；断线时等待 WS 重连，不使用 HTTP 兜底。
function CreateVoiceRealtime(Url = "ws://127.0.0.1:9987/qm/realtime")
{
	const Events = new EventEmitter();
	let Socket = null;
	let Snapshot = null;
	let Retry = null;
	let Closed = false;
	let LastMessage = 0;
	function Connect()
	{
		if(Closed) return;
		Socket = new WebSocket(Url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 5000 });
		Socket.on("open", () => { LastMessage = Date.now(); Events.emit("connected"); });
		Socket.on("message", (Data) => {
			LastMessage = Date.now();
			try
			{
				const Message = JSON.parse(Data);
				if(Message.type === "users" && Array.isArray(Message.data?.users))
				{
					Snapshot = Message.data;
					Events.emit("users", Snapshot);
				}
			}
			catch { Socket.terminate(); }
		});
		Socket.on("error", () => {});
		Socket.on("close", () => {
			Snapshot = null;
			Events.emit("disconnected");
			if(!Closed) Retry = setTimeout(Connect, 2000);
		});
	}
	const Watchdog = setInterval(() => {
		if(Socket?.readyState === WebSocket.OPEN && Date.now() - LastMessage > 30000) Socket.terminate();
	}, 5000);
	Watchdog.unref();
	Events.Current = () => Snapshot;
	Events.Report = (Body, Ip) => {
		if(Socket?.readyState !== WebSocket.OPEN || Socket.bufferedAmount > 1024 * 1024) return false;
		Socket.send(JSON.stringify({ type: "recognition", data: Body, ip: Ip }));
		return true;
	};
	Events.Close = () => {
		Closed = true;
		clearTimeout(Retry);
		clearInterval(Watchdog);
		Socket?.terminate();
	};
	Connect();
	return Events;
}

module.exports = { CreateVoiceRealtime };
