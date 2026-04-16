# Docker Stack Template

Template triển khai nhanh S3 Proxy (`services/s3proxy`) kèm đầy đủ lớp truy cập và vận hành:

- **Core**: Caddy + Cloudflare Tunnel.
- **Ops**: Dozzle, Filebrowser, WebSSH (có thể truy cập qua domain hoặc Tailscale hostname:port).
- **Access**: Tailscale + Keep-IP workflow.

Tài liệu chính đã được chuẩn hoá theo codebase hiện tại:

- Hướng dẫn triển khai tổng quát: `deploy.md`
- Hướng dẫn thay thế app/service mới: `deploy.new.md`
- Tài liệu chi tiết từng dịch vụ (mỗi dịch vụ 1 file): thư mục `docs/services/`
- Tài liệu luồng Public Bucket direct-link cho S3Proxy: `services/s3proxy/README.public-buckets.md`
- One-file handoff cho coding agent khi thay app: `AGENT_APP_SWAP.md`
- Sync embedded files into agent handoff: `npm run agent-app-swap:sync`

## Cấu trúc compose

- `docker-compose/compose.core.yml`
- `docker-compose/compose.ops.yml`
- `docker-compose/compose.access.yml`
- `compose.apps.yml`

Script điều phối chính:

- `docker-compose/scripts/dc.sh` (tự bật profile theo `ENABLE_*`)
- `docker-compose/scripts/validate-env.js` (validate env trước deploy)

## Lệnh thường dùng

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:all
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs
npm run dockerapp-exec:down
npm run s3proxy:test
```

## Tiện ích clone template cho dịch vụ mới

Đã thêm script NodeJS:

```bash
node scripts/clone-stack.js --output /path/deployments --name my-new-service
```

Hoặc chạy interactive:

```bash
node scripts/clone-stack.js
```


> Cloned from H:\nodejs-tester\docker-stack-template at 2026-04-13T06:10:22.707Z
