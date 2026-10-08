"use strict";

const { FetchJson } = require("./outbound_json");
const DEFAULT_SOURCES = [1, 2, 3, 4].map((Index) => `https://master${Index}.ddnet.org/ddnet/15/servers.json`);

function ValidServerList(Body)
{
	return Body && Array.isArray(Body.servers) && Body.servers.length > 0 && Body.servers.every((Server) =>
		Server && Array.isArray(Server.addresses) && Server.addresses.length > 0 &&
		Server.addresses.every((Address) => typeof Address === "string" && /^tw-0\.[67]\+udp:\/\//.test(Address)) &&
		Server.info && typeof Server.info === "object" && !Array.isArray(Server.info));
}

function CreateServerListMirror({ Sources = DEFAULT_SOURCES, Request = FetchJson, Now = Date.now } = {})
{
	let Snapshot = null;
	let InFlight = null;
	let Controller = null;
	let Timer = null;
	let Closed = false;
	async function Sync()
	{
		for(const Source of Sources)
		{
			if(Closed) return false;
			Controller = new AbortController();
			const Timeout = setTimeout(() => Controller?.abort(), 5000);
			try
			{
				const Result = await Request(Source, { signal: Controller.signal }, 16 * 1024 * 1024);
				if(Closed) return false;
				const HeaderAge = Number(Result.Headers?.get("age"));
				if(Result.Status !== 200 || !ValidServerList(Result.Body) || !Number.isFinite(HeaderAge) || HeaderAge < 0 || HeaderAge > 300) continue;
				const SucceededAt = Now();
				Snapshot = { Json: JSON.stringify(Result.Body), SucceededAt, SourceAge: Math.floor(HeaderAge) };
				return true;
			}
			catch {}
			finally { clearTimeout(Timeout); Controller = null; }
		}
		// 失败保留上次成功结果与时间，不能把失败时间当成新的缓存时间。
		return false;
	}
	function Refresh()
	{
		if(Closed) return Promise.resolve(false);
		if(!InFlight) InFlight = Sync().finally(() => { InFlight = null; });
		return InFlight;
	}
	return {
		Refresh,
		Current()
		{
			const Age = Snapshot ? Snapshot.SourceAge + Math.max(0, Math.floor((Now() - Snapshot.SucceededAt) / 1000)) : null;
			return { Json: Snapshot?.Json, Age, Stale: Age === null || Age > 300, LastSuccess: Snapshot ? Math.floor(Snapshot.SucceededAt / 1000) : null };
		},
		Start()
		{
			if(Timer || Closed) return;
			void Refresh();
			Timer = setInterval(() => { void Refresh(); }, 60000);
			Timer.unref();
		},
		Close() { Closed = true; clearInterval(Timer); Timer = null; Controller?.abort(); }
	};
}

function RegisterServerListMirrorRoutes(App, Mirror)
{
	App.get("/ddnet/15/servers.json", (_Req, Res) => {
		const State = Mirror.Current();
		Res.set("Cache-Control", "no-store");
		if(State.Age !== null) Res.set("Age", String(State.Age));
		if(State.LastSuccess !== null) Res.set("X-Qm-Last-Success", String(State.LastSuccess));
		Res.set("X-Qm-Stale", State.Stale ? "1" : "0");
		// 过期镜像返回失败状态，让现有 master 选择器继续选其他有效源。
		if(State.Stale) return Res.status(503).json({ error: "serverlist_stale" });
		Res.type("application/json").send(State.Json);
	});
}

module.exports = { CreateServerListMirror, RegisterServerListMirrorRoutes, ValidServerList };
