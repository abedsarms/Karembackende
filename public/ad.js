'use strict';
(() => {
  const T = {
    en: { t: 'Sponsored page', d: 'Stay on this page for 10 seconds, then go back to the app.', v: '👉 Visit advertiser', n: 'Tap the button at least once to receive the FULL reward (otherwise you get half).', done: '✔' },
    fa: { t: 'صفحه تبلیغاتی', d: 'ده ثانیه در این صفحه بمانید، سپس به برنامه برگردید.', v: '👉 مشاهده تبلیغ‌دهنده', n: 'برای دریافت پاداش کامل حداقل یک‌بار روی دکمه بزنید (در غیر این صورت نصف پاداش را می‌گیرید).', done: '✔' },
    ar: { t: 'صفحة إعلانية', d: 'ابقَ في هذه الصفحة 10 ثوانٍ ثم عد إلى التطبيق.', v: '👉 زيارة المعلن', n: 'اضغط الزر مرة واحدة على الأقل لتحصل على المكافأة الكاملة (وإلا تحصل على النصف).', done: '✔' },
    ru: { t: 'Рекламная страница', d: 'Оставайтесь на странице 10 секунд, затем вернитесь в приложение.', v: '👉 Перейти к рекламодателю', n: 'Нажмите кнопку хотя бы раз, чтобы получить ПОЛНУЮ награду (иначе — половину).', done: '✔' },
  };
  const q = new URLSearchParams(location.search);
  const sid = /^[0-9a-f]{32}$/.test(q.get('sid') || '') ? q.get('sid') : '';
  const l = T[q.get('l')] ? q.get('l') : 'en';
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = l; document.documentElement.dir = l === 'fa' || l === 'ar' ? 'rtl' : 'ltr';
  $('t').textContent = T[l].t; $('d').textContent = T[l].d; $('visit').textContent = T[l].v; $('note').textContent = T[l].n;
  if (sid) $('visit').href = '/r/' + sid; else $('visit').style.display = 'none';
  let left = 10; const iv = setInterval(() => { left -= 1; $('timer').textContent = left > 0 ? String(left) : T[l].done; if (left <= 0) clearInterval(iv); }, 1000);
})();
