/*
 * The language and theme switches on the Cloudflare callback page.
 *
 * The rest of the site says a page in Vietnamese should be a Vietnamese URL,
 * linkable and indexable as such. This page cannot be: its address is
 * registered on the OAuth client and Cloudflare returns to it matched exactly,
 * so there is one address and it has to speak both languages. It used to do
 * that by printing every sentence twice, one under the other, which is twice
 * the reading for a page whose whole job is to be understood in a second.
 *
 * So the page holds one language at a time and a switch changes it. English is
 * in the HTML, which is what a reader without JavaScript gets; Vietnamese is
 * here. `stm-locale` is the same key the site's own language switch writes, and
 * this page is on the same origin as the site, so somebody who reads the
 * documentation in Vietnamese arrives here in Vietnamese.
 */
const VI = {
  'page.title': 'SillyTavern Manager · Cloudflare',
  'working.title': 'Đang quay lại SillyTavern Manager…',
  'working.body': 'Chỉ một giây thôi.',
  'confirm.title': 'Tiếp tục tới trình quản lý?',
  'confirm.body': 'Đăng nhập Cloudflare đã xong. Việc kết nối sẽ được hoàn tất tại:',
  'confirm.warn': 'Chỉ tiếp tục nếu đây đúng là địa chỉ bạn đang mở SillyTavern Manager.',
  'confirm.button': 'Tiếp tục',
  'invalid.title': 'Không dùng được liên kết này',
  'invalid.body': 'Liên kết không đến từ một lần đăng nhập của SillyTavern Manager. Hãy bắt đầu lại từ nút Kết nối Cloudflare trong trình quản lý.',
  'noscript': 'Cần bật JavaScript để quay lại trình quản lý.',
  'lang.other': 'English',
  'lang.switch': 'Read this page in English',
  'theme.dark': 'Chuyển sang giao diện tối',
  'theme.light': 'Chuyển sang giao diện sáng',
};

/**
 * The English wording, taken from the page itself before anything changes it.
 *
 * Including the two switches' own labels: they are not `data-i18n` elements,
 * and reading them here is what stops switching to Vietnamese and back from
 * leaving the language button blank.
 */
function readEnglish(document) {
  const english = { 'page.title': document.title };
  for (const element of document.querySelectorAll('[data-i18n]')) english[element.dataset.i18n] = element.textContent;
  const language = document.querySelector('[data-lang-toggle]');
  if (language) {
    english['lang.other'] = language.querySelector('[data-lang-other]')?.textContent ?? '';
    english['lang.switch'] = language.title;
  }
  const theme = document.querySelector('[data-theme-toggle]');
  if (theme) {
    english['theme.dark'] = theme.dataset.labelDark ?? '';
    english['theme.light'] = theme.dataset.labelLight ?? '';
  }
  return english;
}

function apply(document, words, locale) {
  document.documentElement.lang = locale;
  if (words['page.title']) document.title = words['page.title'];
  for (const element of document.querySelectorAll('[data-i18n]')) {
    const word = words[element.dataset.i18n];
    if (word !== undefined) element.textContent = word;
  }
  const language = document.querySelector('[data-lang-toggle]');
  if (language) {
    language.querySelector('[data-lang-other]').textContent = words['lang.other'] ?? '';
    language.title = words['lang.switch'] ?? '';
  }
  const theme = document.querySelector('[data-theme-toggle]');
  if (theme) {
    theme.dataset.labelDark = words['theme.dark'] ?? '';
    theme.dataset.labelLight = words['theme.light'] ?? '';
    theme.setAttribute('aria-label', (document.documentElement.classList.contains('dark') ? words['theme.light'] : words['theme.dark']) ?? '');
  }
}

function stored(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* the page still changed */ }
}

export function preferredLocale(saved, languages) {
  if (saved === 'vi' || saved === 'en') return saved;
  // Nothing chosen here before: follow the browser, which for a Vietnamese
  // reader is very often already the right answer.
  return (languages ?? []).some((tag) => String(tag).toLowerCase().startsWith('vi')) ? 'vi' : 'en';
}

export function run(window, document) {
  const english = readEnglish(document);
  let locale = preferredLocale(stored('stm-locale'), window.navigator?.languages ?? [window.navigator?.language]);
  const paint = () => apply(document, locale === 'vi' ? { ...english, ...VI } : english, locale);
  paint();

  document.querySelector('[data-lang-toggle]')?.addEventListener('click', () => {
    locale = locale === 'vi' ? 'en' : 'vi';
    remember('stm-locale', locale);
    paint();
  });

  document.querySelector('[data-theme-toggle]')?.addEventListener('click', (event) => {
    const dark = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dark);
    remember('stm-theme', dark ? 'dark' : 'light');
    const button = event.currentTarget;
    button.setAttribute('aria-label', (dark ? button.dataset.labelLight : button.dataset.labelDark) ?? '');
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') run(window, document);
