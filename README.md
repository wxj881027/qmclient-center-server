# QmClient 中心服务（qmclient-center-server）

QmClient（栖梦，基于 DDNet 的第三方客户端）的**中心服务**，使用 Node.js + Express + `ws` 实现。生产环境监听 `8080`，由 nginx 反向代理到 `https://qmclient.icu`。

服务只依赖 `express` 与 `ws` 两个运行时依赖，状态保存在进程内存与少量 JSON 文件中，适合单实例部署在反向代理之后。

## 功能特性

中心服务为客户端提供以下能力：

- **健康检查与时间同步**：`/healthz` 返回服务端 Unix 时间戳，客户端据此校准本地时钟。
- **版本查询**：`/client/version` 查询 GitHub 最新 release，与客户端当前版本比较；GitHub 不可用时使用回退版本，并把成功结果缓存 `CLIENT_VERSION_CACHE_TTL_SEC` 秒。
- **短期识别 token**：`/token` 签发 HMAC-SHA256 签名的短期 token，默认有效期 `TOKEN_TTL_SEC`（300）秒，默认与请求 IP 绑定。
- **识别上报与在线名单**：`/report` 接收「某游戏服务器上有哪些玩家」的上报，`/users.json` 输出仍在有效期内的记录；记录默认 `REPORT_TTL_SEC`（90）秒过期。
- **游玩时长统计**：`/playtime/start|stop|query` 与 WebSocket 共用同一份时长数据库，按 `client_id` 累计总时长，并格式化为「x年x月x天x小时x分钟x秒」。
- **开发者名牌认证（developer presence）**：设备级 Bearer 凭据上报主/副角色在线声明，按「服务器 + 玩家编号 + 精确昵称」在 15 秒租约内生效，并确定性派生样式桶。
- **称号（title）与兑换码**：兑换码一次性兑换、昵称绑定、可达 12 个字宽的自定义文字、31 种风格 id，以及可选的服务器端随机风格。
- **新闻广播（news）**：公开读取、开发者白名单发布的 Markdown 内容，发布后立即向所有 WebSocket 连接推送。
- **编辑器协作（editor collab）**：最多 4 人的房间，房间码 4–12 位，地图以 Base64 同步并带递增 `revision`，支持 HTTP 与 WebSocket 两套等价入口。
- **实时通道 `/ws`**：客户端单条 WebSocket 连接即可获得在线名单、开发者名牌、称号、新闻、时长与时间心跳。
- **语音服务联动**：作为客户端连接本机语音服务 `VOICE_REALTIME_URL`，把玩家识别信息转发给语音服务，并把语音服务维护的在线名单分发给客户端。

## 架构与数据流

```text
                          HTTPS (443)                HTTP (127.0.0.1:8080)
  QmClient 客户端  ───────────────────▶  nginx  ─────────────────────────▶  qmclient-center-server
    │  HTTP: /healthz /client/version /token /report /users.json            (Express + ws, 单进程)
    │        /playtime/* /editor/collab/* /api/v1/*                             │
    │  WS:   wss://qmclient.icu/ws           ──▶  location = /ws        ──▶  /ws        实时通道
    │  WS:   wss://qmclient.icu/ws/editor    ──▶  location = /ws/editor ──▶  /ws/editor 编辑器协作
    │                                                                          │
    │                                                          ws://127.0.0.1:9987/qm/realtime
    │                                                                          ▼
    └───────────────────────────────────────────────────────────  语音服务（qmclient-voice-server）
```

数据流要点：

1. 客户端先 `GET /token` 取短期 token（默认绑定请求 IP），随后在本局内周期性 `POST /report` 上报自己与分身的状态。
2. 客户端另开一条 `wss://.../ws` 连接：握手 `hello` 后，服务端先下发一次全量快照（`users`/`developers`/`titles`/`broadcast`/`playtime`/`time`），之后每 5 秒续租并推送变化。
3. 中心服务把连接上的 `presence` 转发给语音服务（`recognition` 消息），语音服务回推 `users` 快照，中心服务再按连接裁剪后转发给客户端：同服连接保留完整识别字段，外服连接只保留分布统计字段。
4. 开发者名牌、称号、新闻、编辑器协作都复用同一条 `/ws` 或第二条 `/ws/editor`，不额外建立连接。
5. 游玩时长在 `hello`（`start`）与 `stop` 时落盘，`query` 只读内存。

`TRUST_PROXY=1` 时 Express 信任来自 loopback 的代理地址（`app.set("trust proxy", "loopback")`），此时 `req.ip` 取自 `X-Forwarded-For`；`/ws` 在直连地址为 loopback 且存在合法 `X-Real-IP` 时，也用该头作为客户端 IP。默认（`TRUST_PROXY` 未设为 `1`）只信任 TCP 对端地址。

## HTTP 接口

所有请求与响应均为 JSON。除特别说明外，错误响应形如 `{ "ok": false, "error": "<code>" }`。默认 JSON 请求体上限为 32 KiB（`/editor/collab/*` 为 32 MiB）。除 `/healthz` 与 `/client/version` 外的路由都受单 IP 限速（`RATE_LIMIT_PER_MIN`，默认 120 次/分钟），超限返回 `429 { "ok": false, "error": "rate_limited" }`。

### 健康检查与版本

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/healthz` | 无 | 健康检查与时间同步 |
| `GET` | `/client/version?current=<version>` | 无 | 查询最新版本并与客户端版本比较 |

`GET /healthz`

```json
{ "ok": true, "ts": 1739436900 }
```

`ts` 为服务端 Unix 时间戳（秒）。

`GET /client/version?current=2.36.0`

```json
{
  "ok": true,
  "version": "2.36.0",
  "latest_version": "2.36.0",
  "latest_tag": "v2.36.0",
  "release_url": "https://github.com/<owner>/<repo>/releases/tag/v2.36.0",
  "current_version": "2.36.0",
  "up_to_date": true,
  "cache_source": "github",
  "cache_expires_at": 1739437200,
  "last_error": "",
  "update_message": "当前版本不是最新版，请前往 QQ 群更新最新版"
}
```

版本号会被归一化：`v`/`V` 前缀被去掉。`cache_source` 为 `github` 或 `fallback`（回退值）；查询 GitHub 失败时写入 `last_error`，并在 `CLIENT_VERSION_RETRY_DELAY_SEC` 秒后重试。

### 识别 token 与玩家上报

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/token` | 无 | 签发短期识别 token |
| `POST` | `/report` | `auth_token` 字段 | 上报当前服务器上的玩家状态 |
| `GET` | `/users.json` | 无 | 获取仍在有效期内的在线识别记录 |

