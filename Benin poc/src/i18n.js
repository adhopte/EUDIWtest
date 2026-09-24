'use strict';

const path = require('path');

const SUPPORTED = ['en', 'fr'];
const DEFAULT = 'en';
const messages = Object.fromEntries(
  SUPPORTED.map((lang) => [lang, require(path.join(__dirname, '..', 'locales', `${lang}.json`))])
);

function translate(lang, key, vars = {}) {
  const text = messages[lang][key] ?? messages[DEFAULT][key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? vars[name] : `{${name}}`));
}

function pickFromHeader(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const code = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(code)) return code;
  }
  return null;
}

/** Language = ?lang= (persisted in a cookie) > cookie > Accept-Language > English. */
function middleware(req, res, next) {
  let lang = null;
  if (SUPPORTED.includes(req.query.lang)) {
    lang = req.query.lang;
    res.cookie('lang', lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax' });
  }
  lang = lang || (SUPPORTED.includes(req.cookies.lang) ? req.cookies.lang : null) || pickFromHeader(req.get('accept-language')) || DEFAULT;

  req.lang = lang;
  res.locals.lang = lang;
  res.locals.t = (key, vars) => translate(lang, key, vars);
  res.locals.langUrl = (code) => {
    const url = new URL(req.originalUrl, 'http://x');
    url.searchParams.set('lang', code);
    return url.pathname + url.search;
  };
  res.locals.supportedLangs = SUPPORTED;
  next();
}

module.exports = { middleware, translate, SUPPORTED, messages };
