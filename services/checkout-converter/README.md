# Checkout Converter Service

把当前项目里的 Plus checkout 创建逻辑抽成一个独立可部署的云端服务。

## 能力范围

- 输入 ChatGPT `accessToken`
- 按当前项目的规则创建 Plus checkout session
- 返回：
  - `checkoutUrl`
  - `chatgptCheckoutUrl`
  - `hostedCheckoutUrl`
  - `preferredCheckoutUrl`

当前实现与项目内 [content/plus-checkout.js](I:\FlowPilot-FlowPilot1.0\FlowPilot-FlowPilot1.0.2\content\plus-checkout.js:978) 保持一致：

- `paypal` 默认 `US / USD`
- `gopay` 默认 `ID / IDR`
- 默认转换后的 `processorEntity` 为 `openai_llc`
- `paypal` 优先返回 `pay.openai.com` 的 hosted checkout 长链

## 接口

### `GET /healthz`

健康检查与当前并发配置概览。

### `POST /api/checkout`

请求头：

```text
Content-Type: application/json
X-API-Key: <你的服务鉴权，可选但强烈建议开启>
```

请求体：

```json
{
  "accessToken": "<chatgpt access token>",
  "paymentMethod": "paypal",
  "country": "US",
  "currency": "USD",
  "processorEntity": "openai_llc",
  "requestId": "req-001"
}
```

返回示例：

```json
{
  "ok": true,
  "requestId": "req-001",
  "paymentMethod": "paypal",
  "checkoutSessionId": "cs_live_xxx",
  "checkoutUrl": "https://chatgpt.com/checkout/openai_ie/cs_live_xxx",
  "chatgptCheckoutUrl": "https://chatgpt.com/checkout/openai_llc/cs_live_xxx",
  "hostedCheckoutUrl": "https://pay.openai.com/c/pay/hosted_cs_live_xxx",
  "preferredCheckoutUrl": "https://pay.openai.com/c/pay/hosted_cs_live_xxx",
  "processorEntity": "openai_llc",
  "upstreamProcessorEntity": "openai_ie",
  "country": "US",
  "currency": "USD",
  "upstreamStatus": 200,
  "durationMs": 742
}
```

## 本地启动

```powershell
cd services/checkout-converter
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:CHECKOUT_CONVERTER_API_KEY="replace-me"
.\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8080
```

## Docker

```powershell
cd services/checkout-converter
docker build -t checkout-converter .
docker run -d `
  -p 8080:8080 `
  -e CHECKOUT_CONVERTER_API_KEY=replace-me `
  -e MAX_OUTBOUND_CONCURRENCY=200 `
  -e SESSION_MAX_CLIENTS=400 `
  --name checkout-converter `
  checkout-converter
```

## 生产部署建议

### 1. 进程模型

推荐用 `gunicorn + uvicorn worker`：

```bash
gunicorn -k uvicorn.workers.UvicornWorker -w 2 -b 0.0.0.0:8080 app:app
```

如果是 4 核机器，建议从 `2` 或 `3` 个 worker 起步，不要一开始把 worker 开太高。


### 2. 并发参数

- `MAX_OUTBOUND_CONCURRENCY`
  控制单进程同时向 OpenAI 发起多少个 checkout 请求
- `SESSION_MAX_CLIENTS`
  控制 `curl_cffi.AsyncSession` 连接池容量
- `REQUEST_TIMEOUT_SECONDS`
  单次上游请求超时

建议起步值：

```text
MAX_OUTBOUND_CONCURRENCY=200
SESSION_MAX_CLIENTS=400
REQUEST_TIMEOUT_SECONDS=30
```

如果你的机器出口稳定、CPU 余量足，再逐步提高。

### 3. 高并发注意点

- 不要把 access token 打到日志里
- `X-API-Key` 必开
- 入口层建议再加一层 Nginx 限流
- 如需更稳的机房出口，优先通过固定代理或住宅代理出站
- 如果业务会重复提交同一 token，最好在调用方做去重或幂等控制

### 4. Cloudflare 风险

虽然这里用了 `curl_cffi` 的浏览器指纹模拟，但云服务器出口 IP 仍然可能被挑战。

如果你遇到：

- `upstream blocked by Cloudflare challenge`
- 403 / 429 明显增多

优先排查：

1. 服务器出口 IP 质量
2. 是否需要固定代理出站
3. 并发是否过高
4. 是否同一 token 被短时间重复调用

## 环境变量

```text
PORT=8080
BIND_HOST=0.0.0.0
CHECKOUT_CONVERTER_API_KEY=
LOG_LEVEL=INFO
REQUEST_TIMEOUT_SECONDS=30
MAX_OUTBOUND_CONCURRENCY=200
SESSION_MAX_CLIENTS=400
IMPERSONATE_BROWSER=chrome136
OPENAI_PROXY_URL=
SERVICE_NAME=checkout-converter
SERVICE_VERSION=1.0.0
```

`OPENAI_PROXY_URL` 是所有上游请求统一走的代理，支持 `http://`、`https://`、`socks5://`、`socks5h://`。请求体里显式带 `proxyUrl` 时以请求体为准（方便排障）。

## 多节点轮询（xray sidecar）

应用本身不再管理 xray 进程。生产环境用 docker-compose 把 xray 作为独立容器，
让应用通过 `OPENAI_PROXY_URL=http://xray:7891` 出网；xray 负责多节点轮询
（`routing.balancers`，策略可选 `roundRobin / random / leastPing`）。

完整方案见 [`deploy/compose/`](./deploy/compose/README.md)，要点：

- `deploy/compose/xray-config.json` 填入多个 `node-*` outbound，`selector: ["node-"]` 自动加入 balancer。
- 应用容器 `OPENAI_PROXY_URL=http://xray:7891`，多 worker 安全。
- 轮换节点：编辑 `xray-config.json` → `docker compose restart xray`，应用不需重启。
