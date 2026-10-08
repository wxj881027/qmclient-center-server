"use strict";

const CAPABILITY = "decorative_throw_v1";
const TYPES = new Set(["grass", "tomato", "egg"]);
const ValidPoint = (Point) => Point && Number.isFinite(Point.x) && Number.isFinite(Point.y) && Math.abs(Point.x) <= 1048576 && Math.abs(Point.y) <= 1048576;

// 玩家身份取自当前连接的 presence，事件不能指定其他玩家或跨服转发。
function PrepareDecorativeThrow(Session, Body, Now)
{
	const Presence = Session.Presence;
	const Player = Presence.players.find((Entry) => Entry.player_id === Body.player_id);
	if(!Session.DecorativeThrows || !Player || !Presence.server_address || Body.server_address !== Presence.server_address ||
		Body.session_id !== Presence.session_id || !TYPES.has(Body.projectile) || !ValidPoint(Body.origin) || !ValidPoint(Body.direction)) return { Error: "invalid_throw" };
	const Magnitude = Math.hypot(Body.direction.x, Body.direction.y);
	if(Magnitude < 0.5 || Magnitude > 2) return { Error: "invalid_throw" };
	if(Session.LastThrowAt !== undefined && Now - Session.LastThrowAt < 1000) return { Error: "rate_limited" };
	Session.LastThrowAt = Now;
	Session.ThrowSequence = (Session.ThrowSequence || 0) + 1;
	return { Data: { client_id: Session.ClientId, player_name: Player.player_name, player_id: Player.player_id,
		server_address: Presence.server_address, session_id: Presence.session_id, sequence: Session.ThrowSequence,
		projectile: Body.projectile, origin: { x: Body.origin.x, y: Body.origin.y },
		direction: { x: Body.direction.x / Magnitude, y: Body.direction.y / Magnitude } } };
}

module.exports = { CAPABILITY, PrepareDecorativeThrow };
