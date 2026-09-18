// 请抬头享受阳光｜日子很好 我很我---------致咩子
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const DEVELOPER_PRESENCE_TTL_SEC = 15;
const MAX_SERVER_ADDRESS_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_PLAYER_NAME_LENGTH = 64;
const MAX_PLAYERS_PER_PRESENCE = 8;

function IsPlainObject(Value)
{
	return Value !== null && typeof Value === "object" && !Array.isArray(Value);
}

function IsValidIdentityPart(Value)
{
	return typeof Value === "string" && Value.length > 0 && Value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(Value);
}

function NormalizeCredential(Credential)
{
	if(!IsPlainObject(Credential) ||
		!IsValidIdentityPart(Credential.developer_id) ||
		!IsValidIdentityPart(Credential.key_id) ||
		typeof Credential.token_sha256 !== "string" ||
		!/^[a-fA-F0-9]{64}$/.test(Credential.token_sha256))
	{
		throw new Error("invalid developer credential");
	}

	return {
		developer_id: Credential.developer_id,
		key_id: Credential.key_id,
		token_sha256: Credential.token_sha256.toLowerCase(),
		revoked: Credential.revoked === true
	};
}

function LoadDeveloperCredentials(CredentialsFilePath)
{
	if(typeof CredentialsFilePath !== "string" || CredentialsFilePath.length === 0)
		return [];

	const Root = JSON.parse(fs.readFileSync(CredentialsFilePath, "utf8"));
	const CredentialEntries = Array.isArray(Root) ? Root : Root && Array.isArray(Root.credentials) ? Root.credentials : null;
	if(!CredentialEntries)
		throw new Error("developer credentials file must contain an array or a credentials array");

	const Credentials = CredentialEntries.map(NormalizeCredential);
	const TokenHashes = new Set();
	for(const Credential of Credentials)
	{
		if(TokenHashes.has(Credential.token_sha256))
			throw new Error("duplicate developer credential token hash");
		TokenHashes.add(Credential.token_sha256);
	}
	return Credentials;
}

function NormalizeBoundedTrimmedString(Value, MaxLength)
{
	if(typeof Value !== "string")
		return "";
	const Normalized = Value.trim();
	if(Normalized.length === 0 || Normalized.length > MaxLength)
		return "";
	return Normalized;
}

function NormalizePlayer(Player)
{
	if(!IsPlainObject(Player) ||
		!Number.isInteger(Player.player_id) || Player.player_id < 0 || Player.player_id >= 128 ||
		typeof Player.player_name !== "string" || Player.player_name.length === 0 || Player.player_name.length > MAX_PLAYER_NAME_LENGTH ||
		typeof Player.dummy !== "boolean")
	{
		return null;
	}

	return {
		player_id: Player.player_id,
		player_name: Player.player_name,
		dummy: Player.dummy
	};
}

function PublicPresence(Presence)
{
	return {
		developer_id: Presence.developer_id,
		server_address: Presence.server_address,
		player_id: Presence.player_id,
		player_name: Presence.player_name,
		dummy: Presence.dummy,
		issued_at: Presence.issued_at,
		expires_at: Presence.expires_at,
		style_bucket: Presence.style_bucket
	};
}

function DeterministicStyleBucket(Credential, SessionId)
{
	const RejectionLimit = 4294967200;
	for(let Counter = 0;; ++Counter)
	{
		const Digest = crypto.createHash("sha256")
			.update(Credential.developer_id, "utf8")
			.update("\0", "utf8")
			.update(Credential.key_id, "utf8")
			.update("\0", "utf8")
			.update(SessionId, "utf8")
			.update("\0", "utf8")
			.update(String(Counter), "utf8")
			.digest();
		for(let Offset = 0; Offset < Digest.length; Offset += 4)
		{
			const Value = Digest.readUInt32BE(Offset);
			if(Value < RejectionLimit)
				return Value % 100;
		}
	}
}

class CDeveloperPresenceService
{
	constructor(Credentials, NowSec, CalculateStyleBucket)
	{
		this.m_NowSec = NowSec;
		this.m_CalculateStyleBucket = CalculateStyleBucket;
		this.m_CredentialsByTokenHash = new Map();
		this.m_Presences = new Map();

		for(const RawCredential of Credentials)
		{
			const Credential = NormalizeCredential(RawCredential);
			if(this.m_CredentialsByTokenHash.has(Credential.token_sha256))
				throw new Error("duplicate developer credential token hash");
			this.m_CredentialsByTokenHash.set(Credential.token_sha256, Credential);
		}
	}

	Authenticate(Authorization)
	{
		if(typeof Authorization !== "string")
			return null;
		const Match = /^Bearer ([^\s]+)$/i.exec(Authorization);
		if(!Match)
			return null;
		const TokenHash = crypto.createHash("sha256").update(Match[1], "utf8").digest("hex");
		const Credential = this.m_CredentialsByTokenHash.get(TokenHash);
		if(!Credential || Credential.revoked)
			return null;
		return Credential;
	}

	Cleanup(Now)
	{
		for(const [Key, Presence] of this.m_Presences)
		{
			if(Presence.expires_at <= Now)
				this.m_Presences.delete(Key);
		}
	}

