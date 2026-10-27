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
    view: location.hash === '#cf' ? 'cf' : location.hash === '#cmp' ? 'cmp' : location.hash === '#book' ? 'book' : location.hash === '#risk' ? 'risk' : store.prefs.welcomed ? 'input' : 'cover',
    cover: { family: 'kid2', home: 'rent', needs: [] },   // 表紙で選んでいるもの
    help: '',          // 開いている「？」の説明
    thDef: false,      // 手取り計算の「手取りに含めるもの・含めないもの」を開いているか
    thMore: 0,         // 手取り計算の「細かく設定」を開いている給与の id
    book: { year: new Date().getFullYear(), month: new Date().getMonth(), mode: 'month', edit: false, picks: {}, target: 0,  // 家計簿の表示
      slip: new Date().getMonth(), who: '1' },  // 給与明細：表示している明細（0〜11が月、12・13が夏・冬の賞与）と、だれの明細か
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
    penDetail: {},                         // 公的年金の見込みで、人ごとの設定を開いているか（'state-1' など）
    dcOpen: false, dcTable: false,         // DC（会社拠出）の見込額の計算を開いているか、年ごとの表を開いているか
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
    dansin: function (key, id, on) { var r = byId(state[key], id); if (!r) return; if (on) r.dansin = true; else delete r.dansin; commit(); },
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
    invest: '<path d="M12 21v-9M12 12c0-4 3-7 8-7 0 4.5-3 7-8 7zM12 14.5c0-3-2.5-5.5-7-5.5 0 3.5 2.5 5.5 7 5.5z"/>',
    shield: '<path d="M12 3.5 5 6.2v5.3c0 4.4 3 8 7 9 4-1 7-4.6 7-9V6.2z"/><path d="M9 12l2.2 2.2L15.5 10"/>'
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
        // 住宅ローンの行：団体信用生命保険（団信）があれば、もしもの時は返済がなくなる（保障タブで使う）
        (opts.dansin && toNum(r.amount) > 0 ? '<div class="dansin"><label><input type="checkbox" id="' + fid(key, r.id, 'dansin') + '"' + (r.dansin ? ' checked' : '') +
          ' onchange="A.dansin(' + q + ',this.checked)"><span>団信あり</span></label>' +
          (r.dansin ? '<span class="u" style="margin-left:auto">うち返済</span>' + numInput(fid(key, r.id, 'loan'), 'op', 72, r.loan === undefined || r.loan === '' ? r.amount : r.loan, 'A.num(' + q + ",'loan',this.value)") + '<span class="u">万円</span>' : '') +
        '</div>' : '') +
      '</div>';
    }).join('');
  }

  function groupCard(key, label, opts) {
    var list = state[key] || [];
    var max = opts.max || 5;

    return '<div class="card" id="card-' + key + '">' +
      '<div class="head"><span class="ttl">' + esc(label) + '</span>' + helpBtn(key) + '<span class="cnt">' + list.length + ' / ' + max + '行</span></div>' +
      helpBox(key) +
      (opts.top || '') +
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

  // ---------- 取り崩しの提案（老後に普通預金等をおおむね一定に保つ） ----------
  // 入力は state.drawdown = { target, startAge }。計算は E.drawdownPlan（開いているときだけ）

  function ddInputs() {
    var d = state.drawdown || {};
    var m1 = state.family.filter(function (m) { return m.relation === '家族１'; })[0];
    var sal = m1 && state.salaries.filter(function (x) { return x.memberId === m1.id; })[0];
    var retire = sal && toNum(sal.retireAge) ? toNum(sal.retireAge) : 65;
    return { target: d.target === undefined || d.target === '' ? 1500 : toNum(d.target), startAge: d.startAge === undefined || d.startAge === '' ? retire : toNum(d.startAge) };
  }
  function ddChartSVG(p, width) {
    var W = Math.max(280, width || 320), H = 140, P = 8, L = 40;
    var ys = p.after.years.filter(function (y) { return y.year >= p.start - 5; });
    var bf = {}; p.before.years.forEach(function (y) { bf[y.year] = y.assets.deposit; });
    var n = ys.length; if (n < 2) return '';
    var vals = ys.map(function (y) { return y.assets.deposit; }).concat(ys.map(function (y) { return bf[y.year]; }), [p.target, 0]);
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (max === min) max = min + 1;
    var X = function (i) { return L + (W - L - P) * i / (n - 1); }, Y = function (v) { return P + (H - 2 * P) * (max - v) / (max - min); };
    var line = function (f) { return ys.map(function (y, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(f(y)).toFixed(1); }).join(''); };
    var si = ys.map(function (y) { return y.year; }).indexOf(p.start);
    return '<svg class="rkchart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="普通預金等の推移。今のままと、提案どおりに取り崩した場合">' +
      '<line x1="' + L + '" x2="' + (W - P) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="var(--line)" stroke-width="1.5"/>' +
      '<line x1="' + L + '" x2="' + (W - P) + '" y1="' + Y(p.target).toFixed(1) + '" y2="' + Y(p.target).toFixed(1) + '" stroke="var(--text-faint)" stroke-dasharray="4 4"/>' +
      '<text x="' + (L - 4) + '" y="' + (Y(p.target) + 4).toFixed(1) + '" text-anchor="end" class="ax">' + man(p.target) + '</text>' +
      '<text x="' + (L - 4) + '" y="' + (Y(0) + 4).toFixed(1) + '" text-anchor="end" class="ax">0</text>' +
      (si >= 0 ? '<line x1="' + X(si).toFixed(1) + '" x2="' + X(si).toFixed(1) + '" y1="' + P + '" y2="' + (H - P) + '" stroke="var(--text-faint)" stroke-dasharray="2 4"/>' : '') +
      '<path d="' + line(function (y) { return bf[y.year]; }) + '" fill="none" stroke="var(--s1)" stroke-width="2.5"/>' +
      '<path d="' + line(function (y) { return y.assets.deposit; }) + '" fill="none" stroke="var(--c-deposit)" stroke-width="3"/>' +
    '</svg>' +
    '<div class="catlegend"><span><i style="background:var(--s1)"></i>今のまま</span><span><i style="background:var(--c-deposit)"></i>提案どおり</span><span><i style="background:var(--text-faint)"></i>目標</span></div>';
  }
  function drawdownCardHTML() {
    var open = ui.ddOpen;
    var head = '<button class="toggle" aria-expanded="' + !!open + '" onclick="A.ddToggle()">' + ic('calc', 18, 'lead') +
      '<span class="lbl">取り崩しの提案（老後の普通預金等を一定に保つ）</span><span class="chev">' + chevron(open) + '</span></button>';
    var invs = state.assets.filter(function (a) { return !a.fixed; });
    if (!open) return '<div class="card ddcard">' + head + '<div class="hint" style="padding:4px 0 0">保ちたい預金の額を決めると、毎年いくら現金化すればよいかを提案します。</div></div>';
    var inp = ddInputs(), by = baseBirth();
    var field = function (f, label, small, unit, v) {
      return '<div class="calcrow"><span class="u" style="flex:1;min-width:0">' + label + (small ? '<small>' + small + '</small>' : '') + '</span>' +
        numInput('f-dd-' + f, 'op', 84, v, "A.dd('" + f + "',this.value)", ';margin-left:auto;background:var(--surface)') + '<span class="u">' + unit + '</span></div>';
    };
    var body = field('target', '保ちたい普通預金等', 'この額くらいを保つように取り崩します', '万円', inp.target) +
      field('startAge', '取り崩しを始める年齢', '家族１の年齢', '歳から', inp.startAge);
    if (!invs.length || !result.years.length) return '<div class="card ddcard">' + head + '<div class="calcbox">' + body + '<div class="hint">投資資産がないので、提案できません。</div></div></div>';
    var p = E.drawdownPlan(state, inp);
    var ageOf = function (y) { return y - by; };
    var segs = p.segments.filter(function (g) { return g.total > 0; });
    var list = p.segments.map(function (g) {
      return '<div class="ddseg"><span class="when">' + ageOf(g.from) + '〜' + ageOf(g.to) + '歳<small>' + g.from + '〜' + g.to + '年</small></span>' +
        '<span class="amt"><b>' + (g.total ? penFmt(g.total) : '0') + '</b>万円／年' +
        (g.parts.length > 1 || (g.parts[0] && invs.length > 1) ? '<small>' + g.parts.map(function (x) { return esc(x.name) + ' ' + penFmt(x.amount); }).join('・') + '</small>' : '') + '</span></div>';
    }).join('');
    var status = !segs.length
      ? '<div class="vmsg ok">' + ic('check', 15) + '<span>取り崩さなくても、普通預金等は目標の' + man(p.target) + '万円を上回ります。</span></div>'
      : p.short
        ? '<div class="vmsg warn">' + ic('warn', 15) + '<span>' + (p.keptUntil ? ageOf(p.keptUntil) + '歳（' + p.keptUntil + '年）ごろまでは目標を保てますが、その後は' : 'すぐに') + '投資資産が足りず、目標を保てません。目標を下げるか、支出や働き方を見直してください。</span></div>'
        : '<div class="vmsg ok">' + ic('check', 15) + '<span>' + ageOf(p.end) + '歳（' + p.end + '年）まで、普通預金等をおおむね' + man(p.target) + '万円に保てます。</span></div>';
    return '<div class="card ddcard">' + head +
      '<div class="calcbox">' + body +
        '<div class="calcsec">提案（10年ごとに見直す額）</div>' + list + status +
        ddChartSVG(p, 320) +
        (segs.length ? '<button class="btn block" onclick="A.ddApply()">この取り崩しを入れる</button>' : '') +
        '<div class="hint" style="padding:8px 0 0">取り崩す順は、税金のかかる口座 → iDeCo → NISAなど税金のかからない口座（NISAを長く残すため）。各期間の最後の年に普通預金等が目標になる額で、1つの投資から取り崩すのは残高が足りる額までです。入れると、' + ageOf(p.start) + '歳より後の現金化の行は、この提案に置き換わります。</div>' +
      '</div>' +
    '</div>';
  }
  A.ddToggle = function () { ui.ddOpen = !ui.ddOpen; commit(); };
  A.dd = function (f, v) { if (!state.drawdown) state.drawdown = {}; state.drawdown[f] = String(v).trim() === '' ? '' : toNum(v); commit(); };
  A.ddApply = function () {
    var p = E.drawdownPlan(state, ddInputs());
    snapshot('取り崩しの提案を、現金化の行に入れました');
    Object.keys(p.rows).forEach(function (id) {
      var iv = state.invest[id] || (state.invest[id] = { add: [], out: [] });
      iv.out = p.rows[id].map(function (r) { var c = { id: nid(), year: r.year, toYear: r.toYear, amount: r.amount, memo: r.memo || '' }; return c; });
    });
    commit();
  };

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
    h += groupCard('lump', '退職一時金・その他一時収入', { max: 3, lump: true, memo: true, hint: '不動産の売却や親からの援助もここへ', extra: dcCalcHTML() });
    h += groupCard('corpPension', '企業年金', { max: 5, hasTo: true, memo: true });
    h += groupCard('privPension', '個人年金・保険など', { max: 5, hasTo: true, memo: true, hint: '備考に契約名を書いておくと、あとで見返したときに分かります' });
    h += pubPensionCard(by);

    h += '<h2 class="sec" id="sec-expense">' + ic('expense', 20) + '支出</h2>';
    h += groupCard('living', '基本生活費', { monthly: true, max: 5, requiredFirst: true, anchorFirst: true, inflation: true, dupCheck: true, memo: true, hint: '住宅費・教育費・保険料・自動車・その他を除いた、ふだんの支出。2行目以降は今の物価で入れれば、物価上昇を足して計算します。' });
    h += groupCard('housing', '住宅費', { monthly: true, max: 5, requiredFirst: true, anchorFirst: true, dupCheck: true, memo: true, dansin: true, hint: '家賃・ローン・修繕/管理費・固定資産税の合計。住宅ローンに団信があれば印を付けると、保障タブで「もしもの時は返済がなくなる」として計算します', extra: loanCalcHTML() });
    h += groupCard('housingLump', '住宅費一時金（頭金など）', { max: 3, lump: true, memo: true });
    E.children(state).forEach(function (c) { h += eduCard(c); });
    h += groupCard('insurance', '保険料', { monthly: true, max: 7, requiredFirst: true, dupCheck: true, memo: true });
    h += groupCard('carCost', '自動車の維持費', { monthly: true, max: 5, dupCheck: true, memo: true, hint: '税金・保険・車検・駐車場・整備の年額。下の購入費の「◯歳まで」（今は' + state.carBuy.untilAge + '歳）を過ぎた年からは、車を手放したとみなして0になります。' });
    h += carCard();
    h += groupCard('otherFlow', 'その他の経常支出', { monthly: true, max: 5, dupCheck: true, memo: true, hint: '同じ年は1行にまとめます（趣味と旅行なら合算して1行）' });
    h += groupCard('otherLump', 'その他の一時支出', { max: 5, lump: true, memo: true, hint: '子供の結婚の援助、留学費など' });

    h += '<h2 class="sec" id="sec-invest">' + ic('invest', 20) + '投資</h2>';
    h += drawdownCardHTML();
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
      xlsxCardHTML('cf', 'CF表とグラフ（金融資産の推移・収入と支出）を、色付きのExcelファイルで保存します。印刷や、家族・専門家との共有に。', 'A.exportXlsx()') +
      '<div style="text-align:center;margin-top:6px"><button class="btn ghost" onclick="A.view(\'input\')">入力に戻る</button></div>' +
      DISCLAIMER;
  }

  // ---------- Excelに書き出す（app/xlsx.js） ----------
  //
  // 未来の表（cf）、保障（risk）、家計簿の1年の表（book）の3つ。ファイルはアプリの中で組み立てる。

  var r1x = function (v) { return Math.round(v * 10) / 10; };
  // CF表の数字。行は「未来の表」と同じ（st と res は、もしもの場合のプランと計算結果のこともある）
  function cfData(st, res) {
    var ys = res.years;
    var col = function (f) { return ys.map(function (y) { return r1x(f(y)); }); };
    var who = function (id) { var m = byId(st.family, id); return m ? (m.name || m.relation) : 'その他'; };
    return {
      years: ys.map(function (y) { return y.year; }),
      ages: st.family.map(function (m, i) { return { label: m.name || m.relation, values: ys.map(function (y) { return y.ages[i]; }) }; }),
      groups: [
        { label: '収入', rows: st.salaries.map(function (sl, i) { return { label: who(sl.memberId) + 'の給与', values: col(function (y) { return y.income.salaries[i]; }) }; })
            .concat([{ label: '退職金・年金等', values: col(function (y) { return y.income.pension; }) }])
            .concat(res.investNames.map(function (n, i) { return { label: n + 'の現金化', values: col(function (y) { return y.income.withdrawals[i]; }) }; })),
          total: { label: '収入計', key: 'income', values: col(function (y) { return y.income.total; }) } },
        { label: '支出', rows: [['基本生活費', 'living'], ['住宅費', 'housing'], ['教育費', 'education'], ['保険料', 'insurance'], ['自動車', 'car'], ['その他', 'other']]
            .map(function (k) { return { label: k[0], values: col(function (y) { return y.expense[k[1]]; }) }; })
            .concat(res.investNames.map(function (n, i) { return { label: n + 'へ積立', values: col(function (y) { return y.expense.contributions[i]; }) }; })),
          total: { label: '支出計', key: 'expense', values: col(function (y) { return y.expense.total; }) } }
      ],
      balance: { label: '年間収支', values: col(function (y) { return y.balance; }) },
      assets: { label: '金融資産残高（年末）', rows: [{ label: '普通預金等', key: 'deposit', values: col(function (y) { return y.assets.deposit; }) }]
          .concat(res.investNames.map(function (n, i) { return { label: n, values: col(function (y) { return y.assets.investments[i]; }) }; }))
          .concat([{ label: '投資資産計', key: 'investTotal', values: col(function (y) { return y.assets.investTotal; }) }]),
        total: { label: '金融資産の合計', values: col(function (y) { return y.assets.total; }) } }
    };
  }
  function xlsxData() {
    var ys = result.years, last = ys[ys.length - 1];
    var minY = ys.reduce(function (a, y) { return y.assets.total < a.assets.total ? y : a; }, ys[0]);
    var sf = result.shortfall;
    var d = cfData(state, result);
    d.plan = plan().name; d.date = new Date();
    d.keys = [
      ['終了時点（' + last.year + '年・家族１ ' + last.age + '歳）の金融資産', r1x(last.assets.total), '万円', last.assets.total < 0],
      ['金融資産がいちばん少ない年（' + minY.year + '年・' + minY.age + '歳）', r1x(minY.assets.total), '万円', minY.assets.total < 0],
      ['普通預金等がマイナスになる年', sf ? sf.year + '年（家族１が' + sf.age + '歳）' : 'ありません', ''],
      ['計算する期間', ys[0].year + '年〜' + last.year + '年（' + ys.length + '年間）', '']
    ];
    d.family = state.family.map(function (m) {
      var b = E.parseDate(m.birth);
      return [m.relation, m.name || '', b.y ? b.y + '/' + ('0' + b.m).slice(-2) + '/' + ('0' + b.d).slice(-2) : '', b.y ? state.startYear - b.y : ''];
    });
    return d;
  }
  // 保障（もしもの場合）：画面と同じ条件で
  function riskXlsxData() {
    var rk = riskOf(), dead = riskDead(); if (!dead) return null;
    var input = riskInput(rk), dy = input.year, by = E.parseDate(dead.birth).y;
    var withIns = E.riskShortfall(state, input);
    var noIns = toNum(rk.insurance) > 0 ? E.riskShortfall(state, Object.assign({}, input, { insurance: 0 })) : withIns;
    var info = withIns.info, sp = info.spouse, name = memberName(dead.id);
    var res = withIns.cf, ys = res.years;
    var cf = cfData(withIns.state, res);
    var base = E.compute(state), baseBy = {};
    base.years.forEach(function (y) { baseBy[y.year] = y.assets.total; });
    var cmp = [{ label: 'いつも', key: 'base', values: ys.map(function (y) { return r1x(baseBy[y.year]); }) },
      { label: 'もしも', key: 'risk', values: ys.map(function (y) { return r1x(y.assets.total); }) }];
    if (withIns.need > 0 && !info.alone) {
      var cs = JSON.parse(JSON.stringify(withIns.state));
      cs.lump.push({ id: 80900, year: dy, amount: withIns.need, memo: '' });
      var cov = E.compute(cs);
      cmp.push({ label: '保険で備えた場合', key: 'covered', values: cov.years.map(function (y) { return r1x(y.assets.total); }) });
    }
    cf.extra = [{ label: '比較（金融資産の合計）', rows: cmp }];
    var sv = {};
    info.survivor.forEach(function (x) { sv[x.year] = x; });
    if (info.survivor.length) {
      var svRow = function (label, k) { return { label: label, values: ys.map(function (y) { return sv[y.year] ? sv[y.year][k] : ''; }) }; };
      cf.extra.push({ label: '遺族年金など（年額）', rows: [svRow('遺族基礎年金', 'basic'), svRow('子の加算', 'child'), svRow('遺族厚生年金', 'emp'),
        svRow('65歳からの上乗せ', 'extra'), svRow('遺された人の公的年金', 'own'), svRow('公的年金の合計', 'total')] });
    }
    var sby = sp ? E.parseDate(sp.birth).y : 0;
    var steps = [];
    info.survivor.forEach(function (x, i) { if (i === 0 || x.total !== info.survivor[i - 1].total) steps.push([x.year, sp ? x.year - sby : '', x.total]); });
    var keys = [['必要保障額', noIns.need, '万円']];
    if (toNum(rk.insurance) > 0) keys.push(['加入中の保険 ' + manYen(rk.insurance) + '万円を入れると、あと', withIns.need, '万円']);
    var dflt = function (v, d) { return v === undefined || v === '' ? d : v; };
    var conds = [
      ['亡くなる人', name, ''], ['亡くなる年', dy + '年（' + (dy - by) + '歳）', ''],
      ['遺族の生活費（末子独立まで）', dflt(rk.livingRate, 80), '％'], ['末子独立の年齢', dflt(rk.indepAge, 22), '歳'], ['末子独立後の生活費', dflt(rk.livingRate2, 60), '％'],
      ['遺された配偶者の手取り（年）', rk.spouseNet === undefined || rk.spouseNet === '' ? 'プランのまま' : toNum(rk.spouseNet), rk.spouseNet === undefined || rk.spouseNet === '' ? '' : '万円'],
      ['葬儀・整理資金', dflt(rk.funeral, 200), '万円'], ['死亡退職金・弔慰金', toNum(rk.lumpIn), '万円'], ['加入中の死亡保険金', toNum(rk.insurance), '万円'],
      ['住宅ローンの団信', state.housing.filter(function (r) { return r.dansin; }).length ? 'あり（返済がなくなる）' : 'なし', '']
    ];
    var d = { plan: plan().name, date: new Date(), title: name + 'が' + dy + '年（' + (dy - by) + '歳）に亡くなったら', keys: keys, conds: conds, steps: steps, cf: cf, simple: null };
    if (info.alone) d.title += '（遺される家族がいないため、葬儀・整理資金で判定）';
    if (riskAdults().some(function (m) { return m.id !== dead.id; })) {
      var r = E.needSimple(simpleInputs());
      d.simple = {
        need: r.need,
        expense: [['生活費', r1x(r.expense.living)], ['住居費', r1x(r.expense.housing)], ['教育費', r1x(r.expense.edu)], ['保険料', r1x(r.expense.insurance)], ['自動車', r1x(r.expense.car)], ['その他', r1x(r.expense.other)], ['支出の合計', r1x(r.expense.total)]],
        income: [['今の金融資産', r1x(r.income.assets)], ['遺族年金など', r1x(r.income.survivor)], ['会社から（弔慰金・死亡退職金）', r1x(r.income.company)], ['配偶者の収入', r1x(r.income.spouse)], ['その他', r1x(r.income.other)], ['収入の合計', r1x(r.income.total)]],
        table: r.survivorTable.map(function (t) { return [t.age, t.kids, r1x(t.basic), r1x(t.emp), r1x(t.child), r1x(t.own65), r1x(t.total)]; })
      };
    }
    return d;
  }
  // 家計簿の1年の表
  var CAT_HEX = ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300'];
  function bookXlsxData(y) {
    var s = BK.summarize(y);
    var vals = function (arr, total) { return arr.map(function (v) { return BK.filled(v) ? Math.round(BK.num(v)) : ''; }).concat([Math.round(total)]); };
    var sum = function (arr) { return arr.reduce(function (a, v) { return a + BK.num(v); }, 0); };
    var blocks = [{ group: '１．支出' }];
    y.items.forEach(function (it) { blocks.push({ label: it.name, values: vals(it.m, sum(it.m)) }); });
    blocks.push({ label: '支出計', total: true, key: 'expense', values: vals(s.months.map(function (m) { return m.expense; }), s.expense) });
    blocks.push({ group: '２．決済手段別' });
    Object.keys(s.byPay).forEach(function (k) { blocks.push({ label: k, values: vals(s.byPay[k], sum(s.byPay[k])) }); });
    blocks.push({ group: '３．区分別（→ ライフプラン）' });
    BK.CATS.forEach(function (c) { blocks.push({ label: c.no + ' ' + c.label, key: 'cat' + c.no, values: vals(s.months.map(function (m) { return m.cats[c.no]; }), s.catTotals[c.no]) }); });
    blocks.push({ group: '４．手取収入' });
    y.incomes.forEach(function (r) { blocks.push({ label: r.name, values: vals(r.m, sum(r.m)) }); });
    if (s.deducted) blocks.push({ label: '給与天引き（自動）', values: vals(s.months.map(function (m) { return m.deducted; }), s.deducted) });
    blocks.push({ label: '収入計', total: true, key: 'income', values: vals(s.months.map(function (m) { return m.income; }), s.income) });
    blocks.push({ label: '備考', text: true, values: y.notes.map(function (n) { return n || ''; }).concat(['']) });
    blocks.push({ group: '５．収支／残高' });
    blocks.push({ label: '収支', total: true, values: vals(s.months.map(function (m) { return m.balance; }), s.balance) });
    blocks.push({ label: '残高（記録）', values: s.months.map(function (m) { return Math.round(m.running); }).concat(['']) });
    blocks.push({ label: '口座残高（実際）', values: s.months.map(function (m) { return m.actual == null ? '' : Math.round(m.actual); }).concat(['']) });
    blocks.push({ label: '差額（0になること）', values: s.months.map(function (m) { return m.diff == null ? '' : Math.round(m.diff); }).concat(['']) });
    var inv = y.invests.reduce(function (t, v) { return [t[0] + BK.num(v.start), t[1] + BK.num(v.end)]; }, [0, 0]);
    var rate = s.income > 0 ? Math.round((s.income - s.expense + s.catTotals[6]) / s.income * 100) : '';
    return {
      year: ui.book.year, date: new Date(), blocks: blocks,
      cats: BK.CATS.map(function (c, i) { return { key: 'cat' + c.no, label: c.no + ' ' + c.label, color: CAT_HEX[i] }; }),
      keys: [['収入の合計', Math.round(s.income), '円'], ['支出の合計', Math.round(s.expense), '円'], ['収支', Math.round(s.balance), '円', s.balance < 0],
        ['収入のうち貯蓄・投資に回せた割合', rate, rate === '' ? '' : '％'], ['記録した月', s.recorded + 'か月', ''],
        ['投資資産（前年末 → 今年末）', Math.round(inv[0]).toLocaleString('ja-JP') + ' → ' + Math.round(inv[1]).toLocaleString('ja-JP') + '円', '']]
    };
  }

  function ymd() { var d = new Date(); return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2); }
  function safeName(v) { return String(v).replace(/[\\/:*?"<>|]/g, ''); }
  // 保存する（claude.ai ではアプリの保存、ほかのブラウザではダウンロード）。where は画面（cf・risk・book）
  function saveXlsx(where, bytes, name, ascii) {
    var done = function (msg, level) { ui.xlsxMsg = { where: where, text: msg, level: level }; commit(); };
    if (downloads) {
      downloads.save({ filename: name, data: new Blob([bytes]) }).then(function () { done(name + ' を保存しました', 'ok'); }, function (e) {
        var code = e && e.code;
        if (code === 'declined') done('保存を取りやめました', 'warn');
        else if (code === 'rate_limited') done('少し待ってから、もう一度押してください', 'warn');
        else done('この画面ではファイルに保存できませんでした', 'error');
      });
      return;
    }
    try {
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      var a = document.createElement('a');
      // ブラウザによっては日本語のファイル名が「download」になるので、ここでは英字の名前にする
      a.href = url; a.download = ascii;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      done(ascii + ' のダウンロードを始めました', 'ok');
    } catch (e) { done('この画面ではファイルに保存できませんでした', 'error'); }
  }
  function xlsxCardHTML(where, text, fn) {
    var m = ui.xlsxMsg && ui.xlsxMsg.where === where ? ui.xlsxMsg : null;
    return '<div class="card xlcard"><div class="xlrow">' + ic('chart', 22) + '<div><b>Excelに書き出す</b><span>' + text + '</span></div></div>' +
      '<button class="btn block" onclick="' + fn + '">Excelファイルで保存（.xlsx）</button>' +
      (m ? '<div class="vmsg ' + m.level + '">' + ic(m.level === 'ok' ? 'check' : 'warn', 15) + '<span>' + esc(m.text) + '</span></div>' : '') +
    '</div>';
  }
  function buildXlsx(where, fn) {
    try { return fn(); } catch (e) { ui.xlsxMsg = { where: where, text: 'Excelファイルを作れませんでした', level: 'error' }; commit(); return null; }
  }
  A.exportXlsx = function () {
    if (!result.years.length) return;
    var bytes = buildXlsx('cf', function () { return window.LifePlanXlsx.lifeplanWorkbook(xlsxData()); });
    if (bytes) saveXlsx('cf', bytes, 'ライフプラン_' + safeName(plan().name) + '_' + ymd() + '.xlsx', 'lifeplan_' + ymd() + '.xlsx');
  };
  A.exportRisk = function () {
    var bytes = buildXlsx('risk', function () { var d = riskXlsxData(); return d && window.LifePlanXlsx.riskWorkbook(d); });
    if (bytes) saveXlsx('risk', bytes, 'もしもの保障_' + safeName(plan().name) + '_' + ymd() + '.xlsx', 'lifeplan_hosho_' + ymd() + '.xlsx');
  };
  A.exportBook = function () {
    var y = bookYear(); if (!y) return;
    var bytes = buildXlsx('book', function () { return window.LifePlanXlsx.bookWorkbook(bookXlsxData(y)); });
    if (bytes) saveXlsx('book', bytes, '家計簿_' + ui.book.year + '年_' + ymd() + '.xlsx', 'kakeibo_' + ui.book.year + '_' + ymd() + '.xlsx');
  };

  // ---------- 公的年金の見込み（額面基準・プランの給与から） ----------
  //
  // 自動（state.penAuto）なら、計算エンジンの pensionPlan で家族１・家族２の年金を見込み、CF表に使う。
  // 自分で入力するときは、公的年金の行（state.pubPension）を使う。
  // 設定は state.penPlan（かんたん入力では答えの penPlan）＝ { adjust, people: { 家族のid: {...} } }。家族１・家族２の id は、かんたん入力では 1・2。

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
  function penPlanOf(mode, create) {
    var h = mode === 'wz' ? ui.wz.d : state;
    if (!h.penPlan && create) h.penPlan = { adjust: 90, people: {} };
    if (h.penPlan && !h.penPlan.people) h.penPlan.people = {};
    return h.penPlan || { adjust: 90, people: {} };
  }
  // 見込みに使うプラン（かんたん入力では、答えから作る）
  function penStateOf(mode) {
    if (mode !== 'wz') return state;
    try { return window.LifePlanSample.fromAnswers(Object.assign({}, ui.wz.d, { pension: '' })); } catch (e) { return null; }
  }
  function penFmt(v) { return (Math.round(v * 10) / 10).toLocaleString('ja-JP'); }
  var PEN_NOTE = '厚生年金＝額面の年収（上限あり：今は1,080万円、2030年からは1,200万円）×5.481/1000×年数。基礎年金＝満額83.2万円（2025年度）×納めた年数÷40。' +
    '手取りは、国民健康保険・介護保険と税金をおおよそ引いた額（65歳以上・単身とみなす）です。加給年金、在職老齢年金、過去の給与の再評価、遺族年金は含みません。';

  function penPersonHTML(mode, st, p, s, adjust) {
    var m = byId(st.family, p.memberId);
    var name = esc((m && m.name) || (m && m.relation) || '');
    var key = mode + '-' + p.memberId, open = !!ui.penDetail[key];
    var q = "'" + mode + "'," + p.memberId;
    // 空欄のときは、計算に使っている既定値を出しておく
    var DEF = { startAge: p.startAge, firstAge: p.firstAge, basicYears: p.basicYears };
    var field = function (f, label, small, unit, w) {
      var v = s[f] === undefined || s[f] === '' ? (DEF[f] !== undefined ? DEF[f] : '') : s[f];
      return '<div class="calcrow"><span class="u" style="flex:1;min-width:0">' + label + (small ? '<small>' + small + '</small>' : '') + '</span>' +
        numInput('f-pp-' + mode + '-' + p.memberId + '-' + f, 'op', w || 72, v, 'A.pp(' + q + ",'" + f + "',this.value)", ';margin-left:auto') + '<span class="u">' + unit + '</span></div>';
    };
    var teikiOld = p.mode === 'teiki' && p.over50;
    var earnText = p.mode === 'teiki'
      ? '厚生年金 ' + penFmt(p.earn) + '（定期便 ' + penFmt(p.past) + (teikiOld ? ' ＋ 給与の変化・60歳以降 ' + penFmt(p.earn - p.past) : ' ＋ これから ' + penFmt(p.future)) + '）'
      : '厚生年金 ' + penFmt(p.earn) + '（これまで ' + penFmt(p.past) + ' ＋ これから ' + penFmt(p.future) + '）';
    var factorText = p.factor !== 1 ? '）×' + (p.factor > 1 ? '繰下げ' : '繰上げ') + Math.round(p.factor * 1000) / 10 + '％' : '）';
    var past = '';
    if (p.mode === 'teiki') {
      past = p.over50
        ? field('teikiEarn', '老齢厚生年金の見込額', '定期便の「老齢年金の種類と見込額」', '万円', 84) + field('teikiBasic', '老齢基礎年金の見込額', '', '万円', 84) +
          '<div class="hint" style="padding:2px 0 0">50歳以上の定期便は、60歳まで今の条件で入り続けた場合の額です。役職定年など60歳までの給与の変化と、60歳以降に働く分は、プランの給与から足し引きします。</div>'
        : field('teikiEarn', '老齢厚生年金の額', '定期便の「これまでの加入実績に応じた年金額」', '万円', 84) +
          '<div class="hint" style="padding:2px 0 0">50歳未満の定期便は、これまでに入った分だけの額です（ねんきんネットでも見られます）。これからの分は、プランの給与から足します。</div>';
    } else if (p.current > 0) {
      past = field('firstAge', '会社員として働きはじめた年齢', '', '歳', 64) +
        (p.mode === 'first' ? field('firstIncome', 'その年の年収（額面）', '', '万円', 84) +
          '<div class="hint" style="padding:2px 0 0">その年の年収から、今の年収 ' + penFmt(p.current) + '万円（額面）まで、まっすぐ上がってきたとみなします。</div>'
          : '<div class="hint" style="padding:2px 0 0">今の年収 ' + penFmt(p.current) + '万円（額面）から、年齢ごとの賃金の目安（50代前半を100として、20代前半は6割ほど）でさかのぼって推測しています。</div>');
    } else {
      past = field('pastYears', '会社員だった年数', '厚生年金に入っていた年数', '年', 64) + field('pastIncome', 'そのころの年収（額面）', '平均', '万円', 84) +
        '<div class="hint" style="padding:2px 0 0">今は給与の無い人です。扶養の範囲のパートなど、厚生年金に入っていない期間は入れません。</div>';
    }
    return '<div class="penp">' +
      '<div class="pnm">' + name + '<small>' + st.startYear + '年末で' + p.age + '歳</small></div>' +
      '<div class="ppres"><span>' + p.startAge + '歳（' + p.startYear + '年）から</span><b>' + penFmt(p.amount) + '</b><span class="u">万円／年</span></div>' +
      '<div class="ppbreak">（' + earnText + ' ＋ 基礎年金 ' + penFmt(p.basic) + factorText + ' ＝ 額面 ' + penFmt(p.gross) + '万円 → 税・社会保険料を引いて ' + penFmt(p.net) + '万円 → 目減り' + adjust + '％で ' + penFmt(p.amount) + '万円</div>' +
      (p.mode !== 'teiki' || !p.over50 ? '<div class="hint" style="padding:4px 0 0">' + (p.futureYears ? 'これからの分は、プランの給与から' + p.futureYears + '年分（' + p.lastWork + '歳まで）。' : 'プランに給与が無いので、これからの厚生年金は0です。') +
        (p.cappedYears ? '年収が上限を超える' + p.cappedYears + '年は、上限で計算しています。' : '') + '</div>' : '') +
      '<button class="toggle" aria-expanded="' + open + '" onclick="A.ppDetail(\'' + key + '\')"><span class="lbl">' + (open ? '設定を閉じる' : 'もっと正確に（受け取る年齢など）') + '</span><span class="chev">' + chevron(open) + '</span></button>' +
      (open ? '<div class="ppset">' +
        field('startAge', '受け取りはじめる年齢', '65歳より遅らせると1か月0.7％増え、早めると0.4％減ります', '歳から', 64) +
        '<div class="calcsec">これまでの厚生年金</div>' +
        '<div class="mini thsp" role="radiogroup" aria-label="これまでの厚生年金の見込み方">' + [['auto', 'かんたん'], ['first', '1年目の年収'], ['teiki', '定期便']].map(function (o) {
          var on = p.mode === o[0];
          return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.pp(' + q + ",'mode','" + o[0] + '\')">' + o[1] + '</button>';
        }).join('') + '</div>' +
        past +
        (teikiOld && toNum(s.teikiBasic) > 0 ? '' : '<div class="calcsec">基礎年金</div>' +
          field('basicYears', '納める年数', '20〜60歳のうち、国民年金・厚生年金に入る年数。未納や免除がなければ40年', '年', 64)) +
      '</div>' : '') +
    '</div>';
  }

  function penPlanHTML(mode) {
    var st = penStateOf(mode);
    var plan = st ? E.pensionPlan(st) : { people: [], rows: [], adjust: 90 };
    var pp = penPlanOf(mode);
    var people = plan.people.map(function (p) { return penPersonHTML(mode, st, p, pp.people[p.memberId] || {}, plan.adjust); }).join('');
    return '<div class="penplan">' +
      '<div class="hint" style="padding:0 0 6px">プランの給与を額面に直して、厚生年金と基礎年金を見込みます。役職定年や再雇用で給与が下がる行も、そのまま反映されます。わかっていることを「もっと正確に」で入れるほど、確かになります。</div>' +
      (people || '<div class="hint">家族１の生年月日を入れると見込めます。</div>') +
      '<div class="calcrow" style="margin-top:12px"><span class="u" style="flex:1;min-width:0">将来の目減りを見込んだ割合<small>所得代替率の低下に備えて、9割で見ています</small></span>' +
        numInput('f-pp-' + mode + '-adj', 'op', 64, pp.adjust === undefined || pp.adjust === '' ? 90 : pp.adjust, "A.ppAdj('" + mode + "',this.value)", ';margin-left:auto') + '<span class="u">％</span></div>' +
      '<div class="hint" style="padding:4px 0 0"><a href="https://www.excelcf.net/lossofpension/" target="_blank" rel="noopener">20～30年後、公的年金は今より1割くらい減少？</a></div>' +
      (mode === 'state' && plan.rows.length > 1 ? '<div class="pprows">' + plan.rows.map(function (r) { return '<span>' + r.year + '年から 合計 <b>' + penFmt(r.amount) + '</b>万円</span>'; }).join('') + '</div>' : '') +
      '<div class="hint" style="padding:8px 0 0">' + PEN_NOTE + '</div>' +
    '</div>';
  }

  // 公的年金のカード：自動で見込むか、自分で行を入れるか
  function pubPensionCard(by) {
    var auto = !!state.penAuto;
    var sw = '<div class="mini thsp penmode" role="radiogroup" aria-label="公的年金の入れ方">' + [[true, '自動で見込む'], [false, '自分で入力する']].map(function (o) {
      var on = auto === o[0];
      return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.penMode(' + o[0] + ')">' + o[1] + '</button>';
    }).join('') + '</div>';
    if (auto) {
      return '<div class="card" id="card-pubPension"><div class="head"><span class="ttl">公的年金</span>' + helpBtn('pubPension') + '</div>' +
        helpBox('pubPension') + sw + penPlanHTML('state') + '</div>';
    }
    return groupCard('pubPension', '公的年金', { max: 5, requiredFirst: true, dupCheck: true, memo: true, top: sw,
      hint: '家族１が65歳＝' + (by + 65) + '年／70歳＝' + (by + 70) + '年。家族全員の合計を手取りの年額で入れます',
      extra: '<div class="divide" style="padding-top:10px"><button class="btn ghost block" onclick="A.penFill()">' + ic('calc', 18) + '自動の見込額を行に入れる</button></div>' });
  }

  A.ppDetail = function (key) { ui.penDetail[key] = !ui.penDetail[key]; commit(); };
  A.pp = function (mode, mid, field, v) {
    var pp = penPlanOf(mode, true);
    var s = pp.people[mid] || (pp.people[mid] = {});
    s[field] = field === 'mode' ? v : String(v).trim() === '' ? '' : toNum(v);
    commit();
  };
  A.ppAdj = function (mode, v) { penPlanOf(mode, true).adjust = String(v).trim() === '' ? '' : toNum(v); commit(); };
  A.penMode = function (auto) {
    if (!!state.penAuto === auto) return;
    if (auto) state.penAuto = true;
    else {
      delete state.penAuto;
      // 行が無ければ、自動の見込額を入れておく（そこから直せるように）
      if (!state.pubPension.some(function (r) { return toNum(r.amount) > 0; })) {
        state.pubPension = E.pensionPlan(state).rows.map(function (r) { return { id: nid(), year: r.year, amount: r.amount, memo: '自動の見込み' }; });
      }
    }
    commit();
  };
  A.penFill = function () {
    var rows = E.pensionPlan(Object.assign({}, state, { penAuto: true })).rows;
    if (!rows.length) return;
    snapshot('公的年金の行を、自動の見込額にしました');
    state.pubPension = rows.map(function (r) { return { id: nid(), year: r.year, amount: r.amount, memo: '自動の見込み' }; });
    commit();
  };

  // ---------- DC（会社拠出）の見込額（Excel「投資シミュレーション」シートと同じ式） ----------
  // 会社が出す掛金は手取りに入れず、運用して受け取る一時金として「退職一時金」に入れる。
  // 入力は state.dcCalc = { memberId, start, contrib, rate, cost, until, receive, target }。計算エンジンの結果には影響しない。

  var DC_MEMO = 'DC（会社拠出）';
  function dcPeople() { return penPeople('state'); }
  function dcData(create) {
    var people = dcPeople(), p0 = people[0];
    var d = state.dcCalc || {};
    var p = people.filter(function (x) { return x.key === d.memberId; })[0] || p0;
    var sal = p && state.salaries.filter(function (x) { return x.memberId === p.key; })[0];
    var retire = sal && toNum(sal.retireAge) ? toNum(sal.retireAge) : 60;
    var o = {
      memberId: p ? p.key : 0, start: d.start !== undefined ? d.start : '', contrib: d.contrib !== undefined ? d.contrib : '',
      rate: d.rate !== undefined ? d.rate : 3, cost: d.cost !== undefined ? d.cost : 0.2,
      until: d.until !== undefined && d.until !== '' ? d.until : Math.min(retire, 70),
      receive: d.receive !== undefined && d.receive !== '' ? d.receive : Math.max(60, Math.min(retire, 75)),
      target: d.target !== undefined ? d.target : ''
    };
    if (create) state.dcCalc = o;
    return { o: o, p: p };
  }
  function dcResult(d) {
    var by = d.p ? d.p.by : baseBirth();
    var age = state.startYear - by;
    var input = { start: d.o.start, contrib: d.o.contrib, rate: d.o.rate, cost: d.o.cost, age: age, until: d.o.until, to: Math.max(toNum(d.o.receive), age) };
    var r = E.investSim(input);
    r.age = age; r.year = by + Math.max(toNum(d.o.receive), age); r.input = input;
    return r;
  }
  function dcChartSVG(r) {
    var rows = r.rows, n = rows.length;
    if (n < 2) return '';
    var W = 320, H = 120, P = 6;
    var max = Math.max.apply(null, rows.map(function (x) { return Math.max(x.value, x.cumulative); })) || 1;
    var X = function (i) { return P + (W - 2 * P) * i / (n - 1); }, Y = function (v) { return H - P - (H - 2 * P) * v / max; };
    var line = function (k) { return rows.map(function (x, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x[k]).toFixed(1); }).join(''); };
    return '<svg class="dcchart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="積み立てた額と運用した結果の推移">' +
      '<path d="' + line('value') + 'L' + X(n - 1).toFixed(1) + ' ' + (H - P) + 'L' + P + ' ' + (H - P) + 'Z" fill="var(--c-invest)" fill-opacity=".16"/>' +
      '<path d="' + line('value') + '" fill="none" stroke="var(--c-invest)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>' +
      '<path d="' + line('cumulative') + '" fill="none" stroke="var(--text-faint)" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"/>' +
    '</svg>' +
    '<div class="catlegend"><span><i style="background:var(--c-invest)"></i>運用した結果</span><span><i style="background:var(--text-faint)"></i>積み立てた額の合計</span></div>';
  }

  function dcCalcHTML() {
    var open = ui.dcOpen;
    var head = '<button class="toggle" onclick="A.dcToggle()">' + ic('calc', 18, 'lead') +
      '<span class="lbl">DC（会社拠出）の見込額を計算する</span><span class="chev">' + chevron(open) + '</span></button>';
    if (!open) return '<div class="divide">' + head + '</div>';
    var d = dcData(false), o = d.o, people = dcPeople();
    var r = dcResult(d);
    var bg = ';margin-left:auto;background:var(--surface)';
    var row = function (f, label, small, unit, w) {
      return '<div class="calcrow"><span class="u" style="flex:1;min-width:0">' + label + (small ? '<small>' + small + '</small>' : '') + '</span>' +
        numInput('f-dc-' + f, 'op', w || 84, o[f], "A.dc('" + f + "',this.value)", bg) + '<span class="u">' + unit + '</span></div>';
    };
    var badAge = toNum(o.until) < r.age || toNum(o.receive) < r.age;
    var need = toNum(o.target) > 0 ? E.investNeed(r.input, toNum(o.target)) : null;
    var exists = state.lump.some(function (x) { return x.memo === DC_MEMO; });
    var full = !exists && state.lump.length >= 3;
    var value = Math.round(r.value * 10) / 10;
    return '<div class="divide">' + head +
      '<div class="calcbox dc">' +
        '<div class="hint" style="padding:0 0 4px">会社が出してくれるDCの掛金は、手取りには入れず、運用して受け取る一時金として見込みます。Excelの「投資シミュレーション」と同じ計算です。</div>' +
        (people.length > 1 ? '<div class="mini thsp" role="radiogroup" aria-label="だれのDCか">' + people.map(function (p) {
          var on = p.key === o.memberId;
          return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.dc(\'memberId\',' + p.key + ')">' + esc(p.label) + '</button>';
        }).join('') + '</div>' : '') +
        '<div class="hint" style="padding:6px 0 0">' + esc(d.p ? d.p.label : '家族１') + 'は' + state.startYear + '年末で' + r.age + '歳</div>' +
        row('start', '今の残高', '前の年の12月末。DCの運用報告などで', '万円') +
        row('contrib', '会社の掛金（年額）', '月額×12', '万円') +
        row('rate', '想定利回り', '年率。Excelの記入例は5％', '％', 64) +
        row('cost', 'コスト', '信託報酬など。年率', '％', 64) +
        row('until', '何歳まで積み立てる', '掛金が止まる年齢', '歳まで', 64) +
        row('receive', '何歳で受け取る', 'DCは60歳から受け取れます', '歳', 64) +
        (badAge ? '<div class="vmsg error">' + ic('warn', 15) + '<span>年齢が今の年齢（' + r.age + '歳）より前です</span></div>' : '') +
        '<div class="calcresult"><span class="u" style="font-weight:700">' + r.year + '年（' + Math.max(toNum(o.receive), r.age) + '歳）の見込額</span>' +
          '<span style="font-size:22px;font-weight:900;color:var(--accent-ink);margin-left:auto">' + value.toLocaleString('ja-JP') + '</span><span class="u" style="font-weight:700">万円</span></div>' +
        '<div class="hint" style="padding:2px 0 6px;text-align:right">積み立てた額 ' + man(r.cumulative) + '万円 ＋ 運用益 ' + man(r.gain) + '万円</div>' +
        dcChartSVG(r) +
        '<button class="toggle" onclick="A.dcTableToggle()"><span class="lbl">年ごとの表</span><span class="chev">' + chevron(ui.dcTable) + '</span></button>' +
        (ui.dcTable ? '<div class="tablewrap dctable" tabindex="0"><table><thead><tr><th>年</th><th>年齢</th><th>積立</th><th>累積</th><th>結果</th><th>リターン</th></tr></thead><tbody>' +
          r.rows.map(function (x, i) {
            return '<tr><td>' + (state.startYear + i) + '</td><td>' + x.age + '</td><td>' + man(x.contrib) + '</td><td>' + man(x.cumulative) + '</td><td>' + man(x.value) + '</td><td>' + Math.round(x.ret * 1000) / 10 + '％</td></tr>';
          }).join('') + '</tbody></table></div>' : '') +
        '<div class="calcsec">目標から逆算<small>任意</small></div>' +
        row('target', '受け取るときの目標額', '', '万円') +
        (need !== null ? '<div class="hint" style="padding:4px 0 0">目標に届くには、毎年 <b>' + (Math.round(need * 10) / 10).toLocaleString('ja-JP') + '万円</b>（月 ' + (Math.round(need / 12 * 100) / 100).toLocaleString('ja-JP') + '万円）の積立が必要です。</div>' : '') +
        (full ? '<div class="vmsg error">' + ic('warn', 15) + '<span>一時収入の行がいっぱい（3行）です。1行外すと入れられます。</span></div>'
          : '<button class="btn block" ' + (badAge || !(value > 0) ? 'disabled ' : '') + 'onclick="A.dcApply()">' + r.year + '年の一時収入に ' + Math.round(value).toLocaleString('ja-JP') + '万円を' + (exists ? '入れ直す' : '入れる') + '</button>') +
        '<div class="hint" style="padding:8px 0 0">受け取る額は、退職金と合わせて「退職所得控除」（勤続20年までは1年40万円、20年を超えた分は1年70万円）の範囲なら税金がかかりません。超えそうなときは、手取りを少なめに見てください。運用の結果は毎年同じ利回りと仮定したもので、実際には上下します。</div>' +
      '</div>' +
    '</div>';
  }
  A.dcToggle = function () { ui.dcOpen = !ui.dcOpen; commit(); };
  A.dcTableToggle = function () { ui.dcTable = !ui.dcTable; commit(); };
  A.dc = function (field, v) {
    var d = dcData(true);
    d.o[field] = field === 'memberId' ? toNum(v) : String(v).trim() === '' ? '' : toNum(v);
    if (field === 'memberId') { delete d.o.until; delete d.o.receive; state.dcCalc = d.o; dcData(true); }
    commit();
  };
  A.dcApply = function () {
    var d = dcData(true), r = dcResult(d);
    var amount = Math.round(r.value);
    if (!(amount > 0)) return;
    var row = state.lump.filter(function (x) { return x.memo === DC_MEMO; })[0];
    if (!row && state.lump.length >= 3) return;
    snapshot('DC（会社拠出）の見込額を一時収入に入れました');
    if (!row) { row = { id: nid(), year: r.year, amount: amount, memo: DC_MEMO }; state.lump.push(row); }
    row.year = r.year; row.amount = amount;
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
      return { year: start + ph.from, amount: r1(ph.annual + up), loan: r1(ph.annual), dansin: true, memo: '住宅ローン（' + (k ? '金利' + ph.rate + '%に変わってから' : '当初金利' + ph.rate + '%') + '）＋修繕・管理費等' };
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
    if (atStart) {
      head.amount = atStart.amount; head.memo = atStart.memo;
      if (atStart.dansin) { head.dansin = true; head.loan = atStart.loan; } else { delete head.dansin; delete head.loan; }
    }
    var keep = state.housing.slice(1).filter(function (r) { return toNum(r.year) < start; });
    state.housing = [head].concat(keep, gen.filter(function (r) { return r.year > sy; }).map(function (r) {
      var row = { id: nid(), year: r.year, amount: r.amount, memo: r.memo };
      if (r.dansin) { row.dansin = true; row.loan = r.loan; }
      return row;
    }));
  }

  // ---------- 「？」で開くFPのひとこと ----------

  var HELP = {
    period: '計算を始める年と、家族１が何歳になるまで計算するかです。開始年はふつう今年にします。長生きに備えて、90〜100歳くらいまで見ておくと安心です。',
    assets: '開始年の前の年の12月末の残高を入れます。普通預金・定期預金など、すぐ使えるお金は「普通預金等」に。NISAやiDeCo、投資信託などは今の評価額を入れます。投資の名前は書き換えられます。預金の利率は低めに見ておくのがおすすめで、0のままでも結果はほとんど変わりません。',
    family: '一緒に暮らす家族を入れます。家族１は家計の中心になる人です。子供の生年月日から、教育費が自動で入ります。4月1日までに生まれた子（早生まれ）は、学年が1つ上になります。',
    salary: '給与は「手取り」の1年分（ボーナスも含む）で入れます。このアプリの手取りは「額面−社会保険料−所得税−住民税＋通勤手当」で、額面の75〜85％くらいが目安です。生命保険料・財形・持株会・DCの個人の上乗せなど、自分で選んで給与から天引きしているものは引かずに手取りに含め、保険料や投資の欄に入れます。DCの会社拠出は手取りに入れず、退職金として入れます。上昇率は毎年の昇給の目安で、横ばいなら0％。転職や時短で変わるなら、その年から行を足します。',
    lump: '退職金、相続・贈与、不動産の売却など、一度だけ入るお金です。税金を引いた手取りで入れます。退職金は、会社の退職金規程や見込額の資料で確かめられます。',
    corpPension: '会社から年金として受け取るお金（企業年金）です。受け取る期間と、1年あたりの額を入れます。',
    privPension: '個人年金保険など、自分で準備した年金です。保険証券に、受け取りが始まる年齢と年金額が書いてあります。',
    pubPension: '国の年金（老齢基礎年金・老齢厚生年金）です。「自動で見込む」では、プランの給与（額面に直したもの）から厚生年金を、納めた年数から基礎年金を計算し、税・社会保険料と将来の目減りを引いた手取りをCF表に使います。給与を変えると年金も変わります。ねんきん定期便などで額がわかれば「もっと正確に」で入れるか、「自分で入力する」で行を入れます。',
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
    bookIncome: '給与やボーナスは、口座に振り込まれた額を入れます。生命保険料や財形など給与から天引きされているものは、支出の項目の決済手段を「給与天引き」にすると、その額を収入にも自動で足して、手取り（振込額＋天引き）にそろえます。種類（給与・ボーナス・その他）は「項目・口座を編集する」で変えられ、ライフプランへの反映のときに、だれの収入かを見分けるのに使います。',
    payDeduct: '健康保険・介護保険・厚生年金・雇用保険が社会保険料、所得税・住民税が税金です。この2つは強制的に引かれるので、手取りから除きます。財形・DC等（生命保険料や持株会など、自分で選んで天引きしているもの）は貯蓄や支出なので、手取りに含めます。家計簿に入れると、決済手段「給与天引き」の支出になります。',
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
    else if (act === 'pension') {
      if (!state.penAuto) state.penAuto = true;
      var p1 = state.family.filter(function (m) { return m.relation === '家族１'; })[0];
      if (p1) ui.penDetail['state-' + p1.id] = true;
      jumpTo('card-pubPension');
    }
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
      commute: '', mode: '', gPay: '', gAfter: '', gDeduct: '', gTax: '', gSocial: '', gSmall: '', gResident: ''
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
    ['gSmall', 'うち 小規模企業共済等掛金', '社会保険料等の金額の欄の左上に「内」と書かれた金額。DCの個人の上乗せ（マッチング拠出）やiDeCoの掛金です。DCの会社拠出は源泉徴収票に出ません。手取りには入れず、退職金として入れてください', false]
  ];
  function slipInput(c) {
    return { pay: c.gPay, after: c.gAfter, deductions: c.gDeduct, tax: c.gTax, social: c.gSocial, small: c.gSmall, resident: c.gResident };
  }
  // 手取り＝額面−社会保険料−所得税−住民税＋通勤手当。通勤手当（月額・円）は非課税で源泉徴収票の支払金額にも入らないので、ここで足す
  function calcResult(sal, c) {
    var r = c.mode === 'slip' ? E.takeHomeFromSlip(slipInput(c)) : E.takeHome(calcInput(sal, c));
    r.base = r.net;
    r.commute = Math.round(Math.max(0, toNum(c.commute)) * 12 / 100) / 100;
    if (r.net) r.net = Math.round((r.net + r.commute) * 100) / 100;
    return r;
  }
  function commuteHTML(c, sid) {
    return '<div class="calcsec">通勤手当<small>非課税なので、年収や源泉徴収票には入っていません</small></div>' +
      '<div class="calcrow"><span class="u" style="flex:1;min-width:0">通勤手当（月額）<small>給与明細の「通勤手当」「交通費」</small></span>' +
        yenField('f-th-' + sid + '-commute', c.commute, 'A.thSet(' + sid + ",'commute',this.value)", '通勤手当（月額）') + '</div>' +
      '<div class="hint" style="padding:2px 0 0">給与と一緒に振り込まれるので、手取りに足します。定期代などの交通費は、支出（基本生活費）に入れてください。6か月定期の代金がまとめて出るなら、6で割った額です。</div>';
  }
  // 手取りに含めるもの・含めないもの
  var TH_DEF = [
    ['健康保険・介護保険・厚生年金・雇用保険', '引く', ''],
    ['所得税・住民税', '引く', ''],
    ['生命保険料（団体保険など）の天引き', '含める', '保険料'],
    ['財形貯蓄・社内預金', '含める', '貯蓄'],
    ['持株会、DCの個人の上乗せ（マッチング）、iDeCo', '含める', '投資の積立'],
    ['社宅家賃・寮費', '含める', '住宅費'],
    ['労働組合費など', '含める', '基本生活費'],
    ['通勤手当', '足す', '交通費は生活費'],
    ['DCの会社拠出（事業主掛金）', '入れない', '退職金']
  ];
  function thDefHTML() {
    var open = ui.thDef;
    return '<button class="toggle thdeft" aria-expanded="' + !!open + '" onclick="A.thDef()"><span class="lbl">手取りに含めるもの・含めないもの</span><span class="chev">' + chevron(open) + '</span></button>' +
      (open ? '<div class="thdef"><p>このアプリの手取りは<b>「額面−社会保険料−所得税−住民税＋通勤手当」</b>です。引くのは、強制的に引かれるものだけ。自分で選んで天引きしているものは手取りに含めて、支出や投資の欄に入れます。こうすると、何が支出で何が貯蓄かがプランで見えます。</p>' +
        '<table><thead><tr><th>給与明細の項目</th><th>手取りに</th><th>プランでは</th></tr></thead><tbody>' +
        TH_DEF.map(function (d) { return '<tr><td>' + d[0] + '</td><td class="' + (d[1] === '引く' || d[1] === '入れない' ? 'out' : 'in') + '">' + d[1] + '</td><td>' + (d[2] || '—') + '</td></tr>'; }).join('') +
        '</tbody></table></div>' : '');
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
    var parts = [['手取り', th.base, 'var(--good)'], ['社会保険料', th.social, 'var(--k1)'], ['所得税', th.incomeTax, 'var(--k2)'], ['住民税', th.residentTax, 'var(--k4)']];
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
        '<div class="hint" style="padding:2px 0 6px;text-align:right">' + (th.commute ? '通勤手当 ' + th.commute.toLocaleString('ja-JP') + '万円を含む・' : '') + '手取り率 ' + th.ratio + '％・月あたり約' + (Math.round(th.net / 12 * 10) / 10) + '万円（ボーナスを含めて12等分）</div>' +
        bar +
        (slip && th.small > 0 ? '<div class="hint" style="padding:6px 0 0">DCの個人の上乗せ・iDeCoの掛金 ' + th.small.toLocaleString('ja-JP') + '万円は貯蓄なので、手取りに含めています。積み立ては「投資」の欄に入れてください。</div>' : '') +
        (slip && th.residentEstimated ? '<div class="hint" style="padding:4px 0 0">住民税 ' + th.residentTax.toLocaleString('ja-JP') + '万円は見積もりです。</div>' : '') +
        '<button class="btn block" onclick="A.calcApply(' + sid + ')">手取り ' + (Math.round(th.net * 10) / 10).toLocaleString('ja-JP') + '万円を1行目に入れる</button>' : '';
    if (slip) {
      return '<div class="calcbox th">' + thDefHTML() + modes + slipHTML(c, sid) + commuteHTML(c, sid) + result +
        '<div class="hint" style="padding:8px 0 0">手取り＝支払金額−社会保険料等（DCの個人の上乗せ・iDeCoの掛金を除く）−源泉徴収税額−住民税＋通勤手当。去年1年分の実際の金額なので、今年の手取りの目安になります。転職や大きな昇給・減給があった年は「年収から見積もる」も試してください。</div>' +
      '</div>';
    }
    return '<div class="calcbox th">' + thDefHTML() + modes +
      '<div class="calcrow"><span class="u" style="width:88px">年収（額面）</span>' +
        numInput('f-th-' + sid + '-income', 'rq', 96, c.income, 'A.thSet(' + sid + ",'income',this.value)", ';margin-left:auto') + '<span class="u">万円</span></div>' +
      '<div class="hint" style="padding:4px 0 0">源泉徴収票の「支払金額」。わからなければ、月給（額面）×12＋ボーナスの合計</div>' +
      '<div class="calcrow"><span class="u" style="width:120px">去年の年収<small>住民税の計算用・任意</small></span>' +
        numInput('f-th-' + sid + '-last', 'op', 96, c.lastIncome, 'A.thSet(' + sid + ",'lastIncome',this.value)", ';margin-left:auto' + bg) + '<span class="u">万円</span></div>' +
      '<div class="hint" style="padding:4px 0 0">住民税は去年の所得で決まり、6月から1年間引かれます。昇給・転職などで年収が変わったときに入れると正確になります。空欄なら今年と同じとして計算します。</div>' +
      '<div class="calcsec">社会保険料' + (th.socialActual ? '<small>実額で計算</small>' : th.socialRate ? '<small>年収の' + th.socialRate + '％で計算</small>' : '') + '</div>' +
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
      commuteHTML(c, sid) +
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
  A.thDef = function () { ui.thDef = !ui.thDef; commit(); };
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
    var modes = [['month', '月ごと'], ['pay', '給与明細'], ['year', '1年の表'], ['plan', 'プランへ']];
    var pay = y && ui.book.mode === 'pay' ? payOf(y) : null;
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
      (y && ui.book.mode === 'pay' ? '<div class="mini thsp bkwho" role="radiogroup" aria-label="だれの給与明細か">' + ['1', '2'].map(function (k) {
        var on = ui.book.who === k;
        return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.pyWho(\'' + k + '\')">' + esc(payName(k)) + '</button>';
      }).join('') + '</div>' +
      (pay ? '<div class="bkmonths" role="tablist" aria-label="明細">' + BK.SLIP_LABELS.map(function (label, i) {
        var on = ui.book.slip === i, rec = BK.slipFilled(pay.rows[i]);
        return '<button role="tab" id="bkm-' + i + '" aria-selected="' + on + '" class="' + (on ? 'on' : '') + (rec ? ' rec' : '') + (i >= 12 ? ' bonus' : '') + '" onclick="A.pySlip(' + i + ')">' +
          label + (rec ? '<span class="dot" aria-label="記録あり"></span>' : '') + '</button>';
      }).join('') + '</div>' : '') : '') +
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
      (m.deducted ? '<div class="bkrow divide"><span class="nm">給与天引き<small>決済手段が「給与天引き」の支出を、自動で足しています</small></span><span class="bkauto">' + yen(m.deducted) + '<span class="u">円</span></span></div>' : '') +
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
      return '<div class="bkinv divide"><div class="nm">' + esc(v.name) + '</div>' +
        '<div class="bkrow"><span class="u" style="flex:1">前年末</span>' + bookAmountInput('f-bk-ivs-' + v.id, v.start, "A.bkInv(" + v.id + ",'start',this.value)", v.name + 'の前年末', 'op') + '</div>' +
        '<div class="bkrow"><span class="u" style="flex:1">今年末（予想）</span>' + bookAmountInput('f-bk-ive-' + v.id, v.end, "A.bkInv(" + v.id + ",'end',this.value)", v.name + 'の今年末（予想）', 'op') + '</div></div>';
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
        '<div class="total divide"><span class="u" style="font-weight:700">合計</span><span class="v">' + yen(invTotal[0]) + ' → ' + yen(invTotal[1]) + '円</span></div></div>' +
      xlsxCardHTML('book', ui.book.year + '年の年間収支の表と、月ごとの支出（区分別）・収入のグラフを、Excelファイルで保存します。', 'A.exportBook()');
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

  // ---- 給与明細（Excel ver.1.80「給与シート」） ----

  function payOf(y) { return (y.pay && y.pay[ui.book.who]) || null; }
  function payMember(k) { var rel = k === '1' ? '家族１' : '家族２'; return state.family.filter(function (f) { return f.relation === rel; })[0] || null; }
  function payName(k) { var m = payMember(k); return (m && m.name) || (k === '1' ? '家族１' : '家族２'); }
  function prevYearPay() { var py = store.book.years[ui.book.year - 1]; return (py && py.pay && py.pay[ui.book.who]) || null; }
  // 家計簿のその月に入れる値（月の給与の振込額、その月に支給の賞与の振込額、任意の天引き）
  function payForMonth(p, mi) {
    var o = { sal: 0, bonus: 0, voluntary: 0, has: false };
    p.rows.forEach(function (r, i) {
      var at = i < 12 ? i : p.bonusMonths[i - 12] - 1;
      if (at !== mi || !BK.slipFilled(r)) return;
      var t = BK.slipTotals(r);
      o.has = true;
      if (i < 12) o.sal += t.transfer; else o.bonus += t.transfer;
      o.voluntary += t.voluntary;
    });
    return o;
  }
  function payBookRows(y, who, create) {
    var name = payName(who);
    var find = function (kind) { return y.incomes.filter(function (r) { return r.kind === kind; })[0] || null; };
    var mk = function (kind, label) {
      var r = { id: store.book.nextId++, name: label + '（' + name + '）', kind: kind, m: ['', '', '', '', '', '', '', '', '', '', '', ''] };
      y.incomes.push(r); return r;
    };
    var vname = '財形・DC等（' + name + '）';
    var vol = y.items.filter(function (it) { return it.pay === BK.DEDUCTED && it.name === vname; })[0] || null;
    var sal = find('sal' + who), bonus = find('bonus' + who);
    if (create) {
      sal = sal || mk('sal' + who, '給与');
      bonus = bonus || mk('bonus' + who, 'ボーナス');
    }
    return { sal: sal, bonus: bonus, vol: vol, vname: vname };
  }

  function payIntroHTML() {
    return '<div class="bkempty">' + bookArt() +
      '<h2>' + esc(payName(ui.book.who)) + 'の給与明細をつけよう</h2>' +
      '<p>毎月の給与明細と賞与明細の数字を入れると、<b>1年分の手取り</b>が積み上がります。ライフプランの給与にも、家計簿の収入にも、そのまま使えます。</p>' +
      '<ul class="bkpoints">' +
        '<li>' + ic('yen', 18) + '<span><b>額面と手取りの差が見えます。</b>社会保険料と税金で、1年にいくら納めているかがわかります。</span></li>' +
        '<li>' + ic('check', 18) + '<span><b>変わったところを教えます。</b>6月の住民税、9月の社会保険料、残業代の増減など、明細が変わる理由がわかります。</span></li>' +
        '<li>' + ic('lock', 18) + '<span><b>データは端末の外に送りません。</b>給与のような大事な情報も、安心して記録できます。</span></li>' +
      '</ul>' +
      '<div class="cvalt">' +
        '<button class="btn big" onclick="A.pyCreate(false)">給与明細をはじめる</button>' +
        '<button class="btn ghost" onclick="A.pyCreate(true)">記入例（Excelのサンプル）を入れて見てみる</button>' +
      '</div>' +
    '</div>';
  }

  function payHTML(y) {
    var p = payOf(y);
    if (!p) return payIntroHTML();
    var i = ui.book.slip, r = p.rows[i], who = ui.book.who, label = BK.SLIP_LABELS[i];
    var t = BK.slipTotals(r), filled = BK.slipFilled(r);
    var sum = BK.paySummary(p);
    var amtRow = function (f, hint) {
      return '<div class="bkrow divide"><span class="nm">' + f.label + (hint ? '<small>' + hint + '</small>' : '') + '</span>' +
        bookAmountInput('f-py-' + f.key, r[f.key], "A.pyAmt('" + f.key + "',this.value)", f.label + '（' + label + '）', 'op') + '</div>';
    };
    var prevSlip = i > 0 && i < 12 ? p.rows[i - 1] : i === 13 ? p.rows[12] : i === 0 && prevYearPay() ? prevYearPay().rows[11] : null;
    var prevLabel = i > 0 && i < 12 ? BK.SLIP_LABELS[i - 1] : i === 13 ? '夏の賞与' : '去年の12月';
    var copy = !filled && prevSlip && BK.slipFilled(prevSlip)
      ? '<button class="btn ghost bkcopy" onclick="A.pyCopy()">' + ic('copy', 18) + prevLabel + 'の明細と同じ内容を入れる</button>' : '';

    var parts = [['手取り', t.takeHome, 'var(--good)'], ['社会保険料', t.social, 'var(--k1)'], ['所得税・住民税', t.tax, 'var(--k2)']];
    var result = '<div class="card bksum">' +
      '<div class="bkrow1"><div><div class="k">' + label + 'の手取り</div><div class="v">' + yen(t.takeHome) + '<small>円</small></div>' +
        '<div class="io"><span>支給 <b>' + yen(t.pay) + '</b></span><span>控除 <b>' + yen(t.deduct) + '</b></span><span>振込 <b>' + yen(t.transfer) + '</b></span></div></div></div>' +
      (t.pay > 0 ? '<div class="catbar" role="img" aria-label="支給の内訳：' + parts.map(function (q) { return q[0] + ' ' + yen(q[1]) + '円'; }).join('、') + '">' +
        parts.map(function (q) { return q[1] > 0 ? '<span style="width:' + (q[1] / t.pay * 100).toFixed(2) + '%;background:' + q[2] + '"></span>' : ''; }).join('') + '</div>' +
        '<div class="catlegend">' + parts.map(function (q) { return '<span><i style="background:' + q[2] + '"></i>' + q[0] + '<b>' + yen(q[1]) + '</b></span>'; }).join('') + '</div>' : '') +
      '<div class="hint" style="padding:6px 0 0">手取り＝支給合計−社会保険料−所得税・住民税（＝振込額＋財形・DC等）。通勤費も含みます。</div>' +
    '</div>';

    var tips = BK.payInsights(p, i, prevYearPay());
    var review = tips.length ? '<div class="card bkreview"><div class="gh">' + fpFace(36) + '<div class="t">' + label + 'の明細のふりかえり</div></div>' +
      '<ul>' + tips.map(function (q) { return '<li class="' + q.kind + '">' + esc(q.text) + '</li>'; }).join('') + '</ul></div>' : '';

    var bonusMonth = i >= 12 ? '<div class="card bkgroup"><div class="bkrow"><span class="nm">支給月<small>家計簿に入れるときの月</small></span>' +
      selectInput('f-py-bm', 'op', '', MONTHS.map(function (m, k) { return { value: k + 1, label: m }; }), p.bonusMonths[i - 12], 'A.pyBonusMonth(this.value)') + '</div></div>' : '';

    var payCard = '<div class="card bkgroup" id="pyg-pay"><div class="head"><span class="cdot" style="background:var(--good)"></span><span class="ttl">支給</span><span class="sub">' + yen(t.pay) + '円</span></div>' +
      BK.PAY_ITEMS.map(function (f) { return amtRow(f, f.key === 'commute' ? '非課税。手取りに含めます' : ''); }).join('') + '</div>';
    var dedCard = '<div class="card bkgroup" id="pyg-deduct"><div class="head"><span class="cdot" style="background:var(--k1)"></span><span class="ttl">控除</span>' + helpBtn('payDeduct') + '<span class="sub">' + yen(t.deduct) + '円</span></div>' + helpBox('payDeduct') +
      BK.DEDUCT_ITEMS.map(function (f) { return amtRow(f, f.key === 'voluntary' ? '生命保険料・持株会など、自分で選んだ天引きも' : f.key === 'care' ? '40〜64歳' : ''); }).join('') + '</div>';

    // 家計簿へ
    var mi = i < 12 ? i : p.bonusMonths[i - 12] - 1;
    var bv = payForMonth(p, mi), rows = payBookRows(y, who, false);
    var inBook = bv.has && rows.sal && BK.num(rows.sal.m[mi]) === bv.sal && (!bv.bonus || (rows.bonus && BK.num(rows.bonus.m[mi]) === bv.bonus)) &&
      (!bv.voluntary || (rows.vol && BK.num(rows.vol.m[mi]) === bv.voluntary));
    var toBook = filled ? '<div class="card bkgroup pybook">' +
      (inBook ? '<div class="diffline ok">' + ic('check', 16) + '家計簿の' + MONTHS[mi] + 'に入っています</div>'
        : '<p>家計簿の<b>' + MONTHS[mi] + '</b>に、振込額 <b>' + yen(bv.sal + bv.bonus) + '円</b>を収入として' + (bv.voluntary ? '、財形・DC等 <b>' + yen(bv.voluntary) + '円</b>を「給与天引き」の支出として' : '') + '入れます。</p>' +
          '<button class="btn block" onclick="A.pyToBook()">' + ic('book', 18) + '家計簿の' + MONTHS[mi] + 'に入れる</button>') +
    '</div>' : '';

    // 1年のまとめ
    var e = sum.estimate;
    var sal = (function () { var m = payMember(who); return m ? state.salaries.filter(function (x) { return x.memberId === m.id; })[0] : null; })();
    var year = sum.months + sum.bonuses ? '<div class="card bkgroup pyyear"><div class="head"><span class="cdot" style="background:var(--accent)"></span><span class="ttl">' + ui.book.year + '年のまとめ</span>' +
        '<span class="sub">' + sum.months + 'か月・賞与' + sum.bonuses + '回</span></div>' +
      '<table class="pytable"><tbody>' +
        [['額面（通勤費を除く）', e.gross], ['社会保険料', e.social], ['所得税・住民税', e.tax], ['通勤費', e.commute], ['手取り', e.takeHome]].map(function (q, k) {
          return '<tr' + (k === 4 ? ' class="tot"' : '') + '><th>' + q[0] + '</th><td>' + (Math.round(q[1] / 1000) / 10).toLocaleString('ja-JP') + '<small>万円</small></td></tr>';
        }).join('') +
      '</tbody></table>' +
      (sum.full ? '' : '<div class="hint" style="padding:6px 0 0">記録した' + sum.months + 'か月の平均×12' + (sum.bonuses ? '＋記録した賞与' : '') + 'で、1年分を見積もっています。</div>') +
      (e.gross > 0 ? '<div class="pynote">' + ic('yen', 16) + '<span>社会保険料と税金で、1年に <b>' + Math.round((e.social + e.tax) / 10000) + '万円</b>（額面の' + Math.round((e.social + e.tax) / e.gross * 100) + '％）を納めています。手取り率は ' + sum.ratio + '％です。</span></div>' : '') +
      (sal ? '<button class="btn block" onclick="A.pyToPlan()">年間の手取り ' + sum.planMan.toLocaleString('ja-JP') + '万円を、プランの給与（' + esc(payName(who)) + '）に入れる</button>'
        : '<div class="hint" style="padding:8px 0 0">プランの「収入」に' + esc(payName(who)) + 'の給与を足すと、ここから手取りを入れられます。</div>') +
    '</div>' : '';

    return (p.sample ? '<div class="vbanner notice sample">' + ic('book', 18) + '<span>これは記入例（Excelのサンプル）です。自分の明細をつけるときは消してから始めます。</span><button class="btn" onclick="A.pyClear()">記入例を消す</button></div>' : '') +
      result + review + copy + bonusMonth + payCard + dedCard + toBook + year;
  }

  A.pyWho = function (k) { ui.book.who = k; commit(); };
  A.pySlip = function (i) { ui.book.slip = i; commit(); };
  A.pyCreate = function (sample) {
    var y = bookYear(); if (!y) return;
    if (!y.pay) y.pay = {};
    y.pay[ui.book.who] = sample ? BK.samplePay(ui.book.who === '1' ? 1 : 2) : BK.newPay();
    if (sample) y.pay[ui.book.who].sample = true;
    commit();
  };
  A.pyClear = function () {
    var y = bookYear(); if (!y || !y.pay) return;
    snapshot('記入例の給与明細を消しました');
    delete y.pay[ui.book.who];
    commit();
  };
  A.pyAmt = function (key, v) { var y = bookYear(), p = y && payOf(y); if (!p) return; p.rows[ui.book.slip][key] = yenVal(v); commit(); };
  A.pyBonusMonth = function (v) { var y = bookYear(), p = y && payOf(y); if (!p || ui.book.slip < 12) return; p.bonusMonths[ui.book.slip - 12] = Math.min(12, Math.max(1, Math.round(toNum(v)) || 1)); commit(); };
  A.pyCopy = function () {
    var y = bookYear(), p = y && payOf(y), i = ui.book.slip; if (!p) return;
    var src = i > 0 && i < 12 ? p.rows[i - 1] : i === 13 ? p.rows[12] : i === 0 && prevYearPay() ? prevYearPay().rows[11] : null;
    if (!src) return;
    snapshot('前の明細と同じ内容を入れました');
    Object.keys(p.rows[i]).forEach(function (k) { if (!BK.filled(p.rows[i][k]) && BK.filled(src[k])) p.rows[i][k] = src[k]; });
    commit();
  };
  A.pyToBook = function () {
    var y = bookYear(), p = y && payOf(y), i = ui.book.slip; if (!p) return;
    var who = ui.book.who, mi = i < 12 ? i : p.bonusMonths[i - 12] - 1;
    var bv = payForMonth(p, mi);
    snapshot('給与明細を家計簿の' + MONTHS[mi] + 'に入れました');
    var rows = payBookRows(y, who, true);
    rows.sal.m[mi] = bv.sal || '';
    rows.bonus.m[mi] = bv.bonus || '';
    if (bv.voluntary && !rows.vol) {
      rows.vol = { id: store.book.nextId++, name: rows.vname, cat: 6, pay: BK.DEDUCTED, day: '', m: ['', '', '', '', '', '', '', '', '', '', '', ''] };
      var at = -1; y.items.forEach(function (it, k) { if (it.cat === 6) at = k; });
      y.items.splice(at < 0 ? y.items.length : at + 1, 0, rows.vol);
    }
    if (rows.vol) rows.vol.m[mi] = bv.voluntary || '';
    commit();
  };
  A.pyToPlan = function () {
    var y = bookYear(), p = y && payOf(y); if (!p) return;
    var m = payMember(ui.book.who), sal = m && state.salaries.filter(function (x) { return x.memberId === m.id; })[0];
    if (!sal || !sal.rows[0]) return;
    var v = BK.paySummary(p).planMan;
    snapshot('給与明細の手取り ' + v + '万円を、' + payName(ui.book.who) + 'の給与に入れました');
    sal.rows[0].amount = v;
    commit();
  };

  function bookHTML(width) {
    var y = bookYear();
    var body = !y ? bookEmptyHTML() : ui.book.mode === 'year' ? bookYearHTML(y, width) : ui.book.mode === 'plan' ? bookPlanHTML(y) :
      ui.book.mode === 'pay' ? payHTML(y) : bookMonthHTML(y);
    return bookHeaderHTML() + '<div class="bkbody">' + body + '</div>' +
      '<datalist id="bk-pays"><option value="現金"><option value="カード"><option value="口座振替"><option value="電子マネー"><option value="給与天引き"></datalist>';
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

  // ---------- 保障（必要保障額） ----------
  //
  // 家族１（または家族２）に万一のことがあったときに、遺された家族のお金が足りるか。2つの方法で出す。
  //   CF表でシミュレーション（E.riskShortfall）：今のプランをもとに「◯年に亡くなったら」のCF表を作り、不足資金を出す
  //   かんたん計算（E.needSimple）：Excel「必要保障額」シートと同じ式。初期値はプランから（E.needFromPlan）、書き換えは state.risk.simple に置く
  // 設定は state.risk = { mode, memberId, year, livingRate, funeral, lumpIn, insurance, drop, simple }。

  function riskOf(create) {
    if (!state.risk && create) state.risk = {};
    return state.risk || {};
  }
  function riskAdults() {
    return state.family.filter(function (m) { return (m.relation === '家族１' || m.relation === '家族２') && E.parseDate(m.birth).y; });
  }
  function riskDead() {
    var rk = riskOf(), ad = riskAdults();
    return ad.filter(function (m) { return m.id === toNum(rk.memberId); })[0] || ad.filter(function (m) { return m.relation === '家族１'; })[0] || ad[0] || null;
  }
  // 亡くなる年は、計算の範囲（開始年〜終わりの年）に収める
  function riskYearRange() {
    var ys = result && result.years.length ? result.years : E.compute(state).years;
    return { from: state.startYear, to: ys.length ? ys[ys.length - 1].year : state.startYear };
  }
  function riskInput(rk) {
    var dead = riskDead(), rg = riskYearRange();
    var y = Math.round(toNum(rk.year)) || state.startYear;
    return { memberId: dead ? dead.id : 0, year: Math.max(rg.from, Math.min(rg.to, y)), livingRate: rk.livingRate, livingRate2: rk.livingRate2, indepAge: rk.indepAge, funeral: rk.funeral,
      lumpIn: rk.lumpIn, insurance: rk.insurance, drop: rk.drop, spouseNet: rk.spouseNet, spouseUntil: rk.spouseUntil };
  }
  function riskField(f, label, small, unit, value, w) {
    return '<div class="calcrow"><span class="u" style="flex:1;min-width:0">' + label + (small ? '<small>' + small + '</small>' : '') + '</span>' +
      numInput('f-rk-' + f, 'op', w || 84, value, "A.rk('" + f + "',this.value)", ';margin-left:auto') + '<span class="u">' + unit + '</span></div>';
  }
  function manYen(v) { return Math.round(v).toLocaleString('ja-JP'); }

  // いつもと、もしもの金融資産の推移
  function riskChartSVG(base, risk, dy, width, covered) {
    var W = Math.max(280, width || 320), H = 150, P = 8, L = 34;
    var ys = base.years, n = ys.length;
    if (n < 2) return '';
    var vals = ys.map(function (y) { return y.assets.total; }).concat(risk.years.map(function (y) { return y.assets.total; }))
      .concat(covered ? covered.years.map(function (y) { return y.assets.total; }) : []);
    var max = Math.max.apply(null, vals.concat([0])), min = Math.min.apply(null, vals.concat([0]));
    if (max === min) max = min + 1;
    var X = function (i) { return L + (W - L - P) * i / (n - 1); }, Y = function (v) { return P + (H - 2 * P) * (max - v) / (max - min); };
    var line = function (rows) { return rows.map(function (y, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(y.assets.total).toFixed(1); }).join(''); };
    var di = dy - ys[0].year;
    return '<svg class="rkchart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="金融資産の推移。いつもと、もしもの場合">' +
      '<line x1="' + L + '" x2="' + (W - P) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="var(--line)" stroke-width="1.5"/>' +
      '<text x="' + (L - 4) + '" y="' + (Y(0) + 4).toFixed(1) + '" text-anchor="end" class="ax">0</text>' +
      '<text x="' + (L - 4) + '" y="' + (Y(max) + 8).toFixed(1) + '" text-anchor="end" class="ax">' + man(max) + '</text>' +
      (min < 0 ? '<text x="' + (L - 4) + '" y="' + (Y(min)).toFixed(1) + '" text-anchor="end" class="ax">' + man(min) + '</text>' : '') +
      (di >= 0 && di < n ? '<line x1="' + X(di).toFixed(1) + '" x2="' + X(di).toFixed(1) + '" y1="' + P + '" y2="' + (H - P) + '" stroke="var(--text-faint)" stroke-dasharray="4 4"/>' : '') +
      '<path d="' + line(ys) + '" fill="none" stroke="var(--s1)" stroke-width="2.5"/>' +
      '<path d="' + line(risk.years) + '" fill="none" stroke="var(--neg)" stroke-width="2.5"/>' +
      (covered ? '<path d="' + line(covered.years) + '" fill="none" stroke="var(--good)" stroke-width="2.5" stroke-dasharray="6 4"/>' : '') +
    '</svg>' +
    '<div class="catlegend"><span><i style="background:var(--s1)"></i>いつも</span><span><i style="background:var(--neg)"></i>もしも（' + dy + '年）</span>' +
      (covered ? '<span><i style="background:var(--good)"></i>保険で備えた場合</span>' : '') + '</div>';
  }

  function riskHTML(width) {
    var rk = riskOf(), mode = rk.mode === 'simple' ? 'simple' : 'cf';
    var ad = riskAdults(), dead = riskDead();
    var head = '<div class="hero rkhero"><div class="k">' + ic('shield', 20) + 'もしもの保障</div>' +
      '<p>家計の中心の人に万一のことがあったら、遺された家族のお金は足りる？　足りない分が「必要保障額」で、生命保険で備える目安です。</p></div>';
    if (!dead) return head + '<div class="card"><p class="wzlead" style="margin:0">家族構成に家族１の生年月日を入れると、計算できます。</p></div>';
    var sw = '<div class="mini thsp rkmode" role="radiogroup" aria-label="計算のしかた">' + [['cf', 'CF表で計算'], ['simple', 'かんたん計算']].map(function (o) {
      var on = mode === o[0];
      return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.rk(\'mode\',\'' + o[0] + '\')">' + o[1] + '</button>';
    }).join('') + '</div>';
    var who = ad.length > 1 ? '<div class="calcsec">万一のことがあったとき</div><div class="mini thsp" role="radiogroup" aria-label="亡くなる人">' + ad.map(function (m) {
      var on = m.id === dead.id;
      return '<button role="radio" aria-checked="' + on + '"' + (on ? ' class="on"' : '') + ' onclick="A.rk(\'memberId\',' + m.id + ')">' + esc(memberName(m.id)) + '</button>';
    }).join('') + '</div>' : '';
    return head + '<div class="card rkcard">' + sw + who + (mode === 'simple' ? riskSimpleHTML(dead) : riskCfHTML(dead, width)) + '</div>' +
      xlsxCardHTML('risk', '必要保障額と条件、遺族年金の移り変わり、いつも・もしもの推移のグラフ、もしもの場合のCF表、かんたん計算の内訳を、Excelファイルで保存します。保険の見直しの資料に。', 'A.exportRisk()') +
      DISCLAIMER;
  }

  function riskCfHTML(dead, width) {
    var rk = riskOf(), input = riskInput(rk);
    var by = E.parseDate(dead.birth).y, dy = input.year;
    var withIns = E.riskShortfall(state, input);
    var noIns = toNum(rk.insurance) > 0 ? E.riskShortfall(state, Object.assign({}, input, { insurance: 0 })) : withIns;
    var base = E.compute(state);
    var info = withIns.info, sv = info.survivor;
    var name = esc(memberName(dead.id)), sp = info.spouse;
    // 遺族年金が変わる年
    var steps = [];
    sv.forEach(function (x, i) { if (i === 0 || x.total !== sv[i - 1].total) steps.push(x); });
    var sby = sp ? E.parseDate(sp.birth).y : 0;
    var first = sv[0] || { basic: 0, child: 0, emp: 0, total: 0 };
    // 亡くなった後は入らない一時金・年金
    var drop = rk.drop || E.riskDropDefaults(state, input);
    var cands = [];
    [['lump', '一時収入'], ['corpPension', '企業年金'], ['privPension', '個人年金']].forEach(function (k) {
      (state[k[0]] || []).forEach(function (r) {
        var last = k[0] === 'lump' ? toNum(r.year) : toNum(r.toYear);
        if (last >= dy && toNum(r.amount) > 0) cands.push({ id: r.id, label: (r.memo || k[1]) + '（' + (k[0] === 'lump' ? r.year + '年 ' : r.year + '〜' + r.toYear + '年 年') + manYen(r.amount) + '万円）' });
      });
    });
    var dansin = state.housing.filter(function (r) { return r.dansin; }).length;
    var need = withIns.need, need0 = noIns.need;
    if (info.alone) {
      return '<div class="rkres ' + (need > 0 ? 'ng' : 'ok') + '">' +
          '<div class="k">' + name + 'が' + dy + '年（' + (dy - by) + '歳）に亡くなったら</div>' +
          '<div class="row"><span>必要保障額</span><b>' + manYen(need0) + '</b><span class="u">万円</span></div>' +
          '<div class="hint" style="padding:6px 0 0">遺される家族（配偶者や独立前の子）がいないので、必要になるのは葬儀・整理資金くらいです。' +
            'その時の金融資産（約' + manYen(withIns.assets) + '万円）' + (need0 > 0 ? 'では足りない分です。' : 'でまかなえます。') +
            '親の扶養や借入れがあれば、その分を葬儀・整理資金に足してください。</div>' +
        '</div>' +
        '<div class="calcsec">条件</div>' +
        riskField('year', '亡くなる年', (dy - by) + '歳', '年', rk.year === undefined || rk.year === '' ? dy : rk.year, 76) +
        riskField('funeral', '葬儀・整理資金', '', '万円', rk.funeral === undefined || rk.funeral === '' ? 200 : rk.funeral) +
        riskField('insurance', '加入中の死亡保険金', '', '万円', rk.insurance === undefined ? '' : rk.insurance);
    }
    // 必要保障額を備えた場合の推移（グラフの3本目）
    var covered = null;
    if (need > 0) {
      var cs = JSON.parse(JSON.stringify(withIns.state));
      cs.lump.push({ id: 80900, year: dy, amount: need, memo: '' });
      covered = E.compute(cs);
    }
    return '<div class="rkres ' + (need > 0 ? 'ng' : 'ok') + '">' +
        '<div class="k">' + name + 'が' + dy + '年（' + (dy - by) + '歳）に亡くなったら</div>' +
        '<div class="row"><span>必要保障額</span><b>' + manYen(need0) + '</b><span class="u">万円</span></div>' +
        (toNum(rk.insurance) > 0 ? '<div class="row sub"><span>加入中の保険 ' + manYen(rk.insurance) + '万円を入れると</span>' +
          (need > 0 ? '<b>あと ' + manYen(need) + '</b><span class="u">万円</span>' : '<b class="okt">足りています</b>') + '</div>' : '') +
        '<div class="hint" style="padding:6px 0 0">亡くなった年に一度にこの額が入れば、' + (info.until !== Infinity && info.until ? info.until + '年（末子が独立する前の年）' : (base.years.length ? base.years[base.years.length - 1].year : '') + '年') + 'まで金融資産（預金＋投資）がマイナスになりません。</div>' +
      '</div>' +
      riskChartSVG(base, withIns.cf, dy, width, covered) +
      '<div class="calcsec">遺族年金など</div>' +
      '<div class="ppbreak" style="font-size:13.5px">' + dy + '年：遺族基礎年金 ' + first.basic + ' ＋ 子の加算 ' + first.child + ' ＋ 遺族厚生年金 ' + first.emp + ' ＝ <b>' + penFmt(first.basic + first.child + first.emp) + '万円</b>（' + name + 'の厚生年金 ' + penFmt(info.emp) + '万円' + (info.empYears < 25 ? '・加入25年とみなす' : '') + 'から）</div>' +
      '<div class="rksteps">' + steps.slice(0, 8).map(function (x) {
        return '<span>' + x.year + '年' + (sp ? '（' + esc(memberName(sp.id)) + ' ' + (x.year - sby) + '歳）' : '') + '<b>' + penFmt(x.total) + '</b>万円</span>';
      }).join('') + '</div>' +
      '<div class="hint" style="padding:4px 0 0">遺族厚生年金は、子がいる間は報酬比例の3/4。子が18歳を過ぎると遺族基礎年金が終わり、遺族厚生年金はその後5年間（2028年の改正の有期給付。加算で報酬比例の全額ほど）で終わります。65歳からは本人の年金です。非課税なので手取りのまま、将来の目減り（公的年金と同じ割合）を掛けています。</div>' +
      '<div class="calcsec">条件</div>' +
      riskField('year', '亡くなる年', '今年なら「今すぐの場合」。' + (dy - by) + '歳', '年', rk.year === undefined || rk.year === '' ? dy : rk.year, 76) +
      (toNum(rk.year) && toNum(rk.year) !== dy ? '<div class="vmsg warn">' + ic('warn', 15) + '<span>計算できるのは' + riskYearRange().from + '〜' + riskYearRange().to + '年です。' + dy + '年として計算しています。</span></div>' : '') +
      riskField('livingRate', '遺族の生活費（末子独立まで）', '今の生活費に対する割合', '％', rk.livingRate === undefined || rk.livingRate === '' ? 80 : rk.livingRate, 64) +
      riskField('indepAge', '末子独立の年齢', info.indepYear && E.children(state).length ? '独立は' + info.indepYear + '年' : '子がいなければ、はじめから独立後の割合', '歳', rk.indepAge === undefined || rk.indepAge === '' ? 22 : rk.indepAge, 64) +
      riskField('livingRate2', '末子独立後の生活費', '今の生活費に対する割合', '％', rk.livingRate2 === undefined || rk.livingRate2 === '' ? 60 : rk.livingRate2, 64) +
      (sp ? riskField('spouseNet', '遺された' + esc(memberName(sp.id)) + 'の手取り（年）', '空欄ならプランのまま。亡くなった後に働く・増やす予定があれば', '万円', rk.spouseNet === undefined ? '' : rk.spouseNet) +
        (rk.spouseNet !== undefined && rk.spouseNet !== '' ? riskField('spouseUntil', '何歳まで働く', '', '歳', rk.spouseUntil === undefined || rk.spouseUntil === '' ? 65 : rk.spouseUntil, 64) : '') : '') +
      riskField('funeral', '葬儀・整理資金', '', '万円', rk.funeral === undefined || rk.funeral === '' ? 200 : rk.funeral) +
      riskField('lumpIn', '死亡退職金・弔慰金', '会社の規程で。DCの残高もここへ', '万円', rk.lumpIn === undefined ? '' : rk.lumpIn) +
      riskField('insurance', '加入中の死亡保険金', '団信は除く', '万円', rk.insurance === undefined ? '' : rk.insurance) +
      '<div class="hint" style="padding:6px 0 0">住宅ローンの団信：' + (dansin ? dansin + '行に印があり、亡くなった年から返済がなくなります。' : '印のある行がありません。入力の「住宅費」で、団信のある住宅ローンの行に印を付けてください。') + '</div>' +
      (cands.length ? '<div class="calcsec">亡くなった後は入らないもの</div>' + cands.map(function (c) {
        var on = drop.indexOf(c.id) >= 0;
        return '<label class="deprow"><input type="checkbox" id="f-rk-drop-' + c.id + '"' + (on ? ' checked' : '') + ' onchange="A.rkDrop(' + c.id + ',this.checked)"><span class="nm">' + esc(c.label) + '</span></label>';
      }).join('') : '') +
      '<div class="hint" style="padding:8px 0 0">' + name + 'の給与は亡くなった年から0、生活費は末子独立まで・独立後の割合をかけた額、公的年金は遺された人の年金と遺族年金に置き換えます。そのほかの支出（教育費・住宅費・車・保険料など）はプランのままです。</div>' +
      '<button class="btn block" style="margin-top:12px" onclick="A.rkSave()">' + ic('chart', 18) + 'このもしもの場合をプランとして保存（未来の表で見る）</button>';
  }

  var SIMPLE_FIELDS = [
    ['収入面'],
    ['deposit', '普通預金等', '', '万円'], ['invest', '投資資産', 'NISA、iDeCo、株など', '万円'], ['otherAssets', 'その他の資産', '', '万円'],
    ['avgIncome', '亡くなる人のこれまでの平均年収', '額面。上限1,080万円（2030年から1,200万円）', '万円'], ['years', '勤続年数', '25年未満は25年とみなす', '年'],
    ['age', '遺される配偶者の年齢', '', '歳'],
    ['condolence', '弔慰金', '会社から', '万円'], ['retirement', '死亡退職金', '', '万円'], ['otherCompany', 'その他（会社から）', '', '万円'],
    ['spouseNet', '配偶者の手取り（年間）', '', '万円'], ['spouseYears', 'その年数', '', '年'],
    ['spouseAvg', '配偶者の生涯の平均年収', '額面。65歳からの年金の計算用。上限は同じ', '万円'], ['spouseLifeYears', '生涯の勤続年数', '', '年'],
    ['otherIncome', 'その他の収入', '相続など', '万円'],
    ['支出面'],
    ['living', '今の基本生活費', '', '万円'], ['rate1', '亡くなった後の生活費の割合', '末子が独立するまで', '％'], ['indepAge', '末子独立の年齢', '', '歳'], ['rate2', '末子独立後の生活費の割合', '', '％'],
    ['loanYears', '住宅ローンの残り', '', '年'], ['loanAnnual', '住宅ローンの年返済額', '', '万円'], ['dansin', '団信で相殺される割合', '', '％'],
    ['upkeep', '維持費（年）', '修繕積立・管理費・固定資産税', '万円'], ['rent', '家賃（年）', '賃貸の場合', '万円'],
    ['edu', '子供の教育費', 'プランの教育費の合計', '万円'],
    ['insurance', '保険料（年）', '遺された家族の分', '万円'], ['insuranceUntil', '保険料は配偶者が何歳まで', '', '歳'],
    ['carCost', '自動車の維持費（年）', '', '万円'], ['carUntil', '配偶者が何歳まで', '', '歳'], ['carTimes', '車の購入回数', '', '回'], ['carPrice', '1台あたり', '', '万円'],
    ['others', 'その他の支出', '旅行など', '万円'], ['until', '何歳までの生活を見るか', '配偶者の年齢', '歳']
  ];
  // かんたん計算の入力：プランから作った初期値に、書き換えた欄（state.risk.simple）を重ねる
  function simpleInputs() {
    var rk = riskOf(), ov = rk.simple || {};
    var base = E.needFromPlan(state, riskInput(rk));
    var o = {};
    Object.keys(base).forEach(function (k) { o[k] = ov[k] !== undefined && ov[k] !== '' ? ov[k] : base[k]; });
    if (ov.others !== undefined && ov.others !== '') o.others = [ov.others];
    return o;
  }
  function riskSimpleHTML(dead) {
    var rk = riskOf(), ov = rk.simple || {};
    var hasSpouse = riskAdults().some(function (m) { return m.id !== dead.id; });
    if (!hasSpouse) {
      return '<div class="hint" style="padding:8px 0 0">かんたん計算（Excelの必要保障額シート）は、配偶者が遺される場合の計算です。ひとり暮らしやひとり親の場合は「CF表で計算」を使ってください。</div>';
    }
    var o = simpleInputs();
    var r = E.needSimple(o);
    var changed = Object.keys(ov).some(function (k) { return ov[k] !== undefined && ov[k] !== ''; });
    var rows = SIMPLE_FIELDS.map(function (f) {
      if (f.length === 1) return '<div class="calcsec">' + f[0] + '</div>';
      var v = f[0] === 'others' ? (ov.others !== undefined ? ov.others : 0) : o[f[0]];
      var mark = ov[f[0]] !== undefined && ov[f[0]] !== '';
      return '<div class="calcrow' + (mark ? ' edited' : '') + '"><span class="u" style="flex:1;min-width:0">' + f[1] + (f[2] ? '<small>' + f[2] + '</small>' : '') + '</span>' +
        numInput('f-rks-' + f[0], 'op', 76, v, "A.rkSimple('" + f[0] + "',this.value)", ';margin-left:auto') + '<span class="u">' + f[3] + '</span></div>';
    }).join('');
    var kids = o.kids.length ? o.kids.map(function (k) { return k + '歳'; }).join('・') : 'なし';
    var bar = function (label, parts, total) {
      return '<div class="rkbar"><div class="t">' + label + '<b>' + manYen(total) + '</b>万円</div>' +
        parts.filter(function (p) { return p[1] > 0; }).map(function (p) { return '<div class="r"><span>' + p[0] + '</span><span>' + manYen(p[1]) + '</span></div>'; }).join('') + '</div>';
    };
    return '<div class="rkres ' + (r.need > 0 ? 'ng' : 'ok') + '">' +
        '<div class="k">' + esc(memberName(dead.id)) + 'に今、万一のことがあったら（Excelの必要保障額シートの考え方）</div>' +
        '<div class="row"><span>必要保障額</span><b>' + manYen(r.need) + '</b><span class="u">万円</span></div>' +
      '</div>' +
      '<div class="rkcols">' +
        bar('支出の合計', [['生活費', r.expense.living], ['住居費', r.expense.housing], ['教育費', r.expense.edu], ['保険料', r.expense.insurance], ['自動車', r.expense.car], ['その他', r.expense.other]], r.expense.total) +
        bar('収入の合計', [['今の金融資産', r.income.assets], ['遺族年金など', r.income.survivor], ['会社から', r.income.company], ['配偶者の収入', r.income.spouse], ['その他', r.income.other]], r.income.total) +
      '</div>' +
      '<div class="hint" style="padding:6px 0 0">18歳以下（独立前）の子：' + kids + '（家族構成から）。遺族年金は2028年の改正（子が18歳を過ぎて5年で遺族厚生年金が終わる）を見込み、子がいる間の遺族厚生年金は報酬比例の3/4です（Excelのシートは全額）。</div>' +
      rows +
      (changed ? '<button class="btn ghost block" style="margin-top:12px" onclick="A.rkSimpleReset()">プランから入れた値に戻す</button>' : '') +
      '<div class="hint" style="padding:8px 0 0">金額のほとんどはプランから入れています。書き換えた欄には印が付きます。時間の流れ（物価・運用・教育費の時期）を入れて確かめるなら「CF表で計算」へ。</div>';
  }

  A.rk = function (field, v) {
    var rk = riskOf(true);
    if (field === 'mode') rk.mode = v;
    else if (field === 'memberId') { rk.memberId = toNum(v); delete rk.drop; }
    else rk[field] = String(v).trim() === '' ? '' : toNum(v);
    if (field === 'year') delete rk.drop;
    commit();
  };
  A.rkDrop = function (id, on) {
    var rk = riskOf(true);
    var drop = (rk.drop || E.riskDropDefaults(state, riskInput(rk))).slice();
    drop = drop.filter(function (x) { return x !== id; });
    if (on) drop.push(id);
    rk.drop = drop;
    commit();
  };
  A.rkSimple = function (field, v) {
    var rk = riskOf(true);
    rk.simple = rk.simple || {};
    rk.simple[field] = String(v).trim() === '' ? '' : toNum(v);
    commit();
  };
  A.rkSimpleReset = function () { snapshot('かんたん計算をプランの値に戻しました'); delete riskOf(true).simple; commit(); };
  A.rkSave = function () {
    var rk = riskOf(), dead = riskDead(); if (!dead) return;
    var input = riskInput(rk);
    var rs = E.riskState(state, input);
    var src = plan();
    var p = { id: store.nextPlanId++, name: uniqueName('もしも（' + memberName(dead.id) + '・' + input.year + '年）'), state: rs.state };
    delete p.state.risk;
    store.plans.splice(store.plans.indexOf(src) + 1, 0, p);
    switchTo(p.id);
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
      lead = '老後に受け取る公的年金です。入れてもらった給与から、自動で見込みます。';
      body = penPlanHTML('wz') +
        '<div class="calcsec" style="margin-top:18px">額がわかっているときは</div>' +
        wzField('pension', '公的年金（年額・家族の合計）', '万円', { optional: true, hint: '空欄なら、上の自動の見込みを使います。ねんきん定期便の見込額（年額）を足して、その9割ほどが手取りの目安です' }) +
        (String(d.pension).trim() !== '' ? wzField('pensionAge', '受け取りを始める年齢（家族１）', '歳から', { width: 80 }) : '');
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
    'commute', 'loan', 'lumpIn', 'insurance', 'funeral', 'livingRate', 'livingRate2', 'spouseUntil', 'deposit', 'invest', 'otherAssets', 'avgIncome', 'years', 'age', 'condolence', 'retirement', 'otherCompany', 'spouseNet', 'spouseYears', 'spouseAvg', 'spouseLifeYears', 'otherIncome', 'living', 'rate1', 'indepAge', 'rate2', 'loanYears', 'loanAnnual', 'dansin', 'rent', 'edu', 'insuranceUntil', 'carCost', 'carUntil', 'carTimes', 'carPrice', 'others', 'until', 'firstAge', 'firstIncome', 'pastYears', 'pastIncome', 'teikiEarn', 'teikiBasic', 'basicYears', 'startAge', 'contrib', 'cost', 'until', 'receive', 'target', 'gPay', 'gAfter', 'gDeduct', 'gTax', 'gSocial', 'gSmall', 'gResident'];
  // numLeaves：教育費・車の金額の上書き（「キー → 金額」の形）の中は、末端がすべて数値
  function clean(v, key, numLeaves) {
    if (Array.isArray(v)) return v.map(function (x) { return clean(x, null, numLeaves); });
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { o[k] = clean(v[k], k, numLeaves || k === 'eduAmount' || k === 'carBuyOverride'); });
      return o;
    }
    if (typeof v === 'boolean') return v;   // 団信の印（dansin: true）など。数値の欄と同じ名前でも数値にしない
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
      if (y.pay && typeof y.pay === 'object') {
        var pay = {};
        ['1', '2'].forEach(function (k) {
          var p = y.pay[k];
          if (!p || !Array.isArray(p.rows)) return;
          var q = BK.newPay();
          q.rows.forEach(function (r, i) { Object.keys(r).forEach(function (f) { r[f] = amt((p.rows[i] || {})[f]); }); });
          q.bonusMonths = [0, 1].map(function (j) { var v = Math.round(toNum((p.bonusMonths || [])[j])); return v >= 1 && v <= 12 ? v : [6, 12][j]; });
          if (p.sample) q.sample = true;
          pay[k] = q;
        });
        if (Object.keys(pay).length) years[k].pay = pay;
      }
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

    ['book', 'input', 'cf', 'risk', 'cmp'].forEach(function (v) {
      var b = document.getElementById('seg-' + v);
      b.classList.toggle('on', ui.view === v);
      b.setAttribute('aria-current', ui.view === v ? 'page' : 'false');
    });
    document.getElementById('seg-book').classList.toggle('due', bookDue());
    document.getElementById('tabbar').hidden = ui.view === 'cover' || ui.view === 'wizard';
    // かんたん入力の間は、まだ無い新しいプランを作っているので、今のプラン名ではなく「作成中」と出す（切り替えもしない）
    var making = ui.view === 'wizard';
    var pb = document.getElementById('planbtn');
    pb.disabled = making;
    pb.classList.toggle('making', making);
    pb.setAttribute('aria-label', making ? '新しいプランを作成中' : 'プランを切り替える・管理する');
    document.getElementById('planname').textContent = making ? '新しいプランを作成中' : plan().name;
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
    document.getElementById('riskview').hidden = ui.view !== 'risk';
    document.getElementById('topbar').hidden = ui.view === 'cover';

    if (ui.view === 'cover') {
      document.getElementById('coverview').innerHTML = coverHTML();
    } else if (ui.view === 'book') {
      var bv = document.getElementById('bookview');
      patchChildren(bv, bookHTML(bv.clientWidth - 56));
      // 選んでいる月を、月の並びの見える位置に（月を変えたときと、家計簿を開いたとき）
      var mi = ui.book.mode === 'pay' ? ui.book.slip : ui.book.month;
      var mk = ui.book.year + '-' + ui.book.mode + '-' + ui.book.who + '-' + mi;
      if (ui.book.shown !== mk) {
        var row = bv.querySelector('.bkmonths'), chip = document.getElementById('bkm-' + mi);
        if (row && chip) { row.scrollLeft = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2; ui.book.shown = mk; }
      }
    } else if (ui.view === 'risk') {
      var rv = document.getElementById('riskview');
      patchChildren(rv, riskHTML(rv.clientWidth - 56));
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
    autoLabel(document.getElementById({ input: 'inputview', cf: 'cfview', cmp: 'cmpview', wizard: 'wizview', cover: 'coverview', book: 'bookview', risk: 'riskview' }[ui.view] || 'inputview'));
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
    // キーボードを閉じても入力欄にフォーカスが残ることがある（Androidの戻るボタンなど）。そのままだと上のバーと下のタブが隠れたままになるので、
    //   1. 画面の高さ（visualViewport）が元に戻ったら、キーボードが閉じたとみなして入力を終える
    //   2. 入力欄やボタン以外のところに触れたら（スクロールしようとしたときなど）、入力を終える
    var vv = window.visualViewport, vvBase = vv ? vv.height : 0, vvShrunk = false;
    var endTyping = function () {
      var el = document.activeElement;
      if (typingField(el)) el.blur();
      clearTimeout(kbTimer);
      setTyping(false);
    };
    if (vv) {
      vv.addEventListener('resize', function () {
        var typing = document.getElementById('shell').classList.contains('kb');
        if (!typing) { vvBase = vv.height; vvShrunk = false; return; }
        if (vv.height < vvBase - 120) vvShrunk = true;
        else if (vvShrunk && vv.height > vvBase - 60) { vvShrunk = false; endTyping(); }
      });
    }
    document.addEventListener('touchstart', function (ev) {
      if (!document.getElementById('shell').classList.contains('kb')) return;
      var t = ev.target;
      if (t.closest && t.closest('input, select, textarea, button, a, label, [onclick], [role], .sheet')) return;
      endTyping();
    }, { passive: true });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (ui.view !== 'cf' && ui.view !== 'cmp') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  render();
}());
