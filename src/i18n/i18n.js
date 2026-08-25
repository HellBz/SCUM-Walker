window.I18n = (function() {
  let current = {};
  let lang = 'en';

  function getNested(obj, path) {
    return path.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : undefined), obj);
  }

  async function load(language) {
    lang = language ? language.toLowerCase() : 'en';
    try {
      const text = await window.__TAURI__.core.invoke('load_translation', { lang });
      current = JSON.parse(text);
    } catch (err) {
      console.warn('[i18n] Could not load', lang, err);
      current = {};
    }
    apply();
    return current;
  }

  function t(key, fallback) {
    if (current[key] !== undefined) return current[key];
    const value = getNested(current, key);
    if (value !== undefined) return value;
    return fallback !== undefined ? fallback : key;
  }

  function apply() {
    const textEls = document.querySelectorAll('[data-i18n]');
    const titleEls = document.querySelectorAll('[data-i18n-title]');
    const placeholderEls = document.querySelectorAll('[data-i18n-placeholder]');
    textEls.forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const value = t(key);
      if (value !== key) el.textContent = value;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (!key) return;
      const value = t(key);
      if (value !== key) el.setAttribute('title', value);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      const value = t(key);
      if (value !== key) el.setAttribute('placeholder', value);
    });
  }

  return { load, t, apply, get lang() { return lang; } };
})();