`GET /token`

```json
{ "auth_token": "<nonce>.<expiresAt>.<hmac>", "expires_in": 300 }
```

token 由 `nonce.expiresAt.HMAC-SHA256(AUTH_SECRET)` 组成，保存在内存中，过期即失效；`REQUIRE_IP_BIND` 未设为 `0` 时只能由签发时的同一 IP 使用。

`POST /report`

```json
{
  "server_address": "example.org:8303",
  "auth_token": "<token from GET /token>",
  "client_type": "qm",
  "client_id": "qm314a5af9fb19ffc659077aa05e4a2689",
  "timestamp": 1739436900,
  "players": [
    {
      "player_name": "Q1menG",
      "player_id": 0,
      "dummy": false,
      "foot_particles_enabled": true,
      "remote_particles_enabled": true,
      "voice_supported": true
    }
  ]
}
```

成功返回 `{ "ok": true, "accepted": 1 }`。校验顺序与错误码：

| 状态码 | `error` | 触发条件 |
|---|---|---|
| `429` | `rate_limited` | 超出单 IP 每分钟请求上限 |
| `400` | `invalid_server_address` | `server_address` 非字符串、长度为 0 或超过 `MAX_SERVER_ADDRESS_LEN` |
| `401` | `invalid_auth_token` | token 不存在、已过期或 IP 不匹配 |
| `400` | `invalid_timestamp` | `timestamp` 非数字，或与服务端时间相差超过 `TIME_SKEW_SEC` |
| `400` | `too_many_players` | `players` 数量超过 `MAX_PLAYERS_PER_REPORT` |

字段说明：`client_type` 支持 `qm` / `arg`，并兼容 `qmclient` / `q1meng` / `arghena` 别名；同一字段可用 `type` 代替。身份键优先取玩家名（`name:<player_name>`），玩家名为空时退化为 `id:<player_id>`；记录键为 `server_address|身份键`，因此同一服务器上的同名玩家会相互覆盖。`client_id` 也可写作 `machine_hash`，需满足 8–64 位 `[A-Za-z0-9_-]`。玩家名为空且 `player_id` 无效的条目会被跳过，但不会让整个请求失败。玩家名截断到 `MAX_PLAYER_NAME_LEN`（32）个字符，`player_id` 合法范围为 `0..63`。

`GET /users.json`

```json
{
  "users": [
    {
      "server_address": "example.org:8303",
      "player_name": "Q1menG",
      "player_id": 0,
      "dummy": false,
      "client_type": "qm",
      "type": "qm",
      "client_id": "qm314a5af9fb19ffc659077aa05e4a2689",
      "qid": "qm314a5af9fb19ffc659077aa05e4a2689",
      "foot_particles_enabled": true,
      "remote_particles_enabled": true,
      "voice_supported": true,
      "updated_at": 1739436900
    }
  ]
}
```

`player_name` 与 `player_id` 只在有效时出现；`client_id` 与 `qid` 只有在客户端上报了合法 `client_id`/`machine_hash` 时才是非空字符串。

### 游玩时长

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/playtime/start` | 无（限速） | 开始或恢复时长会话 |
| `POST` | `/playtime/stop` | 无（限速） | 结束会话并结算时长 |
| `POST` | `/playtime/query` | 无（限速） | 只读查询累计与当前会话时长 |

请求体：`{ "client_id": "<8-64 位标识>", "player_name": "<可选昵称>" }`；`stop` 可额外带 `stop_at`（Unix 秒，服务端会夹取到 `[active_since, now]`，用于崩溃恢复补算）。`client_id` 非法时返回 `400 { "ok": false, "error": "invalid_client_id" }`；落盘失败时返回 `503 { "ok": false, "error": "storage_unavailable" }`。

成功响应（`start` 示例）：

```json
{
  "ok": true,
  "action": "start",
  "ts": 1739436900,
  "already_running": false,
  "client_id": "qm314a5af9fb19ffc659077aa05e4a2689",
  "player_name": "Q1menG",
  "running": true,
  "total_seconds": 3600,
  "total_time": { "years": 0, "months": 0, "days": 0, "hours": 1, "minutes": 0, "seconds": 0 },
  "total_time_text": "1小时",
  "last_start_at": 1739436900,
  "last_stop_at": 0,
  "last_seen_at": 1739436900
}
```

`start` 额外返回 `already_running`，`stop` 额外返回 `was_running`。`query` 对未知 `client_id` 返回全零的汇总，不创建记录、不落盘；`start`/`stop` 会写回 `PLAYTIME_DB_FILE`。

### 开发者名牌认证

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/api/v1/developers/presence` | `Authorization: Bearer <64 位十六进制 token>` | 上报开发者主/副角色在线声明 |
| `GET` | `/api/v1/developers/presences?server_address=<地址>` | 无 | 查询指定游戏服务器上仍有效的声明 |

`POST /api/v1/developers/presence`

```json
{
  "server_address": "example.org:8303",
  "session_id": "3f9c1d2e4b5a6789",
  "players": [
    { "player_id": 0, "player_name": "Q1menG", "dummy": false },
    { "player_id": 1, "player_name": "Q1menG[分身]", "dummy": true }
  ]
}
```

成功返回：

```json
{
  "ok": true,
  "accepted": 2,
  "presences": [
    {
      "developer_id": "qimeng",
      "server_address": "example.org:8303",
      "player_id": 0,
      "player_name": "Q1menG",
      "dummy": false,
      "issued_at": 1739436900,
      "expires_at": 1739436915,
      "style_bucket": 7
    }
  ]
}
```

