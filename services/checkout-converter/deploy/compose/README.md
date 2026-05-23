# Compose 部署：xray sidecar + checkout-converter

把 xray 和 checkout-converter 拆成两个独立容器，xray 单独管理多节点轮询，应用容器可放心多 worker 横向扩容。

## 目录结构

```
deploy/compose/
├── docker-compose.yml          # 服务编排
├── .env.example                # 环境变量模板，复制为 .env 后修改
├── xray-config.json.example    # xray 配置模板（已 .gitignore 排除 xray-config.json）
└── README.md
```

## 部署步骤

1. **准备 `.env`**

   ```bash
   cd services/checkout-converter/deploy/compose
   cp .env.example .env
   # 修改 CHECKOUT_CONVERTER_API_KEY 等
   ```

2. **填写 xray-config.json**

   ```bash
   cp xray-config.json.example xray-config.json
   # 编辑 xray-config.json，把 node-* outbound 替换成真实节点
   ```

   把 `node-1 / node-2 / node-3` outbound 替换成真实节点（vmess/vless/trojan/ss 等，按需增删）。
   `routing.balancers[0].strategy.type` 可在 `roundRobin / random / leastPing` 间切换。
   `selector: ["node-"]` 表示所有 tag 以 `node-` 开头的 outbound 都加入负载池。
   `xray-config.json` 已被 `.gitignore` 排除，不会被提交。

3. **启动**

   ```bash
   docker compose up -d --build
   ```

   首次启动会构建 `checkout-converter` 镜像。xray 用上游 `teddysun/xray:latest` 镜像；如果想锁版本，把 `image:` 改为具体 tag。

4. **检查健康**

   ```bash
   curl http://127.0.0.1:18080/healthz
   ```

   预期返回 `ok: true`，并包含 `proxyConfigured: true`、`proxyReachable: true`（应用会对 `OPENAI_PROXY_URL` 做一次 TCP 连通性探测）。当 xray sidecar 挂掉时，应用 `/healthz` 会返回 HTTP 503，方便上游反向代理 / 编排器（Nginx/Traefik/Swarm/K8s 等）感知并摘流。注意：纯 `docker compose` + `ports` 本身**不会**因容器 unhealthy 自动停止转发宿主端口流量，只会更新 health 状态，需要前置一层健康感知入口才能真正摘流。

5. **轮换节点 / 升级 xray**

   ```bash
   docker compose restart xray         # 重新加载 xray-config.json
   docker compose pull xray            # 升级 xray 镜像
   docker compose up -d xray
   ```

   重启 xray 期间应用 `/healthz` 会返回 503，前置的健康感知入口（Nginx/Traefik/Swarm/K8s）可据此摘流，恢复后自动回流。纯 `docker compose` + `ports` 不会自动摘流。

## 关键约束

- 应用容器通过 `OPENAI_PROXY_URL=http://xray:7891` 出网；应用自身不再管理 xray 子进程。
- xray 容器内 inbound 必须 `listen=0.0.0.0`（本目录的 `xray-config.json` 已按此模板写好），否则同 compose 网络内的应用容器连不到。
- xray 容器除 compose 内部网络外不暴露端口；如需调试可临时加 `ports: ["127.0.0.1:7891:7891"]`。
- 应用容器要多 worker，修改 `Dockerfile` 的 `CMD`（`-w N`）或在 compose 中用 `command:` 覆写。

## 横向扩容

要再起一组 checkout-converter 共用同一 xray，把第二组应用容器加进 compose 即可：

```yaml
  checkout-converter-2:
    <<: *checkout-converter-base   # 复用 anchors，或直接复制配置
    container_name: checkout-converter-2
    ports:
      - "18081:8080"
```

或者直接 `docker compose up -d --scale checkout-converter=3`（需要移除 `container_name` 以允许多副本）。
