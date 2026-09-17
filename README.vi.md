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

### Hạ tầng chỉ mở một cổng, và hạ tầng không giữ dữ liệu

Một số nền tảng chỉ định tuyến đúng một cổng ra ngoài và báo cổng đó qua biến <code>PORT</code>. Trình quản lý sẽ tự lắng nghe ở đó, nên một repo vừa import vào nền tảng kiểu này chạy được ngay từ lần đầu mà không phải cấu hình gì. Còn cổng mà trình quản lý chỉ *ưu tiên* &mdash; <code>7860</code> của chính nó, <code>8001</code> của cổng truy cập, <code>8000</code> của SillyTavern &mdash; nếu đã bị thứ khác trên máy chiếm thì nó tự nhường sang cổng trống kế tiếp và ghi lại số cổng mới vào log. Muốn cố định thì đặt <code>STM_PORT</code> hoặc <code>STM_ACCESS_PORT</code>.

Một số nền tảng còn cấp cho container một hệ thống tệp sinh ra cùng máy và bị xóa cùng máy, và tắt máy sau một khoảng không dùng. Trình quản lý kiểm tra xem thư mục dữ liệu thực sự nằm trên loại ổ nào, rồi báo trong log và trên trang dữ liệu: máy này không giữ dữ liệu của bạn, hãy kết nối Cloudflare R2.

Cảnh báo đó có lối thoát. Hãy đặt bốn giá trị <code>STM_R2_*</code> vào <code>.env</code> hoặc vào phần biến môi trường của nền tảng, để chúng quay lại cùng bản checkout chứ không mất theo ổ đĩa bị xóa. Khi đó, lúc khởi động trình quản lý sẽ nhận ra hồ sơ đang trống còn bucket thì không, và mang bản khôi phục mới nhất về trước khi SillyTavern chạy. Hồ sơ đã có dữ liệu thì không bao giờ bị ghi đè.

Ở nơi mạng không cho UDP đi ra, cloudflared không tới được biên của Cloudflare qua QUIC và đường hầm cứ đứng ở &ldquo;Registering tunnel&rdquo; cho tới khi link báo lỗi. Trình quản lý nhận ra điều đó &mdash; qua dòng lỗi, hoặc qua sự im lặng &mdash; rồi quay lại bằng HTTP/2 và ghi nhớ, nên chỉ phải chờ một lần. Đặt <code>STM_TUNNEL_PROTOCOL=http2</code> để bỏ qua bước dò.

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

### Cloudflare R2

Ở trang **Data**, chỉ cần bấm **Kết nối Cloudflare**. Đăng nhập Cloudflare, chọn tài khoản, cho phép các quyền, manager sẽ tìm hoặc tạo bucket tên <code>sillytavern-manager-backup</code> trong tài khoản đó và bắt đầu sao lưu. Không cần tạo hay dán khoá nào.

- **Cho phép Workers** (tuỳ chọn, nên bật). Manager deploy một Worker nhỏ, cũng tên <code>sillytavern-manager-backup</code>, để chuyển dữ liệu sao lưu vào bucket. Cách này nhanh và không tốn giới hạn gọi API Cloudflare của bạn. Nếu không cho phép, sao lưu đi qua API của Cloudflare, chậm hơn, và lần sao lưu đầu có thể mất nhiều thời gian.
- **Cho phép Account Analytics** (tuỳ chọn). Panel sẽ hiện dung lượng và số lệnh Class A/B theo số liệu của Cloudflare, cho bucket sao lưu và cho cả tài khoản so với gói miễn phí. Đây là số liệu sử dụng, không phải hoá đơn.
- **Máy mới** kết nối cùng tài khoản sẽ thấy lại đúng bucket đó; các điểm khôi phục có sẵn trong bucket có thể lấy về và khôi phục.
- **Ngắt kết nối** xoá khoá Worker của bản cài này và thu hồi quyền đăng nhập. Bucket và các điểm khôi phục vẫn nằm trong tài khoản của bạn. Bạn cũng có thể thu hồi quyền bất cứ lúc nào trong mục **Manage OAuth authorizations** ở hồ sơ Cloudflare.

Chỉ refresh token của Cloudflare được lưu, trong một file riêng mà chỉ user của bạn đọc được. Khoá Worker chỉ nằm trong bộ nhớ, đổi mỗi ngày, và mỗi bản cài có khoá riêng.

**Dùng khoá S3.** Nếu không muốn đăng nhập, chọn **Khoá S3 (thủ công)** và nhập endpoint, bucket, cặp khoá lấy từ trang R2 trong bảng điều khiển Cloudflare, hoặc đặt trong <code>.env</code> (xem <code>.env.example</code>). Mọi storage tương thích S3 đều dùng được theo cách này.

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

Copyright (C) 2026 Phạm Quang Lộc

SillyTavern Manager là phần mềm tự do: bạn có thể phân phối lại và/hoặc sửa đổi theo các điều khoản của [GNU Affero General Public License phiên bản 3](LICENSE) (AGPL-3.0-only) do Free Software Foundation công bố.

License này áp dụng cho mọi phiên bản của dự án, bao gồm tất cả commit và bản phát hành được công bố trước khi thêm file `LICENSE`, chẳng hạn v0.1.0.

Mã nguồn của bên thứ ba giữ license riêng; xem [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Logo SillyTavern Vietnam (STVN) và các logo của bên thứ ba được mô tả ở đó không thuộc phạm vi AGPL-3.0.