校验规则：`server_address` 与 `session_id` 长度均不超过 128 且非空；`players` 为 1–8 个元素，`player_id` 为 `0..127` 且同一次请求内不重复，`player_name` 长度不超过 64，`dummy` 必须是布尔值。任意一项不合法返回 `400`，凭据不合法返回 `401 invalid_developer_credential`。租约固定 15 秒，键为 `developer_id + key_id + server_address + player_id`，因此同一次上报会覆盖同一位置的旧声明。

`GET /api/v1/developers/presences?server_address=example.org:8303`

```json
{
  "server_time": 1739436900,
  "presences": [
    {
      "developer_id": "qimeng",
      "server_address": "example.org:8303",
      "player_id": 0,
      "player_name": "Q1menG",
      "dummy": false,
      "issued_at": 1739436900,
      "expires_at": 1739436915,
      "style_bucket": 7
    }
  ]
}
```

结果按 `player_id`、`developer_id`、`key_id` 排序。`style_bucket` 由 `developer_id`、`key_id` 与 `session_id` 确定性派生（0–99），因此中心服务重启不会改变同一会话的样式，新会话才会重新取样。

### 称号与兑换码

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `POST` | `/api/v1/titles/redeem` | 请求体中的兑换码与 token | 兑换称号凭证 |
| `GET` | `/api/v1/titles/profile` | `Authorization: Bearer <token>` | 读取自己的称号资料 |
| `POST` | `/api/v1/titles/profile` | `Authorization: Bearer <token>` | 修改称号文字、风格与绑定昵称 |
| `POST` | `/api/v1/titles/presence` | `Authorization: Bearer <token>` | 上报持有称号的在线会话 |
| `GET` | `/api/v1/titles/presences?server_address=<地址>` | 无 | 查询指定服务器上有效的称号展示 |

这一组路由统一返回 `Cache-Control: no-store`，并受单 IP 限速；内部错误统一为 `503 { "ok": false, "error": "storage_unavailable" }`。

`POST /api/v1/titles/redeem`

```json
{ "code": "<48 位十六进制兑换码>", "token": "<64 位十六进制凭证 token>" }
```

成功返回 `{ "ok": true, "title": "赞助者", "style": "", "bound_name": "" }`（新兑换的凭证固定先得到「赞助者」称号，可随后通过 `POST /api/v1/titles/profile` 修改）。兑换码必须是 48 位十六进制、token 必须是 64 位十六进制，否则返回 `400 invalid_code`；服务端只保存 SHA-256 摘要，兑换成功后 `codes/<sha256>.json` 保留但 `redeemed` 表记录归属，重复兑换返回 `409 code_used`；同一 token 重试同一码（例如响应丢失）会返回同样的资料；该 token 已注册时返回 `409 already_registered`；摘要无对应兑换码文件时同样返回 `400 invalid_code`。`style` 为空表示未自选，由服务端在每局开始时分配。

`POST /api/v1/titles/profile`

```json
{ "title": "栖梦", "style": "exotic_rainbow", "bound_name": "Q1menG" }
```

成功返回更新后的资料。文字规则：非空、UTF-8 字节数不超过 48、不含控制字符/行分隔符/`[` `]`，且字宽（ASCII 记 1，其余字符记 2）不超过 12，否则 `400 invalid_title`。`bound_name` 为空表示不绑定昵称，非空时长度不超过 63 字节，否则 `400 invalid_name`。`style` 必须为空字符串或 `STYLE_IDS` 中的 id，否则 `400 invalid_style`；老客户端不带 `style` 时保留原值。凭据非法返回 `401 invalid_credential`。

可用风格 id（须与客户端 `src/game/client/components/qmclient/qm_title_style.cpp` 的风格表一致，客户端遇到未知 id 会回退到默认表现）：

```text
turquoise, pure_green, cosmic_purple, burnished_auric, hot_pink, calamity_red,
exotic_rainbow, exotic_rainbow_expert, dark_orange, angelic_alliance, contagion,
crystyl_crusher, demonshade, draconic_destruction, earth, endogenesis, eternity,
flamsteed_ring, illustrious_knives, profaned_soul_crystal, red_sun, scarlet_devil,
shattered_community, ozzathoth, soma_prime, staff_of_blushie, svantechnical,
sylvestaff, temporal_umbrella, triactis_hammer, donator_item
```

`POST /api/v1/titles/presence`

```json
{
  "server_address": "example.org:8303",
  "session_id": "3f9c1d2e4b5a6789",
  "players": [
    { "player_id": 0, "player_name": "Q1menG", "dummy": false },
    { "player_id": 1, "player_name": "Q1menG[分身]", "dummy": true }
  ]
}
```

成功返回 `{ "ok": true, "accepted": 2 }`。会话租约 15 秒；同一条上报中只要有任意玩家的昵称等于 `bound_name`，整条会话（本体 + 分身）都放行，否则 `accepted` 为 `0`。同一凭证最多 4 个活跃 IP（同一 IP 的多个会话不额外占名额），超出返回 `409 ip_limit`；`server_address`/`session_id` 为空或超过 128 字节、`players` 为空或超过 2 个、`player_id` 超出 `0..127` 或重复、昵称超过 63 字节、`dummy` 不是布尔值、缺少合法客户端 IP 时返回 `400 invalid_presence`。

未自选风格时，风格由 `SHA-256(token 摘要 + server_address + session_id)` 确定性派生，因此同一局内所有观察者看到的效果一致，换服或开新会话才变化。

`GET /api/v1/titles/presences?server_address=example.org:8303`

```json
{
  "server_time": 1739436900,
  "presences": [
    {
      "player_id": 0,
      "player_name": "Q1menG",
      "dummy": false,
      "title": "栖梦",
      "style": "exotic_rainbow",
      "server_address": "example.org:8303",
      "issued_at": 1739436900,
      "expires_at": 1739436915
    }
  ]
}
```

