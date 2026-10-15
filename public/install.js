if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

(() => {
  const standalone = window.matchMedia('(display-mode: standalone)');
  const fullscreen = window.matchMedia('(display-mode: fullscreen)');
  const phone = navigator.userAgentData?.mobile ?? /Android.*Mobile|iPhone|iPod|Windows Phone/i.test(navigator.userAgent);
  const key = 'kyara-install-dismissed-until';
  let pending = null, banner = null;
  const inApp = () => standalone.matches || fullscreen.matches || navigator.standalone === true;
  const dismissed = () => {
    try { return Number(localStorage.getItem(key)) > Date.now(); } catch { return false; }
  };
  const remove = () => { banner?.remove(); banner = null; };
  const dismiss = () => {
    try { localStorage.setItem(key, String(Date.now() + 7 * 86400000)); } catch {}
    remove();
  };
  window.addEventListener('beforeinstallprompt', event => {
    if (!phone || inApp() || dismissed()) return;
    event.preventDefault();
    pending = event;
    if (banner) return;
    banner = document.createElement('aside');
    banner.className = 'install-banner';
    banner.setAttribute('aria-label', 'Install Kyara Market');
    const text = document.createElement('span');
    text.textContent = 'Keep Kyara Market on your phone.';
    const install = document.createElement('button');
    install.type = 'button'; install.className = 'install-banner-action'; install.textContent = 'Install app';
    install.addEventListener('click', async () => {
      if (!pending) return;
      const prompt = pending; pending = null; install.disabled = true;
      try {
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome === 'dismissed') dismiss(); else remove();
      } catch { remove(); }
    });
    const close = document.createElement('button');
    close.type = 'button'; close.className = 'install-banner-close'; close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss install message for one week');
    close.addEventListener('click', dismiss);
    banner.append(text, install, close);
    document.body.prepend(banner);
  });
  window.addEventListener('appinstalled', () => { pending = null; remove(); });
  standalone.addEventListener('change', () => { if (inApp()) remove(); });
  fullscreen.addEventListener('change', () => { if (inApp()) remove(); });
})();
