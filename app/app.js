/*
 * ライフプラン アプリ本体（入力画面とCF表画面）
 *
 * 描画は state から HTML を作り直す単純な方式。入力欄は change（確定時）でだけ state を更新し、
 * 再描画は次のタイミングに回してから、フォーカスとスクロール位置を戻す。
 * こうしておくと、スマホで次の入力欄をタップしたときにキーボードが閉じない。
 */
(function () {
  'use strict';

  var E = window.LifePlanEngine;
  var STORE_KEY = 'lifeplan.v2';
  var OLD_KEY = 'lifeplan.v1';
  var REL = ['家族１', '家族２', '子供１', '子供２', '子供３', '子供４', '親', 'その他'];
  var JOBS = ['会社員等', 'パート', '自営業', '専業主婦', '学生', '乳幼児', '自由業', 'その他'];

  // ---------- 保存と読み込み ----------
  //
  // 保存の形：{ version: 2, activeId, nextPlanId, plans: [{ id, name, state }], prefs: { yearMode, welcomed } }
  // state が1つのプランの入力一式（計算エンジンに渡すもの）。

  function okState(s) { return !!(s && s.version === 1 && Array.isArray(s.family) && s.family.length); }

  function freshStore() {
    return {
      version: 2, activeId: 1, nextPlanId: 2,
      plans: [{ id: 1, name: '記入例', state: window.LifePlanSample.sample() }],
      prefs: { yearMode: 'year', welcomed: false },
      book: { years: {}, nextId: 1 }
    };
  }

  // 保存の問題：'blocked'（ブラウザの設定で保存できない）か 'broken'（保存されていたデータが読めない）
  var storageProblem = '', brokenRaw = '';

  function load() {
    try { localStorage.setItem('lifeplan.check', '1'); localStorage.removeItem('lifeplan.check'); }
    catch (e) { storageProblem = 'blocked'; return freshStore(); }
    var raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var st = JSON.parse(raw);
        if (st && st.version === 2 && Array.isArray(st.plans)) {
          st.plans = st.plans.filter(function (p) { return p && okState(p.state); });
          if (st.plans.length) {
            if (!byId(st.plans, st.activeId)) st.activeId = st.plans[0].id;
            st.prefs = st.prefs || { yearMode: 'year', welcomed: true };
            if (!st.book || typeof st.book.years !== 'object') st.book = { years: {}, nextId: 1 };
            return st;
          }
        }
      }
      // 1つしか保存できなかった頃のデータは、そのまま1つ目のプランにする
      var old = localStorage.getItem(OLD_KEY);
      if (old) {
        var s = JSON.parse(old);
        if (okState(s)) return { version: 2, activeId: 1, nextPlanId: 2, plans: [{ id: 1, name: 'プラン1', state: s }], prefs: { yearMode: 'year', welcomed: true }, book: { years: {}, nextId: 1 } };
      }
    } catch (e) { /* 読めないデータは下で取っておく */ }
    // 読めなかったデータは上書きで消さないよう、別の名前で取っておき、ファイルにも保存できるようにする
    if (raw) {
      storageProblem = 'broken'; brokenRaw = raw;
      try { localStorage.setItem(STORE_KEY + '.broken', raw); } catch (e) { /* 取っておけなくても、画面からファイルに保存できる */ }
    }
    return freshStore();
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 同上 */ }
  }

  function byId(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
  function plan() { return byId(store.plans, store.activeId); }

  var store = load();
  var state = plan().state;
  var ui = {
    view: location.hash === '#cf' ? 'cf' : location.hash === '#cmp' ? 'cmp' : location.hash === '#book' ? 'book' : store.prefs.welcomed ? 'input' : 'cover',
    cover: { family: 'kid2', home: 'rent', needs: [] },   // 表紙で選んでいるもの
    help: '',          // 開いている「？」の説明
    thMore: 0,         // 手取り計算の「細かく設定」を開いている給与の id
    book: { year: new Date().getFullYear(), month: new Date().getMonth(), mode: 'month', edit: false, picks: {}, target: 0 },  // 家計簿の表示
    active: 'basic',
    openMember: 0,
    openCalc: 0,
    carDetailOpen: false,
    confirmReset: false,
    confirmDelMember: 0,
    wz: null,          // かんたん入力の途中の答え
    sheet: false,      // プランの一覧を開いているか
    confirmDelPlan: 0,
    cmp: null,         // 比較で選んでいるプランの id
    backup: { msg: '', level: '', text: false, pending: null },
    penOpen: { state: false, wz: false },  // 公的年金の試算を開いているか
    loanOpen: false, loanTable: false, loanConfirm: false,  // 住宅ローンの試算
    inputScroll: 0
  };
  var result = E.compute(state);
  var issues = {};      // 入力の確認結果を場所ごとに（E.validate の at をキーに）
  var issueCount = 0;
  var pendingRender = false;
  var lastEnd = null;   // 直前に表示した終了時点の金融資産（変化の表示用）
  var deltaTimer = null;
  var quiet = false;    // 次の描画では変化を表示しない（プランの切り替えなど）

  // ---------- 小物 ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // 日本語入力の全角数字・全角の小数点やマイナス・桁区切りのカンマも、数値として読む
  function normNum(v) {
    return String(v == null ? '' : v)
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[．。]/g, '.').replace(/[－ー−‐]/g, '-').replace(/[,，\s　]/g, '');
  }
  function toNum(v) { var n = parseFloat(normNum(v)); return isFinite(n) ? n : 0; }
  function fid() { return 'f-' + Array.prototype.join.call(arguments, '-'); }
  function nid() { return state.nextId++; }
  function baseBirth() { return E.baseBirthYear(state); }
  function man(v) {
    var n = Math.round(v);
    if (n === 0) return '0';
    return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('ja-JP');
  }
  function memberName(id) {
    var m = byId(state.family, id);
    if (!m) return 'その他';
    return m.name || m.relation;
  }

  // ---------- 入力の確認 ----------

  function issuesAt(at) { return issues[at] || []; }
  function bad(at, field) {
    return issuesAt(at).some(function (i) { return i.field === field; }) ? ' bad' : '';
  }
  function vmsgs(at) {
    return issuesAt(at).map(function (i) {
      return '<div class="vmsg ' + i.level + '">' + ic('warn', 15) + '<span>' + esc(i.msg) + '</span></div>';
    }).join('');
  }

  // 保存は「1990/04/01」の形（Excelと同じ）。日付入力欄は「1990-04-01」の形で受け渡す。
  function isoDate(s) {
    var p = String(s || '').trim().split(/[\/-]/);
    if (p.length !== 3 || !/^\d{4}$/.test(p[0])) return '';
    return p[0] + '-' + ('0' + p[1]).slice(-2) + '-' + ('0' + p[2]).slice(-2);
  }

  // ---------- 元に戻す ----------
  // 削除・置き換えの直前の保存内容を1つだけ覚えておき、画面下の「元に戻す」で戻せるようにする

  var undo = null, toastTimer = null;
  function snapshot(msg) {
    undo = { json: JSON.stringify(store), msg: msg };
    toast(msg, true);
  }
  // 元に戻すのない、お知らせだけの表示
  function snapshotless(msg) { undo = null; toast(msg, false); }
  function toast(msg, undoable) {
    var t = document.getElementById('toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (undoable ? '<button onclick="A.undo()">元に戻す</button>' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; undo = null; }, 7000);
  }

  // 生年月日の入力を「1990/04/01」の形にそろえる。8桁の数字・「1990-4-1」・「1990年4月1日」・全角も受け付ける。
  // 日付として読めないものはそのまま残し、入力の確認で知らせる。
  function normBirth(v) {
    var t = String(v == null ? '' : v).trim()
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[年月\-－.．／]/g, '/').replace(/日/g, '').replace(/\s/g, '');
    if (!t) return '';
    var m = /^(\d{4})(\d{2})(\d{2})$/.exec(t) || /^(\d{4})\/(\d{1,2})\/(\d{1,2})\/?$/.exec(t);
    if (!m) return t;
    var out = m[1] + '/' + ('0' + m[2]).slice(-2) + '/' + ('0' + m[3]).slice(-2);
    return E.isDate(out) ? out : t;
  }

  // 生年月日の欄：数字で打てる文字の欄＋カレンダーのボタン。
  // ボタンの上に透明な日付選択の欄を重ね、タップするとそのまま端末のカレンダーが開くようにする。
  // call は「A.birth(3,」のような呼び出しの前半。文字の欄は確定時、カレンダーは選び終えて離れたときに描き直す。
  function dateField(id, cls, value, call, label) {
    return '<span class="datef">' +
      '<input type="text" inputmode="numeric" enterkeyhint="next" autocomplete="off" id="' + id + '" class="' + cls + ' sel" maxlength="12"' +
        ' placeholder="19900401" aria-label="' + esc(label) + '（8桁の数字でも入力できます）" value="' + esc(value) + '" onchange="' + call + 'this.value)">' +
      '<span class="cal">' + ic('calendar', 20) +
        '<input type="date" id="' + id + '-cal" min="1900-01-01" max="2100-12-31" tabindex="-1" aria-label="' + esc(label) + 'をカレンダーから選ぶ"' +
          ' value="' + isoDate(value) + '" onchange="' + call + 'this.value,this)" onblur="A.flush()" onclick="try{this.showPicker()}catch(e){}">' +
      '</span>' +
    '</span>';
  }

  function noticeHTML() {
    if (!storageProblem) return '';
    var text = storageProblem === 'blocked'
      ? 'このブラウザの設定では入力を保存できません。画面を閉じると消えるので、プランの一覧から「ファイルに保存」でバックアップしてください。'
      : '保存されていたデータを読み込めなかったので、記入例から始めています。読めなかったデータは消さずに取ってあります。';
    return '<div class="vbanner notice">' + ic('warn', 18) + '<span>' + text + '</span>' +
      (storageProblem === 'broken' ? '<button class="btn" onclick="A.saveBroken()">ファイルに保存</button>' : '') +
      '<button class="del" style="margin:0" aria-label="このお知らせを閉じる" onclick="A.noticeHide()">' + ic('close', 18) + '</button></div>';
  }
  var DISCLAIMER = '<p class="disclaimer">この結果は、入力した条件にもとづく試算です。将来の収入・物価・運用成果を約束するものではなく、特定の金融商品をすすめるものでもありません。税金・社会保険料・年金などは簡易な計算です。大切な判断の前には、専門家にもご相談ください。</p>';

  // 入力欄に、読み上げ用の名前を付ける（見出し・行の番号・欄の前後の文字から）
  function autoLabel(root) {
    var labelled = {};
    Array.prototype.forEach.call(root.querySelectorAll('label[for]'), function (l) { labelled[l.getAttribute('for')] = true; });
    Array.prototype.forEach.call(root.querySelectorAll('input, select, textarea'), function (el) {
      if (el.type === 'hidden' || el.type === 'file' || el.getAttribute('aria-label') || labelled[el.id]) return;
      var card = el.closest('.card'), ttl = card && card.querySelector('.ttl');
      var who = el.closest('.penp'), whoEl = who && who.querySelector('.pnm');
      var row = el.closest('.rowline, .stage, .member, .occ'), idx = '';
      if (row && row.parentNode) {
        var sibs = Array.prototype.filter.call(row.parentNode.children, function (x) { return x.classList.contains(row.classList[0]); });
        if (sibs.length > 1) idx = (sibs.indexOf(row) + 1) + '行目';
      }
      var prev = el.previousElementSibling, next = el.nextElementSibling;
      var pre = prev && prev.classList.contains('u') ? prev.textContent.trim() : '';
      var post = next && next.classList.contains('u') ? next.textContent.trim() : '';
      var line = el.closest('.rowtop, .calcrow'), lead = '';
      if (!pre && line && line.firstElementChild && line.firstElementChild !== el) {
        var f = line.firstElementChild;
        lead = f.tagName === 'INPUT' ? f.value : f.tagName === 'SPAN' && !f.classList.contains('u') ? f.textContent.trim() : '';
      }
      var label = [ttl ? ttl.textContent.trim() : '', whoEl ? whoEl.textContent.trim() : '', idx, pre || lead, el.getAttribute('placeholder') && !pre && !post ? el.getAttribute('placeholder') : '', post]
        .filter(Boolean).join(' ');
      if (label) el.setAttribute('aria-label', label);
    });
  }

  // 中身を作り直すとき、変わっていない見出しやカードはそのまま残し、変わったものだけ入れ替える。
  // 入力画面は1000要素ほどあり、毎回すべて作り直すと、廉価なスマホでは入力のたびに0.5秒ほど待たされるため。
  function patchChildren(box, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var next = Array.prototype.slice.call(tpl.content.children);
    var cur = Array.prototype.slice.call(box.children);
    if (next.length !== cur.length || tpl.content.childNodes.length !== next.length) { box.innerHTML = html; cacheHtml(box); return; }
    next.forEach(function (n, i) {
      var h = n.outerHTML;
      if (cur[i]._h === h) return;
      n._h = h;
      box.replaceChild(n, cur[i]);
    });
  }
  function cacheHtml(box) { Array.prototype.forEach.call(box.children, function (c) { c._h = c.outerHTML; }); }

  var renderQueued = false;
  function commit() {
    save();
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; render(); }, 0);
  }

  // ---------- 操作 ----------

  var A = {
    num: function (key, id, field, v) { var r = byId(state[key], id); if (r) r[field] = toNum(v); commit(); },
    text: function (key, id, field, v) { var r = byId(state[key], id); if (r) r[field] = v; commit(); },
    del: function (key, id) { snapshot('行を削除しました'); state[key] = state[key].filter(function (r) { return r.id !== id; }); commit(); },
    add: function (key, max, hasTo) {
      var list = state[key];
      if (list.length >= max) return;
      var last = list[list.length - 1];
      var from = last ? (last.toYear ? last.toYear + 1 : last.year + 5) : state.startYear;
      var row = { id: nid(), year: from, amount: 0, memo: '' };
      if (hasTo) row.toYear = from + 4;
      list.push(row);
      commit();
    },
    merge: function (key, id) {
      snapshot('同じ年の行を1行にまとめました');
      var list = state[key], row = byId(list, id);
      if (!row) return;
      var first = list.filter(function (r) { return r.year === row.year && r.id !== id; })[0];
      if (!first) return;
      first.amount = toNum(first.amount) + toNum(row.amount);
      first.memo = [first.memo, row.memo].filter(Boolean).join('、');
      state[key] = list.filter(function (r) { return r.id !== id; });
      commit();
    },

    start: function (v) {
      state.startYear = toNum(v);
      [state.living, state.housing].concat(state.salaries.map(function (s) { return s.rows; })).forEach(function (rows) {
        if (rows && rows[0]) rows[0].year = state.startYear;
      });
      commit();
    },
    endAge: function (v) { state.endAge = toNum(v); commit(); },
    depositRate: function (v) { state.depositRate = toNum(v); commit(); },

    member: function (id) { ui.openMember = ui.openMember === id ? 0 : id; ui.confirmDelMember = 0; commit(); },
    // 日付入力欄は、選んでいる途中にも change が来る（iPhoneの回転式の選択など）。
    // 選んでいる間に描き直すと選択が閉じてしまうので、保存だけして、欄を離れたときに描き直す。
    birth: function (id, v, el) {
      var m = byId(state.family, id); if (!m) return;
      m.birth = normBirth(v);
      if (el && document.activeElement === el) { save(); pendingRender = true; return; }
      commit();
    },
    flush: function () { if (pendingRender) { pendingRender = false; commit(); } },
    firstIssue: function () {
      var el = document.querySelector('#content .vmsg');
      var sc = document.getElementById('scroll');
      if (el && sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 190;
    },
    fam: function (id, field, v) {
      var m = byId(state.family, id); if (!m) return;
      m[field] = v;
      if (field === 'name') state.salaries.forEach(function (s) { if (s.memberId === id) s.who = v || m.relation; });
      commit();
    },
    addFamily: function () {
      if (state.family.length >= 6) return;
      var id = nid();
      state.family.push({ id: id, name: '', gender: '', relation: REL[Math.min(state.family.length, 7)], birth: '', job: '会社員等' });
      ui.openMember = id;
      commit();
    },
    delFamily: function (id) {
      if (ui.confirmDelMember !== id) { ui.confirmDelMember = id; commit(); return; }
      snapshot('「' + memberName(id) + '」を削除しました');
      state.family = state.family.filter(function (m) { return m.id !== id; });
      delete state.edu[id]; delete state.eduAmount[id]; delete state.eduSpan[id];
      state.salaries.forEach(function (s) { if (s.memberId === id) { s.memberId = 0; s.who = 'その他'; } });
      ui.openMember = 0; ui.confirmDelMember = 0;
      commit();
    },

    salMember: function (sid, v) {
      var s = byId(state.salaries, sid); if (!s) return;
      s.memberId = toNum(v);
      s.who = memberName(s.memberId);
      if (!s.memberId) s.retireAge = 0;
      commit();
    },
    salRetire: function (sid, v) { var s = byId(state.salaries, sid); if (s) s.retireAge = toNum(v); commit(); },
    sal: function (sid, rid, field, v) {
      var s = byId(state.salaries, sid); var r = s && byId(s.rows, rid);
      if (r) r[field] = toNum(v);
      commit();
    },
    salDel: function (sid, rid) { snapshot('行を削除しました'); var s = byId(state.salaries, sid); if (s) s.rows = s.rows.filter(function (r) { return r.id !== rid; }); commit(); },
    salAdd: function (sid) {
      var s = byId(state.salaries, sid); if (!s || s.rows.length >= 8) return;
      var last = s.rows[s.rows.length - 1];
      s.rows.push({ id: nid(), year: last ? last.year + 5 : state.startYear, amount: 0, growth: 0 });
      commit();
    },
    addEarner: function () {
      if (state.salaries.length >= 3) return;
      var used = state.salaries.map(function (s) { return s.memberId; });
      var m = state.family.filter(function (f) { return used.indexOf(f.id) < 0 && String(f.relation).indexOf('子供') !== 0; })[0];
      state.salaries.push({
        id: nid(), memberId: m ? m.id : 0, who: m ? memberName(m.id) : 'その他', retireAge: m ? 65 : 0,
        rows: [{ id: nid(), year: state.startYear, amount: 0, growth: 0 }]
      });
      commit();
    },
    delEarner: function (sid) { snapshot('収入のある人を外しました'); state.salaries = state.salaries.filter(function (s) { return s.id !== sid; }); commit(); },

    calcToggle: function (sid) { ui.openCalc = ui.openCalc === sid ? 0 : sid; commit(); },
    calc: function (field, v) { state.calc[field] = field === 'spouse' ? v : toNum(v); commit(); },
    calcApply: function (sid) {
      var s = calcEdit(sid);
      if (!s || !s.rows[0]) return;
      snapshot('手取りの計算結果を1行目に入れました');
      s.rows[0].amount = Math.round(calcResult(s, s.calc).net * 10) / 10;
      ui.openCalc = 0;
      commit();
    },

    infl: function (v) { state.inflation = toNum(v); commit(); },
    car: function (field, v) { state.carBuy[field] = toNum(v); commit(); },
    carToggle: function () { ui.carDetailOpen = !ui.carDetailOpen; commit(); },
    carOver: function (year, v) { state.carBuyOverride[year] = toNum(v); commit(); },

    rate: function (aid, v) { var a = byId(state.assets, aid); if (a) a.rate = toNum(v); commit(); },
    tax: function (aid, v) { var a = byId(state.assets, aid); if (a) a.tax = v; commit(); },
    inv: function (aid, kind, rid, field, v) {
      var r = byId(state.invest[aid][kind], rid);
      if (r) r[field] = field === 'memo' ? v : toNum(v);
      commit();
    },
    invDel: function (aid, kind, rid) { snapshot('行を削除しました'); var iv = state.invest[aid]; iv[kind] = iv[kind].filter(function (r) { return r.id !== rid; }); commit(); },
    invAdd: function (aid, kind) {
      var list = state.invest[aid][kind]; if (list.length >= 5) return;
      var last = list[list.length - 1];
      var from = last ? last.toYear + 1 : state.startYear;
      list.push({ id: nid(), year: from, toYear: from + 4, amount: 0, memo: '' });
      commit();
    },

    eduStage: function (cid, i, v) {
      var cur = (state.edu[cid] || E.EDU_STAGES.map(function (s) { return s.options[0]; })).slice();
      cur[i] = v; state.edu[cid] = cur;
      if (state.eduAmount[cid]) delete state.eduAmount[cid][i];
      commit();
    },
    eduAmt: function (cid, i, v) { (state.eduAmount[cid] = state.eduAmount[cid] || {})[i] = toNum(v); commit(); },
    eduSpan: function (cid, i, field, v, autoFrom, autoTo) {
      var m = state.eduSpan[cid] = state.eduSpan[cid] || {};
      var cur = m[i] || { from: autoFrom, to: autoTo };
      m[i] = { from: cur.from, to: cur.to };
      m[i][field] = toNum(v);
      commit();
    },

    y: function (v, by) { return ageMode() && String(v).trim() !== '' ? toNum(v) + by : v; },
    undo: function () {
      if (!undo) return;
      store = JSON.parse(undo.json);
      state = plan().state;
      undo = null;
      document.getElementById('toast').hidden = true;
      ui.confirmDelMember = 0; ui.confirmDelPlan = 0; ui.confirmReset = false; ui.loanConfirm = false;
      commit();
    },
    privacy: function () { snapshotless('入力した家計簿とプランは、この端末のブラウザの中だけに保存されます。どこにも送られません'); },
    noticeHide: function () { storageProblem = ''; commit(); },
    saveBroken: function () {
      try {
        var url = URL.createObjectURL(new Blob([brokenRaw], { type: 'application/json' }));
        var a = document.createElement('a'); a.href = url; a.download = 'lifeplan-unreadable.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      } catch (e) { /* 保存できない画面では何もしない */ }
    },
    yearMode: function (m) { store.prefs.yearMode = m; quiet = true; commit(); },
    jump: function (key) {

      ui.active = key;
      var el = document.getElementById('sec-' + key);
      var sc = document.getElementById('scroll');
      if (el && sc) sc.scrollTop = Math.max(0, el.offsetTop - 118);
      markTabs();
    },
    view: function (v) {
      if (ui.view === v) return;
      var sc = document.getElementById('scroll');
      if (ui.view === 'wizard') ui.wz = null;
      if (ui.view === 'input') ui.inputScroll = sc.scrollTop;
      ui.view = v;
      if (v === 'book') ui.book.shown = '';
      render();
      sc.scrollTop = v === 'input' ? ui.inputScroll : 0;
    },
    resetAsk: function () { ui.confirmReset = true; commit(); },
    resetNo: function () { ui.confirmReset = false; commit(); },
    resetYes: function () {
      snapshot('記入例の内容に戻しました');
      state = plan().state = window.LifePlanSample.sample();
      ui.confirmReset = false; ui.openMember = 0; ui.openCalc = 0;
      commit();
      document.getElementById('scroll').scrollTop = 0;
    }
  };
  window.A = A;


  // ---------- アイコン（Webフォントに頼らず、読み込み前でも崩れないようSVGで描く） ----------

  var ICONS = {
    add: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    prev: '<path d="M14.5 6l-6 6 6 6"/>',
    next: '<path d="M9.5 6l6 6-6 6"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2.5"/>',
    book: '<path d="M6 4.5h11.5a1.5 1.5 0 0 1 1.5 1.5v14.5H8a2 2 0 0 1-2-2z"/><path d="M6 18.5a2 2 0 0 1 2-2h11M9.5 8.5h6M9.5 11.5h4"/>',
    plan: '<path d="M4.5 6h10M4.5 11h7M4.5 16h4.5"/><path d="M13.5 19.5l.7-3.2 5.6-5.6a1.6 1.6 0 0 1 2.3 2.3l-5.6 5.6z"/>',
    chart: '<path d="M4 19.5h16"/><rect x="5.5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="7.5" width="3" height="9.5" rx="1"/><rect x="15.5" y="4.5" width="3" height="12.5" rx="1"/>',
    compare: '<path d="M4 18l4.5-5 3.5 3L19.5 7"/><path d="M4 9.5l4.5 3 4-3.5 7 4"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    home: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9.5h11V10"/><path d="M10 19.5v-5h4v5"/>',
    school: '<path d="M2.5 9.5 12 5l9.5 4.5L12 14z"/><path d="M6.5 11.8v3.7c1.5 1.4 3.5 2.2 5.5 2.2s4-.8 5.5-2.2v-3.7M21.5 9.5v5"/>',
    hourglass: '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 4 5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5-4 8.5s4 4.5 4 8.5"/>',
    yen: '<circle cx="12" cy="12" r="8.5"/><path d="M8.8 7.5 12 12l3.2-4.5M12 12v5M9.3 12.8h5.4M9.3 15h5.4"/>',
    del: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    more: '<path d="M6 9l6 6 6-6"/>',
    less: '<path d="M6 15l6-6 6 6"/>',
    warn: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    merge: '<path d="M7 4v3a5 5 0 0 0 5 5 5 5 0 0 0 5-5V4M12 12v8"/>',
    calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7.5h7M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/>',
    work: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12.5h18"/>',
    tune: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
    income: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18M15.5 15h2"/>',
    pension: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
    expense: '<path d="M4.5 10h15l-1.6 9.2a1 1 0 0 1-1 .8H7.1a1 1 0 0 1-1-.8L4.5 10zM8 10l4-6 4 6"/>',
    invest: '<path d="M12 21v-9M12 12c0-4 3-7 8-7 0 4.5-3 7-8 7zM12 14.5c0-3-2.5-5.5-7-5.5 0 3.5 2.5 5.5 7 5.5z"/>'
  };
  function ic(name, size, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '" width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  // ---------- 入力画面の部品 ----------

  function numInput(id, cls, width, value, handler, extra) {
    // type="number" だと、タップした位置にカーソルが入り、全部選ぶこともできない。文字の欄にして数字のキーボードを出す
    return '<input type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" id="' + id + '" class="' + cls + ' num" style="width:' + width + 'px' + (extra || '') + '" value="' + esc(value) + '" onchange="' + handler + '">';
  }
  function textInput(id, cls, style, value, handler, placeholder) {
    return '<input type="text" id="' + id + '" class="' + cls + '" style="' + style + '" value="' + esc(value) + '"' + (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') + ' onchange="' + handler + '">';
  }
  function selectInput(id, cls, style, options, current, handler) {
    return '<select id="' + id + '" class="' + cls + '" style="' + style + '" onchange="' + handler + '">' +
      options.map(function (o) {
        var v = typeof o === 'object' ? o.value : o, label = typeof o === 'object' ? o.label : o;
        return '<option value="' + esc(v) + '"' + (String(v) === String(current) ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('') + '</select>';
  }
  function addButton(handler, label) {
    return '<div class="addwrap divide"><button class="addbtn" aria-label="' + label + '" onclick="' + handler + '">' + ic('add', 24) + '</button></div>';
  }
  function delButton(handler) {
    return '<button class="del" aria-label="この行を削除" onclick="' + handler + '">' + ic('del', 20) + '</button>';
  }
  // 年の欄は「西暦」と「年齢」のどちらでも入れられる（store.prefs.yearMode）。
  // 年齢のときは、その欄に関係する人（ふつうは家族１、給与はその人、教育費はその子）の生年 by を足して西暦で保存する。
  function ageMode() { return store.prefs.yearMode === 'age'; }
  function yv(year, by) { return ageMode() ? (toNum(year) ? toNum(year) - by : '') : year; }
  function yin(by) { return 'A.y(this.value,' + by + ')'; }
  function suf(kind) { return (ageMode() ? '歳' : '年') + { from: 'から', at: 'で', to: 'まで' }[kind]; }
  // 欄の下の補足は、入れている方と逆（西暦なら年齢、年齢なら西暦）を出す
  function other(year, by, who) { return ageMode() ? year + '年' : (who ? who + ' ' : '') + (year - by) + '歳'; }

  function lockedYear(by) {
    if (ageMode()) return '<span class="lockyear" title="1行目は開始年から">' + (state.startYear - by) + '</span><span class="u">歳（開始年）から</span>';
    return '<span class="lockyear" title="1行目は開始年から">' + state.startYear + '</span><span class="u">年（開始年）から</span>';
  }
  function chevron(open, size) { return ic(open ? 'less' : 'more', size || 18); }

  function rowsHTML(key, list, opts) {
    var by = baseBirth();
    var counts = {};
    list.forEach(function (r) { counts[r.year] = (counts[r.year] || 0) + 1; });
    var seen = {};
    return list.map(function (r, i) {
      seen[r.year] = (seen[r.year] || 0) + 1;
      var dup = !!opts.dupCheck && counts[r.year] > 1 && seen[r.year] > 1;
      var cls = opts.requiredFirst && i === 0 ? 'rq' : 'op';
      var q = "'" + key + "'," + r.id;
      var at = 'row:' + key + ':' + r.id;
      var locked = opts.anchorFirst && i === 0;
      var ageHint = r.year && !locked ? (opts.hasTo
        ? other(r.year, by, '家族１') + ' 〜 ' + other(r.toYear, by) + '（' + (r.toYear - r.year + 1) + '年間）'
        : other(r.year, by, '家族１')) : locked && !ageMode() ? '家族１ ' + (state.startYear - by) + '歳' : locked ? state.startYear + '年' : '';
      // 年額の支出は、月あたりの額も添える（家計簿の感覚と照らし合わせやすいように）
      if (opts.monthly && toNum(r.amount)) ageHint += (ageHint ? ' ・ ' : '') + '月' + (Math.round(toNum(r.amount) / 12 * 10) / 10).toLocaleString('ja-JP') + '万円';
      return '<div class="rowline divide">' +
        '<div class="rowtop">' +
          (locked ? lockedYear(by) :
            numInput(fid(key, r.id, 'year'), cls + bad(at, 'year'), 76, yv(r.year, by), 'A.num(' + q + ",'year'," + yin(by) + ')') +
            '<span class="u">' + suf(opts.lump ? 'at' : 'from') + '</span>') +
          (opts.hasTo ? numInput(fid(key, r.id, 'to'), cls + bad(at, 'toYear'), 76, yv(r.toYear, by), 'A.num(' + q + ",'toYear'," + yin(by) + ')', ';margin-left:2px') + '<span class="u">' + suf('to') + '</span>' : '') +
          (locked ? '' : delButton('A.del(' + q + ')')) +
        '</div>' +
        (ageHint ? '<div class="ageh">' + ageHint + '</div>' : '') +
        '<div class="rowamt">' +
          (opts.hasTo ? '<span class="u">年間</span>' : '') +
          numInput(fid(key, r.id, 'amt'), cls + bad(at, 'amount'), 96, r.amount, 'A.num(' + q + ",'amount',this.value)") +
          '<span class="u">万円</span>' +
        '</div>' +
        (dup ? '<div class="dup">' + ic('merge', 17) + '<span class="txt">' + r.year + '年の行が重複しています</span>' +
          '<button class="btn" style="margin-left:auto;padding:7px 12px" onclick="A.merge(' + q + ')">合算する</button></div>' : '') +
        vmsgs(at) +
        (opts.memo ? textInput(fid(key, r.id, 'memo'), 'op memo', '', r.memo || '', 'A.text(' + q + ",'memo',this.value)", '備考') : '') +
      '</div>';
    }).join('');
  }

  function groupCard(key, label, opts) {
    var list = state[key] || [];
    var max = opts.max || 5;

    return '<div class="card" id="card-' + key + '">' +
      '<div class="head"><span class="ttl">' + esc(label) + '</span>' + helpBtn(key) + '<span class="cnt">' + list.length + ' / ' + max + '行</span></div>' +
      helpBox(key) +
      (opts.inflation ? '<div class="rowtop divide" style="padding:10px 0"><span class="u">物価上昇率</span>' +
        numInput('f-inflation', 'rq' + bad('infl', 'inflation'), 64, state.inflation, 'A.infl(this.value)', ';margin-left:auto') + '<span class="u">％</span></div>' +
        (issuesAt('infl').length ? '<div style="padding-bottom:10px">' + vmsgs('infl') + '</div>' : '') : '') +
      rowsHTML(key, list, opts) +
      (list.length < max ? addButton("A.add('" + key + "'," + max + ',' + !!opts.hasTo + ')', '行を追加') : '') +
      (opts.hint ? '<div class="hint divide">' + esc(opts.hint) + '</div>' : '') +
      (opts.extra || '') +
    '</div>';
  }

  function salaryCard(sal, idx) {
    var by = baseBirth();
    var member = byId(state.family, sal.memberId);
    var mBirth = member ? E.parseDate(member.birth).y : by;
    var calcOpen = ui.openCalc === sal.id;
    var memberOptions = state.family
      .filter(function (m) { return String(m.relation).indexOf('子供') !== 0; })
      .map(function (m) { return { value: m.id, label: memberName(m.id) }; })
      .concat([{ value: 0, label: 'その他' }]);
    var rows = sal.rows.map(function (r, i) {
      var cls = idx === 0 && i === 0 ? 'rq' : 'op';
      var q = sal.id + ',' + r.id;
      var at = 'salrow:' + sal.id + ':' + r.id;
      var y = i === 0 ? state.startYear : r.year;
      return '<div class="rowline divide">' +
        '<div class="rowtop">' +
          (i === 0 ? lockedYear(mBirth) :
            numInput(fid('sal', sal.id, r.id, 'year'), cls + bad(at, 'year'), 76, yv(r.year, mBirth), 'A.sal(' + q + ",'year'," + yin(mBirth) + ')') +
            '<span class="u">' + suf('from') + '</span>' + delButton('A.salDel(' + q + ')')) +
        '</div>' +
        '<div class="ageh">' + esc(other(y, mBirth, memberName(sal.memberId))) + '</div>' +
        '<div class="rowamt">' +
          numInput(fid('sal', sal.id, r.id, 'amt'), cls + bad(at, 'amount'), 96, r.amount, 'A.sal(' + q + ",'amount',this.value)") +
          '<span class="u">万円</span>' +
          '<span class="u" style="margin-left:auto">上昇率</span>' +
          numInput(fid('sal', sal.id, r.id, 'g'), cls + bad(at, 'growth'), 60, r.growth || 0, 'A.sal(' + q + ",'growth',this.value)") +
          '<span class="u">％</span>' +
        '</div>' +
        vmsgs(at) +
      '</div>';
    }).join('');
    return '<div class="card">' +
      '<div class="head"><span class="u">対象者</span>' +
        selectInput(fid('sal', sal.id, 'member'), idx === 0 ? 'rq' : 'op', '', memberOptions, sal.memberId, 'A.salMember(' + sal.id + ',this.value)') +
        helpBtn('salary-' + sal.id, 'salary') + '<span class="cnt">' + sal.rows.length + ' / 8行</span></div>' +
      helpBox('salary-' + sal.id, 'salary') +
      '<div class="hint" style="padding:6px 0 0">手取り（可処分所得）で入力します。2行目以降の金額は今の水準で入れれば、その行の上昇率で開始年から伸ばして計算します。</div>' +
      rows +
      (sal.rows.length < 8 ? addButton('A.salAdd(' + sal.id + ')', '行を追加') : '') +
      (member ? '<div class="retire divide">' + ic('work', 18) + '' +
        numInput(fid('sal', sal.id, 'retire'), 'op' + bad('sal:' + sal.id, 'retire'), 64, sal.retireAge || '', 'A.salRetire(' + sal.id + ',this.value)', ';margin-left:auto') +
        '<span class="u">歳まで働く</span></div>' +
        vmsgs('sal:' + sal.id) +
        '<div class="hint" style="padding-top:2px">' + (sal.retireAge ? (mBirth + sal.retireAge) + '年以降の収入は0として計算します' : '空欄なら、行で入れた金額がずっと続きます') + '</div>' : '') +
      '<div class="divide">' +
        '<button class="toggle" onclick="A.calcToggle(' + sal.id + ')">' + ic('calc', 18, 'lead') + '<span class="lbl">手取りを計算する（年収や源泉徴収票から）</span><span class="chev">' + chevron(calcOpen) + '</span></button>' +
        (calcOpen ? calcHTML(sal, idx) : '') +
      '</div>' +
      (idx > 0 ? '<div class="divide" style="padding-top:8px;text-align:center"><button class="btn ghost" onclick="A.delEarner(' + sal.id + ')">この対象者を外す</button></div>' : '') +
    '</div>';
  }

  function eduCard(child) {
    var d = E.parseDate(child.birth);
    var early = E.isEarlyBorn(d);
    var plan = E.eduPlan(state, child);
    var total = 0;
    var stages = plan.map(function (st) {
      total += st.amount * st.years;
      var base = child.id + ',' + st.index;
      var at = 'edu:' + child.id + ':' + st.index;
      return '<div class="stage divide">' +
        '<div class="rowtop">' +
          selectInput(fid('edu', child.id, st.index, 'stage'), 'op', 'flex:1;min-width:0', st.options, st.stage, 'A.eduStage(' + base + ',this.value)') +
          numInput(fid('edu', child.id, st.index, 'amt'), 'op', 72, st.amount, 'A.eduAmt(' + base + ',this.value)') +
          '<span class="u">万円</span>' +
        '</div>' +
        '<div class="rowtop" style="margin-top:8px">' +
          numInput(fid('edu', child.id, st.index, 'from'), 'op', 76, yv(st.from, d.y), 'A.eduSpan(' + base + ",'from'," + yin(d.y) + ',' + st.autoFrom + ',' + st.autoTo + ')') +
          '<span class="u">' + suf('from') + '</span>' +
          numInput(fid('edu', child.id, st.index, 'to'), 'op' + bad(at, 'to'), 76, yv(st.to, d.y), 'A.eduSpan(' + base + ",'to'," + yin(d.y) + ',' + st.autoFrom + ',' + st.autoTo + ')') +
          '<span class="u">' + suf('to') + '</span>' +
          '<span class="u" style="margin-left:auto">' + st.years + '年・計' + man(st.amount * st.years) + '万</span>' +
        '</div>' +
        vmsgs(at) +
      '</div>';
    }).join('');
    return '<div class="card" id="card-edu-' + child.id + '">' +
      '<div class="head"><span class="ttl">' + esc(child.name || child.relation) + 'の教育費</span>' + helpBtn('edu-' + child.id, 'edu') + '<span class="cnt">' + esc(child.birth) + (early ? '・早生まれ' : '') + '</span></div>' +
      helpBox('edu-' + child.id, 'edu') +
      (d.y ? stages : '<div class="hint divide">家族構成で生年月日を入れると、在学年と金額が自動で入ります</div>') +
      (d.y ? '<div class="total divide"><span class="u" style="font-weight:700">在学中の合計</span><span class="v">' + man(total) + '</span><span class="u" style="font-weight:700">万円</span></div>' +
        '<div class="hint" style="padding-top:0">年も金額も自動で入りますが、進路に合わせて書き換えられます</div>' : '') +
    '</div>';
  }

  function carCard() {
    var c = state.carBuy, by = baseBirth();
    var occ = E.carOccurrences(state);
    var total = occ.reduce(function (s, o) { return s + o.amount; }, 0);
    return '<div class="card">' +
      '<div class="head" style="margin-bottom:9px"><span class="ttl">自動車の購入費</span>' + helpBtn('carBuy') + '</div>' + helpBox('carBuy') +
      '<div class="rowtop" style="flex-wrap:wrap;row-gap:8px">' +
        numInput('f-car-from', 'op', 76, yv(c.fromYear, by), "A.car('fromYear'," + yin(by) + ')') + '<span class="u">' + suf('from') + '</span>' +
        numInput('f-car-every', 'op' + bad('car', 'every'), 52, c.every, "A.car('every',this.value)", ';margin-left:2px') + '<span class="u">年ごとに</span>' +
        numInput('f-car-until', 'op' + bad('car', 'untilAge'), 56, c.untilAge, "A.car('untilAge',this.value)", ';margin-left:auto') + '<span class="u">歳まで</span>' +
      '</div>' +
      vmsgs('car') +
      '<div class="rowtop" style="margin-top:10px"><span class="u">1回あたり</span>' +
        numInput('f-car-amt', 'op', 96, c.amount, "A.car('amount',this.value)", ';margin-left:auto') + '<span class="u">万円</span></div>' +
      '<div class="divide" style="margin-top:10px">' +
        '<button class="toggle" onclick="A.carToggle()">' + ic('tune', 18, 'lead') + '<span class="lbl">回ごとに金額を変える</span><span class="chev">' + chevron(ui.carDetailOpen) + '</span></button>' +
        (ui.carDetailOpen ? occ.map(function (o) {
          return '<div class="occ divide"><span style="font-size:14.5px;font-weight:700">' + o.year + '年</span><span class="u">家族１ ' + (o.year - by) + '歳</span>' +
            numInput(fid('car', o.year), 'op', 80, o.amount, 'A.carOver(' + o.year + ',this.value)', ';margin-left:auto') + '<span class="u">万円</span></div>';
        }).join('') : '') +
      '</div>' +
      '<div class="total divide"><span class="u" style="font-weight:700">' + occ.length + '回の合計</span><span class="v">' + man(total) + '</span><span class="u" style="font-weight:700">万円</span></div>' +
    '</div>';
  }

  function investCard(asset, kind, label, withRate) {
    var list = (state.invest[asset.id] || {})[kind] || [];
    var by = baseBirth();
    var rows = list.map(function (r) {
      var q = asset.id + ",'" + kind + "'," + r.id;
      var at = 'inv:' + asset.id + ':' + kind + ':' + r.id;
      return '<div class="rowline divide">' +
        '<div class="rowtop">' +
          numInput(fid('inv', asset.id, kind, r.id, 'year'), 'op' + bad(at, 'year'), 76, yv(r.year, by), 'A.inv(' + q + ",'year'," + yin(by) + ')') + '<span class="u">' + suf('from') + '</span>' +
          numInput(fid('inv', asset.id, kind, r.id, 'to'), 'op' + bad(at, 'toYear'), 76, yv(r.toYear, by), 'A.inv(' + q + ",'toYear'," + yin(by) + ')', ';margin-left:2px') + '<span class="u">' + suf('to') + '</span>' +
          delButton('A.invDel(' + q + ')') +
        '</div>' +
        '<div class="ageh">' + other(r.year, by, '家族１') + ' 〜 ' + other(r.toYear, by) + '（' + (r.toYear - r.year + 1) + '年間・計' + man((r.toYear - r.year + 1) * r.amount) + '万円）</div>' +
        '<div class="rowamt"><span class="u">年間</span>' +
          numInput(fid('inv', asset.id, kind, r.id, 'amt'), 'op' + bad(at, 'amount'), 96, r.amount, 'A.inv(' + q + ",'amount',this.value)") + '<span class="u">万円</span></div>' +
        vmsgs(at) +
        textInput(fid('inv', asset.id, kind, r.id, 'memo'), 'op memo', '', r.memo || '', 'A.inv(' + q + ",'memo',this.value)", '備考') +
      '</div>';
    }).join('');
    var hk = kind === 'add' ? 'investAdd' : 'investOut';
    return '<div class="card" id="card-inv-' + asset.id + '-' + kind + '">' +
      '<div class="head"><span class="ttl">' + esc(label) + '</span>' + helpBtn(hk + '-' + asset.id, hk) + '<span class="cnt">' + list.length + ' / 5行</span></div>' +
      helpBox(hk + '-' + asset.id, hk) +
      (withRate ? '<div class="rowtop divide" style="padding:10px 0">' +
        '<span class="u">想定利回り</span>' + numInput(fid('rate', asset.id), 'rq' + bad('rate:' + asset.id, 'rate'), 60, asset.rate, 'A.rate(' + asset.id + ',this.value)') + '<span class="u">％</span>' +
        '<span class="u" style="margin-left:auto">税率</span>' +
        selectInput(fid('tax', asset.id), 'rq', '', ['0%', '20%'], asset.tax, 'A.tax(' + asset.id + ',this.value)') +
      '</div>' + (issuesAt('rate:' + asset.id).length ? '<div style="padding-bottom:10px">' + vmsgs('rate:' + asset.id) + '</div>' : '') : '') +
      rows +
      (list.length < 5 ? addButton('A.invAdd(' + asset.id + ",'" + kind + "')", '行を追加') : '') +
      (withRate ? '<div class="hint divide">税率は、NISA・iDeCoなら0%、投資信託や個別株なら20%。「＋」で足す行は前の行の翌年から始まるので、期間は重なりません。</div>' :
        '<div class="hint divide">前年末の残高が足りない年は、その年の現金化は0になります</div>') +
    '</div>';
  }

  function basicHTML() {
    var assets = state.assets.map(function (a) {
      return '<div class="rowtop divide" style="padding:10px 0">' +
        (a.fixed ? '<span style="font-size:15px;font-weight:500">' + esc(a.name) + '</span>'
                 : textInput(fid('asset', a.id, 'name'), 'op', 'width:120px', a.name, "A.text('assets'," + a.id + ",'name',this.value)")) +
        numInput(fid('asset', a.id, 'amt'), 'rq' + bad('asset:' + a.id, 'amount'), 96, a.amount, "A.num('assets'," + a.id + ",'amount',this.value)", ';margin-left:auto') +
        '<span class="u">万円</span>' +
      '</div>' + (issuesAt('asset:' + a.id).length ? '<div style="padding-bottom:10px">' + vmsgs('asset:' + a.id) + '</div>' : '');
    }).join('');
    var family = state.family.map(function (m, i) {
      var d = E.parseDate(m.birth);
      var isChild = String(m.relation).indexOf('子供') === 0;
      var ageLabel = d.y ? (state.startYear - d.y) + '歳' + (isChild && E.isEarlyBorn(d) ? '・早生まれ' : '') : '';
      var cls = i === 0 ? 'rq' : 'op';
      var open = ui.openMember === m.id;
      return '<div class="member divide">' +
        '<div class="n1">' +
          textInput(fid('fam', m.id, 'name'), cls, 'flex:1;min-width:0', m.name, 'A.fam(' + m.id + ",'name',this.value)", '名前') +
          '<span class="badge">' + esc(m.relation) + '</span>' +
          '<button class="del" style="margin-left:0" aria-label="詳しく" onclick="A.member(' + m.id + ')">' + chevron(open, 22) + '</button>' +
        '</div>' +
        '<div class="n2">' +
          dateField(fid('fam', m.id, 'birth'), cls + bad('fam:' + m.id, 'birth'), m.birth, 'A.birth(' + m.id + ',', '生年月日') +
          '<span class="u">' + ageLabel + '</span>' +
        '</div>' +
        vmsgs('fam:' + m.id) +
        (open ? '<div class="expand">' +
          selectInput(fid('fam', m.id, 'gender'), 'op', '',  [{ value: '', label: '性別' }, '男性', '女性'], m.gender || '',
 'A.fam(' + m.id + ",'gender',this.value)") +
          (i === 0 ? '' : selectInput(fid('fam', m.id, 'rel'), 'op', '', REL.filter(function (r) { return r !== '家族１' || m.relation === '家族１'; }), m.relation, 'A.fam(' + m.id + ",'relation',this.value)")) +
          selectInput(fid('fam', m.id, 'job'), 'op', '', JOBS, m.job, 'A.fam(' + m.id + ",'job',this.value)") +
          (i > 0 ? '<button class="btn ghost" style="margin-left:auto" onclick="A.delFamily(' + m.id + ')">' + (ui.confirmDelMember === m.id ? 'もう一度押すと削除' : 'この人を削除') + '</button>' : '') +
          (ui.confirmDelMember === m.id && state.salaries.some(function (sl) { return sl.memberId === m.id; })
            ? '<div class="hint" style="flex-basis:100%;padding:4px 0 0">この人の給与の欄は消えずに、「その他」の人の収入として残ります。いらなければ、収入の欄で「この対象者を外す」を押します。</div>' : '') +
        '</div>' : '') +
      '</div>';
    }).join('');

    return '<h2 class="sec" id="sec-basic">' + ic('tune', 20) + '基本</h2>' +
      '<div class="card">' +
        '<div class="head" style="margin-bottom:9px"><span class="ttl">シミュレーション期間</span>' + helpBtn('period') + '</div>' + helpBox('period') +
        '<div class="rowtop"><span class="u" style="width:44px">開始年</span>' +
          numInput('f-start', 'rq' + bad('start', 'start'), 84, state.startYear, 'A.start(this.value)') + '<span class="u">年から</span>' +
          numInput('f-endage', 'op' + bad('start', 'endAge'), 64, state.endAge, 'A.endAge(this.value)', ';margin-left:auto') + '<span class="u">歳まで</span>' +
        '</div>' +
        vmsgs('start') +
      '</div>' +
      '<div class="card"><div class="head"><span class="ttl">前年末の金融資産</span>' + helpBtn('assets') + '</div>' + helpBox('assets') + assets +
        '<div class="rowtop divide" style="padding:10px 0"><span class="u">普通預金等の利率</span>' +
          numInput('f-deprate', 'op' + bad('deprate', 'depositRate'), 64, state.depositRate || 0, 'A.depositRate(this.value)', ';margin-left:auto') + '<span class="u">％</span></div>' +
        vmsgs('deprate') +
        '<div class="hint" style="padding-top:0">投資資産の名前は自由に変えられ、投資セクションの見出しに反映されます</div>' +
      '</div>' +
      '<div class="card" id="card-family"><div class="head"><span class="ttl">家族構成</span>' + helpBtn('family') + '<span class="cnt">最大6人</span></div>' + helpBox('family') + family +
        (state.family.length < 6 ? addButton('A.addFamily()', '家族を追加') : '') +
      '</div>';
  }

  function inputHTML() {
    var by = baseBirth();
    var h = '';
    if (issueCount) {
      h += '<div class="vbanner">' + ic('warn', 18) + '<span>確認が必要な入力が ' + issueCount + ' 件あります</span>' +
        '<button class="btn" onclick="A.firstIssue()">見る</button></div>';
    }
    h += noticeHTML();
    h += guideHTML();
    if (ageMode()) h += '<div class="hint" style="padding:8px 2px 0">年の欄は家族１の年齢で入れます（給与はその人の、教育費はその子の年齢）。保存は西暦です。</div>';
    h += basicHTML();

    h += '<h2 class="sec" id="sec-income">' + ic('income', 20) + '収入</h2>';
    state.salaries.forEach(function (s, i) { h += salaryCard(s, i); });
    if (state.salaries.length < 3) {
      h += '<div style="display:flex;justify-content:center;margin:-2px 0 12px"><button class="btn ghost" onclick="A.addEarner()">＋ 収入のある人を追加</button></div>';
    }

    h += '<h2 class="sec" id="sec-pension">' + ic('pension', 20) + '年金・退職金</h2>';
    h += groupCard('lump', '退職一時金・その他一時収入', { max: 3, lump: true, memo: true, hint: '不動産の売却や親からの援助もここへ' });
    h += groupCard('corpPension', '企業年金', { max: 5, hasTo: true, memo: true });
    h += groupCard('privPension', '個人年金・保険など', { max: 5, hasTo: true, memo: true, hint: '備考に契約名を書いておくと、あとで見返したときに分かります' });
    h += groupCard('pubPension', '公的年金', { max: 5, requiredFirst: true, dupCheck: true, memo: true, hint: '家族１が65歳＝' + (by + 65) + '年／70歳＝' + (by + 70) + '年。家族全員の合計を手取りの年額で入れます', extra: penCalcHTML('state') });

    h += '<h2 class="sec" id="sec-expense">' + ic('expense', 20) + '支出</h2>';
    h += groupCard('living', '基本生活費', { monthly: true, max: 5, requiredFirst: true, anchorFirst: true, inflation: true, dupCheck: true, memo: true, hint: '住宅費・教育費・保険料・自動車・その他を除いた、ふだんの支出。2行目以降は今の物価で入れれば、物価上昇を足して計算します。' });
    h += groupCard('housing', '住宅費', { monthly: true, max: 5, requiredFirst: true, anchorFirst: true, dupCheck: true, memo: true, hint: '家賃・ローン・修繕/管理費・固定資産税の合計', extra: loanCalcHTML() });
    h += groupCard('housingLump', '住宅費一時金（頭金など）', { max: 3, lump: true, memo: true });
    E.children(state).forEach(function (c) { h += eduCard(c); });
    h += groupCard('insurance', '保険料', { monthly: true, max: 7, requiredFirst: true, dupCheck: true, memo: true });
    h += groupCard('carCost', '自動車の維持費', { monthly: true, max: 5, dupCheck: true, memo: true, hint: '税金・保険・車検・駐車場・整備の年額。下の購入費の「◯歳まで」（今は' + state.carBuy.untilAge + '歳）を過ぎた年からは、車を手放したとみなして0になります。' });
    h += carCard();
    h += groupCard('otherFlow', 'その他の経常支出', { monthly: true, max: 5, dupCheck: true, memo: true, hint: '同じ年は1行にまとめます（趣味と旅行なら合算して1行）' });
    h += groupCard('otherLump', 'その他の一時支出', { max: 5, lump: true, memo: true, hint: '子供の結婚の援助、留学費など' });

    h += '<h2 class="sec" id="sec-invest">' + ic('invest', 20) + '投資</h2>';
    state.assets.filter(function (a) { return !a.fixed; }).forEach(function (a) {
      h += investCard(a, 'add', a.name + 'へ積立', true);
      h += investCard(a, 'out', a.name + 'の現金化', false);
    });

    h += '<footer class="done">入力はここまでです。おつかれさまでした。</footer>';
    h += '<div class="reset">' + (ui.confirmReset
      ? '<div class="q">表示中のプランの入力をすべて消して、記入例の内容に戻しますか？</div><div class="row"><button class="btn" onclick="A.resetYes()">記入例に戻す</button><button class="btn ghost" onclick="A.resetNo()">やめる</button></div>'
      : '<button class="btn ghost" onclick="A.resetAsk()">このプランを記入例の内容に戻す</button>') + '</div>';
    return h;
  }

  // ---------- サマリーバー ----------

  function sparkPath(values, w, h) {
    var max = Math.max.apply(null, values.concat([0]));
    var min = Math.min.apply(null, values.concat([0]));
    var span = max - min || 1;
    var pts = values.map(function (v, i) {
      return [(i / Math.max(1, values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var zeroY = h - 2 - ((0 - min) / span) * (h - 4);
    return { line: line, area: line + ' L' + w + ',' + zeroY.toFixed(1) + ' L0,' + zeroY.toFixed(1) + ' Z', zeroY: zeroY, hasNeg: min < 0 };
  }

  function summaryHTML() {
    if (!result.years.length) {
      return '<div class="warnline">' + ic('warn', 18) + '<span>計算できません</span><span class="worst" style="font-size:13.5px">期間と生年月日を確認</span></div>';
    }
    var sp = sparkPath(result.years.map(function (r) { return r.assets.total; }), 340, 30);
    var warn = !!result.shortfall;
    var head = warn
      ? '<div class="warnline">' + ic('warn', 18) + '<span>' + result.shortfall.age + '歳で預金が不足</span>' +
        '<span class="worst">最大 ' + man(result.shortfall.minDeposit) + '万円</span></div>'
      : '<div class="row"><span class="lbl">終了時点（' + result.endAge + '歳）の金融資産</span><span class="amt">' + man(result.endTotal) + '<span class="unit"> 万円</span></span></div>';
    var stroke = warn ? 'var(--neg)' : 'var(--sage)';
    var fill = warn ? 'var(--neg-soft)' : 'var(--sage-soft)';
    return head +
      '<svg viewBox="0 0 340 30" width="100%" height="30" preserveAspectRatio="none" aria-hidden="true">' +
        '<path d="' + sp.area + '" fill="' + fill + '" fill-opacity=".9"/>' +
        (sp.hasNeg ? '<line x1="0" x2="340" y1="' + sp.zeroY.toFixed(1) + '" y2="' + sp.zeroY.toFixed(1) + '" stroke="var(--text-faint)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' : '') +
        '<path d="' + sp.line + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '</svg>';
  }

  // 入力を変えたら、終了時点の金融資産がいくら動いたかを数秒だけ出す
  function showDelta() {
    var now = result.years.length ? result.endTotal : null;
    var prev = lastEnd;
    lastEnd = now;
    if (quiet) { quiet = false; return; }
    if (prev == null || now == null || ui.view !== 'input') return;
    var d = Math.round(now - prev);
    if (!d) return;
    var el = document.getElementById('delta');
    el.className = 'delta ' + (d > 0 ? 'up' : 'down');
    el.innerHTML = '<span class="k">今の変更で</span>' + (d > 0 ? '＋' : '−') + Math.abs(d).toLocaleString('ja-JP') + '<span class="k">万円</span>';
    el.setAttribute('aria-label', '終了時点の金融資産が' + Math.abs(d).toLocaleString('ja-JP') + '万円' + (d > 0 ? '増えました' : '減りました'));
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(function () {
      el.classList.remove('show');
      deltaTimer = setTimeout(function () { el.hidden = true; }, 250);
    }, 2600);
  }

  // ---------- CF表画面 ----------


  function niceStep(range, target) {
    var raw = range / target;
    var pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var n = raw / pow;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  }

  function chartSVG(width) {
    var ys = result.years;
    var W = Math.max(280, width), H = 210;
    var L = 54, R = 8, T = 10, B = 34;
    var pw = W - L - R, ph = H - T - B;
    var top = 0, bottom = 0;
    ys.forEach(function (r) {
      var d = r.assets.deposit, v = Math.max(0, r.assets.investTotal);
      top = Math.max(top, (d > 0 ? d : 0) + v);
      bottom = Math.min(bottom, d);
    });
    var step = niceStep((top - bottom) || 1, 4);
    var yMax = Math.ceil(top / step) * step || step;
    var yMin = Math.floor(bottom / step) * step;
    function sy(v) { return T + (yMax - v) / (yMax - yMin) * ph; }
    var slot = pw / ys.length;
    var bw = Math.max(1.5, slot - 2);
    var g = '';
    for (var t = yMin; t <= yMax + 1e-9; t += step) {
      var y = sy(t).toFixed(1);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)" stroke-width="1"/>';
      g += '<text x="' + (L - 6) + '" y="' + (+y + 3.5) + '" text-anchor="end">' + man(t) + '</text>';
    }
    var bars = '';
    ys.forEach(function (r, i) {
      var x = (L + i * slot + (slot - bw) / 2).toFixed(1);
      var d = r.assets.deposit, v = Math.max(0, r.assets.investTotal);
      if (d >= 0) {
        if (d > 0) bars += '<rect x="' + x + '" y="' + sy(d).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, sy(0) - sy(d)).toFixed(1) + '" fill="var(--c-deposit)"/>';
        if (v > 0) bars += '<rect x="' + x + '" y="' + sy(d + v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, sy(d) - sy(d + v) - 1.5).toFixed(1) + '" fill="var(--c-invest)"/>';
      } else {
        if (v > 0) bars += '<rect x="' + x + '" y="' + sy(v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, sy(0) - sy(v)).toFixed(1) + '" fill="var(--c-invest)"/>';
        bars += '<rect x="' + x + '" y="' + sy(0).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, sy(d) - sy(0)).toFixed(1) + '" fill="var(--c-deposit)"/>';
      }
    });
    var zero = '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '" stroke="var(--text-muted)" stroke-width="1"/>';
    var xl = '';
    ys.forEach(function (r, i) {
      if (r.year % 10 !== 0) return;
      var cx = (L + i * slot + slot / 2).toFixed(1);
      xl += '<text x="' + cx + '" y="' + (H - B + 14) + '" text-anchor="middle">' + r.year + '</text>';
      xl += '<text x="' + cx + '" y="' + (H - B + 27) + '" text-anchor="middle">' + r.age + '歳</text>';
    });
    var desc = '金融資産残高の推移。' + ys[0].year + '年 ' + man(ys[0].assets.total) + '万円から、' + ys[ys.length - 1].year + '年 ' + man(result.endTotal) + '万円。';
    chartGeom = { L: L, slot: slot, W: W, n: ys.length, T: T, ph: ph };
    return '<svg id="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(desc) + '">' +
      g + bars + zero + xl +
      '<rect id="hl" x="0" y="' + T + '" width="' + slot.toFixed(1) + '" height="' + ph + '" fill="var(--text)" fill-opacity=".08" visibility="hidden"/>' +
      '</svg>';
  }
  var chartGeom = null;

  function bindChart() {
    var svg = document.getElementById('chart');
    var tip = document.getElementById('tip');
    if (!svg || !tip) return;
    function show(ev) {
      var rect = svg.getBoundingClientRect();
      var scale = chartGeom.W / rect.width;
      var x = (ev.clientX - rect.left) * scale;
      var i = Math.floor((x - chartGeom.L) / chartGeom.slot);
      if (i < 0 || i >= chartGeom.n) { hide(); return; }
      var r = result.years[i];
      var hl = document.getElementById('hl');
      hl.setAttribute('x', (chartGeom.L + i * chartGeom.slot).toFixed(1));
      hl.setAttribute('visibility', 'visible');
      tip.innerHTML = '<div class="t">' + r.year + '年（' + r.age + '歳）</div>' +
        '<div class="r"><i style="background:var(--c-deposit)"></i>普通預金等<b>' + man(r.assets.deposit) + '万</b></div>' +
        '<div class="r"><i style="background:var(--c-invest)"></i>投資資産<b>' + man(r.assets.investTotal) + '万</b></div>' +
        '<div class="r sum">合計<b>' + man(r.assets.total) + '万</b></div>';
      tip.hidden = false;
      var card = svg.parentNode.getBoundingClientRect();
      var px = ev.clientX - card.left;
      var tw = tip.offsetWidth;
      var left = px + 14 + tw > card.width ? px - 14 - tw : px + 14;
      tip.style.left = Math.max(6, left) + 'px';
      tip.style.top = '44px';
    }
    function hide() {
      tip.hidden = true;
      var hl = document.getElementById('hl');
      if (hl) hl.setAttribute('visibility', 'hidden');
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function (ev) { if (ev.pointerType === 'mouse') hide(); });
  }

  function tableHTML() {
    var ys = result.years;
    function row(label, values, cls, swatch) {
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + (swatch ? '<span class="sw" style="background:' + swatch + '"></span>' : '') + esc(label) + '</td>' +
        values.map(function (v) {
          if (v === null) return '<td></td>';
          var c = Math.round(v) === 0 ? ' class="z"' : v < 0 ? ' class="neg"' : '';
          return '<td' + c + '>' + man(v) + '</td>';
        }).join('') + '</tr>';
    }
    function grp(label) { return '<tr class="grp"><td>' + label + '</td>' + ys.map(function () { return '<td></td>'; }).join('') + '</tr>'; }
    function col(f) { return ys.map(f); }

    var h = '<thead><tr><th>年</th>' + ys.map(function (r) { return '<th>' + r.year + '</th>'; }).join('') + '</tr></thead><tbody>';
    state.family.forEach(function (m, i) {
      h += '<tr class="age"><td>' + esc(m.name || m.relation) + '</td>' + ys.map(function (r) {
        var a = r.ages[i]; return '<td>' + (a == null ? '' : a) + '</td>';
      }).join('') + '</tr>';
    });
    h += grp('収入');
    state.salaries.forEach(function (s, i) { h += row(memberName(s.memberId) + 'の給与', col(function (r) { return r.income.salaries[i]; })); });
    h += row('退職金・年金等', col(function (r) { return r.income.pension; }));
    result.investNames.forEach(function (n, i) { h += row(n + 'の現金化', col(function (r) { return r.income.withdrawals[i]; })); });
    h += row('収入計', col(function (r) { return r.income.total; }), 'sum');
    h += grp('支出');
    h += row('基本生活費', col(function (r) { return r.expense.living; }));
    h += row('住宅費', col(function (r) { return r.expense.housing; }));
    h += row('教育費', col(function (r) { return r.expense.education; }));
    h += row('保険料', col(function (r) { return r.expense.insurance; }));
    h += row('自動車', col(function (r) { return r.expense.car; }));
    h += row('その他', col(function (r) { return r.expense.other; }));
    result.investNames.forEach(function (n, i) { h += row(n + 'へ積立', col(function (r) { return r.expense.contributions[i]; })); });
    h += row('支出計', col(function (r) { return r.expense.total; }), 'sum');
    h += row('年間収支', col(function (r) { return r.balance; }), 'sum grp');
    h += grp('年末の金融資産');
    h += row('普通預金等', col(function (r) { return r.assets.deposit; }), '', 'var(--c-deposit)');
    result.investNames.forEach(function (n, i) { h += row(n, col(function (r) { return r.assets.investments[i]; })); });
    h += row('投資資産計', col(function (r) { return r.assets.investTotal; }), '', 'var(--c-invest)');
    h += row('合計', col(function (r) { return r.assets.total; }), 'sum');
    return '<table class="cf">' + h + '</tbody></table>';
  }

  function cfHTML(width) {
    var last = result.years[result.years.length - 1];
    if (!last) {
      return '<div class="alert" style="margin-top:12px">' + ic('warn', 19) + '<span>計算できる年がありません。入力画面で、開始年・終了年齢・家族１の生年月日を確かめてください。</span></div>' +
        '<div style="text-align:center;margin-top:6px"><button class="btn ghost" onclick="A.view(\'input\')">入力に戻る</button></div>';
    }
    var sf = result.shortfall;
    var basis = state.bookBasis;
    var basisRel = basis ? window.LifePlanBook.reliability(basis.months, basis.matched) : null;
    return (basis ? '<button class="basis lv' + basisRel.level + '" onclick="A.view(\'book\')">' + ic('book', 18) + '<span>家計簿（' + basis.year + '年・' + basis.months + 'か月分）の実績にもとづくプラン<b>信頼度：' + basisRel.label + '</b></span></button>' : '') +
      '<div class="hero"><div class="k">終了時点（' + last.year + '年・家族１ ' + last.age + '歳）の金融資産</div>' +
        '<div class="v">' + man(result.endTotal) + '<small> 万円</small></div>' +
        '<div class="note">うち普通預金等 ' + man(last.assets.deposit) + '万円・投資資産 ' + man(last.assets.investTotal) + '万円</div></div>' +
      (sf ? '<div class="alert">' + ic('warn', 19) + '<span>' + sf.year + '年（家族１が' + sf.age + '歳）に普通預金等がマイナスになります。最も少ない年で ' + man(sf.minDeposit) + '万円です。</span></div>' : '') +
      '<div class="card chartcard"><h2 class="h3">金融資産残高の推移</h2>' +
        '<div class="keys"><span><i style="background:var(--c-deposit)"></i>普通預金等</span><span><i style="background:var(--c-invest)"></i>投資資産</span></div>' +
        chartSVG(width) +
        '<div class="tip" id="tip" hidden></div>' +
      '</div>' +
      '<div class="card tablecard"><h2 class="h3">キャッシュフロー表</h2><div class="sub">単位：万円。横にスクロールできます。</div>' +
        '<div class="tablewrap" tabindex="0" role="region" aria-label="キャッシュフロー表（横にスクロールできます）">' + tableHTML() + '</div>' +
      '</div>' +
      '<div style="text-align:center;margin-top:6px"><button class="btn ghost" onclick="A.view(\'input\')">入力に戻る</button></div>' +
      DISCLAIMER;
  }

  // ---------- 公的年金の試算（入力シート T85:AL91） ----------
  //
  // 入力画面（mode 'state'）とかんたん入力（mode 'wz'）で同じ部品を使う。
  // 試算の入力は { adjust: 90, people: { <人のキー>: { from, to, payFrom, payTo, basic } } } の形で、
  // 入力画面では state.penCalc、かんたん入力では答えの penCalc に置く。計算エンジンの結果には影響しない。

  function penPeople(mode) {
    if (mode === 'wz') {
      var d = ui.wz.d, out = [{ key: 1, label: d.name1 || '家族１', by: E.parseDate(d.birth1).y }];
      if (d.has2) out.push({ key: 2, label: d.name2 || '家族２', by: E.parseDate(d.birth2).y });
      return out;
    }
    return state.family
      .filter(function (m) { return m.relation === '家族１' || m.relation === '家族２'; })
      .map(function (m) { return { key: m.id, label: memberName(m.id), by: E.parseDate(m.birth).y || baseBirth() }; });
  }
  function penData(mode, create) {
    var holder = mode === 'wz' ? ui.wz.d : state;
    if (!holder.penCalc && create) holder.penCalc = { adjust: 90, people: {} };
    return holder.penCalc || { adjust: 90, people: {} };
  }
  function penPerson(mode, p) {
    var saved = penData(mode).people[p.key] || {};
    var d = E.pensionDefaults(p.by);
    Object.keys(d).forEach(function (k) { if (saved[k] !== undefined) d[k] = saved[k]; });
    return d;
  }
  function penTotal(mode) {
    var pc = penData(mode);
    var sum = penPeople(mode).reduce(function (s, p) { return s + E.pensionEstimate(penPerson(mode, p), pc.adjust).total; }, 0);
    return Math.round(sum * 10) / 10;
  }

  function penCalcHTML(mode) {
    var open = ui.penOpen[mode];
    var pc = penData(mode);
    var head = '<button class="toggle" onclick="A.penToggle(\'' + mode + '\')">' + ic('calc', 18, 'lead') +
      '<span class="lbl">見込額がわからないときは、ここで試算する</span><span class="chev">' + chevron(open) + '</span></button>';
    if (!open) return '<div class="divide">' + head + '</div>';
    var people = penPeople(mode).map(function (p) {
      var v = penPerson(mode, p);
      var r = E.pensionEstimate(v, pc.adjust);
      var q = "'" + mode + "'," + p.key;
      var id = function (f) { return 'f-pen-' + mode + '-' + p.key + '-' + f; };
      var reversed = toNum(v.from) && toNum(v.to) && toNum(v.to) < toNum(v.from);
      return '<div class="penp">' +
        '<div class="pnm">' + esc(p.label) + '</div>' +
        '<div class="u" style="margin-top:6px">会社員・公務員として働く（働いた）期間</div>' +
        '<div class="calcrow">' +
          numInput(id('from'), 'op' + (reversed ? ' bad' : ''), 76, yv(v.from, p.by), 'A.pen(' + q + ",'from'," + yin(p.by) + ')', ';background:var(--surface)') + '<span class="u">' + suf('from') + '</span>' +
          numInput(id('to'), 'op' + (reversed ? ' bad' : ''), 76, yv(v.to, p.by), 'A.pen(' + q + ",'to'," + yin(p.by) + ')', ';background:var(--surface)') + '<span class="u">' + suf('to') + '</span>' +
        '</div>' +
        (reversed ? '<div class="vmsg error">' + ic('warn', 15) + '<span>「まで」が「から」より前です</span></div>' : '') +
        '<div class="calcrow"><span class="u" style="width:96px">手取り年収 はじめ</span>' +
          numInput(id('payFrom'), 'op', 84, v.payFrom, 'A.pen(' + q + ",'payFrom',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">万円</span></div>' +
        '<div class="calcrow"><span class="u" style="width:96px">手取り年収 終わり</span>' +
          numInput(id('payTo'), 'op', 84, v.payTo, 'A.pen(' + q + ",'payTo',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">万円</span></div>' +
        '<div class="calcrow"><span class="u" style="width:96px">基礎年金</span>' +
          numInput(id('basic'), 'op', 84, v.basic, 'A.pen(' + q + ",'basic',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">万円</span></div>' +
        '<div class="penres"><span class="u">（報酬比例 ' + r.earn + ' ＋ 基礎 ' + man(r.basic) + '）× ' + toNum(pc.adjust) + '％</span>' +
          '<b>' + r.total.toLocaleString('ja-JP') + '</b><span class="u" style="font-weight:700">万円</span></div>' +
      '</div>';
    }).join('');
    var total = penTotal(mode);
    return '<div class="divide">' + head +
      '<div class="calcbox">' +
        '<div class="hint" style="padding:0 0 4px">厚生年金に入っている（いた）期間と、そのはじめと終わりの手取り年収から、おおざっぱに見積もります。自営業や専業主婦（夫）の期間しかない人は、手取りを0にすると基礎年金だけになります。</div>' +
        people +
        '<div class="calcrow" style="margin-top:12px"><span class="u">将来の目減りを見込んだ割合</span>' +
          numInput('f-pen-' + mode + '-adj', 'op', 64, pc.adjust, "A.penAdj('" + mode + "',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">％</span></div>' +
        '<div class="hint" style="padding:4px 0 0">所得代替率の低下を見込んで9割にしています（Excelと同じ）。' +
          '<a href="https://www.excelcf.net/lossofpension/" target="_blank" rel="noopener">20～30年後、公的年金は今より1割くらい減少？</a></div>' +
        '<div class="calcresult"><span class="u" style="font-weight:700">受け取る年金（年額・合計）</span>' +
          '<span style="font-size:20px;font-weight:900;color:var(--accent-ink);margin-left:auto">' + total.toLocaleString('ja-JP') + '</span><span class="u" style="font-weight:700">万円</span></div>' +
        '<button class="btn block" onclick="A.penApply(\'' + mode + '\')">' + (mode === 'wz' ? 'この金額を使う' : '公的年金の1行目に反映する') + '</button>' +
      '</div>' +
    '</div>';
  }

  A.penToggle = function (mode) { ui.penOpen[mode] = !ui.penOpen[mode]; commit(); };
  A.pen = function (mode, key, field, v) {
    var p = penPeople(mode).filter(function (x) { return x.key === key; })[0];
    if (!p) return;
    var pc = penData(mode, true);
    var cur = penPerson(mode, p);
    cur[field] = String(v).trim() === '' ? '' : toNum(v);
    pc.people[key] = cur;
    commit();
  };
  A.penAdj = function (mode, v) { penData(mode, true).adjust = toNum(v); commit(); };
  A.penApply = function (mode) {
    var total = penTotal(mode);
    if (mode !== 'wz') snapshot('公的年金の1行目を試算した額にしました');
    ui.penOpen[mode] = false;
    if (mode === 'wz') {
      ui.wz.d.pension = total;
      delete ui.wz.err.pension;
    } else {
      var rows = state.pubPension;
      if (rows.length) {
        rows[0].amount = total;
        if (!rows[0].memo) rows[0].memo = '試算した額';
      } else {
        rows.push({ id: nid(), year: baseBirth() + 65, amount: total, memo: '試算した額' });
      }
    }
    commit();
  };

  // ---------- 住宅ローンの試算（入力シート T114:AH125、住宅ローン返済表シート） ----------
  //
  // 試算の入力は state.loanCalc に置く：{ start, amount, years, phases: [{ rate, years }], upkeep }。
  // 計算エンジンの結果には影響せず、「住宅費に反映する」で住宅費の行を作る。

  function loanData(create) {
    if (!state.loanCalc && create) {
      state.loanCalc = { start: state.startYear, amount: '', years: 35, phases: [{ rate: 1, years: 10 }, { rate: 2, years: '' }], upkeep: 50 };
    }
    return state.loanCalc || { start: state.startYear, amount: '', years: 35, phases: [{ rate: 1, years: 10 }, { rate: 2, years: '' }], upkeep: 50 };
  }
  function ylabel(year, by) { return ageMode() ? '家族１が' + (year - by) + '歳' : year + '年'; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function f1(v) { return r1(v).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }

  // 反映したときの住宅費の行（年・年額・備考）。完済後は修繕・管理費等だけ
  function loanRows(lc, sch) {
    var start = toNum(lc.start), up = toNum(lc.upkeep);
    var rows = sch.phases.map(function (ph, k) {
      return { year: start + ph.from, amount: r1(ph.annual + up), memo: '住宅ローン（' + (k ? '金利' + ph.rate + '%に変わってから' : '当初金利' + ph.rate + '%') + '）＋修繕・管理費等' };
    });
    if (sch.phases.length) rows.push({ year: start + sch.years, amount: r1(up), memo: '完済後の修繕・管理費等' });
    return rows;
  }

  // 今の住宅費の行のうち、反映で置き換わるもの（1行目は開始年からなので、借入が開始年以前なら1行目も）
  function loanReplaced(lc) {
    var start = toNum(lc.start);
    return state.housing.filter(function (r, i) { return i === 0 ? start <= state.startYear : toNum(r.year) >= start; });
  }

  function loanCalcHTML() {
    var open = ui.loanOpen;
    var head = '<button class="toggle" onclick="A.loanToggle()">' + ic('calc', 18, 'lead') +
      '<span class="lbl">住宅ローンを試算する</span><span class="chev">' + chevron(open) + '</span></button>';
    if (!open) return '<div class="divide">' + head + '</div>';
    var lc = loanData(), by = baseBirth();
    var sch = E.loanSchedule(lc);
    var bg = ';background:var(--surface)';
    var nPh = lc.phases.length;
    var usedBeforeLast = lc.phases.slice(0, -1).reduce(function (s, p) { return s + toNum(p.years); }, 0);
    var over = nPh > 1 && usedBeforeLast >= toNum(lc.years);
    var phases = lc.phases.map(function (ph, k) {
      var last = k === nPh - 1;
      var rest = Math.max(0, toNum(lc.years) - usedBeforeLast);
      return '<div class="calcrow">' +
        '<span class="u" style="width:58px">' + (k === 0 ? '当初金利' : (k + 1) + '段階目') + '</span>' +
        numInput('f-loan-rate-' + k, 'op', 64, ph.rate, 'A.loanPh(' + k + ",'rate',this.value)", bg) + '<span class="u">％を</span>' +
        (last ? '<span class="u" style="font-weight:700">残り' + rest + '年間</span>'
              : numInput('f-loan-yrs-' + k, 'op' + (over ? ' bad' : ''), 56, ph.years, 'A.loanPh(' + k + ",'years',this.value)", bg) + '<span class="u">年間</span>') +
        (k > 0 ? '<button class="del" style="width:36px;height:36px" aria-label="この金利の段階を外す" onclick="A.loanPhDel(' + k + ')">' + ic('del', 18) + '</button>' : '') +
      '</div>';
    }).join('');
    var rows = loanRows(lc, sch);
    var res = toNum(lc.amount) > 0 && sch.phases.length
      ? '<div class="loanres">' + sch.phases.map(function (ph, k) {
          return '<div class="lr"><span class="y">' + ylabel(toNum(lc.start) + ph.from, by) + '〜</span>' +
            '<span class="u">返済 年' + f1(ph.annual) + '万円（月' + f1(ph.monthly) + '万円）</span>' +
            '<span class="v">' + f1(rows[k].amount) + '<small>万円</small></span></div>';
        }).join('') +
        '<div class="lr"><span class="y">' + ylabel(toNum(lc.start) + sch.years, by) + '〜</span><span class="u">完済。修繕・管理費等だけ</span>' +
          '<span class="v">' + f1(toNum(lc.upkeep)) + '<small>万円</small></span></div>' +
        '<div class="hint" style="padding:2px 0 0">右の金額が、その年からの住宅費（返済＋修繕・管理費等の年額）です</div>' +
        '</div>' +
        '<div class="calcresult"><span class="u" style="font-weight:700">返済総額</span>' +
          '<span class="u">うち利息 ' + man(sch.interest) + '万円</span>' +
          '<span style="font-size:20px;font-weight:900;color:var(--accent-ink);margin-left:auto">' + man(sch.total) + '</span><span class="u" style="font-weight:700">万円</span></div>'
      : '<div class="hint" style="padding:10px 0 0">借入額を入れると計算します</div>';
    var table = '';
    if (ui.loanTable && sch.yearly.length) {
      table = '<div class="tablewrap loantable"><table class="cf"><thead><tr><th>年</th><th>返済額</th><th>元金</th><th>利息</th><th>年末残高</th></tr></thead><tbody>' +
        sch.yearly.map(function (y) {
          return '<tr><td>' + (toNum(lc.start) + y.index) + '</td><td>' + f1(y.pay) + '</td><td>' + f1(y.principal) + '</td><td>' + f1(y.interest) + '</td><td>' + man(y.balance) + '</td></tr>';
        }).join('') +
        '<tr class="sum"><td>合計</td><td>' + man(sch.total) + '</td><td>' + man(toNum(lc.amount)) + '</td><td>' + man(sch.interest) + '</td><td></td></tr>' +
        '</tbody></table></div>';
    }
    var replaced = loanReplaced(lc);
    var confirm = ui.loanConfirm
      ? '<div class="plconfirm ok"><span>' + ylabel(toNum(lc.start), by) + '以降の住宅費の行（' + replaced.length + '行）を、試算の結果で置き換えます。</span>' +
        '<button class="btn" onclick="A.loanApply(true)">置き換える</button><button class="btn ghost" onclick="A.loanApplyNo()">やめる</button></div>'
      : '';
    return '<div class="divide">' + head +
      '<div class="calcbox">' +
        '<div class="calcrow"><span class="u" style="width:58px">借入開始</span>' +
          numInput('f-loan-start', 'op', 76, yv(lc.start, by), "A.loan('start'," + yin(by) + ')', bg) + '<span class="u">' + suf('from') + '</span></div>' +
        '<div class="calcrow"><span class="u" style="width:58px">借入額</span>' +
          numInput('f-loan-amount', 'op', 84, lc.amount, "A.loan('amount',this.value)", bg) + '<span class="u">万円</span>' +
          numInput('f-loan-years', 'op', 52, lc.years, "A.loan('years',this.value)", ';margin-left:auto' + bg) + '<span class="u">年返済</span></div>' +
        phases +
        (over ? '<div class="vmsg error">' + ic('warn', 15) + '<span>金利の期間の合計が返済期間を超えています</span></div>' : '') +
        (nPh < 3 ? '<button class="btn ghost" style="margin-top:9px;background:var(--surface)" onclick="A.loanPhAdd()">＋ 金利が変わる時期を追加</button>' : '') +
        '<div class="calcrow" style="margin-top:12px"><span class="u">修繕・管理費、固定資産税（年）</span>' +
          numInput('f-loan-upkeep', 'op', 64, lc.upkeep, "A.loan('upkeep',this.value)", ';margin-left:auto' + bg) + '<span class="u">万円</span></div>' +
        res +
        (sch.yearly.length && toNum(lc.amount) > 0 ? '<button class="toggle" onclick="A.loanTableToggle()"><span class="lbl">年ごとの返済表</span><span class="chev">' + chevron(ui.loanTable) + '</span></button>' + table : '') +
        '<div class="hint" style="padding:8px 0 0">元利均等返済で計算します。金利が変わったあとは、その時点の残高を残りの期間で返す額になります。頭金は「住宅費一時金」に入れます。' +
          '<a href="https://www.excelcf.net/hayamihyo/" target="_blank" rel="noopener">返済額早見表</a>・' +
          '<a href="https://www.excelcf.net/hiritsu/" target="_blank" rel="noopener">安全な返済比率</a></div>' +
        (toNum(lc.amount) > 0 && sch.phases.length ? (confirm || '<button class="btn block" onclick="A.loanApply(false)">住宅費に反映する</button>') : '') +
      '</div>' +
    '</div>';
  }

  A.loanToggle = function () { ui.loanOpen = !ui.loanOpen; ui.loanConfirm = false; commit(); };
  A.loanTableToggle = function () { ui.loanTable = !ui.loanTable; commit(); };
  A.loan = function (field, v) { loanData(true)[field] = String(v).trim() === '' ? '' : toNum(v); ui.loanConfirm = false; commit(); };
  A.loanPh = function (k, field, v) {
    var ph = loanData(true).phases[k]; if (!ph) return;
    ph[field] = String(v).trim() === '' ? '' : toNum(v);
    ui.loanConfirm = false;
    commit();
  };
  A.loanPhAdd = function () {
    var lc = loanData(true);
    if (lc.phases.length >= 3) return;
    var used = lc.phases.slice(0, -1).reduce(function (s, p) { return s + toNum(p.years); }, 0);
    var last = lc.phases[lc.phases.length - 1];
    // 今の最後の段階に年数を入れて（残りの半分ほど）、その後ろに新しい段階を足す
    last.years = Math.max(1, Math.floor((toNum(lc.years) - used) / 2));
    lc.phases.push({ rate: last.rate, years: '' });
    commit();
  };
  A.loanPhDel = function (k) {
    var lc = loanData(true);
    if (k < 1 || lc.phases.length < 2) return;
    lc.phases.splice(k, 1);
    commit();
  };
  A.loanApplyNo = function () { ui.loanConfirm = false; commit(); };
  A.loanApply = function (sure) {
    var lc = loanData(true);
    var sch = E.loanSchedule(lc);
    if (!(toNum(lc.amount) > 0) || !sch.phases.length) return;
    if (!sure && loanReplaced(lc).length) { ui.loanConfirm = true; commit(); return; }
    snapshot('住宅費の行を試算の結果にしました');
    applyLoan(lc);
    ui.loanConfirm = false;
    ui.loanOpen = false;
    commit();
  };

  // 試算の結果で、借入開始年以降の住宅費の行を置き換える（今の state に対して）
  function applyLoan(lc) {
    var sch = E.loanSchedule(lc);
    var start = toNum(lc.start), sy = state.startYear;
    var gen = loanRows(lc, sch);
    var head = state.housing[0] || { id: nid(), year: sy, amount: 0, memo: '' };
    // 開始年までに始まっている分は1行目（開始年から）にまとめる
    var atStart = gen.filter(function (r) { return r.year <= sy; }).pop();
    if (atStart) { head.amount = atStart.amount; head.memo = atStart.memo; }
    var keep = state.housing.slice(1).filter(function (r) { return toNum(r.year) < start; });
    state.housing = [head].concat(keep, gen.filter(function (r) { return r.year > sy; }).map(function (r) {
      return { id: nid(), year: r.year, amount: r.amount, memo: r.memo };
    }));
  }

  // ---------- 「？」で開くFPのひとこと ----------

  var HELP = {
    period: '計算を始める年と、家族１が何歳になるまで計算するかです。開始年はふつう今年にします。長生きに備えて、90〜100歳くらいまで見ておくと安心です。',
    assets: '開始年の前の年の12月末の残高を入れます。普通預金・定期預金など、すぐ使えるお金は「普通預金等」に。NISAやiDeCo、投資信託などは今の評価額を入れます。投資の名前は書き換えられます。預金の利率は低めに見ておくのがおすすめで、0のままでも結果はほとんど変わりません。',
    family: '一緒に暮らす家族を入れます。家族１は家計の中心になる人です。子供の生年月日から、教育費が自動で入ります。4月1日までに生まれた子（早生まれ）は、学年が1つ上になります。',
    salary: '給与は「手取り」の1年分（ボーナスも含む）で入れます。手取りは、額面から税金と社会保険料を引いた額で、額面の75〜85％くらいが目安です。上昇率は毎年の昇給の目安で、横ばいなら0％。転職や時短で変わるなら、その年から行を足します。',
    lump: '退職金、相続・贈与、不動産の売却など、一度だけ入るお金です。税金を引いた手取りで入れます。退職金は、会社の退職金規程や見込額の資料で確かめられます。',
    corpPension: '会社から年金として受け取るお金（企業年金）です。受け取る期間と、1年あたりの額を入れます。',
    privPension: '個人年金保険など、自分で準備した年金です。保険証券に、受け取りが始まる年齢と年金額が書いてあります。',
    pubPension: '国の年金（老齢基礎年金・老齢厚生年金）です。ねんきん定期便の見込額が目安で、税・社会保険料が引かれるので手取りはその9割ほどです。受け取り始めを遅らせると増え、早めると減ります。わからなければ下の「試算する」を使ってください。',
    living: '食費・日用品・水道光熱費・通信費・おこづかいなど、ふだんの生活費の1年分です。住宅費・教育費・保険料・車などは別の欄に入れます。月の額×12で出すと近くなります。物価上昇率は、生活費が毎年どれくらい上がるかで、日本銀行は年2％を目標にしています。控えめに0.5〜1％、慎重に見るなら2％で試してみましょう。',
    housing: '家賃や住宅ローンの返済、管理費・修繕積立金、固定資産税など、住まいにかかる1年分です。住み替えやローン完済で変わるなら、その年から行を足します。住宅ローンは下の「試算する」で計算できます。',
    housingLump: '頭金、引っ越し、リフォームなど、住まいのために一度だけ出るお金です。',
    edu: '子供の生年月日から在学年が自動で入り、公立・私立などを選ぶと目安の金額が入ります。塾や習い事の費用も見込みたいときは、金額を書き換えてください。',
    insurance: '生命保険・医療保険・学資保険などの保険料の1年分です。自動車保険は「自動車の維持費」に入れます。見直しで変わる予定があれば、その年から行を足します。',
    carCost: '自動車税、自動車保険、車検、駐車場、ガソリン、メンテナンスなどの1年分です。車を持たないなら空のままにします。',
    carBuy: '車の買い替えです。最初に買う年、何年ごとに買うか、何歳まで買うか、1回あたりの金額を入れます。回ごとに金額を変えることもできます。',
    otherFlow: '毎年かかる、ほかの欄に当てはまらない支出です。旅行・趣味・帰省・ペット・仕送りなどをまとめて入れます。',
    otherLump: '結婚式、出産、子供の結婚の援助、留学、大きな家電など、一度だけ出る支出です。',
    investAdd: 'NISAやiDeCoなどに、毎年いくら積み立てるかです（月3万円なら36）。積み立てた分は普通預金等から移り、想定利回りで増えていきます。想定利回りは将来の見込みなので、控えめな数字で試すと安心です。税率は、NISA・iDeCoなら0％、それ以外の投資信託や株なら20％を選びます。',
    bookIncome: '給与やボーナスは、口座に振り込まれた手取りの額を入れます。種類（給与・ボーナス・その他）は「項目・口座を編集する」で変えられ、ライフプランへの反映のときに、だれの収入かを見分けるのに使います。',
    bookAccounts: '月末の口座の残高を入れると、「前年末の残高＋その年の収支」と比べて差額を出します。差額が0なら、その月の記録に漏れがないということです。家計簿の正しさの裏付けになり、ライフプランの信頼度も上がります。',
    investOut: '積み立てた資産を取り崩して、生活費などにあてる予定です。iDeCoは、原則として60歳まで引き出せません。'
  };

  // 欄の見出しの横の「？」。id は画面上で一つに決まる名前、key は HELP の項目
  function helpBtn(id, key) {
    var open = ui.help === id;
    return '<button class="hq' + (open ? ' on' : '') + '" aria-expanded="' + open + '" aria-label="この欄の説明" onclick="A.help(\'' + id + '\')">?</button>';
  }
  function helpBox(id, key) {
    if (ui.help !== id) return '';
    return '<div class="helpbox" role="note">' + fpFace(34) +
      '<div><div class="t">FPのひとこと</div><p>' + esc(HELP[key || id]) + '</p></div></div>';
  }
  function fpFace(size) {
    return '<svg class="fpface" width="' + size + '" height="' + size + '" viewBox="0 0 40 40" aria-hidden="true">' +
      '<circle cx="20" cy="20" r="19" fill="var(--accent-soft)"/>' +
      '<path d="M8 19c0-8 5.5-12.5 12-12.5S32 11 32 19c-3-4.5-7.5-6.5-12-6.5S11 14.5 8 19z" fill="var(--accent)"/>' +
      '<circle cx="15" cy="21" r="1.6" fill="var(--text)"/><circle cx="25" cy="21" r="1.6" fill="var(--text)"/>' +
      '<ellipse cx="12.5" cy="25" rx="2.4" ry="1.4" fill="var(--c-deposit)" opacity=".45"/><ellipse cx="27.5" cy="25" rx="2.4" ry="1.4" fill="var(--c-deposit)" opacity=".45"/>' +
      '<path d="M16.5 26c1.9 1.8 5.1 1.8 7 0" fill="none" stroke="var(--text)" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>';
  }
  A.help = function (id) { ui.help = ui.help === id ? '' : id; commit(); };

  // ---------- 表紙（はじめの画面） ----------
  //
  // 何ができるかと3つの手順を見せ、家族のかたち・住まい・気になることを選んでもらう。
  // 選んだ内容から参考値入りのかんたん入力を始め、終わったら気になることに合わせた「次の一歩」を出す。

  var NEED_ICONS = { house: 'home', edu: 'school', retire: 'hourglass', invest: 'invest', work: 'work', save: 'yen' };

  function peopleIcon(adults, kids) {
    var w = (adults * 14) + (kids * 11) + 4, x = 2, g = '';
    for (var i = 0; i < adults; i++, x += 14) g += '<circle cx="' + (x + 6) + '" cy="7" r="4"/><path d="M' + (x + 0.5) + ' 22v-4.5a5.5 5.5 0 0 1 11 0V22"/>';
    for (var k = 0; k < kids; k++, x += 11) g += '<circle cx="' + (x + 5) + '" cy="11.5" r="3"/><path d="M' + (x + 1) + ' 22v-3a4 4 0 0 1 8 0v3"/>';
    return '<svg width="' + w + '" height="24" viewBox="0 0 ' + w + ' 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' + g + '</svg>';
  }

  function coverArt() {
    return '<svg class="cvart" viewBox="0 0 320 170" role="img" aria-label="貯金箱と家と、右肩上がりのグラフのイラスト">' +
      '<ellipse cx="160" cy="150" rx="140" ry="14" fill="var(--accent-soft)"/>' +
      '<circle cx="250" cy="62" r="46" fill="var(--fill-opt)"/>' +
      '<circle cx="78" cy="58" r="34" fill="var(--accent-soft)"/>' +
      // 右肩上がりのグラフ
      '<path d="M30 120 L80 104 L120 110 L170 82 L215 70 L280 34" fill="none" stroke="var(--c-invest)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 8"/>' +
      '<circle cx="280" cy="34" r="6" fill="var(--c-invest)"/>' +
      // 家
      '<path d="M196 146v-46l34-26 34 26v46z" fill="var(--surface)" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/>' +
      '<path d="M188 104l42-33 42 33" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<rect x="220" y="116" width="20" height="30" rx="4" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="2.5"/>' +
      '<path d="M224 96h12" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>' +
      // 貯金箱
      '<g transform="translate(64 66) scale(4.6)" fill="var(--surface)" stroke="var(--accent)" stroke-width=".7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M18.5 10.2C18 7.3 15.3 5.2 12 5.2c-3.9 0-7 2.6-7 5.8 0 1.8 1 3.4 2.5 4.4V18h2.6v-1.5c.6.1 1.2.2 1.9.2s1.3-.1 1.9-.2V18h2.6v-2.6c.8-.5 1.4-1.2 1.8-2h1.4v-3.2h-1.2z" fill="var(--accent-soft)"/>' +
        '<path d="M10 8h3.2" fill="none"/><circle cx="15.6" cy="10.2" r=".55" fill="var(--accent)" stroke="none"/>' +
        '<ellipse cx="8.6" cy="12.3" rx="1.1" ry=".6" fill="var(--c-deposit)" stroke="none" opacity=".5"/>' +
      '</g>' +
      // コイン
      '<g stroke="var(--gold-ink)" stroke-width="2"><ellipse cx="150" cy="138" rx="15" ry="6" fill="var(--gold)"/><ellipse cx="150" cy="130" rx="15" ry="6" fill="var(--gold)"/><ellipse cx="150" cy="122" rx="15" ry="6" fill="var(--gold)"/></g>' +
      '<circle cx="160" cy="44" r="11" fill="var(--gold)" stroke="var(--gold-ink)" stroke-width="2"/><path d="M156 40l4 5 4-5M160 45v6M156.5 47h7" fill="none" stroke="var(--gold-ink)" stroke-width="1.8" stroke-linecap="round"/>' +
      // きらきら
      '<path d="M40 30l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="var(--accent)"/>' +
      '<path d="M300 92l1.8 4.2 4.2 1.8-4.2 1.8-1.8 4.2-1.8-4.2-4.2-1.8 4.2-1.8z" fill="var(--c-invest)"/>' +
      '<path d="M124 22l1.5 3.5 3.5 1.5-3.5 1.5-1.5 3.5-1.5-3.5-3.5-1.5 3.5-1.5z" fill="var(--gold-ink)"/>' +
      '</svg>';
  }

  function coverHTML() {
    var S = window.LifePlanSample, c = ui.cover;
    var fam = S.FAMILIES.map(function (f) {
      var on = c.family === f.key;
      return '<button class="opt' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" onclick="A.coverSet(\'family\',\'' + f.key + '\')">' +
        '<span class="pi">' + peopleIcon(f.adults, f.kids) + '</span><span>' + f.label + '</span></button>';
    }).join('');
    var homes = S.HOMES.map(function (h) {
      var on = c.home === h.key;
      return '<button class="opt sm' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" onclick="A.coverSet(\'home\',\'' + h.key + '\')">' + h.label + '</button>';
    }).join('');
    var needs = S.NEEDS.map(function (n) {
      var on = c.needs.indexOf(n.key) >= 0;
      return '<button class="need' + (on ? ' on' : '') + '" aria-pressed="' + on + '" onclick="A.coverNeed(\'' + n.key + '\')">' +
        '<span class="ni">' + ic(NEED_ICONS[n.key], 22) + '</span><span>' + n.label + '</span>' + (on ? '<span class="tick">' + ic('check', 16) + '</span>' : '') + '</button>';
    }).join('');
    var hasOwn = store.plans.some(function (p) { return p.name !== '記入例'; });
    var steps = [
      ['家族のかたちと、気になることを選ぶ', '下の3つの質問に答えます（あとから変えられます）'],
      ['質問に答えて、金額を入れる', '参考値が入っているので、自分の数字に書き換えるだけ'],
      ['グラフで見て、比べる', '90代までの貯金・資産の流れと、条件を変えたときの違いがわかります'],
      ['月に1回、家計簿をつける', '実績からプランを作り直すほど、未来の見通しが確かになります']
    ];
    return noticeHTML() + '<div class="cover">' +
      '<div class="cvhero">' + coverArt() +
        '<h1>わが家のお金の未来を、<br>のぞいてみよう</h1>' +
        '<p>家族と収入・支出を入れるだけで、これから先の貯金と資産の流れがグラフで見られます。住宅購入、教育費、老後、積立投資の「もしも」も試せます。</p>' +
      '</div>' +
      '<div class="trust"><span>' + ic('lock', 16) + '登録いらず</span><span>' + ic('lock', 16) + 'データを外に送らない</span><span>' + ic('lock', 16) + '商品の勧誘なし</span></div>' +
      '<ol class="cvsteps">' + steps.map(function (st, i) {
        return '<li><span class="no">' + (i + 1) + '</span><div><b>' + st[0] + '</b><span>' + st[1] + '</span></div></li>';
      }).join('') + '</ol>' +
      '<section class="cvq"><h2><span class="qn">Q1</span>家族のかたちは？</h2><div class="opts" role="radiogroup" aria-label="家族のかたち">' + fam + '</div></section>' +
      '<section class="cvq"><h2><span class="qn">Q2</span>住まいは？</h2><div class="opts two" role="radiogroup" aria-label="住まい">' + homes + '</div></section>' +
      '<section class="cvq"><h2><span class="qn">Q3</span>気になることは？<small>いくつでも</small></h2><div class="needs">' + needs + '</div></section>' +
      '<div class="cvcta">' +
        '<button class="btn big" onclick="A.coverStart()">参考値を入れてはじめる</button>' +
        '<p>金額は、家族のかたちに合わせた目安の例です。質問に答えながら、ご自分の数字に書き換えていきます（6ステップ・生年月日だけは必ず入れます）。</p>' +
      '</div>' +
      '<div class="cvalt">' +
        (hasOwn ? '<button class="btn ghost" onclick="A.coverLeave(\'input\')">保存したプランの続きから</button>' : '') +
        '<button class="btn ghost" onclick="A.coverExample()">記入例（共働きの夫婦と子供2人）を見てみる</button>' +
      '</div>' +
      '<p class="cvnote">入力した内容は、この端末のブラウザの中だけに保存されます。計算は、Excel「ライフプラン表」と同じです。</p>' +
      DISCLAIMER +
    '</div>';
  }

  A.coverSet = function (field, v) { ui.cover[field] = v; commit(); };
  A.coverNeed = function (k) {
    var n = ui.cover.needs, i = n.indexOf(k);
    if (i >= 0) n.splice(i, 1); else n.push(k);
    commit();
  };
  A.coverOpen = function () { ui.sheet = false; ui.view = 'cover'; commit(); document.getElementById('scroll').scrollTop = 0; };
  A.coverLeave = function (v) { store.prefs.welcomed = true; ui.view = v; commit(); document.getElementById('scroll').scrollTop = 0; };
  A.coverExample = function () {
    var ex = store.plans.filter(function (p) { return p.name === '記入例'; })[0];
    if (!ex) { ex = { id: store.nextPlanId++, name: uniqueName('記入例'), state: window.LifePlanSample.sample() }; store.plans.push(ex); }
    switchTo(ex.id);
    A.coverLeave('input');
  };
  A.coverStart = function () {
    var c = ui.cover;
    var d = window.LifePlanSample.templateAnswers(c.family, c.home, new Date().getFullYear());
    // 選んだ順ではなく、表紙に並んでいる順で覚えておく
    var needs = window.LifePlanSample.NEEDS.map(function (n) { return n.key; }).filter(function (k) { return c.needs.indexOf(k) >= 0; });
    A.wizOpen(d, needs);
  };

  // ---------- FPからの次の一歩（表紙で選んだ「気になること」に合わせて） ----------
  //
  // store.guide = { planId, needs, done: [], hidden }。比べるためのプランは、guide.planId のプランを複製して作る。

  var GUIDE = {
    house: { t: '家を買った場合と比べる', p: '住宅ローンの試算に参考値（4,000万円・35年）を入れてあります。家を買ったプランを作って、今の住まいのままと並べてみましょう。',
      a: [['家を買ったプランと比べる', 'house'], ['ローンの条件を見る', 'loan']] },
    edu: { t: '教育費を確かめる', p: '子供の生年月日から、在学年と金額が自動で入っています。公立・私立など進路を選ぶと金額が変わります。教育費が重なる時期の預金の減り方も、CF表で見てみましょう。',
      a: [['教育費を見る', 'edu']] },
    retire: { t: '老後のお金を確かめる', p: '公的年金の見込額は参考値です。試算で自分の数字にすると、老後の見通しがぐっと確かになります。CF表で、65歳以降に預金がどう減っていくかを見てみましょう。',
      a: [['年金を試算する', 'pension'], ['CF表を見る', 'cf']] },
    invest: { t: '積立投資の効果を見る', p: 'NISAに月3万円（年36万円）の積立を参考値で入れてあります。積み立てなかった場合のプランと比べてみましょう。',
      a: [['積立なしと比べる', 'invest'], ['積立の条件を見る', 'investCard']] },
    work: { t: '働き方を変えたら？', p: '時短勤務、転職、共働きなど、働き方を変えたプランを作って比べます。作ったプランの給与を書き換えてから、比較画面で並べてみましょう。',
      a: [['働き方を変えたプランを作る', 'work']] },
    save: { t: '節約の効果を見る', p: '基本生活費を1割減らしたプランを作って、今のままと比べてみましょう。月に直すといくらの節約になるかも出ます。',
      a: [['1割節約したプランと比べる', 'save']] }
  };

  function guideHTML() {
    var g = store.guide;
    if (!g || g.hidden || !g.needs.length || !byId(store.plans, g.planId)) return '';
    var items = g.needs.map(function (k) {
      var it = GUIDE[k], done = g.done.indexOf(k) >= 0;
      var text = it.p;
      if (k === 'edu' && !E.children(byId(store.plans, g.planId).state).length) text = '子供の欄を足して生年月日を入れると、在学年と教育費が自動で入ります。';
      if (k === 'save') {
        var lv = (byId(store.plans, g.planId).state.living[0] || {}).amount;
        if (toNum(lv)) text += '（今の基本生活費 年' + man(lv) + '万円 → 1割で年' + (Math.round(toNum(lv) / 10 * 10) / 10) + '万円、月' + (Math.round(toNum(lv) / 120 * 10) / 10) + '万円）';
      }
      return '<div class="gi' + (done ? ' done' : '') + '">' +
        '<div class="gt">' + (done ? '<span class="ok">' + ic('check', 14) + '</span>' : '<span class="dot"></span>') + it.t + '</div>' +
        '<p>' + esc(text) + '</p>' +
        '<div class="row">' + it.a.map(function (a, i) {
          return '<button class="btn' + (i ? ' ghost' : '') + '" onclick="A.guideAct(\'' + k + '\',\'' + a[1] + '\')">' + a[0] + '</button>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');
    return '<div class="guide">' +
      '<div class="gh">' + fpFace(40) + '<div><div class="t">FPからの次の一歩</div><div class="s">選んだ「気になること」に合わせて、やってみるとよいことです</div></div>' +
        '<button class="del" aria-label="次の一歩を閉じる" onclick="A.guideHide()">' + ic('close', 20) + '</button></div>' +
      items +
    '</div>';
  }

  // 比べるためのプランを作る（guide のプランを複製し、change で書き換える）
  function guideCopy(suffix, change) {
    var base = byId(store.plans, store.guide.planId) || plan();
    var p = { id: store.nextPlanId++, name: uniqueName(base.name + '（' + suffix + '）'), state: JSON.parse(JSON.stringify(base.state)) };
    change(p.state);
    store.plans.splice(store.plans.indexOf(base) + 1, 0, p);
    return { base: base, copy: p };
  }
  function compareNow(pair) {
    switchTo(pair.base.id);
    ui.cmp = [pair.base.id, pair.copy.id];
    ui.view = 'cmp';
    commit();
    document.getElementById('scroll').scrollTop = 0;
  }
  function jumpTo(id) {
    ui.view = 'input';
    render();
    var el = document.getElementById(id), sc = document.getElementById('scroll');
    if (el && sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 150;
  }

  A.guideHide = function () { if (store.guide) store.guide.hidden = true; commit(); };
  A.guideAct = function (need, act) {
    var g = store.guide; if (!g) return;
    if (g.done.indexOf(need) < 0) g.done.push(need);
    if (byId(store.plans, g.planId) && store.activeId !== g.planId && /^(loan|edu|pension|cf|investCard)$/.test(act)) switchTo(g.planId);
    if (act === 'house') {
      compareNow(guideCopy('家を買う', function (st) {
        var keep = state; state = st;
        if (!st.loanCalc) st.loanCalc = { start: st.startYear + 2, amount: 4000, years: 35, phases: [{ rate: 1, years: 10 }, { rate: 2, years: '' }], upkeep: 40 };
        applyLoan(st.loanCalc);
        state = keep;
      }));
    } else if (act === 'invest') {
      compareNow(guideCopy('積立なし', function (st) {
        Object.keys(st.invest || {}).forEach(function (k) { st.invest[k].add = []; });
      }));
    } else if (act === 'save') {
      compareNow(guideCopy('1割節約', function (st) {
        st.living.forEach(function (r) { r.amount = Math.round(toNum(r.amount) * 0.9 * 10) / 10; });
      }));
    } else if (act === 'work') {
      var pair = guideCopy('働き方を変える', function () {});
      switchTo(pair.copy.id);
      jumpTo('sec-income');
      snapshotless('「' + pair.copy.name + '」を作りました。給与を書き換えて、比較画面で並べてみましょう');
    } else if (act === 'loan') { ui.loanOpen = true; jumpTo('card-housing'); }
    else if (act === 'pension') { ui.penOpen.state = true; jumpTo('card-pubPension'); }
    else if (act === 'edu') { var kid = E.children(state)[0]; jumpTo(kid ? 'card-edu-' + kid.id : 'card-family'); }
    else if (act === 'investCard') jumpTo('sec-invest');
    else if (act === 'cf') { ui.view = 'cf'; commit(); document.getElementById('scroll').scrollTop = 0; }
  };

  // ---------- 額面から手取りを計算（手取額計算シートと同じ式。会社員向け） ----------
  //
  // 給与の行ごとに設定を持つ（sal.calc）。扶養している子供・親は、家族構成の生年月日から開始年の年末の年齢で区分を決める。

  // その人の配偶者（家族１なら家族２、家族２なら家族１）
  function spouseOf(memberId) {
    var m = byId(state.family, memberId);
    if (!m) return null;
    var want = m.relation === '家族１' ? '家族２' : m.relation === '家族２' ? '家族１' : '';
    return want ? state.family.filter(function (f) { return f.relation === want; })[0] || null : null;
  }
  // 扶養の候補（本人と配偶者以外の家族）と、開始年の年末の年齢・区分
  function depCandidates(sal) {
    var sp = spouseOf(sal.memberId);
    return state.family.filter(function (m) { return m.id !== sal.memberId && (!sp || m.id !== sp.id) && E.parseDate(m.birth).y; }).map(function (m) {
      var age = state.startYear - E.parseDate(m.birth).y;
      return { m: m, age: age, group: E.dependentGroup(age) };
    }).filter(function (d) { return d.age >= 0; });
  }
  // 本人の開始年の年末の年齢（介護保険料の有無に使う）。家族構成にいなければ0
  function earnerAge(sal) {
    var m = byId(state.family, sal.memberId);
    var y = m && E.parseDate(m.birth).y;
    return y ? state.startYear - y : 0;
  }
  // 設定（まだ触っていなければ家族構成から既定値を作る）
  function calcOf(sal, idx) {
    if (sal.calc) return sal.calc;
    var sp = spouseOf(sal.memberId);
    var spSal = sp && state.salaries.filter(function (s) { return s.memberId === sp.id; })[0];
    var spTake = spSal && spSal.rows[0] ? toNum(spSal.rows[0].amount) : 0;
    var deps = {};
    // 子供の扶養は、ふつう収入の多い家族１がまとめて受ける
    depCandidates(sal).forEach(function (d) { deps[d.m.id] = d.group === 'elder' ? 'none' : idx === 0; });
    return {
      income: idx === 0 && state.calc ? state.calc.income : '',
      spouse: sp && spTake <= 100 ? 'あり' : 'なし', spouseIncome: '',
      deps: deps, g16: 0, g19: 0, elderLive: 0, elderAway: 0, life: 5, ideco: 0, other: 0, furusato: 0,
      lastIncome: '', health: '', social: '',
      mode: '', gPay: '', gAfter: '', gDeduct: '', gTax: '', gSocial: '', gSmall: '', gResident: ''
    };
  }
  function calcInput(sal, c) {
    var o = { income: c.income, spouse: c.spouse, spouseIncome: c.spouseIncome, g16: toNum(c.g16), g19: toNum(c.g19),
      elderLive: toNum(c.elderLive), elderAway: toNum(c.elderAway), life: c.life, ideco: c.ideco, other: c.other, furusato: c.furusato,
      lastIncome: c.lastIncome, health: c.health, social: c.social, age: earnerAge(sal) };
    depCandidates(sal).forEach(function (d) {
      var v = c.deps[d.m.id];
      if (d.group === 'g16' && v === true) o.g16++;
      else if (d.group === 'g19' && v === true) o.g19++;
      else if (d.group === 'elder' && v === 'live') o.elderLive++;
      else if (d.group === 'elder' && v === 'away') o.elderAway++;
    });
    return o;
  }

  // 源泉徴収票の欄（金額は円）。[キー, 欄の名前, 説明, 必須]
  var SLIP_FIELDS = [
    ['gPay', '支払金額', '1年間の給与・ボーナスの合計（額面）', true],
    ['gAfter', '給与所得控除後の金額', '', false],
    ['gDeduct', '所得控除の額の合計額', '', false],
    ['gTax', '源泉徴収税額', '1年間の所得税（年末調整のあと）', true],
    ['gSocial', '社会保険料等の金額', '', true],
    ['gSmall', 'うち 小規模企業共済等掛金', '社会保険料等の金額の欄の左上に「内」と書かれた金額。iDeCoや企業型DCで自分が出す掛金です', false]
  ];
  function slipInput(c) {
    return { pay: c.gPay, after: c.gAfter, deductions: c.gDeduct, tax: c.gTax, social: c.gSocial, small: c.gSmall, resident: c.gResident };
  }
  function calcResult(sal, c) {
    return c.mode === 'slip' ? E.takeHomeFromSlip(slipInput(c)) : E.takeHome(calcInput(sal, c));
  }
  function yenField(id, v, handler, label) {
    return '<input type="text" inputmode="numeric" enterkeyhint="next" autocomplete="off" id="' + id + '" class="op num yen" style="width:116px;flex:none;margin-left:auto;background:var(--surface)" aria-label="' + esc(label) + '（円）" value="' + yenIn(v) + '" onchange="' + handler + '"><span class="u">円</span>';
  }
  function slipHTML(c, sid) {
    return '<div class="hint" style="padding:0 0 4px">会社から毎年1月ごろにもらう、去年1年分の源泉徴収票の金額を、そのまま円で入れてください。所得税や社会保険料は実際に引かれた額なので、年の途中の昇給や健康保険組合の料率、住宅ローン控除もすべて入ります。</div>' +
      SLIP_FIELDS.map(function (f) {
        return '<div class="calcrow"><span class="u" style="flex:1;min-width:0">' + f[1] + (f[3] ? '' : '<small>' + (f[0] === 'gSmall' ? 'あれば' : '住民税の見積もり用') + '</small>') + '</span>' +
          yenField('f-th-' + sid + '-' + f[0], c[f[0]], 'A.thSet(' + sid + ",'" + f[0] + "',this.value)", f[1]) + '</div>' +
          (f[2] ? '<div class="hint" style="padding:2px 0 0">' + f[2] + '</div>' : '');
      }).join('') +
      '<div class="calcsec">住民税<small>源泉徴収票には書かれていません</small></div>' +
      '<div class="calcrow"><span class="u" style="flex:1;min-width:0">住民税（年額）<small>わかれば</small></span>' +
        yenField('f-th-' + sid + '-gResident', c.gResident, 'A.thSet(' + sid + ",'gResident',this.value)", '住民税（年額）') + '</div>' +
      '<div class="hint" style="padding:2px 0 0">7月以降の給与明細の住民税×12、または6月ごろ会社から渡される「住民税決定通知書」の年税額。空欄なら、源泉徴収票の金額から見積もります（ふるさと納税をした人は、実際の額を入れると正確です）。</div>';
  }

  var GROUP_TEXT = { under16: '16歳未満は扶養控除なし（児童手当の対象）', g16: '扶養控除 38万円', g19: '特定扶養控除（19〜22歳）63万円' };

  function calcHTML(sal, idx) {
    var c = calcOf(sal, idx), sid = sal.id;
    var slip = c.mode === 'slip';
    var th = calcResult(sal, c);
    var sp = spouseOf(sal.memberId);
    var bg = ';background:var(--surface)';
    var deps = depCandidates(sal).map(function (d) {
      var name = esc(memberName(d.m.id)) + '<small>' + state.startYear + '年末で' + d.age + '歳</small>';
      if (d.group === 'elder') {
        return '<div class="deprow"><span class="nm">' + name + '<small>70歳以上</small></span>' +
          selectInput('f-th-' + sid + '-dep-' + d.m.id, 'op', 'background-color:var(--surface)', [{ value: 'none', label: '扶養しない' }, { value: 'live', label: '同居（58万円）' }, { value: 'away', label: '別居（48万円）' }],
            c.deps[d.m.id] || 'none', 'A.thDep(' + sid + ',' + d.m.id + ',this.value)') + '</div>';
      }
      var on = c.deps[d.m.id] === true && d.group !== 'under16';
      return '<label class="deprow' + (d.group === 'under16' ? ' off' : '') + '"><input type="checkbox" id="f-th-' + sid + '-dep-' + d.m.id + '"' + (on ? ' checked' : '') + (d.group === 'under16' ? ' disabled' : '') +
        ' onchange="A.thDep(' + sid + ',' + d.m.id + ',this.checked)"><span class="nm">' + name + '</span><span class="gp">' + GROUP_TEXT[d.group] + '</span></label>';
    }).join('');
    var parts = [['手取り', th.net, 'var(--good)'], ['社会保険料', th.social, 'var(--k1)'], ['所得税', th.incomeTax, 'var(--k2)'], ['住民税', th.residentTax, 'var(--k4)']];
    var income = slip ? toNum(c.gPay) / 10000 : toNum(c.income);
    var bar = income > 0 ? '<div class="catbar" role="img" aria-label="年収の内訳：' + parts.map(function (p) { return p[0] + ' ' + p[1] + '万円'; }).join('、') + '">' +
      parts.map(function (p) { return p[1] > 0 ? '<span style="width:' + (p[1] / income * 100).toFixed(2) + '%;background:' + p[2] + '"></span>' : ''; }).join('') + '</div>' +
      '<div class="catlegend">' + parts.map(function (p) { return '<span><i style="background:' + p[2] + '"></i>' + p[0] + '<b>' + p[1].toLocaleString('ja-JP') + '万</b></span>'; }).join('') + '</div>' : '';
    var more = ui.thMore === sid;
    var modes = '<div class="mini thsp thmode" role="radiogroup" aria-label="手取りの出し方">' + [['', '年収から見積もる'], ['slip', '源泉徴収票から出す']].map(function (o) {
      var on = (c.mode || '') === o[0];
      return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.thSet(' + sid + ",'mode','" + o[0] + '\')">' + o[1] + '</button>';
    }).join('') + '</div>';
    var result = income > 0 ? '<div class="calcresult"><span class="u" style="font-weight:700">手取り（年額）</span>' +
          '<span style="font-size:22px;font-weight:900;color:var(--accent-ink);margin-left:auto">' + th.net.toLocaleString('ja-JP') + '</span><span class="u" style="font-weight:700">万円</span></div>' +
        '<div class="hint" style="padding:2px 0 6px;text-align:right">手取り率 ' + th.ratio + '％・月あたり約' + (Math.round(th.net / 12 * 10) / 10) + '万円（ボーナスを含めて12等分）</div>' +
        bar +
        (slip && th.small > 0 ? '<div class="hint" style="padding:6px 0 0">iDeCoなどの掛金 ' + th.small.toLocaleString('ja-JP') + '万円は貯蓄なので、手取りに含めています。積み立ては「投資」の欄に入れてください。</div>' : '') +
        (slip && th.residentEstimated ? '<div class="hint" style="padding:4px 0 0">住民税 ' + th.residentTax.toLocaleString('ja-JP') + '万円は見積もりです。</div>' : '') +
        '<button class="btn block" onclick="A.calcApply(' + sid + ')">手取り ' + (Math.round(th.net * 10) / 10).toLocaleString('ja-JP') + '万円を1行目に入れる</button>' : '';
    if (slip) {
      return '<div class="calcbox th">' + modes + slipHTML(c, sid) + result +
        '<div class="hint" style="padding:8px 0 0">手取り＝支払金額−社会保険料等（iDeCoなどの掛金を除く）−源泉徴収税額−住民税。去年1年分の実際の金額なので、今年の手取りの目安になります。転職や大きな昇給・減給があった年は「年収から見積もる」も試してください。</div>' +
      '</div>';
    }
    return '<div class="calcbox th">' + modes +
      '<div class="calcrow"><span class="u" style="width:88px">年収（額面）</span>' +
        numInput('f-th-' + sid + '-income', 'rq', 96, c.income, 'A.thSet(' + sid + ",'income',this.value)", ';margin-left:auto') + '<span class="u">万円</span></div>' +
      '<div class="hint" style="padding:4px 0 0">源泉徴収票の「支払金額」。わからなければ、月給（額面）×12＋ボーナスの合計</div>' +
      '<div class="calcrow"><span class="u" style="width:120px">去年の年収<small>住民税の計算用・任意</small></span>' +
        numInput('f-th-' + sid + '-last', 'op', 96, c.lastIncome, 'A.thSet(' + sid + ",'lastIncome',this.value)", ';margin-left:auto' + bg) + '<span class="u">万円</span></div>' +
      '<div class="hint" style="padding:4px 0 0">住民税は去年の所得で決まり、6月から1年間引かれます。昇給・転職などで年収が変わったときに入れると正確になります。空欄なら今年と同じとして計算します。</div>' +
      '<div class="calcsec">社会保険料<small>' + (th.socialActual ? '実額' : '年収の' + th.socialRate + '％') + 'で計算</small></div>' +
      '<div class="mini thsp" role="radiogroup" aria-label="健康保険の種類">' + [['kyokai', '協会けんぽ'], ['kumiai', '健保組合'], ['', 'わからない']].map(function (o) {
        var on = (c.health || '') === o[0];
        return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.thSet(' + sid + ",'health','" + o[0] + '\')">' + o[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="hint" style="padding:4px 0 0">' + (c.health
        ? (earnerAge(sal) ? esc(memberName(sal.memberId)) + 'は' + state.startYear + '年末で' + earnerAge(sal) + '歳なので、介護保険料（40〜64歳）は' + (earnerAge(sal) >= 40 && earnerAge(sal) < 65 ? '入ります' : '入りません') + '。' : '') +
          (c.health === 'kumiai' ? '健康保険組合は平均的な料率で見積もっています（組合によって違います）。' : '協会けんぽは全国平均の料率で見積もっています。')
        : '保険証に「協会けんぽ」「全国健康保険協会」とあれば協会けんぽ、「◯◯健康保険組合」とあれば健康保険組合です。わからなければ、Excelと同じ年収の15.5％で計算します。') + '</div>' +
      '<div class="calcrow"><span class="u" style="width:148px">実際の社会保険料<small>源泉徴収票の「社会保険料等の金額」</small></span>' +
        numInput('f-th-' + sid + '-social', 'op', 84, c.social, 'A.thSet(' + sid + ",'social',this.value)", ';margin-left:auto' + bg) + '<span class="u">万円</span></div>' +
      '<div class="hint" style="padding:4px 0 0">わかれば入れてください。見積もりより、この金額を優先して使います。源泉徴収票が手元にあれば、上の「源泉徴収票から出す」がいちばん正確です。</div>' +
      '<div class="calcsec">配偶者</div>' +
      '<div class="mini thsp" role="radiogroup" aria-label="配偶者を扶養しているか">' + [['なし', '扶養していない'], ['あり', '扶養している']].map(function (o) {
        var on = c.spouse === o[0];
        return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.thSet(' + sid + ",'spouse','" + o[0] + '\')">' + o[1] + '</button>';
      }).join('') + '</div>' +
      (c.spouse === 'あり' ? '<div class="calcrow"><span class="u" style="width:88px">' + (sp ? esc(memberName(sp.id)) + 'の年収' : '配偶者の年収') + '</span>' +
        numInput('f-th-' + sid + '-spinc', 'op', 96, c.spouseIncome, 'A.thSet(' + sid + ",'spouseIncome',this.value)", ';margin-left:auto' + bg) + '<span class="u">万円</span></div>' +
        '<div class="hint" style="padding:4px 0 0">パートなどの額面の年収。収入がなければ空のまま。年収が201万円くらいまでなら控除があります（配偶者控除・配偶者特別控除）。</div>' : '') +
      '<div class="calcsec">扶養している家族<small>年齢は' + state.startYear + '年の年末</small></div>' +
      (deps || '<div class="hint" style="padding:0">家族構成に子供や親を入れると、生年月日から年齢を見て自動で区分します。</div>') +
      '<button class="toggle" onclick="A.thMore(' + sid + ')"><span class="lbl">細かく設定（生命保険料控除・iDeCo・ふるさと納税など）</span><span class="chev">' + chevron(more) + '</span></button>' +
      (more ? '<div class="thmore">' +
        [['life', '生命保険料控除', '既定は5万円'], ['ideco', 'iDeCoの掛金（年額）', ''], ['other', 'その他の所得控除', '医療費控除など'], ['furusato', '前年のふるさと納税', '住民税から引かれる分']].map(function (f) {
          return '<div class="calcrow"><span class="u" style="width:148px">' + f[1] + (f[2] ? '<small>' + f[2] + '</small>' : '') + '</span>' +
            numInput('f-th-' + sid + '-' + f[0], 'op', 72, c[f[0]], 'A.thSet(' + sid + ",'" + f[0] + "',this.value)", ';margin-left:auto' + bg) + '<span class="u">万円</span></div>';
        }).join('') +
        '<div class="calcsec">家族構成にいない扶養家族<small>人数</small></div>' +
        [['g16', '16歳以上の子供など'], ['g19', '19〜22歳の子供'], ['elderLive', '70歳以上・同居'], ['elderAway', '70歳以上・別居']].map(function (f) {
          return '<div class="calcrow"><span class="u" style="width:148px">' + f[1] + '</span>' +
            numInput('f-th-' + sid + '-' + f[0], 'op', 56, c[f[0]] || 0, 'A.thSet(' + sid + ",'" + f[0] + "',this.value)", ';margin-left:auto' + bg) + '<span class="u">人</span></div>';
        }).join('') + '</div>' : '') +
      result +
      '<div class="hint" style="padding:8px 0 0">Excel「手取額計算」シート（2025年4月〜の税制）の式にもとづく概算です。会社員で年収150〜1000万円くらいの方向け。社会保険料は、健康保険の種類と年齢で見積もるか、実額を入れられます（選ばなければ年収の15.5％）。住民税は去年の年収を入れるとそれで計算します。住宅ローン控除・復興特別所得税は含みません。</div>' +
    '</div>';
  }

  function calcEdit(sid) {
    var idx = -1, sal = null;
    state.salaries.forEach(function (s, i) { if (s.id === sid) { sal = s; idx = i; } });
    if (!sal) return null;
    if (!sal.calc) sal.calc = calcOf(sal, idx);
    return sal;
  }
  A.thSet = function (sid, field, v) {
    var sal = calcEdit(sid); if (!sal) return;
    sal.calc[field] = field === 'spouse' || field === 'health' || field === 'mode' ? v : String(v).trim() === '' ? '' : toNum(v);
    if (field === 'income' && state.salaries[0] === sal) state.calc.income = sal.calc.income;
    commit();
  };
  A.thDep = function (sid, mid, v) { var sal = calcEdit(sid); if (!sal) return; sal.calc.deps[mid] = v; commit(); };
  A.thMore = function (sid) { ui.thMore = ui.thMore === sid ? 0 : sid; commit(); };

  // ---------- 家計簿（年間収支） ----------
  //
  // 1年を1枚にまとめる（Excelの家計簿シートと同じ）。月ごとの入力、1年の表、ライフプランへの反映の3つの画面。
  // データは store.book = { years: { '2026': 1年分 }, nextId }。プランとは別に、家計（世帯）に1つ。

  var BK = window.LifePlanBook;
  var MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

  function bookYear() { return store.book.years[ui.book.year] || null; }
  function yen(v) { var n = Math.round(BK.num(v)); return (n < 0 ? '−' : '') + Math.abs(n).toLocaleString('ja-JP'); }
  function yenIn(v) { return BK.filled(v) ? Math.round(BK.num(v)).toLocaleString('ja-JP') : ''; }
  function catColor(no) { return 'var(--k' + no + ')'; }
  // 今日の月に記録が無ければ、家計簿のタブに印を付ける（家計簿を始めた人だけ）
  function bookDue() {
    if (!Object.keys(store.book.years).length) return false;
    var d = new Date(), y = store.book.years[d.getFullYear()];
    if (!y) return true;
    return !BK.summarize(y).months[d.getMonth()].recorded;
  }

  function bookHeaderHTML() {
    var y = bookYear(), s = y ? BK.summarize(y) : null;
    var modes = [['month', '月ごと'], ['year', '1年の表'], ['plan', 'プランへ']];
    return '<div class="bkhead">' +
      '<div class="bkyear">' +
        '<button class="del" aria-label="前の年" onclick="A.bkYear(-1)">' + ic('prev', 22) + '</button>' +
        '<span class="y">' + ui.book.year + '年の家計簿</span>' +
        '<button class="del" aria-label="次の年" onclick="A.bkYear(1)">' + ic('next', 22) + '</button>' +
      '</div>' +
      (y ? '<div class="mini bkmodes" role="tablist" aria-label="家計簿の表示">' + modes.map(function (m) {
        var on = ui.book.mode === m[0];
        return '<button role="tab" aria-selected="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.bkMode(\'' + m[0] + '\')">' + m[1] + '</button>';
      }).join('') + '</div>' : '') +
      (y && ui.book.mode === 'month' ? '<div class="bkmonths" role="tablist" aria-label="月">' + MONTHS.map(function (label, i) {
        var on = ui.book.month === i, rec = s.months[i].recorded, ok = s.months[i].diff != null && Math.abs(s.months[i].diff) < 1;
        return '<button role="tab" id="bkm-' + i + '" aria-selected="' + on + '" class="' + (on ? 'on' : '') + (rec ? ' rec' : '') + '" onclick="A.bkMonth(' + i + ')">' +
          label + (ok ? '<span class="ok" aria-label="残高と一致">' + ic('check', 11) + '</span>' : rec ? '<span class="dot" aria-label="記録あり"></span>' : '') + '</button>';
      }).join('') + '</div>' : '') +
    '</div>';
  }

  function bookEmptyHTML() {
    var prev = store.book.years[ui.book.year - 1];
    return '<div class="bkempty">' + bookArt() +
      '<h2>' + ui.book.year + '年の家計簿をはじめよう</h2>' +
      '<p>毎日つけなくて大丈夫。<b>月に1回</b>、カードの明細や通帳を見ながら、項目ごとの合計を入れるだけです。1年が1枚の表にまとまります。</p>' +
      '<ul class="bkpoints">' +
        '<li>' + ic('lock', 18) + '<span><b>データは端末の外に送りません。</b>登録も、口座の連携もいりません。</span></li>' +
        '<li>' + ic('check', 18) + '<span><b>口座の残高と照らし合わせて</b>、記録に漏れがないかを確かめられます。</span></li>' +
        '<li>' + ic('chart', 18) + '<span><b>実績からライフプランを作れます。</b>記録した月が増えるほど、未来の見通しが確かになります。</span></li>' +
      '</ul>' +
      '<div class="cvalt">' +
        '<button class="btn big" onclick="A.bkCreate(false)">' + (prev ? ui.book.year - 1 + '年の項目を引き継いではじめる' : 'この年の家計簿をはじめる') + '</button>' +
        '<button class="btn ghost" onclick="A.bkCreate(true)">記入例（Excelのサンプル）を入れて見てみる</button>' +
      '</div>' +
    '</div>';
  }

  function bookArt() {
    return '<svg class="bkart" viewBox="0 0 220 120" aria-hidden="true">' +
      '<ellipse cx="110" cy="110" rx="96" ry="8" fill="var(--accent-soft)"/>' +
      '<rect x="44" y="18" width="92" height="86" rx="10" fill="var(--surface)" stroke="var(--accent)" stroke-width="3"/>' +
      '<path d="M58 40h50M58 54h64M58 68h40M58 82h56" stroke="var(--fill-opt)" stroke-width="6" stroke-linecap="round"/>' +
      '<path d="M58 40h22M58 54h34M58 68h14M58 82h28" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/>' +
      '<rect x="44" y="18" width="12" height="86" rx="6" fill="var(--accent)"/>' +
      '<g transform="translate(132 46) scale(3.1)" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width=".8" stroke-linejoin="round">' +
        '<path d="M18.5 10.2C18 7.3 15.3 5.2 12 5.2c-3.9 0-7 2.6-7 5.8 0 1.8 1 3.4 2.5 4.4V18h2.6v-1.5c.6.1 1.2.2 1.9.2s1.3-.1 1.9-.2V18h2.6v-2.6c.8-.5 1.4-1.2 1.8-2h1.4v-3.2h-1.2z"/>' +
        '<circle cx="15.6" cy="10.2" r=".55" fill="var(--accent)" stroke="none"/></g>' +
      '<circle cx="176" cy="26" r="10" fill="var(--gold)" stroke="var(--gold-ink)" stroke-width="2"/>' +
      '<path d="M26 30l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="var(--accent)"/>' +
    '</svg>';
  }

  // ---- 月ごと ----

  function ringSVG(pct) {
    var p = Math.max(0, Math.min(100, pct)), r = 26, c = 2 * Math.PI * r;
    return '<svg class="ring" width="70" height="70" viewBox="0 0 70 70" role="img" aria-label="貯蓄・投資に回せた割合 ' + p + '％">' +
      '<circle cx="35" cy="35" r="' + r + '" fill="none" stroke="var(--fill-opt)" stroke-width="9"/>' +
      '<circle cx="35" cy="35" r="' + r + '" fill="none" stroke="var(--good)" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + (c * p / 100).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 35 35)"/>' +
      '<text x="35" y="39" text-anchor="middle">' + p + '%</text></svg>';
  }

  function bookMonthHTML(y) {
    var i = ui.book.month, s = BK.summarize(y), m = s.months[i];
    var edit = ui.book.edit;
    var saveRate = m.income > 0 ? Math.round((m.income - m.expense + m.cats[6]) / m.income * 100) : 0;
    var bar = '', legend = '';
    var spend = m.expense;
    BK.CATS.forEach(function (c) {
      var v = m.cats[c.no];
      if (spend > 0 && v > 0) bar += '<span style="width:' + (v / spend * 100).toFixed(2) + '%;background:' + catColor(c.no) + '"></span>';
      legend += '<span><i style="background:' + catColor(c.no) + '"></i>' + c.label + '<b>' + yen(v) + '</b></span>';
    });
    var summary = '<div class="card bksum">' +
      '<div class="bkrow1"><div><div class="k">' + MONTHS[i] + 'の収支</div><div class="v ' + (m.balance < 0 ? 'neg' : '') + '">' + (m.balance > 0 ? '＋' : '') + yen(m.balance) + '<small>円</small></div>' +
        '<div class="io"><span>収入 <b>' + yen(m.income) + '</b></span><span>支出 <b>' + yen(m.expense) + '</b></span></div></div>' +
        (m.income > 0 ? '<div class="ringwrap">' + ringSVG(saveRate) + '<span>貯蓄・投資に<br>回せた割合</span></div>' : '') + '</div>' +
      (spend > 0 ? '<div class="catbar" role="img" aria-label="区分ごとの支出の割合">' + bar + '</div>' : '') +
      '<div class="catlegend">' + legend + '</div>' +
      (m.diff != null ? '<div class="diffline ' + (Math.abs(m.diff) < 1 ? 'ok' : 'ng') + '">' + ic(Math.abs(m.diff) < 1 ? 'check' : 'warn', 16) +
        (Math.abs(m.diff) < 1 ? '記録と口座の残高が一致しています' : '記録と口座の残高の差額 ' + yen(m.diff) + '円（0になれば、記録に漏れなし）') + '</div>' : '') +
    '</div>';

    var tips = BK.insights(y, i, store.book.years[ui.book.year - 1]);
    var review = tips.length ? '<div class="card bkreview">' + '<div class="gh">' + fpFace(36) + '<div class="t">' + MONTHS[i] + 'のふりかえり</div></div>' +
      '<ul>' + tips.map(function (t) { return '<li class="' + t.kind + '">' + esc(t.text) + '</li>'; }).join('') + '</ul></div>' : '';

    var prevRec = i > 0 && s.months[i - 1].recorded;
    var hasEmpty = y.items.some(function (it) { return !BK.filled(it.m[i]) && BK.filled(it.m[i - 1] || ''); }) ||
      y.incomes.some(function (r) { return !BK.filled(r.m[i]) && BK.filled(r.m[i - 1] || ''); });
    var copy = prevRec && hasEmpty && !edit
      ? '<button class="btn ghost bkcopy" onclick="A.bkCopyPrev()">' + ic('copy', 18) + MONTHS[i - 1] + 'と同じ金額を、空いている欄に入れる</button>' : '';

    var groups = BK.CATS.map(function (c) {
      var rows = y.items.filter(function (it) { return it.cat === c.no; });
      if (!rows.length && !edit) return '';
      var sub = rows.reduce(function (t, it) { return t + BK.num(it.m[i]); }, 0);
      return '<div class="card bkgroup" id="bkg-' + c.no + '">' +
        '<div class="head"><span class="cdot" style="background:' + catColor(c.no) + '"></span><span class="ttl">' + c.label + '</span>' +
          '<span class="map">→ ' + c.plan + '</span><span class="sub">' + yen(sub) + '円</span></div>' +
        rows.map(function (it) { return bookItemRow(it, i, edit); }).join('') +
        (edit ? '<div class="addwrap divide"><button class="btn ghost" onclick="A.bkAdd(\'item\',' + c.no + ')">＋ ' + c.label + 'の項目を足す</button></div>' : '') +
      '</div>';
    }).join('');

    var incomes = '<div class="card bkgroup" id="bkg-income"><div class="head"><span class="cdot" style="background:var(--good)"></span><span class="ttl">手取収入</span>' + helpBtn('bookIncome') +
        '<span class="sub">' + yen(m.income) + '円</span></div>' + helpBox('bookIncome') +
      y.incomes.map(function (r) { return bookIncomeRow(r, i, edit); }).join('') +
      (edit ? '<div class="addwrap divide"><button class="btn ghost" onclick="A.bkAdd(\'income\')">＋ 収入の項目を足す</button></div>' : '') +
      '<div class="rowtop divide" style="padding:10px 0"><span class="u">備考</span>' +
        '<input type="text" id="f-bk-note" class="op" style="flex:1;min-width:0" aria-label="' + MONTHS[i] + 'の備考" placeholder="児童手当、定期代など" value="' + esc(y.notes[i] || '') + '" onchange="A.bkNote(this.value)"></div>' +
    '</div>';

    var accounts = '<div class="card bkgroup" id="bkg-accounts"><div class="head"><span class="cdot" style="background:var(--c-deposit)"></span><span class="ttl">' + MONTHS[i] + '末の口座残高</span>' + helpBtn('bookAccounts') + '<span class="sub">任意</span></div>' +
      helpBox('bookAccounts') +
      y.accounts.map(function (a) {
        if (edit) {
          return '<div class="bkrow edit divide">' +
            '<input type="text" id="f-bk-acn-' + a.id + '" class="op" style="flex:1;min-width:0" aria-label="口座の名前" value="' + esc(a.name) + '" onchange="A.bkField(\'account\',' + a.id + ',\'name\',this.value)">' +
            '<span class="u">前年末</span>' + bookAmountInput('f-bk-acs-' + a.id, a.start, "A.bkField('account'," + a.id + ",'start',this.value)", a.name + 'の前年末の残高', 'rq') +
            '<button class="del" aria-label="この口座を外す" onclick="A.bkDel(\'account\',' + a.id + ')">' + ic('del', 20) + '</button></div>';
        }
        return '<div class="bkrow divide"><span class="nm">' + esc(a.name) + '<small>前年末 ' + (BK.filled(a.start) ? yen(a.start) + '円' : '未入力') + '</small></span>' +
          bookAmountInput('f-bk-ac-' + a.id, a.m[i], "A.bkAmt('account'," + a.id + ',this.value)', a.name + 'の' + MONTHS[i] + '末の残高', 'op') + '</div>';
      }).join('') +
      (edit ? '<div class="addwrap divide"><button class="btn ghost" onclick="A.bkAdd(\'account\')">＋ 口座を足す</button></div>' : '') +
    '</div>';

    return (y.sample ? '<div class="vbanner notice sample">' + ic('book', 18) + '<span>これは記入例（Excelのサンプル）です。自分の家計簿にするときは消してから始めます。</span><button class="btn" onclick="A.bkClear()">記入例を消す</button></div>' : '') +
      summary + review + copy +
      '<div class="bkedit"><button class="btn ghost" aria-pressed="' + edit + '" onclick="A.bkEdit()">' + ic(edit ? 'check' : 'tune', 18) + (edit ? '項目の編集を終える' : '項目・口座を編集する') + '</button></div>' +
      groups + incomes + accounts;
  }

  function bookAmountInput(id, v, handler, label, cls) {
    return '<input type="text" inputmode="numeric" enterkeyhint="next" autocomplete="off" id="' + id + '" class="' + (cls || 'op') + ' num yen" aria-label="' + esc(label) + '（円）" value="' + yenIn(v) + '" onchange="' + handler + '"><span class="u">円</span>';
  }

  function bookItemRow(it, i, edit) {
    if (edit) {
      return '<div class="bkrow edit divide">' +
        '<input type="text" id="f-bk-itn-' + it.id + '" class="op" style="flex:1 1 100%;min-width:0" aria-label="項目の名前" value="' + esc(it.name) + '" onchange="A.bkField(\'item\',' + it.id + ',\'name\',this.value)">' +
        selectInput('f-bk-itc-' + it.id, 'op', '', BK.CATS.map(function (c) { return { value: c.no, label: c.no + ' ' + c.label }; }), it.cat, "A.bkField('item'," + it.id + ",'cat',this.value)") +
        '<input type="text" id="f-bk-itp-' + it.id + '" class="op" style="width:118px" list="bk-pays" aria-label="決済手段" placeholder="決済手段" value="' + esc(it.pay) + '" onchange="A.bkField(\'item\',' + it.id + ',\'pay\',this.value)">' +
        '<input type="text" id="f-bk-itd-' + it.id + '" class="op" style="width:92px" aria-label="引落日" placeholder="引落日" value="' + esc(it.day) + '" onchange="A.bkField(\'item\',' + it.id + ',\'day\',this.value)">' +
        '<button class="del" aria-label="「' + esc(it.name) + '」を外す" onclick="A.bkDel(\'item\',' + it.id + ')">' + ic('del', 20) + '</button>' +
      '</div>';
    }
    var sub = [it.pay, it.day].filter(Boolean).join('・');
    var prev = i > 0 && BK.filled(it.m[i - 1]) ? '先月 ' + yen(it.m[i - 1]) : '';
    return '<div class="bkrow divide"><span class="nm">' + esc(it.name) + (sub || prev ? '<small>' + esc([sub, prev].filter(Boolean).join('　')) + '</small>' : '') + '</span>' +
      bookAmountInput('f-bk-it-' + it.id, it.m[i], "A.bkAmt('item'," + it.id + ',this.value)', it.name + '（' + MONTHS[i] + '）', 'op') + '</div>';
  }

  function bookIncomeRow(r, i, edit) {
    if (edit) {
      return '<div class="bkrow edit divide">' +
        '<input type="text" id="f-bk-inn-' + r.id + '" class="op" style="flex:1 1 100%;min-width:0" aria-label="収入の名前" value="' + esc(r.name) + '" onchange="A.bkField(\'income\',' + r.id + ',\'name\',this.value)">' +
        selectInput('f-bk-ink-' + r.id, 'op', '', BK.INCOME_KINDS.map(function (k) { return { value: k.key, label: k.label }; }), r.kind, "A.bkField('income'," + r.id + ",'kind',this.value)") +
        '<button class="del" aria-label="「' + esc(r.name) + '」を外す" onclick="A.bkDel(\'income\',' + r.id + ')">' + ic('del', 20) + '</button></div>';
    }
    return '<div class="bkrow divide"><span class="nm">' + esc(r.name) + '</span>' +
      bookAmountInput('f-bk-in-' + r.id, r.m[i], "A.bkAmt('income'," + r.id + ',this.value)', r.name + '（' + MONTHS[i] + '）', 'op') + '</div>';
  }

  // ---- 1年の表 ----

  function bookChartSVG(s, width) {
    var W = Math.max(300, width), H = 210, L = 54, R = 8, T = 12, B = 26, pw = W - L - R, ph = H - T - B;
    var top = 0;
    s.months.forEach(function (m) { top = Math.max(top, m.expense, m.income); });
    var step = niceStep(top || 1, 4), yMax = Math.ceil((top || 1) / step) * step;
    var sy = function (v) { return T + (yMax - v) / yMax * ph; };
    var slot = pw / 12, bw = Math.min(22, slot * 0.6);
    var g = '';
    for (var t = 0; t <= yMax + 1e-9; t += step) {
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(t).toFixed(1) + '" y2="' + sy(t).toFixed(1) + '" stroke="var(--line)"/>' +
        '<text x="' + (L - 6) + '" y="' + (sy(t) + 3.5).toFixed(1) + '" text-anchor="end">' + (t / 10000).toLocaleString('ja-JP') + '万</text>';
    }
    var bars = '';
    s.months.forEach(function (m, i) {
      var x = L + i * slot + (slot - bw) / 2, acc = 0;
      BK.CATS.forEach(function (c) {
        var v = m.cats[c.no]; if (v <= 0) return;
        bars += '<rect x="' + x.toFixed(1) + '" y="' + sy(acc + v).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, sy(acc) - sy(acc + v) - 0.8).toFixed(1) + '" fill="' + catColor(c.no) + '"/>';
        acc += v;
      });
      if (m.income > 0) bars += '<line x1="' + (x - 3).toFixed(1) + '" x2="' + (x + bw + 3).toFixed(1) + '" y1="' + sy(m.income).toFixed(1) + '" y2="' + sy(m.income).toFixed(1) + '" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round"/>';
      bars += '<text x="' + (L + i * slot + slot / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + (i + 1) + '</text>';
    });
    return '<svg id="bkchart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="月ごとの支出（区分ごとの積み上げ）と収入（横線）">' + g + bars + '</svg>';
  }

  function bookYearHTML(y, width) {
    var s = BK.summarize(y);
    var head = '<tr><th>項目</th>' + MONTHS.map(function (m) { return '<th>' + m + '</th>'; }).join('') + '<th>合計</th></tr>';
    var cell = function (v, cls) { var n = Math.round(BK.num(v)); return '<td' + (cls ? ' class="' + cls + '"' : n < 0 ? ' class="neg"' : n === 0 ? ' class="z"' : '') + '>' + (n === 0 ? '' : yen(n)) + '</td>'; };
    var row = function (label, arr, total, cls, sw) {
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + (sw ? '<span class="sw" style="background:' + sw + '"></span>' : '') + esc(label) + '</td>' + arr.map(function (v) { return cell(v); }).join('') + cell(total) + '</tr>';
    };
    var grp = function (label) { return '<tr class="grp"><td>' + label + '</td>' + MONTHS.map(function () { return '<td></td>'; }).join('') + '<td></td></tr>'; };
    var h = grp('１．支出');
    y.items.forEach(function (it) { h += row(it.name, it.m, BK.num(it.m.reduce(function (a, v) { return a + BK.num(v); }, 0)), '', catColor(it.cat)); });
    h += row('支出計', s.months.map(function (m) { return m.expense; }), s.expense, 'sum');
    h += grp('２．決済手段別');
    Object.keys(s.byPay).forEach(function (k) { h += row(k, s.byPay[k], s.byPay[k].reduce(function (a, v) { return a + v; }, 0)); });
    h += grp('３．区分別（→ ライフプラン）');
    BK.CATS.forEach(function (c) { h += row(c.no + ' ' + c.label, s.months.map(function (m) { return m.cats[c.no]; }), s.catTotals[c.no], '', catColor(c.no)); });
    h += grp('４．手取収入');
    y.incomes.forEach(function (r) { h += row(r.name, r.m, r.m.reduce(function (a, v) { return a + BK.num(v); }, 0)); });
    h += row('収入計', s.months.map(function (m) { return m.income; }), s.income, 'sum');
    h += '<tr class="note"><td>備考</td>' + y.notes.map(function (n) { return '<td>' + esc(n || '') + '</td>'; }).join('') + '<td></td></tr>';
    h += grp('５．収支／残高');
    h += row('収支', s.months.map(function (m) { return m.balance; }), s.balance, 'sum');
    h += '<tr><td>残高（記録）</td>' + s.months.map(function (m) { return cell(m.running); }).join('') + '<td></td></tr>';
    h += '<tr><td>口座残高（実際）</td>' + s.months.map(function (m) { return m.actual == null ? '<td></td>' : cell(m.actual); }).join('') + '<td></td></tr>';
    h += '<tr><td>差額（0になること）</td>' + s.months.map(function (m) {
      return m.diff == null ? '<td></td>' : Math.abs(m.diff) < 1 ? '<td class="okc">0 ✓</td>' : cell(m.diff, 'neg');
    }).join('') + '<td></td></tr>';

    var inv = y.invests.map(function (v) {
      return '<div class="bkrow divide"><span class="nm">' + esc(v.name) + '</span>' +
        '<span class="u">前年末</span>' + bookAmountInput('f-bk-ivs-' + v.id, v.start, "A.bkInv(" + v.id + ",'start',this.value)", v.name + 'の前年末', 'op').replace('<span class="u">円</span>', '') +
        '<span class="u">今年末（予想）</span>' + bookAmountInput('f-bk-ive-' + v.id, v.end, "A.bkInv(" + v.id + ",'end',this.value)", v.name + 'の今年末（予想）', 'op') + '</div>';
    }).join('');
    var invTotal = y.invests.reduce(function (t, v) { return [t[0] + BK.num(v.start), t[1] + BK.num(v.end)]; }, [0, 0]);

    return '<div class="card chartcard"><h2 class="h3">月ごとの支出と収入</h2>' +
        '<div class="keys">' + BK.CATS.map(function (c) { return '<span><i style="background:' + catColor(c.no) + '"></i>' + c.label + '</span>'; }).join('') +
        '<span><i style="background:var(--text);height:3px"></i>収入</span></div>' + bookChartSVG(s, width) + '</div>' +
      '<div class="yeartotals">' +
        '<div><span>収入</span><b>' + yen(s.income) + '</b></div><div><span>支出</span><b>' + yen(s.expense) + '</b></div>' +
        '<div><span>収支</span><b class="' + (s.balance < 0 ? 'neg' : 'pos') + '">' + (s.balance > 0 ? '＋' : '') + yen(s.balance) + '</b></div></div>' +
      '<div class="card tablecard"><h2 class="h3">' + ui.book.year + '年の年間収支</h2><div class="sub">単位：円。Excelの家計簿シートと同じ並びです。横にスクロールできます。</div>' +
        '<div class="tablewrap" tabindex="0" role="region" aria-label="年間収支の表"><table class="cf bk">' + '<thead>' + head + '</thead><tbody>' + h + '</tbody></table></div></div>' +
      '<div class="card bkgroup"><div class="head"><span class="ttl">投資資産の残高（NISA・iDeCo・株など）</span></div>' + inv +
        '<div class="total divide"><span class="u" style="font-weight:700">合計</span><span class="v">' + yen(invTotal[0]) + ' → ' + yen(invTotal[1]) + '円</span></div></div>';
  }

  // ---- ライフプランへ反映 ----

  // 反映できる項目。get は今のプランの値（万円）、set はプランに書き込む
  function bookTargets(st, bp) {
    var fam1 = st.family[0], fam2 = st.family.filter(function (m) { return m.relation === '家族２'; })[0];
    var salOf = function (m) { return m && st.salaries.filter(function (s) { return s.memberId === m.id; })[0]; };
    var invAsset = function (name) { return st.assets.filter(function (a) { return !a.fixed && String(a.name).toUpperCase() === String(name).toUpperCase(); })[0]; };
    var firstInv = st.assets.filter(function (a) { return !a.fixed; })[0];
    var row = function (key, label, val, get, set, note) { return { key: key, label: label, val: val, now: get(), set: set, note: note || '' }; };
    var firstAmt = function (list) { return list && list[0] ? toNum(list[0].amount) : null; };
    var setFirst = function (key, memo) {
      return function (v) {
        var list = st[key] = st[key] || [];
        if (list[0]) { list[0].amount = v; if (!list[0].memo) list[0].memo = memo; }
        else list.push({ id: st.nextId++, year: st.startYear, amount: v, memo: memo });
      };
    };
    var out = [
      row('living', '基本生活費', bp.living, function () { return firstAmt(st.living); }, setFirst('living', '家計簿の実績')),
      row('housing', '住宅費', bp.housing, function () { return firstAmt(st.housing); }, setFirst('housing', '家計簿の実績')),
      row('insurance', '保険料', bp.insurance, function () { return firstAmt(st.insurance); }, setFirst('insurance', '家計簿の実績')),
      row('car', '自動車の維持費', bp.car, function () { return firstAmt(st.carCost); }, setFirst('carCost', '家計簿の実績（車関連）'))
    ];
    if (firstInv) {
      out.push(row('invest', firstInv.name + 'への積立（年額）', bp.invest, function () {
        var add = ((st.invest || {})[firstInv.id] || {}).add || []; return add[0] ? toNum(add[0].amount) : null;
      }, function (v) {
        var iv = st.invest[firstInv.id] = st.invest[firstInv.id] || { add: [], out: [] };
        var by = E.baseBirthYear(st);
        if (iv.add[0]) iv.add[0].amount = v;
        else iv.add.push({ id: st.nextId++, year: st.startYear, toYear: Math.max(st.startYear, by + 59), amount: v, memo: '家計簿の実績' });
      }));
    }
    [[fam1, 'sal1'], [fam2, 'sal2']].forEach(function (p) {
      if (!p[0] || !bp[p[1]]) return;
      var m = p[0], who = memberName(m.id);
      out.push(row(p[1], who + 'の手取り収入（ボーナス込み）', bp[p[1]], function () { var s = salOf(m); return s && s.rows[0] ? toNum(s.rows[0].amount) : null; }, function (v) {
        var s = salOf(m);
        if (!s) { s = { id: st.nextId++, memberId: m.id, who: who, retireAge: 65, rows: [{ id: st.nextId++, year: st.startYear, amount: 0, growth: 0 }] }; st.salaries.push(s); }
        s.rows[0].amount = v;
      }));
    });
    var yearNote = ui.book.year !== toNum(st.startYear) ? 'この家計簿の前年末は' + (ui.book.year - 1) + '年末、プランの開始年は' + st.startYear + '年です' : '';
    out.push(row('cash', '前年末の普通預金等', bp.cash, function () { var a = st.assets.filter(function (x) { return x.fixed; })[0]; return a ? toNum(a.amount) : null; }, function (v) {
      var a = st.assets.filter(function (x) { return x.fixed; })[0]; if (a) a.amount = v;
    }, yearNote));
    bp.invests.forEach(function (v) {
      var a = invAsset(v.name);
      if (!a) return;
      out.push(row('inv-' + a.id, '前年末の' + a.name, v.start, function () { return toNum(a.amount); }, function (x) { a.amount = x; }, yearNote));
    });
    return out;
  }

  function bookPlanHTML(y) {
    var bp = BK.toPlan(y);
    var s = BK.summarize(y);
    var rel = BK.reliability(bp ? bp.months : 0, bp ? bp.matched : 0);
    var meter = '<div class="meter" role="img" aria-label="記録した月 ' + s.recorded + 'か月、うち残高と一致 ' + s.matched + 'か月">' + s.months.map(function (m, i) {
      var ok = m.diff != null && Math.abs(m.diff) < 1;
      return '<span class="' + (ok ? 'ok' : m.recorded ? 'rec' : '') + '">' + (i + 1) + '</span>';
    }).join('') + '</div>';
    var head = '<div class="card bkrel">' +
      '<div class="t">家計簿からライフプランを作る</div>' +
      '<p>記録した月の実績から1年分の金額を出し、ライフプランに入れます。予想ではなく<b>実績</b>にもとづくので、未来の見通しが確かになります。</p>' +
      meter +
      '<div class="lv lv' + rel.level + '"><span>信頼度</span><b>' + rel.label + '</b></div>' +
      '<p class="hint" style="padding:4px 0 0">' + esc(rel.text) + (bp && bp.months < 12 ? '　記録した' + bp.months + 'か月の平均×12で、1年分にしています。' : '') + '</p>' +
    '</div>';
    if (!bp) return head;
    var target = byId(store.plans, ui.book.target) || plan();
    var rows = bookTargets(target.state, bp);
    var picks = ui.book.picks;
    var table = rows.map(function (r) {
      var on = picks[r.key] !== undefined ? picks[r.key] : r.val > 0;
      var d = r.now == null ? null : Math.round((r.val - r.now) * 10) / 10;
      return '<label class="maprow' + (on ? ' on' : '') + '"><input type="checkbox" id="f-bkp-' + r.key + '"' + (on ? ' checked' : '') + ' onchange="A.bkPick(\'' + r.key + '\',this.checked)">' +
        '<span class="lb2">' + esc(r.label) + (r.note ? '<small>' + esc(r.note) + '</small>' : '') + '</span>' +
        '<span class="vals"><b>' + man1(r.val) + '</b><small>今 ' + (r.now == null ? '—' : man1(r.now)) + (d ? '（' + (d > 0 ? '＋' : '−') + man1(Math.abs(d)) + '）' : '') + '</small></span></label>';
    }).join('');
    var n = rows.filter(function (r) { return picks[r.key] !== undefined ? picks[r.key] : r.val > 0; }).length;
    var planOpts = store.plans.map(function (p) { return { value: p.id, label: p.name }; });
    return head +
      '<div class="card bkmap">' +
        '<div class="rowtop" style="padding-bottom:8px"><span class="u">反映するプラン</span>' + selectInput('f-bk-target', 'rq', 'flex:1;min-width:0', planOpts, target.id, 'A.bkTarget(this.value)') + '</div>' +
        '<div class="maphead"><span>項目</span><span>家計簿から（年額・万円）</span></div>' + table +
        '<p class="hint">教育費（家計簿では年' + man1(bp.edu) + '万円）は、子供の年齢と進路から計算するので反映しません。家計簿の教育費と比べて、進路や金額を見直す目安にしてください。' +
          (bp.other ? '児童手当などその他の収入（年' + man1(bp.other) + '万円）も、続く期間が人によって違うので反映しません。' : '') + '</p>' +
        '<button class="btn block big" onclick="A.bkApply()"' + (n ? '' : ' disabled') + '>チェックした' + n + '項目を「' + esc(target.name) + '」に反映する</button>' +
      '</div>';
  }
  function man1(v) { return (Math.round(v * 10) / 10).toLocaleString('ja-JP'); }

  function bookHTML(width) {
    var y = bookYear();
    var body = !y ? bookEmptyHTML() : ui.book.mode === 'year' ? bookYearHTML(y, width) : ui.book.mode === 'plan' ? bookPlanHTML(y) : bookMonthHTML(y);
    return bookHeaderHTML() + '<div class="bkbody">' + body + '</div>' +
      '<datalist id="bk-pays"><option value="現金"><option value="カード"><option value="口座振替"><option value="電子マネー"></datalist>';
  }

  // ---- 操作 ----

  function bkFind(kind, id) {
    var y = bookYear(); if (!y) return null;
    var list = kind === 'item' ? y.items : kind === 'income' ? y.incomes : kind === 'account' ? y.accounts : y.invests;
    return { list: list, row: byId(list, id), y: y };
  }
  function yenVal(v) { return String(v).trim() === '' ? '' : Math.round(toNum(v)); }

  A.bkYear = function (d) { ui.book.year += d; ui.book.edit = false; ui.book.picks = {}; commit(); };
  A.bkMonth = function (i) { ui.book.month = i; commit(); };
  A.bkMode = function (m) { ui.book.mode = m; ui.book.edit = false; commit(); document.getElementById('scroll').scrollTop = 0; };
  A.bkEdit = function () { ui.book.edit = !ui.book.edit; commit(); };
  A.bkCreate = function (sample) {
    var prev = store.book.years[ui.book.year - 1];
    store.book.years[ui.book.year] = sample ? BK.sampleYear(store.book) : BK.newYear(store.book, prev || null);
    ui.book.mode = 'month';
    commit();
  };
  A.bkClear = function () {
    snapshot('記入例の家計簿を消しました');
    delete store.book.years[ui.book.year];
    commit();
  };
  A.bkAmt = function (kind, id, v) {
    var f = bkFind(kind, id); if (!f || !f.row) return;
    f.row.m[ui.book.month] = yenVal(v);
    commit();
  };
  A.bkNote = function (v) { var y = bookYear(); if (y) y.notes[ui.book.month] = String(v).slice(0, 60); commit(); };
  A.bkField = function (kind, id, field, v) {
    var f = bkFind(kind, id); if (!f || !f.row) return;
    if (field === 'cat') f.row.cat = toNum(v);
    else if (field === 'start') f.row.start = yenVal(v);
    else f.row[field] = String(v).slice(0, 30);
    commit();
  };
  A.bkInv = function (id, field, v) { var f = bkFind('invest', id); if (f && f.row) f.row[field] = yenVal(v); commit(); };
  A.bkAdd = function (kind, cat) {
    var y = bookYear(); if (!y) return;
    var blank = function () { return ['', '', '', '', '', '', '', '', '', '', '', '']; };
    var id = store.book.nextId++;
    if (kind === 'item') {
      // 同じ区分の最後の項目の後ろに足す（年間の表でも区分ごとにまとまるように）
      var at = -1; y.items.forEach(function (it, k) { if (it.cat === cat) at = k; });
      y.items.splice(at < 0 ? y.items.length : at + 1, 0, { id: id, name: '新しい項目', cat: cat, pay: '', day: '', m: blank() });
    } else if (kind === 'income') y.incomes.push({ id: id, name: '新しい収入', kind: 'other', m: blank() });
    else if (kind === 'account') y.accounts.push({ id: id, name: '新しい口座', start: '', m: blank() });
    commit();
  };
  A.bkDel = function (kind, id) {
    var f = bkFind(kind, id); if (!f || !f.row) return;
    snapshot('「' + f.row.name + '」を外しました');
    f.list.splice(f.list.indexOf(f.row), 1);
    commit();
  };
  // 前の月に金額があって、この月がまだ空の欄だけに、前の月と同じ金額を入れる（毎月同じ固定費の手間を省く）
  A.bkCopyPrev = function () {
    var y = bookYear(), i = ui.book.month; if (!y || i < 1) return;
    snapshot(MONTHS[i - 1] + 'と同じ金額を入れました');
    y.items.concat(y.incomes).forEach(function (r) { if (!BK.filled(r.m[i]) && BK.filled(r.m[i - 1])) r.m[i] = r.m[i - 1]; });
    commit();
  };
  A.bkTarget = function (v) { ui.book.target = toNum(v); ui.book.picks = {}; commit(); };
  A.bkPick = function (k, on) { ui.book.picks[k] = !!on; commit(); };
  A.bkApply = function () {
    var y = bookYear(), bp = y && BK.toPlan(y); if (!bp) return;
    var target = byId(store.plans, ui.book.target) || plan();
    snapshot('家計簿の実績を「' + target.name + '」に反映しました');
    var rows = bookTargets(target.state, bp);
    var keep = state; state = target.state;
    rows.forEach(function (r) { if (ui.book.picks[r.key] !== undefined ? ui.book.picks[r.key] : r.val > 0) r.set(r.val); });
    state = keep;
    target.state.bookBasis = { year: ui.book.year, months: bp.months, matched: bp.matched };
    ui.book.picks = {};
    switchTo(target.id);
    ui.view = 'cf';
    commit();
    document.getElementById('scroll').scrollTop = 0;
  };

  // ---------- かんたん入力（必須の項目だけを順に聞く） ----------

  var WZ_STEPS = ['期間と家族１', '家族', '金融資産', '収入', '年金', '支出'];

  function wzDraft() {
    return {
      startYear: new Date().getFullYear(), endAge: 90, name1: '', birth1: '',
      has2: false, name2: '', birth2: '', kids: [],
      deposit: '', nisa: 0, ideco: 0, rate: 3,
      sal1: '', retire1: 65, growth: 1, sal2: '', retire2: 65, retireLump: 0,
      pension: '', pensionAge: 65,
      living: '', housing: '', insurance: 0, inflation: 0.5
    };
  }

  // そのステップで先に進めない入力（キー → メッセージ）
  function wzErrors(step, d) {
    var e = {};
    function need(key, label) { if (String(d[key]).trim() === '') e[key] = label + 'を入れてください'; }
    if (step === 0) {
      var sy = toNum(d.startYear);
      if (!(sy >= 1990 && sy <= 2100)) e.startYear = '1990〜2100の西暦で入れてください';
      if (!E.isDate(d.birth1)) e.birth1 = '生年月日を選んでください';
      else if (toNum(d.endAge) <= sy - E.parseDate(d.birth1).y) e.endAge = '今の年齢より上にしてください';
    }
    if (step === 1) {
      if (d.has2 && !E.isDate(d.birth2)) e.birth2 = '生年月日を選んでください';
      d.kids.forEach(function (k, i) { if (!E.isDate(k.birth)) e['kid' + i] = '生年月日を選んでください'; });
    }
    if (step === 2) need('deposit', '普通預金等の残高');
    if (step === 3) need('sal1', '手取り年収');
    if (step === 4) need('pension', '年金の見込額');
    if (step === 5) { need('living', '基本生活費'); need('housing', '住宅費'); }
    return e;
  }

  function wzField(key, label, unit, opts) {
    opts = opts || {};
    var d = ui.wz.d, err = ui.wz.err[key];
    var id = 'w-' + key;
    var input = opts.date
      ? dateField(id, 'rq' + (err ? ' bad' : ''), d[key], "A.wz('" + key + "',", label)
      : opts.text
        ? '<input type="text" id="' + id + '" class="op" style="flex:1;min-width:0" value="' + esc(d[key]) + '" placeholder="' + esc(opts.placeholder || '') + '" onchange="A.wz(\'' + key + '\',this.value)">'
        : '<input type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" id="' + id + '" class="' + (opts.optional ? 'op' : 'rq') + (err ? ' bad' : '') + ' num" style="width:' + (opts.width || 110) + 'px" value="' + esc(d[key]) + '" onchange="A.wz(\'' + key + '\',this.value)">';
    var ref = d._ref && d._ref[key] ? '<span class="refchip">参考値</span>' : '';
    return '<div class="fl"><label class="lb" for="' + id + '">' + label + ref + '</label>' +
      '<div class="fi">' + input + (unit ? '<span class="u">' + unit + '</span>' : '') + '</div>' +
      (err ? '<div class="vmsg error">' + ic('warn', 15) + '<span>' + esc(err) + '</span></div>' : '') +
      (opts.hint ? '<div class="hint" style="padding:6px 0 0">' + opts.hint + '</div>' : '') +
    '</div>';
  }

  function wzKid(k, i) {
    var err = ui.wz.err['kid' + i];
    return '<div class="kid divide">' +
      '<div class="fi">' +
        '<input type="text" id="w-kidname-' + i + '" class="op" style="flex:1;min-width:0" value="' + esc(k.name) + '" placeholder="子供' + (i + 1) + 'の名前（任意）" onchange="A.wzKid(' + i + ',\'name\',this.value)">' +
        '<button class="del" aria-label="この子供を外す" onclick="A.wzKidDel(' + i + ')">' + ic('del', 20) + '</button>' +
      '</div>' +
      '<div class="fi" style="margin-top:8px">' +
        dateField('w-kid-' + i, 'rq' + (err ? ' bad' : ''), k.birth, 'A.wzKid(' + i + ",'birth',", '子供' + (i + 1) + 'の生年月日') +
        '<span class="u">生まれ（予定でも可）</span>' +
      '</div>' +
      (err ? '<div class="vmsg error">' + ic('warn', 15) + '<span>' + esc(err) + '</span></div>' : '') +
    '</div>';
  }

  function wizardHTML() {
    var w = ui.wz, d = w.d, s = w.step;
    var body = '';
    var lead = '';
    if (s === 0) {
      lead = 'いつから、だれの何歳までを計算するかを決めます。家族１は家計の中心になる人です。';
      body = wzField('startYear', '開始年', '年から', { width: 96 }) +
        wzField('name1', '家族１の名前', '', { text: true, placeholder: '任意（例：わたし）' }) +
        wzField('birth1', '家族１の生年月日', '', { date: true }) +
        wzField('endAge', '家族１が何歳になるまで計算するか', '歳まで', { width: 80 });
    } else if (s === 1) {
      lead = '一緒に暮らす家族を入れます。子供の生年月日から、教育費が自動で入ります。';
      body = '<button class="check' + (d.has2 ? ' on' : '') + '" role="switch" aria-checked="' + d.has2 + '" onclick="A.wz(\'has2\',' + !d.has2 + ')"><span class="box"></span>家族２（配偶者・パートナー）がいる</button>' +
        (d.has2 ? wzField('name2', '家族２の名前', '', { text: true, placeholder: '任意' }) + wzField('birth2', '家族２の生年月日', '', { date: true }) : '') +
        '<div class="lb" style="margin-top:16px">子供（' + d.kids.length + '人）</div>' +
        d.kids.map(wzKid).join('') +
        (d.kids.length < 4 ? '<div style="margin-top:8px"><button class="btn ghost" onclick="A.wzKidAdd()">＋ 子供を追加</button></div>' : '');
    } else if (s === 2) {
      lead = '前の年の年末時点の残高です。だいたいで構いません。';
      body = wzField('deposit', '普通預金等（現金・預貯金）', '万円') +
        wzField('nisa', 'NISA', '万円', { optional: true }) +
        wzField('ideco', 'iDeCo', '万円', { optional: true }) +
        wzField('rate', '投資の想定利回り（年）', '％', { width: 80, hint: '積立や取り崩しの予定は、あとで「投資」で入れられます' });
    } else if (s === 3) {
      lead = '給与は手取り（税金・社会保険料を引いた額）の年額で入れます。';
      body = wzField('sal1', (esc(d.name1) || '家族１') + 'の手取り年収', '万円', { hint: '額面しかわからなければ、あとで「額面から手取りを計算」が使えます' }) +
        wzField('retire1', '何歳まで働くか', '歳まで', { width: 80 }) +
        (d.has2 ? wzField('sal2', (esc(d.name2) || '家族２') + 'の手取り年収', '万円', { optional: true, hint: '収入がなければ0のままにします' }) + wzField('retire2', '何歳まで働くか', '歳まで', { width: 80, optional: true }) : '') +
        wzField('growth', '毎年の昇給率', '％', { width: 80, optional: true }) +
        wzField('retireLump', '退職金（手取り）', '万円', { optional: true, hint: '働き終える年に入ります。わからなければ0' });
    } else if (s === 4) {
      lead = '老後に受け取る公的年金です。家族全員の合計を、手取りの年額で入れます。';
      body = wzField('pension', '公的年金（年額・家族の合計）', '万円', { hint: 'ねんきん定期便の見込額（年額）を足して、その9割ほどが手取りの目安です' }) +
        penCalcHTML('wz') +
        wzField('pensionAge', '受け取りを始める年齢（家族１）', '歳から', { width: 80 });
    } else {
      lead = '今の暮らしの年額です。月の額なら12倍にします（月20万円なら240）。';
      body = wzField('living', '基本生活費', '万円', { hint: '住宅費・教育費・保険料・自動車を除いた、ふだんの支出' }) +
        wzField('housing', '住宅費', '万円', { hint: '家賃やローン返済、管理費・固定資産税など' }) +
        wzField('insurance', '保険料', '万円', { optional: true, hint: '生命保険・医療保険など' }) +
        wzField('inflation', '物価上昇率（年）', '％', { width: 80 });
    }
    var last = s === WZ_STEPS.length - 1;
    return '<div class="wz">' +
      '<div class="wzhead">' +
        '<button class="del" style="margin:0" aria-label="かんたん入力を閉じる" onclick="A.wizClose(false)">' + ic('close', 22) + '</button>' +
        '<div class="dots" aria-hidden="true">' + WZ_STEPS.map(function (x, i) { return '<i class="' + (i < s ? 'done' : i === s ? 'on' : '') + '"></i>'; }).join('') + '</div>' +
        '<span class="u">' + (s + 1) + ' / ' + WZ_STEPS.length + '</span>' +
      '</div>' +
      (w.closeAsk ? '<div class="plconfirm" style="margin-top:10px"><span>ここまでの答えは保存されません。閉じますか？</span>' +
        '<button class="btn danger" onclick="A.wizClose(true)">閉じる</button><button class="btn ghost" onclick="A.wizStay()">続ける</button></div>' : '') +
      '<h2 class="wzt">' + WZ_STEPS[s] + '</h2>' +
      '<p class="wzlead">' + lead + '</p>' +
      '<div class="card">' + body + '</div>' +
      '<div class="wznav">' +
        (s > 0 ? '<button class="btn ghost" onclick="A.wzBack()">戻る</button>' : '') +
        '<button class="btn" style="margin-left:auto" onclick="A.wzNext()">' + (last ? 'この内容で計算する' : '次へ') + '</button>' +
      '</div>' +
      '<div class="hint" style="text-align:center">細かい項目（住宅ローン、車、一時的な支出など）は、あとで入力画面で足せます</div>' +
    '</div>';
  }

  // d：答えのひな形（表紙から来たときは参考値入り）、needs：表紙で選んだ気になること
  A.wizOpen = function (d, needs) {
    ui.wz = { step: 0, d: d || wzDraft(), needs: needs || [], err: {}, from: ui.view === 'wizard' ? 'input' : ui.view };
    ui.penOpen.wz = false;
    store.prefs.welcomed = true;
    ui.view = 'wizard';
    commit();
    document.getElementById('scroll').scrollTop = 0;
  };
  // 答えを入れ始めていたら、閉じる前に確かめる（閉じると答えは残らない）
  A.wizClose = function (sure) {
    var w = ui.wz;
    if (w && !sure && (w.step > 0 || w.d.birth1 || w.d.name1)) { w.closeAsk = true; commit(); return; }
    ui.view = w ? w.from : 'input'; ui.wz = null; commit();
  };
  A.wizStay = function () { ui.wz.closeAsk = false; commit(); };
  A.wz = function (key, v, el) {
    var d = ui.wz.d;
    if (key === 'has2') d.has2 = !!v;
    else if (key.indexOf('birth') === 0) d[key] = normBirth(v);
    else if (key === 'name1' || key === 'name2') d[key] = v;
    else d[key] = String(v).trim() === '' ? '' : String(toNum(v));
    delete ui.wz.err[key];
    if (d._ref) delete d._ref[key];
    if (el && document.activeElement === el) { pendingRender = true; return; }
    commit();
  };
  A.wzKid = function (i, field, v, el) {
    var k = ui.wz.d.kids[i]; if (!k) return;
    k[field] = field === 'birth' ? normBirth(v) : v;
    if (field === 'birth') delete ui.wz.err['kid' + i];
    if (el && document.activeElement === el) { pendingRender = true; return; }
    commit();
  };
  A.wzKidAdd = function () { if (ui.wz.d.kids.length < 4) ui.wz.d.kids.push({ name: '', birth: '' }); commit(); };
  A.wzKidDel = function (i) { ui.wz.d.kids.splice(i, 1); ui.wz.err = {}; commit(); };
  A.wzBack = function () { ui.wz.step = Math.max(0, ui.wz.step - 1); ui.wz.err = {}; commit(); document.getElementById('scroll').scrollTop = 0; };
  A.wzNext = function () {
    var w = ui.wz;
    w.err = wzErrors(w.step, w.d);
    if (Object.keys(w.err).length) { commit(); return; }
    if (w.step < WZ_STEPS.length - 1) { w.step++; commit(); document.getElementById('scroll').scrollTop = 0; return; }
    // 完成：新しいプランとして加え、そのプランのCF表を開く
    var st = window.LifePlanSample.applyNeeds(window.LifePlanSample.fromAnswers(w.d), w.needs);
    var p = { id: store.nextPlanId++, name: uniqueName(w.d._ref ? 'わが家' : 'プラン' + (store.plans.length + 1)), state: st };
    store.plans.push(p);
    if (w.needs.length) store.guide = { planId: p.id, needs: w.needs.slice(), done: [], hidden: false };
    store.prefs.welcomed = true;
    store.activeId = p.id;
    state = p.state;
    ui.wz = null; ui.view = 'cf'; ui.active = 'basic'; ui.inputScroll = 0; ui.openMember = 0; ui.openCalc = 0;
    quiet = true;
    commit();
    document.getElementById('scroll').scrollTop = 0;
  };
  // ---------- プラン（保存した複数の入力）の切り替えと比較 ----------

  function switchTo(id) {
    var p = byId(store.plans, id); if (!p) return;
    store.activeId = id;
    state = p.state;
    ui.openMember = 0; ui.openCalc = 0; ui.carDetailOpen = false; ui.confirmReset = false; ui.inputScroll = 0;
    ui.loanConfirm = false;
    quiet = true;
  }
  function uniqueName(base) {
    var name = base, n = 2;
    while (store.plans.some(function (x) { return x.name === name; })) name = base + '（' + (n++) + '）';
    return name;
  }

  A.planSheet = function () {
    ui.sheet = !ui.sheet; ui.confirmDelPlan = 0;
    ui.backup = { msg: '', level: '', text: false, pending: null };
    commit();
  };
  A.planSwitch = function (id) {
    switchTo(id);
    ui.sheet = false;
    commit();
    document.getElementById('scroll').scrollTop = 0;
  };
  A.planRename = function (v) { var t = String(v).trim(); if (t) plan().name = t.slice(0, 30); commit(); };
  A.planDup = function () {
    var src = plan();
    var p = { id: store.nextPlanId++, name: uniqueName(src.name + 'のコピー'), state: JSON.parse(JSON.stringify(src.state)) };
    store.plans.splice(store.plans.indexOf(src) + 1, 0, p);
    switchTo(p.id);
    commit();
  };
  A.planDel = function (id) {
    if (store.plans.length < 2) return;
    if (ui.confirmDelPlan !== id) { ui.confirmDelPlan = id; commit(); return; }
    snapshot('プラン「' + byId(store.plans, id).name + '」を削除しました');
    store.plans = store.plans.filter(function (p) { return p.id !== id; });
    if (ui.cmp) ui.cmp = ui.cmp.filter(function (x) { return x !== id; });
    ui.confirmDelPlan = 0;
    if (store.activeId === id) switchTo(store.plans[0].id);
    commit();
  };
  A.planDelNo = function () { ui.confirmDelPlan = 0; commit(); };
  A.planNew = function () { ui.sheet = false; A.wizOpen(); };
  A.cmpToggle = function (id) {
    var sel = cmpSelection();
    var i = sel.indexOf(id);
    if (i >= 0) { if (sel.length > 1) sel.splice(i, 1); }
    else if (sel.length < 3) sel.push(id);
    ui.cmp = sel;
    commit();
  };

  // バックアップ（ファイルへの保存と読み込み）の欄。
  // claude.ai の中ではファイルの保存に downloads の機能を使う（使えない画面では null になる）。
  // それ以外（保存したHTMLを直接開いた場合など）はブラウザのダウンロードで保存する。
  var downloads = null;
  try {
    if (window.claude && window.claude.use) {
      window.claude.use('downloads').then(function (d) { downloads = d; }, function () { /* 使えなければブラウザのダウンロードで */ });
    }
  } catch (e) { /* 同上 */ }

  // 読み込んだファイルの数値の欄は数値に直す。画面に出すときに、数値の欄は文字として扱っていないため。
  var NUM_KEYS = ['id', 'memberId', 'year', 'toYear', 'amount', 'growth', 'retireAge', 'startYear', 'endAge', 'depositRate',
    'inflation', 'rate', 'fromYear', 'every', 'untilAge', 'income', 'kids', 'nextId', 'from', 'to', 'payFrom', 'payTo', 'basic', 'adjust', 'start', 'upkeep', 'spouseIncome', 'g16', 'g19', 'elderLive', 'elderAway', 'life', 'ideco', 'other', 'furusato', 'lastIncome', 'social',
    'gPay', 'gAfter', 'gDeduct', 'gTax', 'gSocial', 'gSmall', 'gResident'];
  // numLeaves：教育費・車の金額の上書き（「キー → 金額」の形）の中は、末端がすべて数値
  function clean(v, key, numLeaves) {
    if (Array.isArray(v)) return v.map(function (x) { return clean(x, null, numLeaves); });
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = clean(v[k], k, numLeaves || k === 'eduAmount' || k === 'carBuyOverride'); });
      return o;
    }
    if (numLeaves || NUM_KEYS.indexOf(key) >= 0) return v === '' || v == null ? '' : toNum(v);
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : '';
  }

  // 読み込んだ家計簿は、金額を数値に、文字を短い文字列にそろえる（画面に出すときに部品が入り込まないように）
  function cleanBook(b) {
    if (!b || typeof b.years !== 'object') return null;
    var str = function (v, n) { return typeof v === 'string' ? v.slice(0, n || 30) : ''; };
    var amt = function (v) { return v === '' || v == null ? '' : Math.round(toNum(v)); };
    var m12 = function (a) { var o = []; for (var i = 0; i < 12; i++) o.push(amt(Array.isArray(a) ? a[i] : '')); return o; };
    var years = {};
    Object.keys(b.years).forEach(function (k) {
      var y = b.years[k];
      if (!/^\d{4}$/.test(k) || !y || !Array.isArray(y.items)) return;
      years[k] = {
        items: y.items.map(function (it) { return { id: 0, name: str(it.name), cat: Math.min(6, Math.max(1, Math.round(toNum(it.cat)) || 1)), pay: str(it.pay), day: str(it.day, 20), m: m12(it.m) }; }),
        incomes: (y.incomes || []).map(function (r) { return { id: 0, name: str(r.name), kind: /^(sal1|bonus1|sal2|bonus2|other)$/.test(r.kind) ? r.kind : 'other', m: m12(r.m) }; }),
        notes: m12([]).map(function (x, i) { return str((y.notes || [])[i], 60); }),
        accounts: (y.accounts || []).map(function (a) { return { id: 0, name: str(a.name), start: amt(a.start), m: m12(a.m) }; }),
        invests: (y.invests || []).map(function (v) { return { id: 0, name: str(v.name), start: amt(v.start), end: amt(v.end) }; })
      };
    });
    return Object.keys(years).length ? years : null;
  }

  function backupText() {
    return JSON.stringify({
      app: 'lifeplan', kind: 'backup', version: 2, savedAt: new Date().toISOString(),
      plans: store.plans.map(function (p) { return { name: p.name, state: p.state }; }),
      book: store.book
    }, null, 1);
  }

  function parseBackup(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return { error: 'ライフプランのバックアップの形式ではありません' }; }
    var list = [];
    if (o && Array.isArray(o.plans)) list = o.plans.map(function (p) { return { name: p && p.name, state: p && p.state }; });
    else if (okState(o)) list = [{ name: '読み込んだプラン', state: o }];
    list = list.filter(function (p) { return okState(p.state); }).map(function (p) {
      return { name: String(p.name || '読み込んだプラン').slice(0, 30), state: clean(p.state, null, false) };
    });
    var book = cleanBook(o && o.book);
    if (!list.length && !book) return { error: '読み込めるプランが見つかりませんでした' };
    return { plans: list, book: book };
  }

  function renderBackup() {
    var el = document.getElementById('backup');
    if (!el) return;
    var b = ui.backup;
    var msg = b.msg ? '<div class="vmsg ' + (b.level || 'ok') + '">' + ic(b.level === 'error' ? 'warn' : 'check', 15) + '<span>' + esc(b.msg) + '</span></div>' : '';
    var newYears = b.pendingBook ? Object.keys(b.pendingBook).filter(function (k) { return !store.book.years[k]; }) : [];
    var pending = b.pending
      ? '<div class="plconfirm ok"><span>' + (b.pending.length ? b.pending.length + '件のプラン（' + b.pending.map(function (p) { return '「' + esc(p.name) + '」'; }).join('') + '）を追加します。' : '') +
        (newYears.length ? '家計簿（' + newYears.join('年・') + '年）を追加します。' : b.pendingBook ? '家計簿は、同じ年がもうあるので読み込みません。' : '') +
        '今あるプランと家計簿はそのまま残ります。</span>' +
        '<button class="btn" onclick="A.backupAdd()">追加する</button><button class="btn ghost" onclick="A.backupCancel()">やめる</button></div>'
      : '';
    el.innerHTML = '<div class="bk">' +
      '<div class="lb">バックアップ</div>' +
      '<div class="hint" style="padding:0 0 8px">入力はこの端末のこのブラウザの中だけに保存されています。ファイルにしておくと、機種変更やデータの削除のあとでも戻せます。</div>' +
      '<div class="sheetbtns" style="margin:0">' +
        '<button class="btn ghost" onclick="A.backupSave()">すべてのプランをファイルに保存</button>' +
        '<button class="btn ghost" onclick="document.getElementById(\'f-backup-file\').click()">ファイルから読み込む</button>' +
        '<input type="file" id="f-backup-file" accept=".json,application/json,text/plain" hidden onchange="A.backupFile(this)">' +
      '</div>' +
      msg + pending +
      '<button class="toggle" onclick="A.backupTextToggle()"><span class="lbl">ファイルが使えないときは、テキストで受け渡す</span><span class="chev">' + chevron(b.text) + '</span></button>' +
      (b.text ? '<div class="hint" style="padding:4px 0 6px">下の文字をコピーして、メモやメールに貼っておきます。戻すときは、ここに貼り付けて「この内容を読み込む」を押します。</div>' +
        '<textarea id="f-backup-text" class="op bktext" spellcheck="false" aria-label="バックアップの内容">' + esc(backupText()) + '</textarea>' +
        '<div class="sheetbtns"><button class="btn ghost" onclick="A.backupCopy()">コピー</button><button class="btn ghost" onclick="A.backupPaste()">この内容を読み込む</button></div>' : '') +
    '</div>';
  }

  function backupNote(text, level) { ui.backup.msg = text; ui.backup.level = level; renderBackup(); }

  A.backupSave = function () {
    var d = new Date();
    var name = 'lifeplan-backup-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.json';
    var data = backupText();
    ui.backup.pending = null;
    if (downloads) {
      downloads.save({ filename: name, data: data }).then(function () {
        backupNote(name + ' を保存しました', 'ok');
      }, function (e) {
        var code = e && e.code;
        if (code === 'declined') backupNote('保存を取りやめました', 'warn');
        else if (code === 'rate_limited') backupNote('少し待ってから、もう一度押してください', 'warn');
        else backupNote('この画面ではファイルに保存できませんでした。下の「テキストで受け渡す」を使ってください', 'error');
      });
      return;
    }
    try {
      var url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      backupNote(name + ' のダウンロードを始めました', 'ok');
    } catch (e) {
      backupNote('この画面ではファイルに保存できませんでした。下の「テキストで受け渡す」を使ってください', 'error');
    }
  };
  function received(text) {
    var r = parseBackup(text);
    if (r.error) { ui.backup.pending = null; backupNote(r.error, 'error'); return; }
    ui.backup.pending = r.plans; ui.backup.pendingBook = r.book; ui.backup.msg = '';
    renderBackup();
  }
  A.backupFile = function (input) {
    var f = input.files && input.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { received(String(reader.result || '')); };
    reader.onerror = function () { backupNote('ファイルを読めませんでした', 'error'); };
    reader.readAsText(f);
    input.value = '';
  };
  A.backupPaste = function () { received(document.getElementById('f-backup-text').value); };
  A.backupCopy = function () {
    var ta = document.getElementById('f-backup-text');
    ta.focus(); ta.select();
    function done() { backupNote('コピーしました', 'ok'); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(done, function () {
          try { if (document.execCommand('copy')) done(); else throw 0; } catch (e) { backupNote('選択した文字を、長押しでコピーしてください', 'warn'); }
        });
        return;
      }
      if (document.execCommand('copy')) { done(); return; }
    } catch (e) { /* 下へ */ }
    backupNote('選択した文字を、長押しでコピーしてください', 'warn');
  };
  A.backupTextToggle = function () { ui.backup.text = !ui.backup.text; ui.backup.msg = ''; renderBackup(); };
  A.backupCancel = function () { ui.backup.pending = null; renderBackup(); };
  A.backupAdd = function () {
    var list = ui.backup.pending; if (!list) return;
    var first = null, addedYears = [];
    if (ui.backup.pendingBook) {
      Object.keys(ui.backup.pendingBook).forEach(function (k) {
        if (store.book.years[k]) return;
        var y = ui.backup.pendingBook[k];
        y.items.concat(y.incomes, y.accounts, y.invests).forEach(function (r) { r.id = store.book.nextId++; });
        store.book.years[k] = y;
        addedYears.push(k);
      });
    }
    list.forEach(function (p) {
      var np = { id: store.nextPlanId++, name: uniqueName(p.name), state: p.state };
      np.state.nextId = Math.max(toNum(np.state.nextId), 500);
      store.plans.push(np);
      if (!first) first = np;
    });
    if (first) switchTo(first.id);
    ui.backup = { msg: (first ? list.length + '件のプランを追加し、「' + first.name + '」を表示しています。' : '') + (addedYears.length ? '家計簿（' + addedYears.join('年・') + '年）を追加しました。' : ''), level: 'ok', text: false, pending: null };
    store.prefs.welcomed = true;
    commit();
  };

  function sheetHTML() {
    var list = store.plans.map(function (p) {
      var on = p.id === store.activeId;
      var r = E.compute(p.state);
      var sub = r.years.length ? (r.shortfall ? r.shortfall.age + '歳で預金が不足' : '終了時点 ' + man(r.endTotal) + '万円') : '計算できません';
      return '<div class="pl' + (on ? ' on' : '') + '">' +
        '<button class="pick" onclick="A.planSwitch(' + p.id + ')" aria-current="' + on + '">' +
          '<span class="radio"></span><span class="nm">' + esc(p.name) + '</span><span class="sub' + (r.shortfall ? ' neg' : '') + '">' + sub + '</span>' +
        '</button>' +
        (store.plans.length > 1 ? '<button class="del" style="margin:0" aria-label="「' + esc(p.name) + '」を削除" onclick="A.planDel(' + p.id + ')">' + ic('del', 20) + '</button>' : '') +
      '</div>' +
      (ui.confirmDelPlan === p.id ? '<div class="plconfirm"><span>「' + esc(p.name) + '」を削除しますか？元に戻せません</span>' +
        '<button class="btn danger" onclick="A.planDel(' + p.id + ')">削除する</button><button class="btn ghost" onclick="A.planDelNo()">やめる</button></div>' : '');
    }).join('');
    return '<div class="backdrop" onclick="A.planSheet()"></div>' +
      '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-t">' +
        '<div class="sheethead"><h2 id="sheet-t">プラン</h2><button class="del" style="margin-left:auto" aria-label="閉じる" onclick="A.planSheet()">' + ic('close', 22) + '</button></div>' +
        '<div class="hint" style="padding:0 0 8px">住宅購入の有無、働き方の違いなど、条件を変えた家計を別々に保存して比べられます。</div>' +
        list +
        '<div class="fl" style="border-top:1px solid var(--line)"><label class="lb" for="f-planname">表示中のプランの名前</label>' +
          '<div class="fi"><input type="text" id="f-planname" class="op" style="flex:1;min-width:0" maxlength="30" value="' + esc(plan().name) + '" onchange="A.planRename(this.value)"></div></div>' +
        '<div class="sheetbtns">' +
          '<button class="btn ghost" onclick="A.planDup()">表示中のプランを複製</button>' +
          '<button class="btn ghost" onclick="A.coverOpen()">表紙（はじめの画面）を開く</button>' +
          '<button class="btn" onclick="A.planNew()">＋ かんたん入力で作る</button>' +
        '</div>' +
        '<div id="backup"></div>' +
      '</div>';
  }

  function cmpSelection() {
    var ids = store.plans.map(function (p) { return p.id; });
    var sel = (ui.cmp || []).filter(function (id) { return ids.indexOf(id) >= 0; });
    if (!sel.length) {
      sel = [store.activeId].concat(ids.filter(function (id) { return id !== store.activeId; })).slice(0, 3);
    }
    return sel;
  }

  function planMetrics(p) {
    var r = E.compute(p.state);
    var minDep = Infinity, inc = 0, exp = 0;
    r.years.forEach(function (y) { minDep = Math.min(minDep, y.assets.deposit); inc += y.income.total; exp += y.expense.total; });
    return { r: r, end: r.endTotal, endAge: r.endAge, endYear: r.years.length ? r.years[r.years.length - 1].year : null, shortfall: r.shortfall, minDep: r.years.length ? minDep : 0, inc: inc, exp: exp };
  }

  var cmpGeom = null;
  function cmpChartSVG(width, series) {
    var W = Math.max(280, width), H = 220, L = 54, R = 10, T = 10, B = 24;
    var pw = W - L - R, ph = H - T - B;
    var y0 = Infinity, y1 = -Infinity, top = 0, bottom = 0;
    series.forEach(function (s) {
      s.m.r.years.forEach(function (r) {
        y0 = Math.min(y0, r.year); y1 = Math.max(y1, r.year);
        top = Math.max(top, r.assets.total); bottom = Math.min(bottom, r.assets.total);
      });
    });
    if (!isFinite(y0)) return '';
    var step = niceStep((top - bottom) || 1, 4);
    var yMax = Math.ceil(top / step) * step || step, yMin = Math.floor(bottom / step) * step;
    var span = Math.max(1, y1 - y0);
    function sx(year) { return L + (year - y0) / span * pw; }
    function sy(v) { return T + (yMax - v) / (yMax - yMin) * ph; }
    var g = '';
    for (var t = yMin; t <= yMax + 1e-9; t += step) {
      var y = sy(t).toFixed(1);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)" stroke-width="1"/>';
      g += '<text x="' + (L - 6) + '" y="' + (+y + 3.5) + '" text-anchor="end">' + man(t) + '</text>';
    }
    var xl = '';
    for (var yr = Math.ceil(y0 / 10) * 10; yr <= y1; yr += 10) {
      xl += '<text x="' + sx(yr).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + yr + '</text>';
    }
    var zero = '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '" stroke="var(--text-muted)" stroke-width="1"/>';
    var lines = series.map(function (s) {
      var d = s.m.r.years.map(function (r, i) { return (i ? 'L' : 'M') + sx(r.year).toFixed(1) + ',' + sy(r.assets.total).toFixed(1); }).join(' ');
      return '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    }).join('');
    cmpGeom = { L: L, pw: pw, W: W, y0: y0, y1: y1, T: T, ph: ph, sx: sx, sy: sy };
    var desc = 'プランごとの金融資産の推移。' + series.map(function (s) { return s.name + 'は終了時点 ' + man(s.m.end) + '万円'; }).join('、');
    return '<svg id="cmpchart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(desc) + '">' + g + zero + lines + xl +
      '<line id="cmphl" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" stroke="var(--text-muted)" stroke-width="1" visibility="hidden"/>' +
      series.map(function (s, i) { return '<circle id="cmpdot' + i + '" r="4" fill="' + s.color + '" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>'; }).join('') +
      '</svg>';
  }

  function bindCmpChart(series) {
    var svg = document.getElementById('cmpchart'), tip = document.getElementById('cmptip');
    if (!svg || !tip || !cmpGeom) return;
    function show(ev) {
      var rect = svg.getBoundingClientRect();
      var x = (ev.clientX - rect.left) * (cmpGeom.W / rect.width);
      var year = Math.round(cmpGeom.y0 + (x - cmpGeom.L) / cmpGeom.pw * (cmpGeom.y1 - cmpGeom.y0));
      if (year < cmpGeom.y0 || year > cmpGeom.y1) return;
      var hl = document.getElementById('cmphl');
      hl.setAttribute('x1', cmpGeom.sx(year).toFixed(1)); hl.setAttribute('x2', cmpGeom.sx(year).toFixed(1));
      hl.setAttribute('visibility', 'visible');
      var rows = series.map(function (s, i) {
        var r = s.m.r.years.filter(function (y) { return y.year === year; })[0];
        var dot = document.getElementById('cmpdot' + i);
        if (r) { dot.setAttribute('cx', cmpGeom.sx(year).toFixed(1)); dot.setAttribute('cy', cmpGeom.sy(r.assets.total).toFixed(1)); dot.setAttribute('visibility', 'visible'); }
        else dot.setAttribute('visibility', 'hidden');
        return '<div class="r"><i style="background:' + s.color + '"></i>' + esc(s.name) + '<b>' + (r ? man(r.assets.total) + '万' : '—') + '</b></div>';
      }).join('');
      tip.innerHTML = '<div class="t">' + year + '年</div>' + rows;
      tip.hidden = false;
      var card = svg.parentNode.getBoundingClientRect();
      var px = ev.clientX - card.left, tw = tip.offsetWidth;
      tip.style.left = Math.max(6, px + 14 + tw > card.width ? px - 14 - tw : px + 14) + 'px';
      tip.style.top = '70px';
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      tip.hidden = true;
      ['cmphl', 'cmpdot0', 'cmpdot1', 'cmpdot2'].forEach(function (id) { var el = document.getElementById(id); if (el) el.setAttribute('visibility', 'hidden'); });
    });
  }

  var CMP_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)'];
  var cmpLast = [];

  function cmpHTML(width) {
    if (store.plans.length < 2) {
      return '<div class="hero"><div class="k">プランの比較</div></div>' +
        '<div class="card"><p class="wzlead" style="margin:0 0 12px">プランが1つだけです。表示中のプランを複製して条件を変えるか、かんたん入力で別のプランを作ると、ここで並べて比べられます。</p>' +
        '<div class="sheetbtns" style="margin:0"><button class="btn ghost" onclick="A.planDup();A.view(\'input\')">表示中のプランを複製</button><button class="btn" onclick="A.wizOpen()">＋ かんたん入力で作る</button></div></div>';
    }
    var sel = cmpSelection();
    var series = cmpLast = sel.map(function (id, i) { var p = byId(store.plans, id); return { id: id, name: p.name, color: CMP_COLORS[i], m: planMetrics(p) }; });
    var chips = store.plans.map(function (p) {
      var i = sel.indexOf(p.id);
      var full = i < 0 && sel.length >= 3;
      return '<button class="chipbtn' + (i >= 0 ? ' on' : '') + '" aria-pressed="' + (i >= 0) + '"' + (full ? ' disabled' : '') + ' onclick="A.cmpToggle(' + p.id + ')">' +
        '<i style="background:' + (i >= 0 ? CMP_COLORS[i] : 'transparent') + '"></i>' + esc(p.name) + '</button>';
    }).join('');
    var base = series[0].m;
    function diff(v, b, higherIsBetter) {
      var d = Math.round(v - b);
      if (!d) return '<span class="df">±0</span>';
      var good = higherIsBetter ? d > 0 : d < 0;
      return '<span class="df ' + (good ? 'up' : 'down') + '">' + (d > 0 ? '＋' : '−') + Math.abs(d).toLocaleString('ja-JP') + '</span>';
    }
    function row(label, f, higher, note) {
      return '<tr><th scope="row">' + label + (note ? '<small>' + note + '</small>' : '') + '</th>' + series.map(function (s, i) {
        var v = f(s.m);
        return '<td><b>' + man(v) + '</b>' + (i ? diff(v, f(base), higher) : '') + '</td>';
      }).join('') + '</tr>';
    }
    var table = '<table class="cmpt"><thead><tr><th></th>' + series.map(function (s) {
        return '<th scope="col"><i style="background:' + s.color + '"></i>' + esc(s.name) + '</th>';
      }).join('') + '</tr></thead><tbody>' +
      row('終了時点の金融資産', function (m) { return m.end; }, true) +
      '<tr><th scope="row">預金が不足する年齢</th>' + series.map(function (s) {
        return '<td>' + (s.m.shortfall ? '<b class="neg">' + s.m.shortfall.age + '歳</b><span class="df">' + s.m.shortfall.year + '年</span>' : '<b>なし</b>') + '</td>';
      }).join('') + '</tr>' +
      row('普通預金等が最も少ない年の額', function (m) { return m.minDep; }, true) +
      row('収入の合計', function (m) { return m.inc; }, true, '期間中') +
      row('支出の合計', function (m) { return m.exp; }, false, '期間中') +
      '<tr><th scope="row">期間</th>' + series.map(function (s) {
        return '<td><span class="df" style="margin:0">' + (s.m.r.years.length ? s.m.r.years[0].year + '〜' + s.m.endYear + '年' : '—') + '</span></td>';
      }).join('') + '</tr>' +
      '</tbody></table>';
    return '<div class="hero"><div class="k">プランの比較</div><div class="note">比べるプランを3つまで選べます</div></div>' +
      '<div class="chips">' + chips + '</div>' +
      '<div class="card chartcard"><h2 class="h3">金融資産の推移</h2>' +
        '<div class="keys">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>' +
        cmpChartSVG(width, series) + '<div class="tip" id="cmptip" hidden></div>' +
      '</div>' +
      '<div class="card tablecard"><h2 class="h3">主な数字</h2><div class="sub">単位：万円。2つ目以降の小さな数字は、1つ目のプランとの差です。</div>' +
        '<div class="tablewrap" tabindex="0" role="region" aria-label="比較の表">' + table + '</div></div>' + DISCLAIMER;
  }

  // ---------- 描画 ----------

  function markTabs() {
    var tabs = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-k') === ui.active);
  }

  function onScroll() {
    if (ui.view !== 'input') return;
    var sc = document.getElementById('scroll');
    var y = sc.scrollTop, next = 'basic';
    ['basic', 'income', 'pension', 'expense', 'invest'].forEach(function (k) {
      var el = document.getElementById('sec-' + k);
      if (el && y >= el.offsetTop - 140) next = k;
    });
    if (next !== ui.active) { ui.active = next; markTabs(); }
  }

  function render() {
    result = E.compute(state);
    issues = {};
    var list = E.validate(state);
    list.forEach(function (i) { (issues[i.at] = issues[i.at] || []).push(i); });
    issueCount = list.length;

    var sc = document.getElementById('scroll');
    var top = sc.scrollTop;
    var active = document.activeElement && document.activeElement.id;

    ['book', 'input', 'cf', 'cmp'].forEach(function (v) {
      var b = document.getElementById('seg-' + v);
      b.classList.toggle('on', ui.view === v);
      b.setAttribute('aria-current', ui.view === v ? 'page' : 'false');
    });
    document.getElementById('seg-book').classList.toggle('due', bookDue());
    document.getElementById('tabbar').hidden = ui.view === 'cover' || ui.view === 'wizard';
    document.getElementById('planname').textContent = plan().name;
    var sheet = document.getElementById('sheetwrap');
    var wasOpen = !sheet.hidden;
    sheet.hidden = !ui.sheet;
    if (ui.sheet) {
      sheet.innerHTML = sheetHTML();
      renderBackup();
      if (!wasOpen) { var t = document.getElementById('sheet-t'); t.tabIndex = -1; t.focus(); }
    } else if (wasOpen) {
      sheet.innerHTML = '';
      document.getElementById('planbtn').focus();
    }

    var summary = document.getElementById('summary');
    summary.hidden = ui.view !== 'input';
    summary.classList.toggle('warn', !!result.shortfall || !result.years.length);
    document.getElementById('sumbody').innerHTML = summaryHTML();
    showDelta();

    document.getElementById('inputview').hidden = ui.view !== 'input';
    document.getElementById('cfview').hidden = ui.view !== 'cf';
    document.getElementById('wizview').hidden = ui.view !== 'wizard';
    document.getElementById('cmpview').hidden = ui.view !== 'cmp';
    document.getElementById('coverview').hidden = ui.view !== 'cover';
    document.getElementById('bookview').hidden = ui.view !== 'book';
    document.getElementById('topbar').hidden = ui.view === 'cover';

    if (ui.view === 'cover') {
      document.getElementById('coverview').innerHTML = coverHTML();
    } else if (ui.view === 'book') {
      var bv = document.getElementById('bookview');
      patchChildren(bv, bookHTML(bv.clientWidth - 56));
      // 選んでいる月を、月の並びの見える位置に（月を変えたときと、家計簿を開いたとき）
      var mk = ui.book.year + '-' + ui.book.month;
      if (ui.book.shown !== mk) {
        var row = bv.querySelector('.bkmonths'), chip = document.getElementById('bkm-' + ui.book.month);
        if (row && chip) { row.scrollLeft = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2; ui.book.shown = mk; }
      }
    } else if (ui.view === 'cmp') {
      var cmp = document.getElementById('cmp');
      cmp.innerHTML = cmpHTML(cmp.clientWidth - 24);
      bindCmpChart(cmpLast);
    } else if (ui.view === 'wizard') {
      document.getElementById('wizview').innerHTML = wizardHTML();
    } else if (ui.view === 'input') {
      document.getElementById('tabs').innerHTML = [['basic', '基本'], ['income', '収入'], ['pension', '年金'], ['expense', '支出'], ['invest', '投資']]
        .map(function (t) { return '<button class="tab' + (ui.active === t[0] ? ' on' : '') + '" data-k="' + t[0] + '" onclick="A.jump(\'' + t[0] + '\')">' + t[1] + '</button>'; }).join('');
      document.getElementById('legend').innerHTML =
        '<span class="chip"><span class="sw" style="background:var(--fill-req)"></span>必須</span>' +
        '<span class="chip"><span class="sw" style="background:var(--fill-opt)"></span>任意</span>' +
        '<span class="ymode"><span>年の入れ方</span><span class="mini" role="radiogroup" aria-label="年の入れ方">' +
          [['year', '西暦'], ['age', '年齢']].map(function (m) {
            var on = store.prefs.yearMode === m[0];
            return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.yearMode(\'' + m[0] + '\')">' + m[1] + '</button>';
          }).join('') + '</span></span>';
      patchChildren(document.getElementById('content'), inputHTML());
    } else {
      var cf = document.getElementById('cf');
      cf.innerHTML = guideHTML() + cfHTML(cf.clientWidth - 24);
      bindChart();
    }

    // 表示中の画面とプランの一覧だけ（隠れている画面の古い入力欄まで調べると遅くなる）
    autoLabel(document.getElementById({ input: 'inputview', cf: 'cfview', cmp: 'cmpview', wizard: 'wizview', cover: 'coverview', book: 'bookview' }[ui.view] || 'inputview'));
    if (ui.sheet) autoLabel(document.getElementById('sheetwrap'));
    sc.scrollTop = top;
    if (active) {
      var el = document.getElementById(active);
      if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
    }
  }

  document.getElementById('scroll').addEventListener('scroll', onScroll, { passive: true });
  var summaryEl = document.getElementById('summary');
  summaryEl.addEventListener('click', function () { A.view('cf'); });
  summaryEl.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); A.view('cf'); }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && ui.sheet) A.planSheet(); });

  // 数字の欄をタップしたら中身を全部選ぶ（そのまま打てば置き換わる。一の位の右を狙ってタップしなくてよい）
  document.addEventListener('focusin', function (ev) {
    var el = ev.target;
    if (!el.classList || !(el.classList.contains('num') || el.classList.contains('sel'))) return;
    setTimeout(function () {
      if (document.activeElement === el) { try { el.setSelectionRange(0, el.value.length); } catch (e) { /* 選べない欄は何もしない */ } }
    }, 0);
  });

  // Enter（キーボードの「次へ」）で、同じ画面の次の入力欄へ
  document.addEventListener('keydown', function (ev) {
    var el = ev.target;
    if (ev.key !== 'Enter' || ev.isComposing || el.tagName !== 'INPUT' || el.type === 'file') return;
    var scope = el.closest('.sheet') || el.closest('#wizview') || el.closest('#content');
    if (!scope) return;
    var all = Array.prototype.filter.call(scope.querySelectorAll('input:not([type=file]):not([type=hidden]), select, textarea'),
      function (x) { return x.offsetParent && !x.disabled; });
    var next = all[all.indexOf(el) + 1];
    ev.preventDefault();
    if (next) next.focus(); else el.blur();
  });

  // スマホで入力している間は、上のバーと目次をたたんで、入力欄の見える範囲を広げる。
  // 欄を移るときや描き直しで一瞬フォーカスが外れても、ちらつかないよう少し待ってから戻す。
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var kbTimer = null;
  function typingField(el) {
    return el && ((el.tagName === 'INPUT' && /^(text|search|tel|email|)$/.test(el.type)) || el.tagName === 'TEXTAREA');
  }
  function setTyping(on) {
    var shell = document.getElementById('shell');
    if (shell.classList.contains('kb') === on) return;
    var sc = document.getElementById('scroll');
    // 本文が画面上で動かないよう、たたむ・戻す前後で本文の位置の差だけスクロールを戻す
    var el = typingField(document.activeElement) ? document.activeElement : document.getElementById(ui.view === 'wizard' ? 'wizview' : 'content');
    var before = el.getBoundingClientRect().top;
    shell.classList.toggle('kb', on);
    sc.scrollTop += el.getBoundingClientRect().top - before;
  }
  if (coarse) {
    document.addEventListener('focusin', function (ev) {
      clearTimeout(kbTimer);
      if (typingField(ev.target) && !ev.target.closest('.sheet')) setTyping(true);
    });
    document.addEventListener('focusout', function () {
      clearTimeout(kbTimer);
      kbTimer = setTimeout(function () { if (!typingField(document.activeElement)) setTyping(false); }, 180);
    });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (ui.view !== 'cf' && ui.view !== 'cmp') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  render();
}());