结果按 `player_id:player_name` 去重，不包含凭证或客户端 IP。`server_address` 不合法时返回 `400 invalid_server_address`。

### 新闻广播

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/api/v1/news/current` | 无 | 公开读取当前内容 |
| `POST` | `/api/v1/news/publish` | `Authorization: Bearer <开发者凭据>` | 发布内容 |

`GET /api/v1/news/current`

```json
{ "ok": true, "version": 3, "updated_at": 1739436900, "markdown": "## 本次更新\n- 新增功能" }
```

尚未发布时返回 `{ "ok": true, "version": 0, "updated_at": 0, "markdown": "" }`。两个路由都返回 `Cache-Control: no-store`。

`POST /api/v1/news/publish`

```json
{ "markdown": "## 本次更新\n- 新增功能" }
```

成功返回 `{ "ok": true, "version": 4, "updated_at": 1739436900 }` 并立即向所有 WebSocket 连接推送 `broadcast`。校验规则：凭据非法返回 `401 invalid_developer_credential`；凭据的 `developer_id` 不在 `NEWS_PUBLISH_DEVELOPER_IDS` 白名单内返回 `403 publishing_not_allowed`；请求体不是对象返回 `400 invalid_body`；内容为空或含除 `\n`、`\t` 以外的控制字符返回 `400 invalid_markdown`（`\r\n` 会先归一化为 `\n`）；超过 `NEWS_MAX_MARKDOWN_BYTES` 返回 `413 markdown_too_large`。只有发布成功才会通知实时连接。

### 编辑器协作

HTTP 路由与 `/ws/editor` 共用同一套房间操作与 `revision` 语义；HTTP 侧的鉴权是房间码本身（房间由 6 位随机码标识，服务端不额外校验 HTTP 调用方身份）。

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/editor/collab/create` | 创建房间 |
| `POST` | `/editor/collab/join` | 加入房间 |
| `POST` | `/editor/collab/leave` | 离开房间 |
| `POST` | `/editor/collab/push` | 上传新的地图修订 |
| `GET` | `/editor/collab/pull` | 拉取房间状态与新修订 |

请求体（`pull` 使用同名查询参数）：

```json
{ "room_code": "K7QM2P", "client_id": "qm314a5af9fb19ffc659077aa05e4a2689", "player_name": "Q1menG" }
```

`push` 额外带 `{ "map_base64": "<Base64 地图数据>" }`，`pull` 额外带 `?since=<revision>`。

成功响应（`create` / `join` / `push` / `pull` 同构）：

```json
{
  "ok": true,
  "room_code": "K7QM2P",
  "revision": 1,
  "member_count": 2,
  "max_members": 4,
  "members": [
    { "client_id": "qm314a5af9fb19ffc659077aa05e4a2689", "player_name": "Q1menG", "updated_at": 1739436900 }
  ],
  "map_base64": "<Base64 地图数据>"
}
```

`leave` 返回 `{ "ok": true, "room_code": "K7QM2P", "member_count": 1 }`。`map_base64` 仅在 `join`（房间已有地图时）、`push` 的响应以及 `pull` 且 `revision > since` 时出现。

| 状态码 | `error` | 触发条件 |
|---|---|---|
| `400` | `invalid_client_id` | `client_id` 不是 8–64 位 `[A-Za-z0-9_-]` |
| `404` | `invalid_room` | 房间码不合法或房间已过期 |
| `409` | `room_full` | 房间已有 4 名成员且该 `client_id` 不在其中 |
| `403` | `not_in_room` | `push`/`pull` 的 `client_id` 未加入该房间 |
| `400` | `invalid_map` | `map_base64` 为空、含非 Base64 字符或超过 `EDITOR_COLLAB_MAX_MAP_BASE64_LEN` |

