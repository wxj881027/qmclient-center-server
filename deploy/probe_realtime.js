"use strict";

// 部署检查：临时身份和临时协作房间，不使用真实玩家凭据。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { WebSocket } = require("ws");

async function Connect(Url)
{
    const Socket = new WebSocket(Url, "qmclient-json", { handshakeTimeout: 10000 });
    const Messages = [];
    Socket.on("message", Raw => Messages.push(JSON.parse(Raw)));
    Socket.on("error", () => {});
    await once(Socket, "open");
    return {
        Socket,
        Send(Body) { Socket.send(JSON.stringify(Body)); },
        async Wait(Predicate)
        {
            const Until = Date.now() + 12000;
            while(Date.now() < Until)
            {
                const Index = Messages.findIndex(Predicate);
                if(Index >= 0) return Messages.splice(Index, 1)[0];
                if(Socket.readyState !== WebSocket.OPEN) throw new Error("WS closed before expected response");
                await new Promise(Resolve => setTimeout(Resolve, 20));
            }
            throw new Error("WS response timeout");
        }
    };
}

async function Main()
{
    const Url = process.argv[2] || "wss://qmclient.icu/ws";
    const Id = "wsprobe_" + crypto.randomBytes(8).toString("hex");
    const Clients = [];
    let Room = "";
    try
    {
        const Client = await Connect(Url); Clients.push(Client);
        Client.Send({ type: "hello", v: 2, machine_hash: crypto.randomBytes(32).toString("hex"), client_id: Id,
            player_name: "WS deployment probe", server_address: "127.0.0.1:18303", session_id: Id, players: [] });
        for(const Type of ["users", "developers", "titles", "broadcast", "playtime", "time"])
            await Client.Wait(Message => Message.type === Type);
        Client.Send({ type: "stop", stop_at: Math.floor(Date.now() / 1000) });
        await Client.Wait(Message => Message.type === "playtime" && Message.data.action === "stop");
        console.log("main WS: upgrade, six initial topics and stop acknowledgement OK");

        const First = await Connect(Url + "/editor"); Clients.push(First);
        const Second = await Connect(Url + "/editor"); Clients.push(Second);
        First.Send({ type: "collab", request_id: 1, action: "create", data: { client_id: Id + "a", player_name: "WS probe A" } });
        const Created = await First.Wait(Message => Message.request_id === 1);
        assert.equal(Created.status, 200);
        Room = Created.room_code;
        Second.Send({ type: "collab", request_id: 1, action: "join", data: { client_id: Id + "b", room_code: Room, player_name: "WS probe B" } });
        assert.equal((await Second.Wait(Message => Message.request_id === 1)).member_count, 2);
        const Map = Buffer.from("WS transport deployment probe").toString("base64");
        First.Send({ type: "collab", request_id: 2, action: "push", data: { client_id: Id + "a", room_code: Room, revision: 0, map_base64: Map } });
        assert.equal((await First.Wait(Message => Message.request_id === 2)).revision, 1);
        const Update = await Second.Wait(Message => Message.request_id === 0 && Message.revision === 1);
        assert.equal(Update.map_base64, Map);
        // 接收方没有发送 pull；更新必须来自房间变更推送。
        for(const [Index, Peer] of [First, Second].entries())
        {
            Peer.Send({ type: "collab", request_id: 3, action: "leave", data: { client_id: Id + (Index === 0 ? "a" : "b"), room_code: Room } });
            assert.equal((await Peer.Wait(Message => Message.request_id === 3)).status, 200);
        }
        console.log("editor WS: create/join, revision and snapshot push without pull, leave OK");
    }
    finally
    {
        for(const Client of Clients) Client.Socket.close();
        setTimeout(() => { for(const Client of Clients) Client.Socket.terminate(); }, 1000).unref();
    }
}

Main().catch(Error => { console.error(Error.message); process.exitCode = 1; });
