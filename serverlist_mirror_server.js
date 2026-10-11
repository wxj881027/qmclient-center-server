"use strict";

const express = require("express");
const { CreateServerListMirror, RegisterServerListMirrorRoutes } = require("./serverlist_mirror");

// 独立监听回环地址，让镜像部署无需重启中心服务的实时连接。
const Port = Number(process.env.SERVERLIST_PORT || 8081);
if(!Number.isInteger(Port) || Port < 1 || Port > 65535)
	throw new Error("invalid_serverlist_port");

const App = express();
App.disable("x-powered-by");
const Mirror = CreateServerListMirror();
RegisterServerListMirrorRoutes(App, Mirror);
Mirror.Start();

const Server = App.listen(Port, "127.0.0.1", () => {
	console.log(`serverlist mirror listening on 127.0.0.1:${Port}`);
});
Server.on("error", (Error) => {
	Mirror.Close();
	console.error(`serverlist mirror listener failed: ${Error.code || "unknown"}`);
	process.exitCode = 1;
});

function Stop()
{
	Mirror.Close();
	Server.close();
}

process.once("SIGTERM", Stop);
process.once("SIGINT", Stop);
