"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { CreateEditorRealtimeServer } = require("../editor_realtime");

test("协作变更主动推送，保留 revision，并固定连接的客户端身份", async () => {
    const Server = http.createServer();
    let Revision = 7;
    let Pulls = 0;
    const Hub = CreateEditorRealtimeServer(Server, {
        Handle(Action, Body) {
            if(Action === "pull") ++Pulls;
            return { status: 200, body: { ok: true, room_code: "ABCDEF", revision: Revision, map_base64: Action === "pull" && Body.since < Revision ? "bWFw" : "", member_count: 1, max_members: 4 } };
        },
        Renew() { return true; }
    });
    Server.listen(0, "127.0.0.1");
    await once(Server, "listening");
    const Socket = new WebSocket(`ws://127.0.0.1:${Server.address().port}/ws/editor`, "qmclient-json");
    const Receive = () => once(Socket, "message").then(([Raw]) => JSON.parse(Raw));
    try {
        await once(Socket, "open");
        let Reply = Receive();
        Socket.send(JSON.stringify({ type: "collab", request_id: 1, action: "join", data: { client_id: "client123", room_code: "ABCDEF" } }));
        assert.equal((await Reply).revision, 7);
        assert.equal(Pulls, 0);
        ++Revision;
        Reply = Receive();
        Hub.Notify("ABCDEF");
        const Snapshot = await Reply;
        assert.equal(Snapshot.request_id, 0);
        assert.equal(Snapshot.revision, 8);
        assert.equal(Snapshot.map_base64, "bWFw");
        Reply = Receive();
        Socket.send(JSON.stringify({ type: "collab", request_id: 2, action: "push", data: { client_id: "other123", room_code: "ABCDEF" } }));
        assert.equal((await Reply).status, 403);
    } finally {
        Socket.terminate();
        Hub.Close();
        await new Promise(Resolve => Server.close(Resolve));
    }
});
