/**
 * The site's chrome, in both languages.
 *
 * Page content lives beside the page that renders it; this is what every page
 * shares - the bar at the top, the columns at the bottom, and the handful of
 * words the switches and skip links need. The build reads one of these two
 * objects per page and never mixes them, so a half-translated page is not a
 * state this site can be in.
 */

export const LOCALES = ['en', 'vi'];

/** Where each locale's pages live. English is at the root; Vietnamese under /vi. */
export const localeRoot = (locale) => (locale === 'en' ? '' : `/${locale}`);

export const SITE_ORIGIN = 'https://stm.phamloc.top';
export const REPOSITORY = 'https://github.com/locmaymo/stm';
export const RELEASES = 'https://github.com/locmaymo/stm/releases/latest';
export const NPM_PACKAGE = 'https://www.npmjs.com/package/sillytavern-manager';
export const ISSUES = 'https://github.com/locmaymo/stm/issues';
export const UPSTREAM = 'https://github.com/SillyTavern/SillyTavern';

export const strings = {
  en: {
    language: 'English',
    otherLanguage: 'Tiếng Việt',
    legal: {
      label: 'Legal',
      documents: 'Documents',
      inThisDocument: 'In this document',
      footer: 'This is the same text the manager shows at its first run and in **Settings → About**. It ships inside the application, so it can be read without an internet connection.',
    },
    switchLanguage: 'Đọc trang này bằng tiếng Việt',
    skip: 'Skip to content',
    useDark: 'Switch to the dark theme',
    useLight: 'Switch to the light theme',
    nav: [
      { href: '/#what', label: 'Features' },
      { href: '/#install', label: 'Install' },
      { href: '/#how', label: 'How it works' },
      { href: '/docs', label: 'Documentation' },
    ],
    footer: {
      about: 'A control panel that installs, runs, shares, backs up and watches SillyTavern on a machine you own. Free software, AGPL-3.0.',
      independence: 'An independent project. Not affiliated with, or endorsed by, the SillyTavern project.',
      columns: [
        {
          title: 'Project',
          links: [
            { href: REPOSITORY, label: 'Source on GitHub' },
            { href: RELEASES, label: 'Download a release' },
            { href: NPM_PACKAGE, label: 'npm package' },
            { href: ISSUES, label: 'Report a problem' },
          ],
        },
        {
          title: 'Documentation',
          links: [
            { href: '/docs', label: 'Getting started' },
            { href: '/docs#install', label: 'Installing' },
            { href: '/docs#backups', label: 'Backups' },
            { href: '/docs#share', label: 'Remote access' },
          ],
        },
        {
          title: 'Legal',
          links: [
            { href: '/terms', label: 'Terms of Use' },
            { href: '/disclaimer', label: 'Disclaimer' },
            { href: '/privacy', label: 'Privacy Notice' },
            { href: '/notices', label: 'Notices' },
          ],
        },
      ],
      licence: 'Copyright © 2026 locmaymo. Published under the AGPL-3.0, with no warranty.',
    },
  },
  vi: {
    language: 'Tiếng Việt',
    otherLanguage: 'English',
    legal: {
      label: 'Pháp lý',
      documents: 'Các văn bản',
      inThisDocument: 'Trong văn bản này',
      footer: 'Đây đúng là nội dung mà trình quản lý hiển thị ở lần chạy đầu tiên và trong **Thiết lập → Về trình quản lý**. Nội dung này đi kèm ứng dụng, nên đọc được mà không cần kết nối internet.',
    },
    switchLanguage: 'Read this page in English',
    skip: 'Tới nội dung chính',
    useDark: 'Chuyển sang giao diện tối',
    useLight: 'Chuyển sang giao diện sáng',
    nav: [
      { href: '/vi/#what', label: 'Tính năng' },
      { href: '/vi/#install', label: 'Cài đặt' },
      { href: '/vi/#how', label: 'Cách hoạt động' },
      { href: '/vi/docs', label: 'Tài liệu' },
    ],
    footer: {
      about: 'Bảng điều khiển giúp cài đặt, chạy, chia sẻ, sao lưu và theo dõi SillyTavern trên máy của chính bạn. Phần mềm tự do, giấy phép AGPL-3.0.',
      independence: 'Dự án độc lập. Không liên kết với và không được dự án SillyTavern chứng thực.',
      columns: [
        {
          title: 'Dự án',
          links: [
            { href: REPOSITORY, label: 'Mã nguồn trên GitHub' },
            { href: RELEASES, label: 'Tải bản phát hành' },
            { href: NPM_PACKAGE, label: 'Gói npm' },
            { href: ISSUES, label: 'Báo lỗi' },
          ],
        },
        {
          title: 'Tài liệu',
          links: [
            { href: '/vi/docs', label: 'Bắt đầu' },
            { href: '/vi/docs#install', label: 'Cài đặt' },
            { href: '/vi/docs#backups', label: 'Sao lưu' },
            { href: '/vi/docs#share', label: 'Truy cập từ xa' },
          ],
        },
        {
          title: 'Pháp lý',
          links: [
            { href: '/vi/terms', label: 'Điều khoản sử dụng' },
            { href: '/vi/disclaimer', label: 'Miễn trừ trách nhiệm' },
            { href: '/vi/privacy', label: 'Quyền riêng tư' },
            { href: '/vi/notices', label: 'Thông báo' },
          ],
        },
      ],
      licence: 'Bản quyền © 2026 locmaymo. Phát hành theo giấy phép AGPL-3.0, không kèm bảo hành.',
    },
  },
};
