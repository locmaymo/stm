# SillyTavern Manager

[English](README.md)

SillyTavern Manager là bảng điều khiển đa nền tảng giúp cài đặt, chạy, mở truy cập, sao lưu và theo dõi [SillyTavern](https://github.com/SillyTavern/SillyTavern) mà không cần dùng terminal sau khi cài đặt.

Manager chạy ở cổng `7860`. SillyTavern chạy ở cổng `8000`. Cloudflare Tunnel, nếu bật, chỉ trỏ tới SillyTavern và không công khai bảng quản trị.

## Tính năng

- Cài bản SillyTavern mới nhất hoặc chọn release, `release`, `staging`.
- Chuyển phiên bản bằng một Git checkout dùng chung để tránh lưu nhiều runtime trùng lặp.
- Có profile dữ liệu mặc định và cho phép tạo thêm profile.
- Hỗ trợ chuẩn mới `data/` và runtime cũ dùng `public/`.
- Start, stop, restart và theo dõi SillyTavern trong trình duyệt.
- Xem log realtime có giới hạn, tìm kiếm và lọc.
- Sao lưu ZIP local, xem trước và restore theo chế độ replace hoặc merge, cùng tùy chọn Cloudflare R2.
- Bật truy cập mạng nội bộ hoặc tunnel công khai qua hệ thống tài khoản SillyTavern.
- Theo dõi request, provider, model, latency, streaming, input/output, cache và reasoning token.
- Chạy trên Windows, Linux/VPS, Termux, Docker và các nền tảng cloud.

## Windows: tải và chạy

Tải ZIP từ GitHub Releases, giải nén và bấm `SillyTavernManager.exe`. Không cần cài Node.js riêng. Trang quản trị mở tại:

```text
http://127.0.0.1:7860
```

Lần đầu truy cập, hãy tạo mật khẩu quản trị. Dữ liệu manager được lưu tại:

```text
%LOCALAPPDATA%\SillyTavernManager
```

Thư mục này chứa state, profile, backup, log, metrics và telemetry outbox. Nó tách khỏi thư mục ứng dụng, nên cập nhật bundle không xóa dữ liệu.

## Docker và VPS

Build image:

```bash
docker build -f deploy/docker/Dockerfile -t sillytavern-manager .
```

Chạy với volume persistent:

```bash
docker run --rm \
  -p 7860:7860 \
  -v sillytavern-manager-data:/data \
  -e STM_ADMIN_PASSWORD='chon-mat-khau-dai' \
  sillytavern-manager
```

Mở manager tại `http://127.0.0.1:7860`. SillyTavern vẫn chạy ở cổng nội bộ `8000`.

Trên nền tảng container cloud, deploy `deploy/docker/Dockerfile`, mở cổng `7860`, đặt `STM_ADMIN_PASSWORD` bằng Studio secret và giữ dữ liệu persistent tại `/mnt/workspace`. Không đưa mật khẩu vào Dockerfile hoặc Git.

## Linux và Termux

Linux cần Node.js 22+:

```bash
npm ci
node deploy/linux/launcher.mjs
```

Termux:

```bash
npm ci
node deploy/termux/launcher.mjs
```

Linux lưu dữ liệu tại `$XDG_DATA_HOME/sillytavern-manager` hoặc `~/.local/share/sillytavern-manager`. Termux lưu tại `$PREFIX/var/sillytavern-manager`.

## npm cho người dùng kỹ thuật

Máy đã có Node.js 22+ có thể chạy:

```bash
npx sillytavern-manager
```

Hoặc:

```bash
npm install --global sillytavern-manager
sillytavern-manager
```

Người dùng Windows nên dùng ZIP portable vì ZIP đã có sẵn Node.js.

## Thiết lập lần đầu

1. Mở manager ở cổng `7860`.
2. Đặt mật khẩu quản trị manager.
3. Chọn phiên bản SillyTavern; mặc định là `latest`.
4. Bấm **Cài đặt** và chờ trạng thái **Ready**, đồng thời SillyTavern phải trả lời ở cổng `8000`.
5. Mở link local hoặc bật mạng nội bộ/tunnel trong thẻ truy cập.
6. Đặt mật khẩu tài khoản SillyTavern trước khi bật LAN hoặc tunnel công khai.

Mật khẩu manager và mật khẩu tài khoản SillyTavern là hai mật khẩu khác nhau. Tunnel công khai không bao giờ chuyển tiếp bảng quản trị manager.

## Sao lưu và khôi phục

Sao lưu local luôn hoạt động. Archive là ZIP streaming tương thích với export của SillyTavern. Mặc định loại `secrets.json`, thumbnail, vector, backup sinh tự động, `.git`, `node_modules` và metadata hệ điều hành. Việc đưa secrets vào backup phải được bật rõ ràng.

Restore cho xem trước trước khi ghi dữ liệu. Replace là mặc định, merge là tùy chọn. Manager tạo safety snapshot trước khi replace hoặc chuyển profile. Cloudflare R2 được khuyến nghị để tránh mất dữ liệu khi hỏng ổ đĩa, mất máy hoặc workspace cloud bị xóa.

## Telemetry và quyền riêng tư

Telemetry là một phần của dự án miễn phí này. Manager chỉ gửi thông tin tổng hợp như nền tảng, phiên bản, provider, model, hostname endpoint, streaming, token, cache, reasoning token, status và duration.

Không gửi API key, authorization header, prompt, chat, model response, request body, response body, request log, tên file, đường dẫn, IP hoặc query string. Event được ghi vào outbox local trước và gửi bất đồng bộ; server nhận lỗi không làm SillyTavern bị chặn.

## Cập nhật

Khi có bản manager mới, đóng bản cũ, giải nén ZIP mới vào thư mục khác và chạy executable mới. Dữ liệu tại `%LOCALAPPDATA%\SillyTavernManager` không bị đụng tới. Thư mục cũ vẫn có thể dùng để rollback.

## Phát triển

Yêu cầu: Node.js 22+, npm 11+, PowerShell 7+ khi build Windows.

```bash
npm ci
npm run panel:dev
npm run manager:start
npm run verify
```

Build artifact Windows:

```powershell
pwsh packaging/windows/package-release.ps1
npm run release:npm
```

## License

Xem `THIRD_PARTY_NOTICES.md` để biết thông báo license của các UI component được sử dụng.