房间码由 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` 生成的 6 位字符串（避免易混字符），匹配规则为 4–12 位大写字母或数字。成员在 `EDITOR_COLLAB_MEMBER_TTL_SEC`（45 秒）无任何操作后过期；无成员的房间在 `EDITOR_COLLAB_ROOM_TTL_SEC`（300 秒）后被回收。`push` 会令 `revision` 加一。

## WebSocket 协议

三个端点在 HTTP 升级阶段区分：

| 路径 | 传输子协议 | 帧上限 | 说明 |
|---|---|---|---|
| `/ws` | 必须声明 `qmclient-json` | 32 KiB | 客户端实时通道 |
| `/ws/editor` | 必须声明 `qmclient-json` | 32 MiB | 编辑器协作通道 |
| `/ws/voice` | — | — | 中心服务**出站**连接语音服务，不对客户端开放 |

`/ws` 与 `/ws/editor` 都必须携带 `Sec-WebSocket-Protocol: qmclient-json`；`/ws` 在子协议缺失时返回 `HTTP/1.1 400 Bad Request`，`/ws/editor` 在子协议缺失时直接断开连接。两者均禁用 `perMessageDeflate`。服务端每 10 秒发送 ping，45 秒未收到任何消息即终止连接；`/ws` 在 15 秒内未完成 `hello` 也会被终止。每条连接每分钟最多 120 条消息（超限以 `1008 rate_limited` 关闭）。

服务端消息统一封装为 `{ "type": ..., "v": 2, "data": ... }`。

### `/ws` 客户端 → 服务端

| `type` | 关键字段 | 说明 |
|---|---|---|
| `hello` | `v`(必须为 `2`)、`machine_hash`(64 位十六进制)、`client_id`、`player_name`、`server_address`、`session_id`、`players`、`title_token`、`developer_token`、`recovery_stop_at` | 必须作为首条消息发送；每条连接只能发送一次，重复发送得到 `already_initialized` |
| `presence` | `server_address`、`session_id`、`players`、`title_token`、`developer_token` | 更新当前在线状态；服务端不返回确认消息 |
| `subscribe_titles` | `title_token` | 更新称号凭证并立即请求称号资料与当前服务器的称号快照 |
| `news` | — | 主动拉取当前新闻内容 |
| `ping` | — | 应用层心跳，返回 `pong` |
| `pong` | — | 应用层保活应答，不做任何响应 |
| `stop` | `stop_at`(可选，Unix 秒) | 结束时长会话，返回结算后的 `playtime` |

`hello` 校验失败（版本不为 2、`machine_hash` 不是 64 位十六进制、`client_id` 不是 8–64 位标识、`player_name` 非文本或超长、`presence` 非法）返回 `invalid_hello`。`presence` 的校验规则：`server_address` 与 `session_id` 均为不超过 128 字节的可打印文本；`players` 为数组且不超过 2 个元素；每个玩家的 `player_id` 为 `0..127` 且不重复，`player_name` 为 1–63 字节可打印文本，`dummy` 必须是布尔值；`players` 非空时 `server_address` 与 `session_id` 不得为空。`hello` 中的 `title_token`、`developer_token` 以及后续 `presence` 中被改写的同名字段必须是 64 位十六进制字符串。

设备身份（`machine_hash`、`client_id`）与时长身份在首次 `hello` 时固定，后续消息不能替换。若 `hello` 带 `recovery_stop_at`，服务端先按该时间点补算上一次未正常结束的会话，再开始新会话；时长数据库不可用时返回 `playtime_unavailable` 并关闭该连接。

### `/ws` 服务端 → 客户端

| `type` | `data` 关键字段 | 触发时机 |
|---|---|---|
| `playtime` | `action`(`start`/`stop`/`query`)、`running`、`total_seconds`、`total_time_text`、`ts`，`hello` 时附带 `recovery_processed` | `hello`、`stop` 以及每 5 秒的时长心跳 |
| `users` | `users`、`server_address`、`lease_seconds`(20) | `hello`、换服、语音服务推送新名单、每 5 秒续租 |
| `developers` | `presences`、`server_time`、`server_address` | `hello`、同服开发者声明发生变化（50 毫秒合并）、每 5 秒租约心跳 |
| `titles` | `presences`、`server_time`、`server_address` | `hello`、`subscribe_titles`、称号数据变化、每 5 秒租约心跳 |
| `broadcast` | `version`、`updated_at`、`markdown` | `hello`、收到 `news`、发布成功后的主动推送 |
| `time` | `ts` | `hello` 及每 5 秒 |
| `title_profile` | `status`、`title`、`style`、`bound_name` | `hello`（已带 `title_token` 时）与 `subscribe_titles` |
| `title_status` | `status`、`error` 等 | 称号上报失败时（例如租约 IP 超限） |
| `pong` | `ts` | 收到 `ping` |
| `error` | `error` | 见下表 |

`users` 名单的裁剪规则：`server_address` 与本连接相同的条目保留完整识别字段；其他服务器的条目只保留 `server_address`、`player_name`、`dummy`。名单按连接合并为「最新一份」，`lease_seconds` 为 20 秒，语音服务断线或名单超过 20 秒未刷新时不会继续续租。

`error` 的可能取值：`text_required`（收到二进制帧）、`invalid_message`（不是 JSON 对象）、`already_initialized`、`invalid_hello`、`hello_required`（未握手就发送其他消息）、`invalid_presence`、`unknown_event`、`playtime_unavailable`、`service_unavailable`（处理消息时抛出异常）。

### `/ws/editor` 双向消息

客户端 → 服务端：

```json
{
  "type": "collab",
  "request_id": 1,
  "action": "create",
  "data": { "client_id": "qm314a5af9fb19ffc659077aa05e4a2689", "player_name": "Q1menG", "room_code": "K7QM2P", "map_base64": "<Base64>" }
}
```

`action` 仅接受 `create`、`join`、`leave`、`push`（与 HTTP 路由一一对应，`pull` 不需要手工发送）。`request_id` 必须是正整数；`data.client_id` 必须是 8–64 位 `[A-Za-z0-9_-]`。

服务端 → 客户端：

```json
{
  "ok": true,
  "type": "collab",
  "request_id": 1,
  "status": 200,
  "room_code": "K7QM2P",
  "revision": 1,
  "member_count": 2,
  "max_members": 4,
  "members": [ { "client_id": "qm314a5af9fb19ffc659077aa05e4a2689", "player_name": "Q1menG", "updated_at": 1739436900 } ]
}
```

`status` 与 HTTP 状态码同义（200/400/403/404/409）。除请求应答外，服务端在房间变更时主动推送快照，`request_id` 为 `0`，因此接收方无需轮询 `pull`；推送同样遵循 `map_base64` 仅在 `revision > since` 时携带的规则。每条连接只能绑定一个房间：`create`/`join` 成功即与该 `client_id`、房间码绑定，之后消息中的 `client_id` 与 `room_code` 必须一致，再次 `create` 也会被拒绝，违规返回 `status: 403, error: invalid_session`；`leave` 解除绑定。连接关闭或房间成员过期时绑定失效，过期成员对应的连接会在下一次 ping 收到 `403 not_in_room`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP 监听端口，监听地址固定为 `0.0.0.0` |
| `TOKEN_TTL_SEC` | `300` | 识别 token 有效期（秒） |
| `REPORT_TTL_SEC` | `90` | 在线识别记录有效期（秒） |
| `MAX_PLAYERS_PER_REPORT` | `8` | 单次 `/report` 的玩家数上限 |
| `MAX_SERVER_ADDRESS_LEN` | `128` | `server_address` 长度上限 |
| `TIME_SKEW_SEC` | `600` | `/report` 时间戳允许偏差（秒） |
| `REQUIRE_IP_BIND` | `1` | 仅当值为 `0` 时关闭 token 与请求 IP 的绑定 |
| `TRUST_PROXY` | `0` | 仅当值为 `1` 时启用 `trust proxy = "loopback"` |
| `RATE_LIMIT_PER_MIN` | `120` | 单 IP 每分钟请求上限 |
| `AUTH_SECRET` | 每次启动随机生成 | token 签名密钥；未显式配置时重启即失效全部 token |
| `DEVELOPER_CREDENTIALS_FILE` | 空 | 开发者设备凭据摘要 JSON 路径；为空时不接受任何开发者上报 |
| `PLAYTIME_DB_FILE` | `<仓库目录>/playtime_db.json` | 游玩时长数据库路径 |
| `CLIENT_RELEASE_OWNER` | `wxj881027` | 版本查询的 GitHub 仓库所有者 |
| `CLIENT_RELEASE_REPO` | `QmClient` | 版本查询的 GitHub 仓库名 |
| `CLIENT_LATEST_VERSION` | `2.36.0` | GitHub 查询失败时的回退版本（自动去掉 `v` 前缀） |
| `CLIENT_VERSION_CACHE_TTL_SEC` | `300` | 成功查询结果的缓存时间（秒） |
| `CLIENT_VERSION_RETRY_DELAY_SEC` | `60` | 查询失败后的重试间隔（秒） |
| `CLIENT_VERSION_FETCH_TIMEOUT_MS` | `5000` | 查询 GitHub 的超时（毫秒） |
| `CLIENT_RELEASES_API_URL` | `https://api.github.com/repos/${CLIENT_RELEASE_OWNER}/${CLIENT_RELEASE_REPO}/releases/latest` | release 查询地址 |
| `CLIENT_LATEST_TAG` | `v${CLIENT_LATEST_VERSION}` | 回退版本对应的 tag |
| `CLIENT_RELEASE_URL` | 回退 tag 对应的 GitHub release 页面 | 回退下载页地址 |
| `MAX_CLIENT_ID_LEN` | `64` | `client_id` 长度上限 |
| `MAX_PLAYER_NAME_LEN` | `32` | `/report` 中玩家名截断长度 |
| `EDITOR_COLLAB_MEMBER_TTL_SEC` | `45` | 协作成员无操作后的过期时间（秒） |
| `EDITOR_COLLAB_ROOM_TTL_SEC` | `300` | 空房间的回收时间（秒） |
| `EDITOR_COLLAB_MAX_MAP_BASE64_LEN` | `25165824`（24 MiB） | Base64 地图长度上限 |
| `TITLE_DATA_DIR` | `<仓库目录>/title_data` | 称号与兑换码目录 |
| `NEWS_DATA_DIR` | `<仓库目录>/news_data` | 新闻内容目录 |
| `NEWS_PUBLISH_DEVELOPER_IDS` | 空 | 允许发布新闻的 `developer_id`，逗号分隔；为空时无人可发布 |
| `NEWS_MAX_MARKDOWN_BYTES` | `16384`（16 KiB） | 新闻 Markdown 字节上限 |
| `VOICE_REALTIME_URL` | `ws://127.0.0.1:9987/qm/realtime` | 语音服务实时通道地址 |

