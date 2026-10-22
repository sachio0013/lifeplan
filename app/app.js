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
      prefs: { yearMode: 'year', welcomed: false }
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var st = JSON.parse(raw);
        if (st && st.version === 2 && Array.isArray(st.plans)) {
          st.plans = st.plans.filter(function (p) { return p && okState(p.state); });
          if (st.plans.length) {
            if (!byId(st.plans, st.activeId)) st.activeId = st.plans[0].id;
            st.prefs = st.prefs || { yearMode: 'year', welcomed: true };
            return st;
          }
        }
      }
      // 1つしか保存できなかった頃のデータは、そのまま1つ目のプランにする
      var old = localStorage.getItem(OLD_KEY);
      if (old) {
        var s = JSON.parse(old);
        if (okState(s)) return { version: 2, activeId: 1, nextPlanId: 2, plans: [{ id: 1, name: 'プラン1', state: s }], prefs: { yearMode: 'year', welcomed: true } };
      }
    } catch (e) { /* 保存領域が使えない環境では毎回記入例から始める */ }
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
    view: location.hash === '#cf' ? 'cf' : location.hash === '#cmp' ? 'cmp' : 'input',
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
    var t = document.getElementById('toast');
    t.innerHTML = '<span>' + esc(msg) + '</span><button onclick="A.undo()">元に戻す</button>';
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
      var s = byId(state.salaries, sid);
      var th = E.takeHome(state.calc.income, state.calc.spouse === 'あり', state.calc.kids);
      if (s && s.rows[0]) s.rows[0].amount = th.net;
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

    return '<div class="card">' +
      '<div class="head"><span class="ttl">' + esc(label) + '</span><span class="cnt">' + list.length + ' / ' + max + '行</span></div>' +
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
    var th = E.takeHome(state.calc.income, state.calc.spouse === 'あり', state.calc.kids);
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
        '<span class="cnt">' + sal.rows.length + ' / 8行</span></div>' +
      '<div class="hint" style="padding:6px 0 0">手取り（可処分所得）で入力します。2行目以降の金額は今の水準で入れれば、その行の上昇率で開始年から伸ばして計算します。</div>' +
      rows +
      (sal.rows.length < 8 ? addButton('A.salAdd(' + sal.id + ')', '行を追加') : '') +
      (member ? '<div class="retire divide">' + ic('work', 18) + '' +
        numInput(fid('sal', sal.id, 'retire'), 'op' + bad('sal:' + sal.id, 'retire'), 64, sal.retireAge || '', 'A.salRetire(' + sal.id + ',this.value)', ';margin-left:auto') +
        '<span class="u">歳まで働く</span></div>' +
        vmsgs('sal:' + sal.id) +
        '<div class="hint" style="padding-top:2px">' + (sal.retireAge ? (mBirth + sal.retireAge) + '年以降の収入は0として計算します' : '空欄なら、行で入れた金額がずっと続きます') + '</div>' : '') +
      '<div class="divide">' +
        '<button class="toggle" onclick="A.calcToggle(' + sal.id + ')">' + ic('calc', 18, 'lead') + '<span class="lbl">額面から手取りを計算</span><span class="chev">' + chevron(calcOpen) + '</span></button>' +
        (calcOpen ?
          '<div class="calcbox">' +
            '<div class="calcrow"><span class="u" style="width:72px">年収（額面）</span>' +
              numInput('f-calc-income', 'op', 84, state.calc.income, "A.calc('income',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">万円</span></div>' +
            '<div class="calcrow"><span class="u" style="width:72px">扶養配偶者</span>' +
              selectInput('f-calc-spouse', 'op', 'margin-left:auto;background-color:var(--surface)', ['なし', 'あり'], state.calc.spouse, "A.calc('spouse',this.value)") + '</div>' +
            '<div class="calcrow"><span class="u" style="width:72px">扶養の子</span>' +
              numInput('f-calc-kids', 'op', 56, state.calc.kids, "A.calc('kids',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">人</span></div>' +
            '<div class="calcresult"><span class="u" style="font-weight:700">手取り</span>' +
              '<span style="font-size:20px;font-weight:900;color:var(--accent-ink);margin-left:auto">' + th.net + '</span><span class="u" style="font-weight:700">万円</span></div>' +
            '<div class="hint" style="padding:4px 0 0">社会保険料 ' + th.social + '万円・税 ' + th.tax + '万円を差し引き（手取り率 ' + th.ratio + '％）。会社員で年収150〜1000万円程度向けの目安です。</div>' +
            '<button class="btn block" onclick="A.calcApply(' + sal.id + ')">1行目の手取額に反映する</button>' +
          '</div>' : '') +
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
    return '<div class="card">' +
      '<div class="head"><span class="ttl">' + esc(child.name || child.relation) + 'の教育費</span><span class="cnt">' + esc(child.birth) + (early ? '・早生まれ' : '') + '</span></div>' +
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
      '<div class="ttl" style="margin-bottom:11px">自動車の購入費</div>' +
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
    return '<div class="card">' +
      '<div class="head"><span class="ttl">' + esc(label) + '</span><span class="cnt">' + list.length + ' / 5行</span></div>' +
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
          selectInput(fid('fam', m.id, 'gender'), 'op', '', [{ value: '', label: '性別' }, '男性', '女性'], m.gender || '',
 'A.fam(' + m.id + ",'gender',this.value)") +
          selectInput(fid('fam', m.id, 'rel'), 'op', '', REL, m.relation, 'A.fam(' + m.id + ",'relation',this.value)") +
          selectInput(fid('fam', m.id, 'job'), 'op', '', JOBS, m.job, 'A.fam(' + m.id + ",'job',this.value)") +
          (i > 0 ? '<button class="btn ghost" style="margin-left:auto" onclick="A.delFamily(' + m.id + ')">' + (ui.confirmDelMember === m.id ? 'もう一度押すと削除' : 'この人を削除') + '</button>' : '') +
        '</div>' : '') +
      '</div>';
    }).join('');

    return '<h2 class="sec" id="sec-basic">' + ic('tune', 20) + '基本</h2>' +
      '<div class="card">' +
        '<div class="ttl" style="margin-bottom:11px">シミュレーション期間</div>' +
        '<div class="rowtop"><span class="u" style="width:44px">開始年</span>' +
          numInput('f-start', 'rq' + bad('start', 'start'), 84, state.startYear, 'A.start(this.value)') + '<span class="u">年から</span>' +
          numInput('f-endage', 'op' + bad('start', 'endAge'), 64, state.endAge, 'A.endAge(this.value)', ';margin-left:auto') + '<span class="u">歳まで</span>' +
        '</div>' +
        vmsgs('start') +
      '</div>' +
      '<div class="card"><div class="ttl" style="margin-bottom:2px">前年末の金融資産</div>' + assets +
        '<div class="rowtop divide" style="padding:10px 0"><span class="u">普通預金等の利率</span>' +
          numInput('f-deprate', 'op' + bad('deprate', 'depositRate'), 64, state.depositRate || 0, 'A.depositRate(this.value)', ';margin-left:auto') + '<span class="u">％</span></div>' +
        vmsgs('deprate') +
        '<div class="hint" style="padding-top:0">投資資産の名前は自由に変えられ、投資セクションの見出しに反映されます</div>' +
      '</div>' +
      '<div class="card"><div class="head"><span class="ttl">家族構成</span><span class="cnt">最大6人</span></div>' + family +
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
    h += welcomeHTML();
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
    return '<div class="hero"><div class="k">終了時点（' + last.year + '年・家族１ ' + last.age + '歳）の金融資産</div>' +
        '<div class="v">' + man(result.endTotal) + '<small> 万円</small></div>' +
        '<div class="note">うち普通預金等 ' + man(last.assets.deposit) + '万円・投資資産 ' + man(last.assets.investTotal) + '万円</div></div>' +
      (sf ? '<div class="alert">' + ic('warn', 19) + '<span>' + sf.year + '年（家族１が' + sf.age + '歳）に普通預金等がマイナスになります。最も少ない年で ' + man(sf.minDeposit) + '万円です。</span></div>' : '') +
      '<div class="card chartcard"><h3>金融資産残高の推移</h3>' +
        '<div class="keys"><span><i style="background:var(--c-deposit)"></i>普通預金等</span><span><i style="background:var(--c-invest)"></i>投資資産</span></div>' +
        chartSVG(width) +
        '<div class="tip" id="tip" hidden></div>' +
      '</div>' +
      '<div class="card tablecard"><h3>キャッシュフロー表</h3><div class="sub">単位：万円。横にスクロールできます。</div>' +
        '<div class="tablewrap">' + tableHTML() + '</div>' +
      '</div>' +
      '<div style="text-align:center;margin-top:6px"><button class="btn ghost" onclick="A.view(\'input\')">入力に戻る</button></div>';
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
    ui.loanConfirm = false;
    ui.loanOpen = false;
    commit();
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
    return '<div class="fl"><label class="lb" for="' + id + '">' + label + '</label>' +
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
        '<button class="del" style="margin:0" aria-label="かんたん入力を閉じる" onclick="A.wizClose()">' + ic('close', 22) + '</button>' +
        '<div class="dots" aria-hidden="true">' + WZ_STEPS.map(function (x, i) { return '<i class="' + (i < s ? 'done' : i === s ? 'on' : '') + '"></i>'; }).join('') + '</div>' +
        '<span class="u">' + (s + 1) + ' / ' + WZ_STEPS.length + '</span>' +
      '</div>' +
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

  A.wizOpen = function () {
    ui.wz = { step: 0, d: wzDraft(), err: {}, from: ui.view === 'wizard' ? 'input' : ui.view };
    ui.penOpen.wz = false;
    store.prefs.welcomed = true;
    ui.view = 'wizard';
    commit();
    document.getElementById('scroll').scrollTop = 0;
  };
  A.wizClose = function () { ui.view = ui.wz ? ui.wz.from : 'input'; ui.wz = null; commit(); };
  A.wz = function (key, v, el) {
    var d = ui.wz.d;
    if (key === 'has2') d.has2 = !!v;
    else if (key.indexOf('birth') === 0) d[key] = normBirth(v);
    else if (key === 'name1' || key === 'name2') d[key] = v;
    else d[key] = String(v).trim() === '' ? '' : String(toNum(v));
    delete ui.wz.err[key];
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
    var n = store.plans.length + 1;
    var p = { id: store.nextPlanId++, name: 'プラン' + n, state: window.LifePlanSample.fromAnswers(w.d) };
    while (store.plans.some(function (x) { return x.name === p.name; })) p.name = 'プラン' + (++n);
    store.plans.push(p);
    store.activeId = p.id;
    state = p.state;
    ui.wz = null; ui.view = 'cf'; ui.active = 'basic'; ui.inputScroll = 0; ui.openMember = 0; ui.openCalc = 0;
    quiet = true;
    commit();
    document.getElementById('scroll').scrollTop = 0;
  };
  A.welcomeDone = function () { store.prefs.welcomed = true; commit(); };

  function welcomeHTML() {
    if (store.prefs.welcomed) return '';
    return '<div class="welcome">' +
      '<div class="t">ようこそ</div>' +
      '<p>いま入っているのは記入例（共働きの夫婦と子供2人）です。数字を書き換えると、上の資産の見通しがその場で変わります。</p>' +
      '<p>ご自分の家計で試すなら、必須の項目だけを順に聞く「かんたん入力」が手早いです（6ステップ）。</p>' +
      '<div class="row"><button class="btn" onclick="A.wizOpen()">かんたん入力で始める</button><button class="btn ghost" onclick="A.welcomeDone()">記入例を見る</button></div>' +
    '</div>';
  }

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
    'inflation', 'rate', 'fromYear', 'every', 'untilAge', 'income', 'kids', 'nextId', 'from', 'to', 'payFrom', 'payTo', 'basic', 'adjust', 'start', 'upkeep'];
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

  function backupText() {
    return JSON.stringify({
      app: 'lifeplan', kind: 'backup', version: 2, savedAt: new Date().toISOString(),
      plans: store.plans.map(function (p) { return { name: p.name, state: p.state }; })
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
    if (!list.length) return { error: '読み込めるプランが見つかりませんでした' };
    return { plans: list };
  }

  function renderBackup() {
    var el = document.getElementById('backup');
    if (!el) return;
    var b = ui.backup;
    var msg = b.msg ? '<div class="vmsg ' + (b.level || 'ok') + '">' + ic(b.level === 'error' ? 'warn' : 'check', 15) + '<span>' + esc(b.msg) + '</span></div>' : '';
    var pending = b.pending
      ? '<div class="plconfirm ok"><span>' + b.pending.length + '件のプラン（' + b.pending.map(function (p) { return '「' + esc(p.name) + '」'; }).join('') + '）を追加します。今あるプランはそのまま残ります。</span>' +
        '<button class="btn" onclick="A.backupAdd()">追加する</button><button class="btn ghost" onclick="A.backupCancel()">やめる</button></div>'
      : '';
    el.innerHTML = '<div class="bk">' +
      '<div class="lb">バックアップ</div>' +
      '<div class="hint" style="padding:0 0 8px">入力はこの端末のこのブラウザの中だけに保存されています。ファイルにしておくと、機種変更やデータの削除のあとでも戻せます。</div>' +
      '<div class="sheetbtns" style="margin:0">' +
        '<button class="btn ghost" onclick="A.backupSave()">すべてのプランをファイルに保存</button>' +
        '<label class="btn ghost" for="f-backup-file" role="button" tabindex="0" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();this.click();}">ファイルから読み込む</label>' +
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
    ui.backup.pending = r.plans; ui.backup.msg = '';
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
    var first = null;
    list.forEach(function (p) {
      var np = { id: store.nextPlanId++, name: uniqueName(p.name), state: p.state };
      np.state.nextId = Math.max(toNum(np.state.nextId), 500);
      store.plans.push(np);
      if (!first) first = np;
    });
    switchTo(first.id);
    ui.backup = { msg: list.length + '件のプランを追加し、「' + first.name + '」を表示しています', level: 'ok', text: false, pending: null };
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
      '<div class="card chartcard"><h3>金融資産の推移</h3>' +
        '<div class="keys">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>' +
        cmpChartSVG(width, series) + '<div class="tip" id="cmptip" hidden></div>' +
      '</div>' +
      '<div class="card tablecard"><h3>主な数字</h3><div class="sub">単位：万円。2つ目以降の小さな数字は、1つ目のプランとの差です。</div>' +
        '<div class="tablewrap">' + table + '</div></div>';
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

    ['input', 'cf', 'cmp'].forEach(function (v) {
      var b = document.getElementById('seg-' + v);
      b.classList.toggle('on', ui.view === v);
      b.setAttribute('aria-selected', ui.view === v);
    });
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

    if (ui.view === 'cmp') {
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
      document.getElementById('content').innerHTML = inputHTML();
    } else {
      var cf = document.getElementById('cf');
      cf.innerHTML = cfHTML(cf.clientWidth - 24);
      bindChart();
    }

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