	StyleBucketForSession(Credential, SessionId)
	{
		const Bucket = this.m_CalculateStyleBucket(Credential, SessionId);
		if(!Number.isInteger(Bucket) || Bucket < 0 || Bucket >= 100)
			throw new Error("developer presence random bucket must be an integer from 0 to 99");
		return Bucket;
	}

	ReportPresence(Authorization, Body)
	{
		const Credential = this.Authenticate(Authorization);
		if(!Credential)
			return { statusCode: 401, response: { ok: false, error: "invalid_developer_credential" } };
		if(!IsPlainObject(Body))
			return { statusCode: 400, response: { ok: false, error: "invalid_body" } };

		const ServerAddress = NormalizeBoundedTrimmedString(Body.server_address, MAX_SERVER_ADDRESS_LENGTH);
		const SessionId = NormalizeBoundedTrimmedString(Body.session_id, MAX_SESSION_ID_LENGTH);
		const Now = Math.floor(this.m_NowSec());
		if(ServerAddress === "")
			return { statusCode: 400, response: { ok: false, error: "invalid_server_address" } };
		if(SessionId === "")
			return { statusCode: 400, response: { ok: false, error: "invalid_session_id" } };
		if(!Array.isArray(Body.players) || Body.players.length === 0 || Body.players.length > MAX_PLAYERS_PER_PRESENCE)
			return { statusCode: 400, response: { ok: false, error: "invalid_players" } };

		const Players = [];
		const PlayerIds = new Set();
		for(const RawPlayer of Body.players)
		{
			const Player = NormalizePlayer(RawPlayer);
			if(!Player || PlayerIds.has(Player.player_id))
				return { statusCode: 400, response: { ok: false, error: "invalid_player" } };
			PlayerIds.add(Player.player_id);
			Players.push(Player);
		}

		this.Cleanup(Now);
		const UpdatedPresences = [];
		const StyleBucket = this.StyleBucketForSession(Credential, SessionId);
		for(const Player of Players)
		{
			const Key = `${Credential.developer_id}\0${Credential.key_id}\0${ServerAddress}\0${Player.player_id}`;
			const Presence = {
				developer_id: Credential.developer_id,
				key_id: Credential.key_id,
				server_address: ServerAddress,
				session_id: SessionId,
				player_id: Player.player_id,
				player_name: Player.player_name,
				dummy: Player.dummy,
				issued_at: Now,
				expires_at: Now + DEVELOPER_PRESENCE_TTL_SEC,
				style_bucket: StyleBucket
			};
			this.m_Presences.set(Key, Presence);
			UpdatedPresences.push(PublicPresence(Presence));
		}

		return {
			statusCode: 200,
			response: {
				ok: true,
				accepted: UpdatedPresences.length,
				presences: UpdatedPresences
			}
		};
	}

	GetPresences(ServerAddressValue)
	{
		const ServerAddress = NormalizeBoundedTrimmedString(ServerAddressValue, MAX_SERVER_ADDRESS_LENGTH);
		if(ServerAddress === "")
			return { statusCode: 400, response: { ok: false, error: "invalid_server_address" } };

		const Now = Math.floor(this.m_NowSec());
		this.Cleanup(Now);
		const Presences = Array.from(this.m_Presences.values())
			.filter((Presence) => Presence.server_address === ServerAddress)
			.sort((Left, Right) => Left.player_id - Right.player_id || Left.developer_id.localeCompare(Right.developer_id) || Left.key_id.localeCompare(Right.key_id))
			.map(PublicPresence);
		return { statusCode: 200, response: { server_time: Now, presences: Presences } };
	}
}

function CreateDeveloperPresenceService(Options = {})
{
	const Credentials = Options.Credentials !== undefined ? Options.Credentials : LoadDeveloperCredentials(Options.CredentialsFilePath || "");
	const NowSec = Options.NowSec || (() => Math.floor(Date.now() / 1000));
	const CalculateStyleBucket = Options.RandomBucket || DeterministicStyleBucket;
	return new CDeveloperPresenceService(Credentials, NowSec, CalculateStyleBucket);
}

function SendServiceResult(res, Result)
{
	res.status(Result.statusCode).json(Result.response);
}

function RegisterDeveloperPresenceRoutes(app, Service, Options = {})
{
	const CheckRateLimit = (req, res) => {
		if(!Options.CheckRateLimit || Options.CheckRateLimit(req))
			return true;
		res.status(429).json({ ok: false, error: "rate_limited" });
		return false;
	};

	app.post("/api/v1/developers/presence", (req, res) => {
		if(!CheckRateLimit(req, res))
			return;
		const Authorization = req.get ? req.get("authorization") : req.headers && req.headers.authorization;
		const Result = Service.ReportPresence(Authorization, req.body);
		SendServiceResult(res, Result);
		if(Result.statusCode === 200 && Options.OnChanged) Options.OnChanged(req.body.server_address);
	});

	app.get("/api/v1/developers/presences", (req, res) => {
		if(!CheckRateLimit(req, res))
			return;
		SendServiceResult(res, Service.GetPresences(req.query && req.query.server_address));
	});
}

module.exports = {
	CreateDeveloperPresenceService,
	DEVELOPER_PRESENCE_TTL_SEC,
	LoadDeveloperCredentials,
	RegisterDeveloperPresenceRoutes
};