未在环境变量表中的常量：开发者名牌租约 15 秒、称号会话租约 15 秒、`/report` 记录中 `player_id` 的合法范围 `0..63`、开发者名牌与称号上报中 `player_id` 的合法范围 `0..127`、编辑器协作成员上限 4 人、在线名单租约 20 秒、WebSocket 每条连接每分钟 120 条消息。

## 运行期数据文件

服务自身只读取/写入以下文件，均可用环境变量改到仓库之外（推荐生产环境这样做）：

### `playtime_db.json`（`PLAYTIME_DB_FILE`）

游玩时长数据库，写入采用「临时文件 + rename」的原子替换，结构为：

```json
{
  "version": 1,
  "updated_at": 1739436900,
  "clients": {
    "qm314a5af9fb19ffc659077aa05e4a2689": {
      "client_id": "qm314a5af9fb19ffc659077aa05e4a2689",
      "player_name": "<玩家昵称>",
      "total_seconds": 3600,
      "active_since": 0,
      "created_at": 1739430000,
      "updated_at": 1739436900,
      "last_start_at": 1739430000,
      "last_stop_at": 1739436900,
      "last_seen_at": 1739436900
    }
  }
}
```

`active_since` 非 0 表示会话进行中；读取时会用 `total_seconds + (now - active_since)` 得到当前总时长，因此进程重启不会丢失进行中的会话（前提是能以 `recovery_stop_at` 恢复）。所有数值字段都会被规范化为非负整数。

### `news_data/news.json`（`NEWS_DATA_DIR`）

新闻内容，单文件单频道，写入同样先落盘再发布内存状态：

```json
{ "version": 3, "updated_at": 1739436900, "markdown": "## 本次更新\n- 新增功能" }
```

`version` 从 0 开始，每次成功发布加一；文件不存在时视为 `{ "version": 0, "updated_at": 0, "markdown": "" }`；字段类型不合法会导致构造失败（直接退出，而不是带病运行）。

### `title_data/titles.json` 与 `title_data/codes/`（`TITLE_DATA_DIR`）

`titles.json` 保存已兑换用户与已使用兑换码：

```json
{
  "users": {
    "<token 的 SHA-256>": { "label": "<发放标签>", "title": "<称号文字>", "style": "", "bound_name": "" }
  },
  "redeemed": { "<兑换码的 SHA-256>": "<token 的 SHA-256>" }
}
```

`codes/<兑换码的 SHA-256>.json` 是发放兑换码时写入的文件，内容为 `{ "label": "<发放标签>" }`；兑换成功后该文件保留，归属关系记录在 `redeemed` 中。目录以 `0700` 创建，文件以 `0600` 写入。三种文件都只保存摘要或昵称，不保存原始 token 与原始兑换码。

### `data/` 目录

仓库内的 `data/news_data/`、`data/title_data/`、`data/title_data/codes/` 用于示意生产环境的目录布局（当前只保留 `.gitkeep` 占位，目录内容为空）。**这些目录不得提交真实运行期数据**：`playtime_db.json` 含玩家标识与时长，`news_data/news.json` 含真实内容，`title_data/` 含真实兑换码，都只应存在于部署主机的数据目录中。

## 本地运行与测试

要求 Node.js 18 及以上（生产使用 Node 24），依赖只有 `express ^4.21.2` 与 `ws ^8.21.3`。

```bash
npm ci                 # 或 npm install
AUTH_SECRET="<32 字节以上的随机值>" PORT=8080 npm start
```

