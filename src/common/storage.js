/* Single-key state in chrome.storage.local, shared by the content script,
 * the popup, the options page and the service worker. One key keeps change
 * notifications cheap and makes read-modify-write races obvious instead of
 * subtle.
 *
 *   { enabled, placeholders, keywords: { enabled, terms },
 *     sites: { <site id>: { enabled, presets: { <preset id>: bool }, custom: [rule],
 *                           remembered: { <group>: [preset id] } } } }
 *
 * The pause switch, the "show" bars and the word list are shared by every
 * site; switches and picked rules belong to one site. `remembered` holds what
 * was on in a group when the popup's group switch turned it off, so turning
 * it back on restores that. Settings saved before there was more than one
 * site were Facebook's and are moved there.
 */
(function (root) {
  'use strict';

  var KEY = 'bfx';
  var APP = 'xrnsoc';

  var DEFAULTS = {
    enabled: true,
    placeholders: false,
    keywords: { enabled: false, terms: [] },
    sites: {}
  };

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function siteIds() {
    return root.BFX_SITES ? root.BFX_SITES.list.map(function (s) { return s.id; }) : [];
  }

  /* Only lists of ids survive, whatever a hand-edited backup holds. */
  function cleanRemembered(map) {
    var out = {};
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      Object.keys(map).forEach(function (group) {
        if (!Array.isArray(map[group])) return;
        var ids = map[group].filter(function (id) { return typeof id === 'string' && id; });
        if (ids.length) out[group] = ids;
      });
    }
    return out;
  }

  /* One site's settings over its defaults. Defaults come from the site's
   * rule pack, so where a pack is not loaded (the service worker) stored
   * switches are kept as they are and nothing is added. */
  function mergeSite(id, stored) {
    stored = stored || {};
    var defaults = root.BFX_SITES ? root.BFX_SITES.defaultsFor(id) : {};
    return {
      enabled: stored.enabled !== false,
      presets: Object.assign(defaults, stored.presets || {}),
      custom: Array.isArray(stored.custom) ? stored.custom : [],
      remembered: cleanRemembered(stored.remembered)
    };
  }

  function merge(stored) {
    stored = stored || {};
    var s = clone(DEFAULTS);
    if (typeof stored.enabled === 'boolean') s.enabled = stored.enabled;
    if (typeof stored.placeholders === 'boolean') s.placeholders = stored.placeholders;
    s.keywords = Object.assign(clone(DEFAULTS.keywords), stored.keywords || {});

    var sites = Object.assign({}, stored.sites || {});
    /* Saved before there were other sites: these switches are Facebook's. */
    if (!stored.sites && (stored.presets || stored.custom)) {
      sites.facebook = { enabled: true, presets: stored.presets || {}, custom: stored.custom || [] };
    }
    var ids = siteIds();
    Object.keys(sites).forEach(function (id) {
      if (ids.indexOf(id) === -1) ids.push(id);
    });
    ids.forEach(function (id) {
      s.sites[id] = mergeSite(id, sites[id]);
    });
    return s;
  }

  /* A site's settings inside a full state, created if missing, for writers. */
  function site(state, id) {
    if (!state.sites[id]) state.sites[id] = mergeSite(id);
    return state.sites[id];
  }

  /* What a page on one site runs on: the shared settings with that site's
   * switches and picked rules. Paused when everything is paused or the site
   * is switched off. */
  function view(state, id) {
    var own = state.sites[id] || mergeSite(id);
    return {
      site: id,
      enabled: state.enabled && own.enabled,
      presets: own.presets,
      custom: own.custom,
      keywords: state.keywords,
      placeholders: state.placeholders
    };
  }

  function failure() {
    var error = chrome.runtime && chrome.runtime.lastError;
    return error ? new Error(error.message || String(error)) : null;
  }

  /* A read that fails reads as the defaults; read(true) refuses instead, so
   * a write is never built on settings that were not there. */
  function read(strict) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.get(KEY, function (res) {
        var error = failure();
        if (error && strict) reject(error);
        else resolve(merge(res && res[KEY]));
      });
    });
  }

  function get() {
    return read(false);
  }

  /* Rejects when storage refuses the write (over quota, for one), so
   * nothing claims a state that was never stored. */
  function set(state) {
    return new Promise(function (resolve, reject) {
      var payload = {};
      payload[KEY] = state;
      chrome.storage.local.set(payload, function () {
        var error = failure();
        if (error) reject(error);
        else resolve(state);
      });
    });
  }

  /* Read-modify-write, one at a time. Two that overlapped were built from
   * the same read, and the later one undid the earlier: two switches
   * flipped in a row, or the picker saving while the shortcut paused. In
   * one page they wait in one queue; the extension's own pages and its
   * worker also share a lock. A content script takes none: a lock there
   * would be the site's, which could hold on to it. fn may mutate the state
   * or return a new one. */
  var queue = Promise.resolve();
  var locks = typeof navigator !== 'undefined' && navigator.locks && typeof location !== 'undefined' &&
    /^(chrome|moz)-extension:$/.test(location.protocol) ? navigator.locks : null;

  function update(fn) {
    var write = function () {
      return read(true).then(function (state) {
        return set(fn(state) || state);
      });
    };
    var run = queue.then(function () {
      return locks ? locks.request(KEY, write) : write();
    });
    queue = run.catch(function () {});   // a write that failed holds up no other
    return run;
  }

  function onChange(cb) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[KEY]) return;
      cb(merge(changes[KEY].newValue));
    });
  }

  function newId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* Custom selectors are pasted into a stylesheet as `selector{...}`, so one
   * that is not a real selector could close the rule and inject CSS of its
   * own (url() requests included). The selector parser alone is not enough:
   * as the CSS spec says, it closes whatever a selector leaves open at its
   * end, so it passes `a/*`, whose comment then runs on into the rules after
   * it. A selector must also be self-contained: no comments (none is ever
   * picked), every string and bracket closed, no escape cut off by the end.
   * Without a DOM (the service worker) nothing is accepted. */
  var CLOSER = { '(': ')', '[': ']' };

  function selfContained(sel) {
    var open = [];
    var quote = '';
    for (var i = 0; i < sel.length; i++) {
      var c = sel.charAt(i);
      if (c === '\\') {
        if (i === sel.length - 1) return false;
        i++;                       // an escaped character is never syntax
      } else if (quote) {
        if (c === quote) quote = '';
        else if (c === '\n' || c === '\r' || c === '\f') return false;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '/' && sel.charAt(i + 1) === '*') {
        return false;
      } else if (CLOSER[c]) {
        open.push(CLOSER[c]);
      } else if (c === ')' || c === ']') {
        if (open.pop() !== c) return false;
      } else if (c === '{' || c === '}' || c === ';') {
        return false;
      }
    }
    return !quote && !open.length;
  }

  var probe = null;
  function validSelector(sel) {
    if (typeof sel !== 'string' || !sel.trim() || !selfContained(sel)) return false;
    if (typeof document === 'undefined') return false;
    probe = probe || document.createDocumentFragment();
    try {
      probe.querySelector(sel);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* A /regex/ body that a backtracking engine can take seconds or hours over
   * on one post, with the tab frozen while it runs, since a scan can't be
   * interrupted:
   *   - a group repeated more than once around something that varies or
   *     branches: (a+)+, (a?){40}, (a|aa)*, (\w+\s?)*, (.*a){9};
   *   - a repeat of any size straight after another that can match the same
   *     characters, with only optional bits between: .*.*, \d+\d*, a?a?,
   *     a{0,999}a{0,999};
   *   - too many ways in all to share a post out among its repeats: each
   *     counts its choices, one that is open-ended or takes more than WIDE
   *     extra counts sixteen, and the product may not pass WAYS. That allows
   *     .*a.*b but not .*a.*b.*c, .{0,99}a.{0,99}b.{0,99}c or
   *     .*a.{0,9}b.{0,9}c.{0,9}d, each of which took over a second.
   * Read token by token; a group's prefix ("?:", "?<name>") is skipped. */
  var WIDE = 10;
  var WAYS = 1000;
  var CLASSES = { d: /\d/, w: /\w/, s: /\s/, D: /\D/, W: /\W/, S: /\S/ };
  var APART = ['\\D\\d', '\\S\\s', '\\W\\w', '\\d\\s', '\\s\\w', '\\W\\d'];
  /* Whether two atoms can match no character in common. An atom is 'L' and
   * the character, '\\' and a class letter, or anything else (could be
   * anything). */
  function apart(a, b) {
    if (a[0] === 'L' && b[0] === 'L') return a !== b;
    if (a[0] === 'L' && b[0] === '\\') return !CLASSES[b[1]].test(a.slice(1));
    if (b[0] === 'L' && a[0] === '\\') return !CLASSES[a[1]].test(b.slice(1));
    return APART.indexOf([a, b].sort().join('')) !== -1;
  }

  function meetsAny(kinds, kind) {
    for (var i = 0; i < kinds.length; i++) {
      if (!apart(kinds[i], kind)) return true;
    }
    return false;
  }

  function slowPattern(body) {
    var REPEAT = /^\{(\d+)(,(\d*))?\}/;
    var PREFIX = /^\(\?([:=!]|<[=!]|<[^>]*>)/;
    /* first: what a group's first item can match, which tells (,\d{3})*
     * from what came before it; '(' when that could be anything. */
    var groups = [{ vary: false, alt: false, before: [], first: null }];
    var atom = null;        // what a quantifier here would apply to
    var before = [];        // what the repeats that meet this item can match
    var open = [];          // the same for the item after it, once its quantifier is read
    var ways = 1;
    for (var i = 0; i < body.length; i++) {
      var c = body[i];
      var top = groups[groups.length - 1];
      var q = c === '{' ? REPEAT.exec(body.slice(i)) : null;
      if (c === '*' || c === '+' || c === '?' || q) {
        if (q) i += q[0].length - 1;
        if (body[i + 1] === '?') i++;   // lazy: the same work
        if (!atom) continue;
        var min = c === '+' ? 1 : c === '*' || c === '?' ? 0 : +q[1];
        var max = c === '*' || c === '+' ? Infinity : c === '?' ? 1 : q[2] === undefined ? min : q[3] === '' ? Infinity : +q[3];
        if (max > 1 && atom.group && (atom.group.vary || atom.group.alt)) return true;
        if (max > min) {
          top.vary = true;
          ways *= max - min > WIDE ? 16 : max - min + 1;
          if (ways > WAYS) return true;
        }
        /* A group that is only optional repeats nothing: what it holds was
         * judged on its own. */
        var repeats = max > min && !(atom.group && max <= 1);
        if (repeats && meetsAny(before, atom.kind)) return true;
        open = repeats ? [atom.kind] : [];
        if (min === 0) {
          open = open.concat(before);   // optional: what came before still meets what follows
          if (atom.first) top.first = '(';
        }
        atom = null;
        continue;
      }
      if (c === '(') {
        var prefix = PREFIX.exec(body.slice(i));
        if (prefix) i += prefix[0].length - 1;
        groups.push({ vary: false, alt: false, before: open, first: null });
        atom = null;
        before = open = [];
        continue;
      }
      if (c === '|') {
        top.alt = true;
        atom = null;
        before = open = [];
        continue;
      }
      if (c === ')' && groups.length > 1) {
        var done = groups.pop();
        var outer = groups[groups.length - 1];
        outer.vary = outer.vary || done.vary;
        outer.alt = outer.alt || done.alt;
        atom = { group: done, kind: done.alt || !done.first ? '(' : done.first, first: !outer.first };
        if (!outer.first) outer.first = atom.kind;
        before = done.before;
        open = [];
        continue;
      }
      var kind = c === '.' || c === '[' ? c : 'L' + c.toLowerCase();
      if (c === '\\') {
        var e = body[++i] || '';
        var close = /[pPu]/.test(e) && body[i + 1] === '{' ? '}' : e === 'k' && body[i + 1] === '<' ? '>' : '';
        if (close) i = Math.max(i, body.indexOf(close, i));
        kind = CLASSES[e] ? '\\' + e : /[A-Za-z0-9]/.test(e) ? '?' : 'L' + e;
      } else if (c === '[') {
        for (i++; i < body.length && body[i] !== ']'; i++) if (body[i] === '\\') i++;
      }
      atom = { group: null, kind: kind, first: !top.first };
      if (!top.first) top.first = kind;
      before = open;
      open = [];
    }
    return false;
  }

  /* A word as it is kept: a /regex/ that slowPattern() refuses becomes the
   * plain word between its slashes. */
  function cleanTerm(term) {
    var t = String(term).trim();
    var m = /^\/(.+)\/([gimsuy]*)$/.exec(t);
    return m && slowPattern(m[1]) ? m[1] : t;
  }

  function toBackup(state) {
    return {
      app: APP,
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: state
    };
  }

  /* A selector is kept trimmed: one with a space at the end hid what was
   * inside the element instead of the element (engine.js, boosted()). */
  function cleanRules(list) {
    return (Array.isArray(list) ? list : []).filter(function (r) {
      return r && validSelector(r.selector);
    }).map(function (r) {
      return {
        id: typeof r.id === 'string' && r.id ? r.id : newId(),
        selector: r.selector.trim(),
        label: typeof r.label === 'string' ? r.label : '',
        scope: r.scope === 'path' ? 'path' : 'all',
        path: typeof r.path === 'string' ? r.path : '/',
        enabled: r.enabled !== false,
        createdAt: Number(r.createdAt) || Date.now()
      };
    });
  }

  function cleanSwitches(map) {
    var out = {};
    if (map && typeof map === 'object') {
      Object.keys(map).forEach(function (id) {
        if (typeof map[id] === 'boolean') out[id] = map[id];
      });
    }
    return out;
  }

  /* Rebuild settings from an exported file field by field, so a hand-edited
   * or foreign file can only ever produce a well-formed state. Files saved
   * under the extension's earlier names are still ours: "xrnsocial" (until
   * 2.1.0, when the new name came with a new Firefox add-on id, so a backup
   * is how settings move across), "XrnSocial" and "BlockDistractXrn" (same
   * shape as today's) and "BlockFB" (one site, restored into Facebook).
   * Throws with a message fit to show the person. */
  var OLD_APPS = ['xrnsocial', 'XrnSocial', 'BlockDistractXrn', 'BlockFB'];

  function fromBackup(data) {
    var s = data && (data.app === APP || OLD_APPS.indexOf(data.app) !== -1) ? data.settings : data;
    if (!s || typeof s !== 'object' || Array.isArray(s) ||
        !('sites' in s || 'presets' in s || 'custom' in s || 'keywords' in s)) {
      throw new Error('Not a backup');
    }
    var out = {};
    if (typeof s.enabled === 'boolean') out.enabled = s.enabled;
    if (typeof s.placeholders === 'boolean') out.placeholders = s.placeholders;
    if (s.keywords && typeof s.keywords === 'object') {
      out.keywords = {
        enabled: s.keywords.enabled === true,
        terms: (Array.isArray(s.keywords.terms) ? s.keywords.terms : [])
          .filter(function (t) { return typeof t === 'string' && t.trim(); })
          .map(cleanTerm)
      };
    }
    var sites = s.sites && typeof s.sites === 'object' ? s.sites
      : { facebook: { presets: s.presets, custom: s.custom } };
    var known = siteIds();
    out.sites = {};
    Object.keys(sites).forEach(function (id) {
      if (known.indexOf(id) === -1 || !sites[id] || typeof sites[id] !== 'object') return;
      out.sites[id] = {
        enabled: sites[id].enabled !== false,
        presets: cleanSwitches(sites[id].presets),
        custom: cleanRules(sites[id].custom),
        remembered: sites[id].remembered
      };
    });
    return merge(out);
  }

  root.BFX_STORE = {
    KEY: KEY,
    APP: APP,
    DEFAULTS: DEFAULTS,
    get: get,
    set: set,
    update: update,
    onChange: onChange,
    merge: merge,
    site: site,
    view: view,
    newId: newId,
    validSelector: validSelector,
    slowPattern: slowPattern,
    cleanTerm: cleanTerm,
    toBackup: toBackup,
    fromBackup: fromBackup
  };
})(typeof self !== 'undefined' ? self : this);
