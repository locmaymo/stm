# SillyTavern Manager

[Xem hướng dẫn bằng tiếng Anh](README.md)

SillyTavern Manager là bảng điều khiển đa nền tảng để cài đặt, chạy, mở truy cập, sao lưu và theo dõi [SillyTavern](https://github.com/SillyTavern/SillyTavern). Manager chạy ở cổng <code>7860</code>, còn SillyTavern chạy ở cổng <code>8000</code> và chỉ máy này mới vào được. Thiết bị khác trong mạng, hoặc Cloudflare Tunnel, vào SillyTavern qua cổng truy cập <code>8001</code> của manager, và cổng đó hỏi một mật khẩu trước. Tunnel không bao giờ công khai bảng quản trị.

## Chọn nền tảng

| Nền tảng | Bắt đầu tại đây |
| --- | --- | --- |
| Windows | [Tải ZIP portable](#windows-tải-và-chạy) |
| Android / Termux | [Copy các lệnh Termux](#android-cài-termux-bằng-copy-paste) |
| macOS | [Cài từ source](#macos-cài-từ-source) |
| Linux / VPS | [Chạy launcher Unix](#linux-và-vps) |
| Docker / studio cloud | [Deploy Docker image](#docker-và-vps) |

Lần đầu mở, bạn tạo một mật khẩu quản trị manager. Sau đó chọn phiên bản SillyTavern và bấm **Cài đặt**. Manager chỉ báo **Ready** sau khi SillyTavern thực sự lắng nghe ở cổng <code>8000</code>.

## Windows: tải và chạy

Đây là cách dễ nhất cho hầu hết người dùng Windows.

1. Mở [GitHub Release mới nhất](https://github.com/locmaymo/stm/releases/latest).
2. Tải <code>SillyTavernManager-windows-x64-vX.Y.Z.zip</code> cùng file checksum <code>.sha256</code>.
3. Giải nén ZIP vào thư mục bình thường, ví dụ <code>Downloads\SillyTavernManager</code>.
4. Bấm đúp <code>SillyTavernManager.exe</code>.
5. Nếu trình duyệt không tự mở, truy cập <code>http://127.0.0.1:7860</code>.

Một cửa sổ console sẽ mở ra và ở nguyên đó. Cửa sổ đó chính là trình quản lý: nó hiển thị địa chỉ truy cập, nơi lưu dữ liệu của bạn, và mọi việc trình quản lý cùng SillyTavern đang làm. Để dừng tất cả, bấm <kbd>Q</kbd> hoặc <kbd>Ctrl</kbd>+<kbd>C</kbd> trong cửa sổ đó, hoặc đóng nó. SillyTavern và Cloudflare tunnel sẽ được tắt cùng, nên không còn cổng nào bị chiếm và bạn không phải đi tìm tiến trình trong Task Manager. Bấm <kbd>O</kbd> để mở lại console trong trình duyệt.

Nếu trình quản lý không khởi động được, cửa sổ sẽ giữ nguyên lý do trên màn hình và chờ bạn bấm <kbd>Enter</kbd> thay vì tự đóng. Nếu bạn mở bản thứ hai trong khi một bản đang chạy, nó sẽ báo cho bạn biết và mở bản đang chạy.

ZIP portable đã gồm Node.js, server manager, giao diện và dependency production. Bạn không cần cài gì bằng terminal. Thư mục ứng dụng và thư mục dữ liệu được tách riêng:

~~~text
%LOCALAPPDATA%\SillyTavernManager
~~~

Thư mục dữ liệu chứa profile, backup, log, metrics và telemetry outbox. Thay ZIP ứng dụng không xóa thư mục này. Bản phát hành Windows có checksum để bạn kiểm tra file trước khi giải nén.

## Android: cài Termux bằng copy-paste

Cài [Termux từ F-Droid](https://f-droid.org/packages/com.termux/) hoặc nguồn đáng tin cậy khác. Không dùng bản Termux cũ trên Play Store. Mở Termux và dán từng khối lệnh sau:

~~~bash
pkg update -y
pkg upgrade -y
pkg install -y git nodejs-lts
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
npm start
~~~

Giữ phiên Termux này chạy trong lúc dùng SillyTavern. Mở manager trên điện thoại tại <code>http://127.0.0.1:7860</code>; SillyTavern ở <code>http://127.0.0.1:8000</code>. Khi cần dùng iPhone hoặc mạng khác truy cập, bạn có thể tạo public tunnel trong manager.

Lần sau khởi động lại:

~~~bash
cd "$HOME/stm"
npm start
~~~

Cập nhật sau khi đã dừng manager:

~~~bash
cd "$HOME/stm"
git pull --ff-only
npm ci
npm start
~~~

Dữ liệu Termux nằm ngoài repository tại:

~~~text
$PREFIX/var/sillytavern-manager
~~~

Thư mục này vẫn còn sau <code>git pull</code> và cập nhật ứng dụng. Cloudflared là tùy chọn; truy cập local vẫn hoạt động khi tunnel chưa cài hoặc đang offline. Bật tunnel trên Termux không cần cài gì bằng tay: Android chỉ chạy tệp thực thi độc lập vị trí còn bản của Cloudflare thì không, nên trình quản lý xin bản cloudflared của Termux, nếu không được thì chạy bản của Cloudflare qua `proot`, và tự cài thứ mà nó cần.

## macOS: cài từ source

macOS hiện dùng launcher Node.js giống Linux. Cài Homebrew và Node.js 22 trở lên, sau đó copy các lệnh này vào Terminal:

~~~bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install git node
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs
~~~

Mở <code>http://127.0.0.1:7860</code>. SillyTavern vẫn ở <code>http://127.0.0.1:8000</code>. Dừng bằng <code>Ctrl+C</code>. Lần sau chạy lại:

~~~bash
cd "$HOME/stm"
node deploy/linux/launcher.mjs
~~~

Launcher source trên macOS hiện lưu dữ liệu tại <code>~/.local/share/sillytavern-manager</code>. Đây là cùng một codebase với bản Windows, Termux, Linux, Docker và các nền tảng cloud.

## Linux và VPS

Cài Node.js 22 trở lên rồi chạy:

~~~bash
git clone https://github.com/locmaymo/stm.git
cd stm
npm ci
node deploy/linux/launcher.mjs
~~~

Linux lưu dữ liệu tại <code>$XDG_DATA_HOME/sillytavern-manager</code> hoặc <code>~/.local/share/sillytavern-manager</code>. Hãy đặt cổng <code>7860</code> sau firewall hoặc access control của VPS; dùng tunnel đã cấu hình để mở SillyTavern thay vì public manager.

## Docker và VPS

Clone repository rồi build image:

~~~bash
git clone https://github.com/locmaymo/stm.git
cd stm
docker build -f deploy/docker/Dockerfile -t sillytavern-manager .
~~~

Chạy với volume persistent:

~~~bash
docker run --rm \
  -p 7860:7860 \
  -v sillytavern-manager-data:/data \
  -e STM_ADMIN_PASSWORD='chon-mat-khau-dai' \
  sillytavern-manager
~~~

Mở manager tại <code>http://127.0.0.1:7860</code>. SillyTavern vẫn chạy ở cổng nội bộ <code>8000</code>; tunnel chỉ trỏ tới cổng đó.

Trên nền tảng cloud có container, mở cổng <code>7860</code>, đặt <code>STM_ADMIN_PASSWORD</code> bằng phần secret của nền tảng và mount lưu trữ persistent tại <code>/data</code>. Không đưa mật khẩu vào Dockerfile hoặc Git.

## npm (người dùng kỹ thuật)

Máy có Node.js 22 trở lên có thể dùng package đã publish khi package sẵn sàng:

~~~bash
npx sillytavern-manager
~~~

Hoặc cài global:

~~~bash
npm install --global sillytavern-manager
sillytavern-manager
~~~

Người dùng Windows nên chọn ZIP portable vì ZIP đã có Node.js. Package và launcher source dùng cùng cổng và quy tắc thư mục dữ liệu.

## Thiết lập lần đầu

1. Mở manager ở cổng <code>7860</code>.
2. Tạo mật khẩu quản trị manager.
3. Chọn phiên bản SillyTavern; mặc định là <code>latest</code>.
4. Bấm **Cài đặt** và chờ **Ready**. Ready nghĩa là SillyTavern đã trả lời ở cổng <code>8000</code>.
5. Mở link local, hoặc bật truy cập mạng nội bộ / public tunnel trong thẻ truy cập.
6. Đặt mật khẩu SillyTavern trước khi bật LAN hoặc public tunnel.

Mật khẩu manager và mật khẩu SillyTavern là hai mật khẩu khác nhau. Mật khẩu SillyTavern được hỏi ở trang đăng nhập do chính manager phục vụ, nên nó hoạt động giống nhau trên mọi phiên bản SillyTavern, cũ hay mới; đổi mật khẩu sẽ đăng xuất mọi thiết bị đang ở trong. Public tunnel không chuyển tiếp bảng quản trị manager.

## Sao lưu và khôi phục

Backup local luôn hoạt động. Archive là ZIP streaming tương thích với export của SillyTavern. Mặc định loại <code>secrets.json</code>, thumbnail, vector, backup sinh tự động, <code>.git</code>, <code>node_modules</code> và metadata hệ điều hành. Đưa secrets vào backup là thao tác explicit kèm cảnh báo.

Restore cho xem trước trước khi ghi. Replace là chế độ mặc định, merge là tùy chọn. Manager tạo safety snapshot trước khi replace hoặc chuyển profile. Cloudflare R2 được khuyến nghị để bảo vệ dữ liệu khi hỏng ổ đĩa, mất máy hoặc workspace cloud bị xóa.

## Telemetry và quyền riêng tư

Telemetry là một phần của dự án miễn phí này. Manager chỉ gửi summary trong allowlist như nền tảng, phiên bản ứng dụng, provider, model, hostname endpoint, streaming, max tokens, input/output/total tokens, cache, reasoning token, status và duration.

Không gửi API key, authorization header, prompt, chat, model response, request body, response body, request log, tên file, đường dẫn file, IP hoặc query string. Event được ghi vào outbox local trước rồi gửi bất đồng bộ; server nhận bị lỗi không chặn SillyTavern.

## Cập nhật

Khi có bản manager mới, dừng bản cũ, giải nén ZIP Windows mới vào thư mục khác rồi chạy executable mới. Trên Termux, macOS hoặc Linux, dừng process, chạy <code>git pull --ff-only</code>, chạy <code>npm ci</code> rồi khởi động launcher. Thư mục dữ liệu nền tảng được giữ nguyên nên profile, backup, log, metrics và settings vẫn còn. Giữ thư mục Windows cũ để rollback.

Release được tạo từ version tag. GitHub Actions chạy kiểm tra, tạo ZIP Windows và checksum, build Docker image và tạo npm tarball.

## Phát triển

Yêu cầu: Node.js 22+, npm 11+ và PowerShell 7+ khi đóng gói Windows.

~~~bash
npm ci
npm run panel:dev
npm run manager:start
~~~

Chạy kiểm tra trước khi tạo pull request:

~~~bash
npm run verify
~~~

Build artifact Windows trên máy local:

~~~powershell
pwsh packaging/windows/package-release.ps1
npm run release:npm
~~~

## License

Xem license của repository và [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) để biết các thông báo license của UI component được sử dụng.