启动后监听 `http://127.0.0.1:8080`，日志只有一行 `[qmclient-center-server] listening on :8080`。本地自检：

```bash
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/client/version
curl -s -X POST http://127.0.0.1:8080/playtime/query \
  -H 'content-type: application/json' \
  -d '{"client_id":"localdev0001","player_name":"tester"}'
```

测试脚本位于 `test/`，用 Node 内置测试运行器执行：

```bash
npm test               # 等价于 node --test test/*.test.js
node --test test/realtime.test.js   # 只跑单个文件
```

`test/` 现有 5 个测试文件：`developer_auth.test.js`、`editor_realtime.test.js`、`news_auth.test.js`、`realtime.test.js`、`title_auth.test.js`，共 35 个用例，全部通过（Node 22/24 实测：`# tests 35 / # pass 35 / # fail 0`）。

测试覆盖范围与源码能力严格对齐。本版本**未实现**赞助名单频道（`sponsors` 消息类型 / `/api/v1/sponsors/*` 路由）与表情事件（`emoticon` 消息类型），因此原测试集中针对这两项能力的用例已从本仓库移除，共 6 个（`realtime.test.js` 中 5 个 + 整个 `sponsors_auth.test.js` 的 3 个用例中的 2 个，该文件随之删除）。若你在此仓库上补齐这两项能力，请把对应用例一并加回。

`deploy/probe_realtime.js` 是**部署自检脚本**，用临时身份和临时协作房间验证线上实时通道（不触碰真实玩家凭据）：

```bash
node deploy/probe_realtime.js                       # 默认 wss://qmclient.icu/ws
node deploy/probe_realtime.js ws://127.0.0.1:8080/ws
```

它依次断言：主通道能升级握手、`hello` 后能收到 `users`/`developers`/`titles`/`broadcast`/`playtime`/`time` 六类初始快照、`stop` 能得到结算应答；编辑器通道能 `create`/`join`、`push` 后靠房间推送（不主动 `pull`）拿到新 `revision` 与地图、`leave` 成功。任一断言失败会以非零退出码结束并打印原因。

## 生产部署

推荐把代码部署到 `/opt/qmclient-center-server`，用专用系统账号运行，systemd 单元名为 `qmclient-center-server.service`。参考单元文件（密钥与路径均用占位符，请勿提交真实值）：

```ini
[Unit]
Description=QmClient Center Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=qmcenter
Group=qmcenter
WorkingDirectory=/opt/qmclient-center-server
EnvironmentFile=/etc/qmclient/center-server.env
Environment=NODE_ENV=production
Environment=PORT=8080
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/qmclient-center-server

[Install]
WantedBy=multi-user.target
```

`.env`（权限建议 `0600`，属主为服务运行用户）：

```ini
PORT=8080
AUTH_SECRET=<32 字节以上的随机值，必须持久化>
TRUST_PROXY=1
DEVELOPER_CREDENTIALS_FILE=/etc/qmclient/developer_credentials.json
PLAYTIME_DB_FILE=/var/lib/qmclient-center-server/playtime_db.json
TITLE_DATA_DIR=/var/lib/qmclient-center-server/title_data
NEWS_DATA_DIR=/var/lib/qmclient-center-server/news_data
NEWS_PUBLISH_DEVELOPER_IDS=<开发者 ID，逗号分隔>
VOICE_REALTIME_URL=ws://127.0.0.1:9987/qm/realtime
```

常用操作：`sudo systemctl daemon-reload && sudo systemctl restart qmclient-center-server`、`journalctl -u qmclient-center-server -f`。

nginx 由 `qmclient.icu` 的虚拟主机终结 TLS，并把 WebSocket 与普通 HTTP 反向代理到 `127.0.0.1:8080`。`deploy/nginx/` 下提供 4 个可直接 `include` 到该 server 块的片段：

| 片段 | 覆盖的入口 |
| --- | --- |
| `qmclient-realtime.conf` | `location = /ws`、`location = /ws/editor`（WebSocket 专用入口） |
| `qmclient-news.conf` | `location ^~ /api/v1/news/`（新闻与更新内容） |
| `qmclient-titles.conf` | `location ^~ /api/v1/titles/`（称号） |
| `qmclient-developer-auth.conf` | `location = /api/v1/developers/presence`、`/api/v1/developers/presences`（开发者名牌在场） |

```nginx
# 中心服务 HTTP 入口
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# 编辑器协作请求体可达 32 MiB，必须放开代理限制
location /editor/collab/ {
    client_max_body_size 32m;
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

`deploy/nginx/qmclient-realtime.conf` 提供 `location = /ws` 与 `location = /ws/editor`，两者都设置 `Upgrade`/`Connection` 升级头、`X-Real-IP`（`/ws` 在 loopback 直连时用它判定客户端 IP）、`proxy_read_timeout 75s` 与 `proxy_buffering off`（避免 WebSocket 帧被缓冲）。使用该片段时，反向代理本身不负责 `wss` 加密，TLS 仍由现有虚拟主机终结。

客户端侧对应配置：HTTP 基准地址为 `https://qmclient.icu`，实时通道为 `wss://qmclient.icu/ws`（编辑器为 `wss://qmclient.icu/ws/editor`）。`/ws/voice` 不是客户端入口。

部署注意事项：

- token、在线记录、开发者名牌、称号会话与协作房间都保存在单进程内存中，因此不能多实例负载均衡；需要扩容时应先改为共享存储或保证会话粘滞。
- `AUTH_SECRET`、`DEVELOPER_CREDENTIALS_FILE`、`PLAYTIME_DB_FILE`、`TITLE_DATA_DIR`、`NEWS_DATA_DIR` 所在目录都要持久化并限制访问权限（建议目录 `0700`、文件 `0600`）。
- 修改 nginx 配置或数据目录后，按 `deploy/probe_realtime.js` 做一次线上自检。

## 客户端增量更新脚本

