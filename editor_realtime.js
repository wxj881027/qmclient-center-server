"use strict";

const { WebSocket, WebSocketServer } = require("ws");

function CreateEditorRealtimeServer(Server, { Handle, Renew })
{
    const Wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false,
        handleProtocols: Protocols => Protocols.has("qmclient-json") ? "qmclient-json" : false });
    const Sessions = new Map();
    const Dirty = new Set();
    let FlushTimer = null;
    function Send(Socket, Id, Result)
    {
        if(Socket.readyState !== WebSocket.OPEN) return;
        if(Socket.bufferedAmount > 32 * 1024 * 1024) { Socket.terminate(); return; }
        Socket.send(JSON.stringify({ ...Result.body, type: "collab", request_id: Id, status: Result.status }));
    }
    function Upgrade(Req, Socket, Head)
    {
        if(Req.url !== "/ws/editor") return;
        if(!(Req.headers["sec-websocket-protocol"] || "").split(/,\s*/).includes("qmclient-json")) { Socket.destroy(); return; }
        Wss.handleUpgrade(Req, Socket, Head, Ws => Wss.emit("connection", Ws));
    }
    Server.on("upgrade", Upgrade);
    Wss.on("connection", Socket => {
        let LastSeen = Date.now();
        const OpenedAt = LastSeen;
        let WindowStart = LastSeen, Count = 0;
        Socket.on("error", () => {});
        Socket.on("pong", () => {
            LastSeen = Date.now();
            const Session = Sessions.get(Socket);
            if(Session && !Renew(Session.Room, Session.ClientId, Session.PlayerName))
            {
                Sessions.delete(Socket);
                Send(Socket, 0, { status: 403, body: { ok: false, error: "not_in_room" } });
            }
        });
        Socket.on("message", (Raw, Binary) => {
            LastSeen = Date.now();
            if(LastSeen - WindowStart > 60000) { WindowStart = LastSeen; Count = 0; }
            if(++Count > 120) { Socket.close(1008, "rate_limited"); return; }
            let Body;
            try { Body = !Binary && JSON.parse(Raw); } catch { Socket.close(1008, "invalid_json"); return; }
            if(!Body || Body.type !== "collab" || !Number.isSafeInteger(Body.request_id) || Body.request_id <= 0 || !["create", "join", "leave", "push"].includes(Body.action) || !Body.data || typeof Body.data !== "object")
            { Socket.close(1008, "invalid_request"); return; }
            const Data = Body.data;
            const Session = Sessions.get(Socket);
            if(!/^[A-Za-z0-9_-]{8,64}$/.test(Data.client_id || "") || (Session && (Data.client_id !== Session.ClientId || Body.action === "create" || (Data.room_code || "").trim().toUpperCase() !== Session.Room)) || (!Session && !["create", "join"].includes(Body.action)))
            { Send(Socket, Body.request_id, { status: 403, body: { ok: false, error: "invalid_session" } }); return; }
            const Result = Handle(Body.action, Data);
            if(Result.status === 200)
            {
                if(Body.action === "create" || Body.action === "join")
                    Sessions.set(Socket, { Room: Result.body.room_code, ClientId: Data.client_id, PlayerName: Data.player_name || "", Revision: Result.body.revision });
                else if(Body.action === "leave") Sessions.delete(Socket);
                else if(Session) Session.Revision = Result.body.revision;
            }
            Send(Socket, Body.request_id, Result);
        });
        const Timer = setInterval(() => {
            if(Date.now() - LastSeen > 45000 || (!Sessions.has(Socket) && Date.now() - OpenedAt > 15000)) { Socket.terminate(); return; }
            Socket.ping();
        }, 10000);
        Timer.unref();
        Socket.on("close", () => { clearInterval(Timer); Sessions.delete(Socket); });
    });
    return {
        Notify(Room)
        {
            Dirty.add(Room);
            if(FlushTimer) return;
            FlushTimer = setTimeout(() => {
                FlushTimer = null;
                for(const [Socket, Session] of Sessions)
                {
                    if(!Dirty.has(Session.Room)) continue;
                    // 直接复用房间读取逻辑；仅在变更事件发生时生成快照，不发 HTTP 请求。
                    const Result = Handle("pull", { room_code: Session.Room, client_id: Session.ClientId, player_name: Session.PlayerName, since: Session.Revision });
                    Send(Socket, 0, Result);
                    if(Result.status === 200) Session.Revision = Result.body.revision;
                }
                Dirty.clear();
            }, 50);
        },
        Close()
        {
            clearTimeout(FlushTimer);
            Server.off("upgrade", Upgrade);
            for(const Socket of Wss.clients) Socket.terminate();
            Wss.close();
        }
    };
}

module.exports = { CreateEditorRealtimeServer };
