// ============ DeepSeek API 探测 hook v5（正确 JSON Patch）============
(function() {
  if (window.__adshield_probe_installed) return;
  window.__adshield_probe_installed = true;

  // ★ 会话累积状态（按 chat_session_id 分片累积 + debounce）
  var __sessions = {};

  var LOG = function(tag, data) {
    try {
      var s = typeof data === 'string' ? data : JSON.stringify(data);
      console.log('[probe] ' + tag + ' | ' + s);
    } catch (e) {}
  };

  function parseSSE(text) {
    var events = [];
    var lines = text.split('\n');
    var ev = '', data = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('event: ') === 0) ev = line.slice(7).trim();
      else if (line.indexOf('data: ') === 0) data.push(line.slice(6));
      else if (line === '') {
        if (data.length) events.push({ event: ev, data: data.join('\n') });
        ev = ''; data = [];
      }
    }
    if (data.length) events.push({ event: ev, data: data.join('\n') });
    return events;
  }

  // ---- 应用单个 JSON Patch ----
  function applyPatch(root, patch) {
    var op = patch.o;
    var path = patch.p;
    var val = patch.v;
    if (!path || !op) return;

    // BATCH：递归执行子 patch
    if (op === 'BATCH' && Array.isArray(val)) {
      for (var bi = 0; bi < val.length; bi++) {
        applyPatch(root, { p: path + '/' + val[bi].p, o: 'SET', v: val[bi].v });
      }
      return;
    }

    var parts = path.split('/').filter(function(s) { return s !== ''; });
    if (parts.length === 0) return;

    // 遍历到倒数第二层
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      var key = parts[i];
      if (key === '-1') {
        if (Array.isArray(node) && node.length > 0) node = node[node.length - 1];
        else return;
      } else if (/^\d+$/.test(key) && Array.isArray(node)) {
        var idx = parseInt(key, 10);
        if (node[idx] === undefined) node[idx] = {};
        node = node[idx];
      } else {
        if (node[key] === undefined) node[key] = {};
        node = node[key];
      }
    }

    var lastKey = parts[parts.length - 1];
    // 解析目标
    var target, realKey;
    if (lastKey === '-1') {
      target = node; realKey = Array.isArray(node) ? node.length - 1 : null;
    } else if (/^\d+$/.test(lastKey) && Array.isArray(node)) {
      target = node; realKey = parseInt(lastKey, 10);
    } else {
      target = node; realKey = lastKey;
    }
    if (realKey === null) return;

    // 应用操作
    if (op === 'SET' || op === 'REPLACE') {
      target[realKey] = val;
    } else if (op === 'APPEND') {
      var cur = target[realKey];
      if (Array.isArray(cur) && Array.isArray(val)) {
        for (var pj = 0; pj < val.length; pj++) cur.push(val[pj]);
      } else if (Array.isArray(cur)) {
        cur.push(val);
      } else if (typeof cur === 'string') {
        target[realKey] = cur + (val || '');
      } else if (cur === undefined) {
        target[realKey] = val;
      } else {
        target[realKey] = val;
      }
    } else if (op === 'ADD') {
      if (Array.isArray(target) && typeof realKey === 'number') {
        target.splice(realKey, 0, val);
      } else {
        target[realKey] = val;
      }
    } else if (op === 'DELETE') {
      if (Array.isArray(target)) target.splice(realKey, 1);
      else delete target[realKey];
    }
  }

  function analyzeCompletion(text) {
    var events = parseSSE(text);
    LOG('sse:total', { eventCount: events.length });

    var root = null;
    var patchCount = 0;
    for (var i = 0; i < events.length; i++) {
      var dataStr = events[i].data;
      if (!dataStr) continue;
      var obj;
      try { obj = JSON.parse(dataStr); } catch (e) { continue; }

      // 初始化（含 v.response）
      if (obj.v && obj.v.response && !root) {
        root = obj.v;  // ★ 注意：root = obj.v（因为路径是 response/...）
        LOG('init:root', { fragmentCount: (root.response.fragments || []).length });
        continue;
      }

      // JSON Patch
      if (obj.p !== undefined && obj.o !== undefined) {
        patchCount++;
        if (patchCount <= 20) {
          LOG('patch:' + patchCount, { p: obj.p, o: obj.o, vPreview: (typeof obj.v === 'string' ? obj.v.slice(0, 60) : JSON.stringify(obj.v).slice(0, 100)) });
        }
        if (root) {
          try { applyPatch(root, obj); } catch (e) {}
        }
      }
    }

    LOG('patch:stats', { total: patchCount });

    // 输出最终 fragments
    if (root && root.response && root.response.fragments) {
      var frags = root.response.fragments;
      LOG('final:fragmentCount', frags.length);
      for (var fi = 0; fi < frags.length; fi++) {
        var frag = frags[fi];
        LOG('final:frag' + fi, {
          type: frag.type,
          contentLen: (frag.content || '').length,
          contentPreview: (frag.content || '').slice(0, 150)
        });
      }
      LOG('final:status', root.response.status);
      // ★ 拼接本片段的 RESPONSE 文本 → 累积到 session
      try {
        var pieceText = '';
        for (var fj = 0; fj < frags.length; fj++) {
          if (frags[fj].type === 'RESPONSE') {
            pieceText += (frags[fj].content || '');
          }
        }
        if (pieceText) {
          var sessionKey = window.__adshield_current_session || 'default';
          if (!__sessions[sessionKey]) {
            __sessions[sessionKey] = { text: '', timer: null };
          }
          __sessions[sessionKey].text += pieceText;
          LOG('session:append', { key: sessionKey, piece: pieceText.slice(0, 60), total: __sessions[sessionKey].text.length });
          
          // debounce：1.5 秒内无新分片就触发
          if (__sessions[sessionKey].timer) {
            clearTimeout(__sessions[sessionKey].timer);
          }
          __sessions[sessionKey].timer = setTimeout(function() {
            var finalText = __sessions[sessionKey].text;
            delete __sessions[sessionKey];
            if (finalText) {
              // 用当前页自己的 origin，不要用 '*'：这段文本是 AI 回复原文，
              // 一旦页面被导航到别的 origin，'*' 就等于把它广播给那个页面
              window.postMessage({ __adshield_ai_reply: true, text: finalText, ts: Date.now() }, window.location.origin);
              LOG('posted:debounced', { textLen: finalText.length, preview: finalText.slice(0, 200) });
            }
          }, 4000);
        }
      } catch (e) { LOG('post:err', e.message); }
    }
  }

  function isApi(url) {
    if (!url) return false;
    return (url.indexOf('deepseek.com/api/') !== -1) || (url.indexOf('/api/v0/') !== -1);
  }

  LOG('install', 'hook v5 已注入');

  var _open = XMLHttpRequest.prototype.open;
  var _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__adshield = { method: method, url: url };
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    var self = this;
    var url = (self.__adshield || {}).url || '';
    // ★ 从 /chat/completion 请求体提取 chat_session_id
    if (url.indexOf('/chat/completion') !== -1 && body) {
      try {
        var reqBody = JSON.parse(body);
        if (reqBody && reqBody.chat_session_id) {
          window.__adshield_current_session = reqBody.chat_session_id;
          LOG('session:set', { key: reqBody.chat_session_id });
        }
      } catch (e) {}
    }
    if (isApi(url)) {
      self.addEventListener('load', function() {
        if (url.indexOf('/chat/completion') !== -1) {
          try { analyzeCompletion(self.responseText || ''); } catch (e) { LOG('err', e.message); }
        }
      });
    }
    return _send.apply(this, arguments);
  };

  LOG('ready', 'hook v5 就绪');
})();