`scripts/` 下的两个脚本维护的是**客户端自身的更新分发**（用于 `update.json` 增量清单），它们不在中心服务的运行路径上，也不会被 `server.js` 加载或调用；同目录其余文件与它们没有依赖关系。脚本源自 DDNet/TaterClient 的发布流程，目录布局按该流程的服务器约定硬编码。

### `scripts/diff_update.py`

比较两个已解包的客户端版本目录，生成增量更新描述：

```bash
cd <存放发布包与 update.json 的工作目录>
python3 diff_update.py <旧版本> <新版本>    # 例如 python3 diff_update.py 2.35.0 2.36.0
```

行为：

- 读取当前目录的 `update.json`（不存在时上游 `update.zsh` 会先写入 `[]`）。
- 对 `TClient-<版本>-win64` 与 `TClient-<版本>-linux_x86_64` 两个目录分别递归计算 SHA-256：文件名含 `.` 且不以 `.exe` 结尾的文件才纳入比较（即 `data/` 下的资源等；`.exe` 由 `update.zsh` 单独按名字搬运）。
- 输出新增/变更文件列表（`download`）与删除列表（`remove`），并把这些条目插到 `update.json` 数组的最前面：`{ "version": "<新版本>", "client": true, "server": true, "download": [...], "remove": [...] }`。
- 结果写入 `update.json.new`（不覆盖原文件）。同一路径同时出现在 `download` 与 `remove` 时直接报错，避免生成自相矛盾的清单。
- 安装了 `tqdm` 时显示进度条；未安装时自动退化为无进度条，功能不受影响。

### `scripts/update.zsh`

一次发布（从旧版本到新版本）的完整打包脚本：

```bash
./update.zsh <旧版本> <新版本>    # 例如 ./update.zsh 2.35.0 2.36.0
```

行为（`set -e -x`，任一步失败即中止并打印每条命令）：

- 以低优先级运行（`renice 19`、`ionice -c 3`），从上游 GitHub release 下载两个版本的 Windows zip 与 Linux tar.xz，解包并拉平 Windows 包内的单层子目录。
- 从更新目录取现有 `update.json`（不存在则初始化为 `[]`），调用 `diff_update.py` 生成新清单，并把旧清单留作 `update.json.old`。
- 用新版本替换更新目录中的资源：`data/` 整目录切换（旧的改名为 `data.old` 后删除）、`license.txt`、`storage.cfg`、`config_directory.bat`。
- 把 Windows 的 `.exe`/`.dll` 按 `<名字>-win64.<扩展名>`、Linux 的 `DDNet`/`DDNet-Server` 按 `<名字>-linux-x86_64`、`*.so` 按 `<名字>-linux-x86_64.so` 改名后放进更新目录（搬运使用「先写临时文件再改名」的方式，避免在线客户端读到半个文件）。
- 最后把新 `update.json` 放进更新目录，写出 `info.json`（`{ "version": "<新版本>" }`），并清理下载包与解包目录。

注意事项：脚本以 `zsh` 运行，依赖 `wget`、`unzip`、`tar`、`ionice` 等工具；`SCRIPTS_DIR` / `UPDATES_DIR` 两个路径按发布服务器的既有布局写死，在别处使用前需要先改这两行以及下载地址。`diff_update.py` 建议用 Python 3.8+ 运行。

## 安全说明

- **`AUTH_SECRET` 必须显式配置并持久化**。未设置时进程每次启动都会生成 32 字节随机值，重启后所有已签发的识别 token 立即失效，客户端需要重新获取 token。生产环境必须通过 `EnvironmentFile` 或密钥管理工具注入，且不要写入仓库。
- **token 与 IP 绑定**。`REQUIRE_IP_BIND` 默认为开启（只有显式设置为 `0` 才关闭），token 只能由签发时的 IP 使用，降低 token 被转发滥用的风险。反向代理后必须让服务看到真实客户端 IP。
- **`TRUST_PROXY` 的语义**：只有值为 `1` 时启用 `trust proxy = "loopback"`，即信任来自 loopback 的代理所附加的 `X-Forwarded-For`。仅在服务确实位于本机反向代理之后时才开启；若服务直接暴露或被不受信任的代理访问，开启会让客户端可以伪造 IP，从而绕过限速与 IP 绑定。
- **限速与容量限制**。单 IP 每分钟 `RATE_LIMIT_PER_MIN`（默认 120）次请求；WebSocket 每条连接每分钟 120 条消息；请求体默认 32 KiB，编辑器协作为 32 MiB；`/report`、开发者名牌、称号上报都有玩家数与字段长度上限。这些是防误用与防滥用的第一道闸门，不能替代反向代理层的访问控制。
- **凭据安全**。识别 token 只存在于内存；开发者凭据文件只保存设备 token 的 SHA-256（`token_sha256`），可用 `revoked: true` 吊销；称号系统只保存 token 与兑换码的 SHA-256；公开接口（`/users.json`、`/api/v1/developers/presences`、`/api/v1/titles/presences`、`/api/v1/news/current`）不会返回客户端 IP、原始凭据或原始兑换码。
- **运行时数据不入库**。`playtime_db.json` 含玩家标识与时长，`news_data/news.json` 含真实内容，`title_data/` 含真实兑换码，均属于运行期数据，只应存在于部署主机的数据目录（`0700`/`0600`），不要复制回仓库或在 issue 中粘贴。
- **编辑器协作房间依赖房间码作为访问凭据**，6 位随机码可被暴力尝试；HTTP 入口按 IP 限速，请勿把 `/editor/collab/*` 暴露到不受限速保护的通道，也不要用于同步敏感地图。
- **异常输入一律拒绝**：非法 JSON、二进制帧、未知消息类型、超长字段都会被明确拒绝或关闭连接，且服务端不信任客户端上报的时间（`/report` 用 `TIME_SKEW_SEC` 校验，`/playtime/stop` 的 `stop_at` 会被夹取到合法区间）。

## 许可证

本项目使用 Zlib 许可证，见同目录 `LICENSE`。服务使用的 `express`、`ws` 等第三方依赖遵循其各自的许可证。

上游致谢：DDNet / Teeworlds / TaterClient。
