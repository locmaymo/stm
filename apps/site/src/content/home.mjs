import { RELEASES, UPSTREAM } from './strings.mjs';

/**
 * The landing page, said twice.
 *
 * Both languages carry the same shape - same sections, same number of cards,
 * same order - so the page can be rendered from one template and a reader who
 * switches language lands on the same place in the page rather than somewhere
 * else entirely. The build checks that shape before it writes anything.
 *
 * Written for somebody who has heard of SillyTavern and has never opened a
 * terminal. What the manager does is said as what it does for them - a chat
 * that survives a lost phone, a link that opens on any device - and the ports,
 * tunnels and buckets behind it are left to the documentation. The features
 * are in the order people value them, and each one is shown, not described.
 */

export const home = {
  en: {
    title: 'SillyTavern, safe and everywhere',
    description: 'Install, run, update and back up SillyTavern from one simple page. Your chats are saved to your own cloud all the time, and SillyTavern opens on any device you have. Free forever.',
    hero: {
      badge: 'Free forever · open source',
      heading: 'Your SillyTavern, safe and everywhere',
      lede: `Install, run, update and back up [SillyTavern](${UPSTREAM}) from one simple page — no commands to remember. Your chats are copied to your own cloud all the time, and SillyTavern opens on your phone, tablet or laptop, wherever you are.`,
      primary: { href: RELEASES, label: 'Download for Windows', icon: 'download' },
      secondary: { href: '/#install', label: 'Android, Mac and Linux', icon: 'phone' },
      meta: [
        { icon: 'gift', label: 'Free forever, no limits' },
        { icon: 'lock', label: 'Your data stays yours' },
        { icon: 'languages', label: 'English and Tiếng Việt' },
      ],
      shot: 'overview',
      shotAlt: 'The manager overview page: SillyTavern running, its online link, backups, the computer’s usage and live logs',
    },
    features: {
      eyebrow: 'What it does for you',
      heading: 'Everything SillyTavern needs, in a few clicks',
      lede: 'No terminal, no long commands copied from a forum, no folders to find. Here is what that looks like.',
      rows: [
        {
          icon: 'cloud',
          badge: 'Most loved',
          label: 'Cloud backup',
          title: 'Never lose a chat again',
          body: 'Sign in to Cloudflare once, and your chats, characters and settings are copied to free cloud storage in your own account — every few minutes, by themselves. If your computer breaks, your phone is lost, or you delete something by mistake, sign in again on any device and everything comes back.',
          points: [
            'Backs up on its own, every few minutes',
            'Free with Cloudflare R2’s free plan',
            'One sign-in on a new device brings it all back',
          ],
          shot: 'f-cloud',
          narrow: 'f-signin-mobile',
          alt: 'The cloud backup card: backing up automatically every 5 minutes, the last copy sent a minute ago, and a list of recovery points to bring back',
        },
        {
          icon: 'globe',
          label: 'Online link',
          title: 'Your SillyTavern, on every device',
          body: 'Switch on one link and SillyTavern opens on your phone, tablet or another computer — at home or anywhere else. Scan the QR code to open it on your phone in a second. Your own PIN keeps everybody else out.',
          points: [
            'A link that stays the same, so bookmarks keep working',
            'Scan a QR code instead of typing an address',
            'Locked with a PIN only you know',
          ],
          shot: 'f-link',
          narrow: 'f-link-mobile',
          alt: 'The Open SillyTavern menu: open it with tools, or scan the QR code to open SillyTavern on your phone',
        },
        {
          icon: 'download',
          label: 'Install and versions',
          title: 'Any SillyTavern version, one click',
          body: 'Pick the SillyTavern version you like from the list and press Install. The manager downloads it from SillyTavern’s official GitHub and sets it up for you. Want to try a newer one, or go back to the one you liked? Same list, same button — your chats are copied somewhere safe first.',
          points: [
            'Start and stop SillyTavern with a button',
            'Switch versions without reinstalling anything',
            'Always the official release, straight from GitHub',
          ],
          shot: 'f-versions',
          narrow: 'f-versions-mobile',
          alt: 'The version list open on the overview: the latest release, the release and staging branches, and every earlier version',
        },
        {
          icon: 'bell',
          label: 'Updates',
          title: 'New releases, the moment they are out',
          body: 'When SillyTavern publishes a new version, a notice appears right on your overview. Press Install it and you are up to date. Not ready yet? Not now hides it until the next one.',
          points: [
            'Told on the page, no need to watch GitHub',
            'One click to update',
            'Your data is copied to safety before switching',
          ],
          shot: 'f-update',
          narrow: 'f-update-mobile',
          alt: 'A notice on the overview: SillyTavern 1.19.0 is out, with Install it and Not now buttons',
        },
        {
          icon: 'upload',
          label: 'Restore',
          title: 'Bring back a backup with one button',
          body: 'Moving from an old SillyTavern? Upload the ZIP you downloaded from it, or a backup from another SillyTavern Manager. No extra apps, no unzipping, no hunting for the right folder. The manager shows what is inside, takes a copy of what you have now, then puts it all back.',
          points: [
            'Works with SillyTavern’s own backup ZIP',
            'See what is inside before anything changes',
            'A safety copy is taken first, so you can undo',
          ],
          shot: 'f-restore',
          narrow: 'f-restore-mobile',
          alt: 'The restore window for an uploaded ZIP: 1604 files, replace or merge, and a note that a copy is taken first',
        },
        {
          icon: 'window',
          label: 'Open with tools',
          title: 'SillyTavern, with a toolbox beside it',
          body: 'Open SillyTavern with tools and a small button floats at the edge of the page. Back up to your computer or to the cloud without leaving your chat, read what is happening in the live logs, reload SillyTavern or go full screen. No terminal window needed.',
          points: [
            'Back up in the middle of a chat',
            'Live logs whenever something looks wrong',
            'Works on a phone as well as a computer',
          ],
          shot: 'f-tools',
          narrow: 'f-tools-mobile',
          alt: 'SillyTavern in a tab with the manager’s tools: a chat with Seraphina and the tools menu with backups, logs and reload',
        },
        {
          icon: 'box',
          label: 'Saver mode',
          title: 'Little space? It still fits',
          body: 'On a phone or a small server that is nearly full, Saver mode keeps your backups in the cloud instead of on the device. When a backup is too big to bring back, it offers to leave out what SillyTavern does not need — old extension downloads, thumbnails, SillyTavern’s own backup copies — and every chat, character and setting still comes back.',
          points: [
            'Turns itself on when space is short',
            'Leaves out files SillyTavern can do without',
            'Refuses a restore that would not fit, instead of failing halfway',
          ],
          shot: 'f-saver',
          narrow: 'f-saver-mobile',
          alt: 'A restore in saver mode: 7442 files and 1.7 GB reduced to 1606 files and 823 MB by leaving out what SillyTavern can do without',
        },
      ],
    },
    trust: {
      eyebrow: 'Free and private',
      heading: 'Free forever, and your data stays yours',
      lede: 'SillyTavern Manager is free, open-source software. There is no account to create and nothing to pay for.',
      cards: [
        { icon: 'gift', title: 'Free for life', body: 'No subscription, no trial, no limits. The source code is public under the AGPL-3.0 licence, so anyone can check what it does.' },
        { icon: 'github', title: 'The official SillyTavern', body: 'SillyTavern is always downloaded from its official GitHub repository, and its files are never changed.' },
        { icon: 'lock', title: 'Only you hold your data', body: 'Chats and characters stay on your device and in your own Cloudflare account. This project has no server that stores them and never sees them.' },
        { icon: 'shield', title: 'Locked with your passwords', body: 'The manager opens with your password and SillyTavern with your PIN. Too many wrong guesses and the door locks itself.' },
      ],
      note: 'The manager sends the project a small, anonymous usage summary — never your chats, prompts, characters or keys. The [Privacy Notice](/privacy) lists every field and shows how to switch it off.',
    },
    install: {
      eyebrow: 'Get started',
      heading: 'Pick your device',
      lede: 'Every way ends at the same place: a page in your browser that asks you to choose a password. Then pick a SillyTavern version and press Install.',
      cards: [
        { icon: 'monitor', title: 'Windows', body: 'Download the ZIP, unzip it and double-click SillyTavernManager.exe. Nothing else to install.', href: '/docs#windows', go: 'Windows guide' },
        { icon: 'phone', title: 'Android', body: 'Install Termux, paste the commands from the guide, and open the manager in your phone’s browser.', href: '/docs#android', go: 'Android guide' },
        { icon: 'apple', title: 'Mac', body: 'Paste a few lines into Terminal once. Works on Apple Silicon and Intel Macs.', href: '/docs#macos', go: 'Mac guide' },
        { icon: 'server', title: 'Linux and servers', body: 'One command starts it, and it can start by itself after a reboot.', href: '/docs#linux', go: 'Linux guide' },
        { icon: 'box', title: 'Docker', body: 'Run the ready-made image and keep your data in a volume.', href: '/docs#docker', go: 'Docker guide' },
        { icon: 'npm', title: 'npm', body: 'Already have Node.js? One command: npx sillytavern-manager.', href: '/docs#npm', go: 'npm guide' },
      ],
    },
    more: {
      eyebrow: 'And also',
      heading: 'The little things that add up',
      cards: [
        { icon: 'chart', title: 'See your usage', body: 'Messages, tokens and response times per day, per provider and per model.' },
        { icon: 'layers', title: 'Separate profiles', body: 'Keep different sets of characters and chats apart, and switch between them in a click.' },
        { icon: 'refresh', title: 'Stays awake', body: 'Keeps the manager running where a battery saver or an idle timer would shut it down.' },
        { icon: 'languages', title: 'Your language, your look', body: 'English and Vietnamese, light and dark, on a computer or with one thumb on a phone.' },
      ],
    },
    screens: {
      eyebrow: 'Take a look',
      heading: 'The whole panel, on any screen',
      lede: 'The same interface on a computer and on a phone, in light and dark, in English and Vietnamese.',
      shots: [
        { name: 'data', title: 'Data', body: 'Backups on your device and in the cloud, on one page.', alt: 'The data page: backups on this machine and Cloudflare R2 recovery points' },
        { name: 'metrics', title: 'Metrics', body: 'How much you chat, per day, provider and model.', alt: 'The usage page: requests, tokens, cache hits and latency per day, provider and model' },
        { name: 'settings', title: 'Settings', body: 'Passwords, and SillyTavern’s settings as simple switches.', alt: 'The settings page: security, performance, extensions, API keys and chat backups' },
      ],
    },
    cta: {
      heading: 'Set it up in a few minutes',
      lede: 'Nothing to sign up for and nothing to pay. Download it, choose a password, press Install.',
      primary: { href: RELEASES, label: 'Download the latest release', icon: 'download' },
      secondary: { href: '/docs', label: 'Read the step-by-step guide', icon: 'book' },
    },
  },
  vi: {
    title: 'SillyTavern an toàn, dùng ở mọi nơi',
    description: 'Cài đặt, chạy, cập nhật và sao lưu SillyTavern trên một trang web đơn giản. Chat của bạn được lưu liên tục lên cloud của riêng bạn, và SillyTavern mở được trên mọi thiết bị của bạn. Miễn phí trọn đời.',
    hero: {
      badge: 'Miễn phí trọn đời · mã nguồn mở',
      heading: 'SillyTavern của bạn, an toàn và ở mọi nơi',
      lede: `Cài đặt, chạy, cập nhật và sao lưu [SillyTavern](${UPSTREAM}) ngay trên một trang web đơn giản — không cần nhớ câu lệnh nào. Chat của bạn được chép lên cloud của riêng bạn liên tục, và SillyTavern mở được trên điện thoại, máy tính bảng hay laptop, ở bất cứ đâu.`,
      primary: { href: RELEASES, label: 'Tải cho Windows', icon: 'download' },
      secondary: { href: '/#install', label: 'Android, Mac và Linux', icon: 'phone' },
      meta: [
        { icon: 'gift', label: 'Miễn phí trọn đời, không giới hạn' },
        { icon: 'lock', label: 'Dữ liệu là của bạn' },
        { icon: 'languages', label: 'Tiếng Việt và English' },
      ],
      shot: 'overview',
      shotAlt: 'Trang tổng quan của trình quản lý: SillyTavern đang chạy, link online, sao lưu, tài nguyên máy và nhật ký trực tiếp',
    },
    features: {
      eyebrow: 'Làm được gì cho bạn',
      heading: 'Mọi thứ SillyTavern cần, chỉ vài cú bấm',
      lede: 'Không cửa sổ dòng lệnh, không chép những câu lệnh dài từ diễn đàn, không phải đi tìm thư mục. Đây là cách nó trông khi dùng.',
      rows: [
        {
          icon: 'cloud',
          badge: 'Được yêu thích nhất',
          label: 'Sao lưu lên cloud',
          title: 'Không bao giờ mất chat nữa',
          body: 'Đăng nhập Cloudflare một lần, và chat, nhân vật, thiết lập của bạn được chép lên kho lưu trữ cloud miễn phí trong chính tài khoản của bạn — vài phút một lần, tự động. Máy hỏng, mất điện thoại hay lỡ tay xoá nhầm, chỉ cần đăng nhập lại trên bất kỳ thiết bị nào là mọi thứ quay về.',
          points: [
            'Tự sao lưu, vài phút một lần',
            'Miễn phí với gói miễn phí của Cloudflare R2',
            'Đăng nhập một lần trên máy mới là lấy lại tất cả',
          ],
          shot: 'f-cloud',
          narrow: 'f-signin-mobile',
          alt: 'Thẻ sao lưu đám mây: tự sao lưu mỗi 5 phút, bản gần nhất vừa gửi một phút trước, và danh sách điểm khôi phục để lấy về',
        },
        {
          icon: 'globe',
          label: 'Link online',
          title: 'SillyTavern trên mọi thiết bị của bạn',
          body: 'Bật một link là SillyTavern mở được trên điện thoại, máy tính bảng hay máy tính khác — ở nhà hay bất cứ đâu. Quét mã QR là mở ngay trên điện thoại. Mã PIN của riêng bạn giữ người khác ở ngoài.',
          points: [
            'Link cố định, lưu bookmark là dùng mãi',
            'Quét mã QR thay vì gõ địa chỉ',
            'Khoá bằng mã PIN chỉ bạn biết',
          ],
          shot: 'f-link',
          narrow: 'f-link-mobile',
          alt: 'Menu Mở SillyTavern: mở kèm tiện ích, hoặc quét mã QR để mở SillyTavern trên điện thoại',
        },
        {
          icon: 'download',
          label: 'Cài đặt và phiên bản',
          title: 'Phiên bản SillyTavern nào cũng chỉ một cú bấm',
          body: 'Chọn phiên bản SillyTavern bạn thích trong danh sách rồi bấm Cài đặt. Trình quản lý tải về từ GitHub chính thức của SillyTavern và cài sẵn cho bạn. Muốn thử bản mới hơn, hay quay về bản bạn ưng? Vẫn danh sách đó, vẫn nút đó — chat của bạn được chép ra chỗ an toàn trước.',
          points: [
            'Bật, tắt SillyTavern bằng một nút',
            'Đổi phiên bản không cần cài lại gì',
            'Luôn là bản chính thức, lấy thẳng từ GitHub',
          ],
          shot: 'f-versions',
          narrow: 'f-versions-mobile',
          alt: 'Danh sách phiên bản đang mở trên trang tổng quan: bản mới nhất, nhánh release và staging, và mọi phiên bản trước đó',
        },
        {
          icon: 'bell',
          label: 'Cập nhật',
          title: 'Có bản mới là biết ngay',
          body: 'Khi SillyTavern ra phiên bản mới, một thông báo hiện ngay trên trang tổng quan. Bấm Cài bản này là lên bản mới. Chưa muốn cập nhật? Bấm Để sau là nó ẩn đi tới bản kế tiếp.',
          points: [
            'Báo ngay trên giao diện, không cần canh GitHub',
            'Một cú bấm để cập nhật',
            'Dữ liệu được chép ra chỗ an toàn trước khi đổi',
          ],
          shot: 'f-update',
          narrow: 'f-update-mobile',
          alt: 'Thông báo trên trang tổng quan: đã có SillyTavern 1.19.0, kèm nút cài đặt và để sau',
        },
        {
          icon: 'upload',
          label: 'Khôi phục',
          title: 'Khôi phục bản sao lưu bằng một nút',
          body: 'Chuyển từ SillyTavern cũ sang? Tải lên file ZIP bạn đã tải về từ nó, hoặc một bản sao lưu từ SillyTavern Manager khác. Không cần cài thêm app, không cần giải nén, không phải đi tìm đúng thư mục. Trình quản lý cho xem bên trong có gì, chép lại bản hiện tại, rồi đưa tất cả trở về.',
          points: [
            'Dùng được file ZIP sao lưu của chính SillyTavern',
            'Xem bên trong có gì trước khi thay đổi',
            'Luôn chép một bản an toàn trước, nên hoàn tác được',
          ],
          shot: 'f-restore',
          narrow: 'f-restore-mobile',
          alt: 'Cửa sổ khôi phục một file ZIP tải lên: 1604 tệp, thay thế hoặc gộp, và ghi chú rằng một bản sao được chép trước',
        },
        {
          icon: 'window',
          label: 'Mở kèm tiện ích',
          title: 'SillyTavern, kèm hộp đồ nghề bên cạnh',
          body: 'Mở SillyTavern kèm tiện ích là có một nút nhỏ nổi ở mép trang. Sao lưu lên máy hay lên cloud mà không phải rời đoạn chat, xem nhật ký trực tiếp để biết chuyện gì đang xảy ra, tải lại SillyTavern hay phóng toàn màn hình. Không cần mở cửa sổ dòng lệnh.',
          points: [
            'Sao lưu ngay giữa lúc đang chat',
            'Xem nhật ký trực tiếp khi có gì lạ',
            'Dùng được trên điện thoại lẫn máy tính',
          ],
          shot: 'f-tools',
          narrow: 'f-tools-mobile',
          alt: 'SillyTavern trong một tab kèm tiện ích của trình quản lý: đoạn chat với Seraphina và menu tiện ích có sao lưu, nhật ký và tải lại',
        },
        {
          icon: 'box',
          label: 'Chế độ tiết kiệm',
          title: 'Máy ít dung lượng? Vẫn vừa',
          body: 'Trên điện thoại hay máy chủ nhỏ gần đầy, Chế độ tiết kiệm giữ bản sao lưu trên cloud thay vì trên máy. Khi bản sao lưu quá lớn để khôi phục, nó đề nghị bỏ bớt những thứ SillyTavern không cần — tệp tải về cũ của tiện ích, ảnh thu nhỏ, bản sao lưu riêng của SillyTavern — mà mọi chat, nhân vật và thiết lập vẫn quay về đủ.',
          points: [
            'Tự bật khi máy thiếu chỗ',
            'Bỏ bớt tệp SillyTavern không cần',
            'Từ chối lần khôi phục không vừa, thay vì hỏng giữa chừng',
          ],
          shot: 'f-saver',
          narrow: 'f-saver-mobile',
          alt: 'Khôi phục ở chế độ tiết kiệm: 7442 tệp và 1,7 GB giảm còn 1606 tệp và 823 MB nhờ bỏ những thứ SillyTavern không cần',
        },
      ],
    },
    trust: {
      eyebrow: 'Miễn phí và riêng tư',
      heading: 'Miễn phí trọn đời, dữ liệu là của bạn',
      lede: 'SillyTavern Manager là phần mềm miễn phí, mã nguồn mở. Không phải tạo tài khoản, không có gì phải trả tiền.',
      cards: [
        { icon: 'gift', title: 'Miễn phí trọn đời', body: 'Không thuê bao, không dùng thử, không giới hạn. Mã nguồn công khai theo giấy phép AGPL-3.0, ai cũng kiểm tra được nó làm gì.' },
        { icon: 'github', title: 'SillyTavern chính chủ', body: 'SillyTavern luôn được tải từ kho GitHub chính thức của nó, và tệp của nó không bao giờ bị sửa.' },
        { icon: 'lock', title: 'Chỉ bạn giữ dữ liệu', body: 'Chat và nhân vật nằm trên thiết bị của bạn và trong tài khoản Cloudflare của chính bạn. Dự án không có máy chủ nào lưu chúng và không bao giờ nhìn thấy chúng.' },
        { icon: 'shield', title: 'Khoá bằng mật khẩu của bạn', body: 'Trình quản lý mở bằng mật khẩu của bạn, SillyTavern mở bằng mã PIN của bạn. Đoán sai quá nhiều lần là cửa tự khoá.' },
      ],
      note: 'Trình quản lý gửi cho dự án một bản tóm tắt sử dụng nhỏ và ẩn danh — không bao giờ có chat, prompt, nhân vật hay khoá API của bạn. [Thông báo quyền riêng tư](/privacy) liệt kê từng trường và chỉ cách tắt hẳn.',
    },
    install: {
      eyebrow: 'Bắt đầu',
      heading: 'Chọn thiết bị của bạn',
      lede: 'Cách nào cũng dẫn tới cùng một chỗ: một trang trên trình duyệt hỏi bạn đặt mật khẩu. Sau đó chọn phiên bản SillyTavern và bấm Cài đặt.',
      cards: [
        { icon: 'monitor', title: 'Windows', body: 'Tải file ZIP, giải nén rồi bấm đúp SillyTavernManager.exe. Không cần cài gì thêm.', href: '/docs#windows', go: 'Hướng dẫn Windows' },
        { icon: 'phone', title: 'Android', body: 'Cài Termux, dán các lệnh trong hướng dẫn, rồi mở trình quản lý bằng trình duyệt trên điện thoại.', href: '/docs#android', go: 'Hướng dẫn Android' },
        { icon: 'apple', title: 'Mac', body: 'Dán vài dòng vào Terminal một lần. Chạy trên cả Mac chip Apple và Intel.', href: '/docs#macos', go: 'Hướng dẫn Mac' },
        { icon: 'server', title: 'Linux và máy chủ', body: 'Một lệnh là chạy, và có thể tự chạy lại sau khi khởi động máy.', href: '/docs#linux', go: 'Hướng dẫn Linux' },
        { icon: 'box', title: 'Docker', body: 'Chạy image dựng sẵn và giữ dữ liệu trong một volume.', href: '/docs#docker', go: 'Hướng dẫn Docker' },
        { icon: 'npm', title: 'npm', body: 'Đã có Node.js? Một lệnh: npx sillytavern-manager.', href: '/docs#npm', go: 'Hướng dẫn npm' },
      ],
    },
    more: {
      eyebrow: 'Còn nữa',
      heading: 'Những điều nhỏ cộng lại',
      cards: [
        { icon: 'chart', title: 'Xem mức sử dụng', body: 'Số tin nhắn, token và thời gian phản hồi theo ngày, theo nhà cung cấp và theo mô hình.' },
        { icon: 'layers', title: 'Nhiều hồ sơ riêng', body: 'Tách riêng các bộ nhân vật và chat, chuyển qua lại chỉ một cú bấm.' },
        { icon: 'refresh', title: 'Luôn thức', body: 'Giữ trình quản lý chạy ở nơi trình tiết kiệm pin hay bộ hẹn giờ nhàn rỗi sẽ tắt nó.' },
        { icon: 'languages', title: 'Ngôn ngữ và giao diện của bạn', body: 'Tiếng Việt và tiếng Anh, sáng và tối, trên máy tính hay bằng một ngón tay trên điện thoại.' },
      ],
    },
    screens: {
      eyebrow: 'Xem qua',
      heading: 'Toàn bộ bảng điều khiển, trên mọi màn hình',
      lede: 'Cùng một giao diện trên máy tính và điện thoại, sáng hay tối, tiếng Việt hay tiếng Anh.',
      shots: [
        { name: 'data', title: 'Dữ liệu', body: 'Sao lưu trên máy và trên cloud, trong cùng một trang.', alt: 'Trang dữ liệu: bản sao lưu trên máy và điểm phục hồi trên Cloudflare R2' },
        { name: 'metrics', title: 'Số liệu', body: 'Bạn chat nhiều ra sao, theo ngày, nhà cung cấp và mô hình.', alt: 'Trang số liệu: lượt gọi, token, tỷ lệ trúng bộ nhớ đệm và độ trễ theo ngày, nhà cung cấp và mô hình' },
        { name: 'settings', title: 'Thiết lập', body: 'Mật khẩu, và thiết lập của SillyTavern dưới dạng công tắc.', alt: 'Trang thiết lập: bảo mật, hiệu năng, tiện ích mở rộng, API key và sao lưu chat' },
      ],
    },
    cta: {
      heading: 'Cài xong trong vài phút',
      lede: 'Không phải đăng ký, không mất tiền. Tải về, đặt mật khẩu, bấm Cài đặt.',
      primary: { href: RELEASES, label: 'Tải bản mới nhất', icon: 'download' },
      secondary: { href: '/docs', label: 'Xem hướng dẫn từng bước', icon: 'book' },
    },
  },
};
