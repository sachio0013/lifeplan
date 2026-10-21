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
  var STORE_KEY = 'lifeplan.v1';
  var REL = ['家族１', '家族２', '子供１', '子供２', '子供３', '子供４', '親', 'その他'];
  var JOBS = ['会社員等', 'パート', '自営業', '専業主婦', '学生', '乳幼児', '自由業', 'その他'];

  // ---------- 保存と読み込み ----------

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.version === 1 && Array.isArray(s.family) && s.family.length) return s;
      }
    } catch (e) { /* 保存領域が使えない環境では毎回サンプルから始める */ }
    return window.LifePlanSample.sample();
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 同上 */ }
  }

  var state = load();
  var ui = {
    view: location.hash === '#cf' ? 'cf' : 'input',
    active: 'basic',
    openMember: 0,
    openCalc: 0,
    carDetailOpen: false,
    confirmReset: false,
    confirmDelMember: 0,
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
  function toNum(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fid() { return 'f-' + Array.prototype.join.call(arguments, '-'); }
  function nid() { return state.nextId++; }
  function byId(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
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
    del: function (key, id) { state[key] = state[key].filter(function (r) { return r.id !== id; }); commit(); },
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
      m.birth = v ? v.replace(/-/g, '/') : '';
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
      state.family.push({ id: id, name: '', gender: '男性', relation: REL[Math.min(state.family.length, 7)], birth: '', job: '会社員等' });
      ui.openMember = id;
      commit();
    },
    delFamily: function (id) {
      if (ui.confirmDelMember !== id) { ui.confirmDelMember = id; commit(); return; }
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
    salDel: function (sid, rid) { var s = byId(state.salaries, sid); if (s) s.rows = s.rows.filter(function (r) { return r.id !== rid; }); commit(); },
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
    delEarner: function (sid) { state.salaries = state.salaries.filter(function (s) { return s.id !== sid; }); commit(); },

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
    invDel: function (aid, kind, rid) { var iv = state.invest[aid]; iv[kind] = iv[kind].filter(function (r) { return r.id !== rid; }); commit(); },
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
      if (ui.view === 'input') ui.inputScroll = sc.scrollTop;
      ui.view = v;
      render();
      sc.scrollTop = v === 'input' ? ui.inputScroll : 0;
    },
    resetAsk: function () { ui.confirmReset = true; commit(); },
    resetNo: function () { ui.confirmReset = false; commit(); },
    resetYes: function () {
      state = window.LifePlanSample.sample();
      ui.confirmReset = false; ui.openMember = 0; ui.openCalc = 0;
      commit();
      document.getElementById('scroll').scrollTop = 0;
    }
  };
  window.A = A;


  // ---------- アイコン（Webフォントに頼らず、読み込み前でも崩れないようSVGで描く） ----------

  var ICONS = {
    add: '<path d="M12 5v14M5 12h14"/>',
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
    return '<input type="number" inputmode="decimal" id="' + id + '" class="' + cls + '" style="width:' + width + 'px' + (extra || '') + '" value="' + esc(value) + '" onchange="' + handler + '">';
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
  function lockedYear() {
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
      var ageYear = opts.anchorFirst && i === 0 ? state.startYear : r.year;
      var ageHint = r.year ? (opts.hasTo
        ? '家族１ ' + (r.year - by) + '歳 〜 ' + (r.toYear - by) + '歳（' + (r.toYear - r.year + 1) + '年間）'
        : '家族１ ' + (r.year - by) + '歳') : '';
      var locked = opts.anchorFirst && i === 0;
      return '<div class="rowline divide">' +
        '<div class="rowtop">' +
          (locked ? lockedYear() :
            numInput(fid(key, r.id, 'year'), cls + bad(at, 'year'), 76, r.year, 'A.num(' + q + ",'year',this.value)") +
            '<span class="u">' + opts.yearSuffix + '</span>') +
          (opts.hasTo ? numInput(fid(key, r.id, 'to'), cls + bad(at, 'toYear'), 76, r.toYear, 'A.num(' + q + ",'toYear',this.value)", ';margin-left:2px') + '<span class="u">年まで</span>' : '') +
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
    opts.yearSuffix = opts.lump ? '年に' : '年から';
    return '<div class="card">' +
      '<div class="head"><span class="ttl">' + esc(label) + '</span><span class="cnt">' + list.length + ' / ' + max + '行</span></div>' +
      (opts.inflation ? '<div class="rowtop divide" style="padding:10px 0"><span class="u">物価上昇率</span>' +
        numInput('f-inflation', 'rq' + bad('infl', 'inflation'), 64, state.inflation, 'A.infl(this.value)', ';margin-left:auto') + '<span class="u">％</span></div>' +
        (issuesAt('infl').length ? '<div style="padding-bottom:10px">' + vmsgs('infl') + '</div>' : '') : '') +
      rowsHTML(key, list, opts) +
      (list.length < max ? addButton("A.add('" + key + "'," + max + ',' + !!opts.hasTo + ')', '行を追加') : '') +
      (opts.hint ? '<div class="hint divide">' + esc(opts.hint) + '</div>' : '') +
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
          (i === 0 ? lockedYear() :
            numInput(fid('sal', sal.id, r.id, 'year'), cls + bad(at, 'year'), 76, r.year, 'A.sal(' + q + ",'year',this.value)") +
            '<span class="u">年から</span>' + delButton('A.salDel(' + q + ')')) +
        '</div>' +
        '<div class="ageh">' + esc(memberName(sal.memberId)) + ' ' + (y - mBirth) + '歳</div>' +
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
          numInput(fid('edu', child.id, st.index, 'from'), 'op', 76, st.from, 'A.eduSpan(' + base + ",'from',this.value," + st.autoFrom + ',' + st.autoTo + ')') +
          '<span class="u">年から</span>' +
          numInput(fid('edu', child.id, st.index, 'to'), 'op' + bad(at, 'to'), 76, st.to, 'A.eduSpan(' + base + ",'to',this.value," + st.autoFrom + ',' + st.autoTo + ')') +
          '<span class="u">年まで</span>' +
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
        numInput('f-car-from', 'op', 76, c.fromYear, "A.car('fromYear',this.value)") + '<span class="u">年から</span>' +
        numInput('f-car-every', 'op' + bad('car', 'every'), 52, c.every, "A.car('every',this.value)", ';margin-left:2px') + '<span class="u">年ごとに</span>' +
        numInput('f-car-until', 'op' + bad('car', 'untilAge'), 56, c.untilAge, "A.car('untilAge',this.value)", ';margin-left:auto') + '<span class="u">歳まで</span>' +
      '</div>' +
      vmsgs('car') +
      '<div class="rowtop" style="margin-top:10px"><span class="u">1回あたり</span>' +
        numInput('f-car-amt', 'op', 96, c.amount, "A.car('amount',this.value)", ';margin-left:auto') + '<span class="u">万円</span></div>' +
      '<div class="divide" style="margin-top:10px">' +
        '<button class="toggle" onclick="A.carToggle()">' + ic('tune', 18, 'lead') + '<span class="lbl">回ごとに金額を変える</span><span class="chev">' + chevron(ui.carDetailOpen) + '</span></button>' +
        (ui.carDetailOpen ? occ.map(function (o) {
          return '<div class="occ divide"><span style="font-size:13px;font-weight:700">' + o.year + '年</span><span class="u">家族１ ' + (o.year - by) + '歳</span>' +
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
          numInput(fid('inv', asset.id, kind, r.id, 'year'), 'op' + bad(at, 'year'), 76, r.year, 'A.inv(' + q + ",'year',this.value)") + '<span class="u">年から</span>' +
          numInput(fid('inv', asset.id, kind, r.id, 'to'), 'op' + bad(at, 'toYear'), 76, r.toYear, 'A.inv(' + q + ",'toYear',this.value)", ';margin-left:2px') + '<span class="u">年まで</span>' +
          delButton('A.invDel(' + q + ')') +
        '</div>' +
        '<div class="ageh">家族１ ' + (r.year - by) + '歳 〜 ' + (r.toYear - by) + '歳（' + (r.toYear - r.year + 1) + '年間・計' + man((r.toYear - r.year + 1) * r.amount) + '万円）</div>' +
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
        (a.fixed ? '<span style="font-size:14px;font-weight:500">' + esc(a.name) + '</span>'
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
          '<button class="del" aria-label="詳しく" onclick="A.member(' + m.id + ')">' + chevron(open, 22) + '</button>' +
        '</div>' +
        '<div class="n2">' +
          '<input type="date" id="' + fid('fam', m.id, 'birth') + '" class="' + cls + bad('fam:' + m.id, 'birth') + ' date" min="1900-01-01" max="2100-12-31" aria-label="生年月日"' +
            ' value="' + isoDate(m.birth) + '" onchange="A.birth(' + m.id + ',this.value,this)" onblur="A.flush()">' +
          '<span class="u">' + ageLabel + '</span>' +
          '<span class="badge" style="margin-left:auto">' + esc(m.relation) + '</span>' +
        '</div>' +
        vmsgs('fam:' + m.id) +
        (open ? '<div class="expand">' +
          selectInput(fid('fam', m.id, 'gender'), 'op', '', ['男性', '女性'], m.gender, 'A.fam(' + m.id + ",'gender',this.value)") +
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
    h += groupCard('pubPension', '公的年金', { max: 5, requiredFirst: true, dupCheck: true, memo: true, hint: '家族１が65歳＝' + (by + 65) + '年／70歳＝' + (by + 70) + '年' });

    h += '<h2 class="sec" id="sec-expense">' + ic('expense', 20) + '支出</h2>';
    h += groupCard('living', '基本生活費', { max: 5, requiredFirst: true, anchorFirst: true, inflation: true, dupCheck: true, memo: true, hint: '住宅費・教育費・保険料・自動車・その他を除いた、ふだんの支出。2行目以降は今の物価で入れれば、物価上昇を足して計算します。' });
    h += groupCard('housing', '住宅費', { max: 5, requiredFirst: true, anchorFirst: true, dupCheck: true, memo: true, hint: '家賃・ローン・修繕/管理費・固定資産税の合計' });
    h += groupCard('housingLump', '住宅費一時金（頭金など）', { max: 3, lump: true, memo: true });
    E.children(state).forEach(function (c) { h += eduCard(c); });
    h += groupCard('insurance', '保険料', { max: 7, requiredFirst: true, dupCheck: true, memo: true });
    h += groupCard('carCost', '自動車の維持費', { max: 5, dupCheck: true, memo: true, hint: '税金・保険・車検・駐車場・整備の年額。下の購入費の「◯歳まで」（今は' + state.carBuy.untilAge + '歳）を過ぎた年からは、車を手放したとみなして0になります。' });
    h += carCard();
    h += groupCard('otherFlow', 'その他の経常支出', { max: 5, dupCheck: true, memo: true, hint: '同じ年は1行にまとめます（趣味と旅行なら合算して1行）' });
    h += groupCard('otherLump', 'その他の一時支出', { max: 5, lump: true, memo: true, hint: '子供の結婚の援助、留学費など' });

    h += '<h2 class="sec" id="sec-invest">' + ic('invest', 20) + '投資</h2>';
    state.assets.filter(function (a) { return !a.fixed; }).forEach(function (a) {
      h += investCard(a, 'add', a.name + 'へ積立', true);
      h += investCard(a, 'out', a.name + 'の現金化', false);
    });

    h += '<footer class="done">入力はここまでです。おつかれさまでした。</footer>';
    h += '<div class="reset">' + (ui.confirmReset
      ? '<div class="q">入力をすべて消して、サンプルの内容に戻しますか？</div><div class="row"><button class="btn" onclick="A.resetYes()">サンプルに戻す</button><button class="btn ghost" onclick="A.resetNo()">やめる</button></div>'
      : '<button class="btn ghost" onclick="A.resetAsk()">サンプルの内容に戻す</button>') + '</div>';
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
      return '<div class="warnline">' + ic('warn', 18) + '<span>計算できません</span><span class="worst" style="font-size:12px">期間と生年月日を確認</span></div>';
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
    var L = 46, R = 8, T = 10, B = 34;
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

    document.getElementById('seg-input').classList.toggle('on', ui.view === 'input');
    document.getElementById('seg-cf').classList.toggle('on', ui.view === 'cf');
    document.getElementById('seg-input').setAttribute('aria-selected', ui.view === 'input');
    document.getElementById('seg-cf').setAttribute('aria-selected', ui.view === 'cf');

    var summary = document.getElementById('summary');
    summary.hidden = ui.view !== 'input';
    summary.classList.toggle('warn', !!result.shortfall || !result.years.length);
    document.getElementById('sumbody').innerHTML = summaryHTML();
    showDelta();

    document.getElementById('inputview').hidden = ui.view !== 'input';
    document.getElementById('cfview').hidden = ui.view !== 'cf';

    if (ui.view === 'input') {
      document.getElementById('tabs').innerHTML = [['basic', '基本'], ['income', '収入'], ['pension', '年金'], ['expense', '支出'], ['invest', '投資']]
        .map(function (t) { return '<button class="tab' + (ui.active === t[0] ? ' on' : '') + '" data-k="' + t[0] + '" onclick="A.jump(\'' + t[0] + '\')">' + t[1] + '</button>'; }).join('');
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
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (ui.view !== 'cf') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  render();
}());
