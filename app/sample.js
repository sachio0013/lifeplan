/*
 * 初期データ。Excel「ライフプラン表 ver.1.79」入力シートのサンプル入力と同じ内容。
 * Excelと同じ入力で同じCF表になることを test/engine.test.mjs で確かめる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LifePlanSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function sample() {
    return {
      version: 1,
      startYear: 2026,
      endAge: 90,
      depositRate: 0,
      assets: [
        { id: 1, name: '普通預金等', fixed: true, amount: 500 },
        { id: 2, name: 'NISA', fixed: false, amount: 0, rate: 3, tax: '0%' },
        { id: 3, name: 'iDeCo', fixed: false, amount: 0, rate: 3, tax: '0%' }
      ],
      family: [
        { id: 1, name: '夫', gender: '男性', relation: '家族１', birth: '1991/01/01', job: '会社員等' },
        { id: 2, name: '妻', gender: '女性', relation: '家族２', birth: '1991/01/01', job: '会社員等' },
        { id: 3, name: '第一子', gender: '男性', relation: '子供１', birth: '2022/01/01', job: '乳幼児' },
        { id: 4, name: '第二子', gender: '女性', relation: '子供２', birth: '2024/01/01', job: '乳幼児' }
      ],
      edu: {
        3: ['保育園0～3歳', '保育園4～6歳', '小学校（公）', '中学校（公）', '高校（公）', '大学（私文）', '大学院'],
        4: ['保育園0～3歳', '保育園4～6歳', '小学校（公）', '中学校（公）', '高校（公）', '大学（私文）', '大学院']
      },
      eduAmount: {},
      eduSpan: {},
      salaries: [
        { id: 1, who: '家族１', memberId: 1, retireAge: 65, rows: [
          { id: 1, year: 2026, amount: 500, growth: 1.5 },
          { id: 2, year: 2051, amount: 300, growth: 0 }
        ] },
        { id: 2, who: '家族２', memberId: 2, retireAge: 60, rows: [
          { id: 3, year: 2026, amount: 300, growth: 1.5 }
        ] }
      ],
      lump: [{ id: 1, year: 2051, amount: 1500, memo: '退職金' }],
      corpPension: [],
      privPension: [],
      pubPension: [{ id: 1, year: 2056, amount: 290, memo: '家族１・家族２の合計' }],
      living: [
        { id: 1, year: 2026, amount: 360, memo: '' },
        { id: 2, year: 2056, amount: 300, memo: '老後' }
      ],
      inflation: 0.5,
      housing: [
        { id: 1, year: 2026, amount: 100, memo: '賃貸' },
        { id: 2, year: 2027, amount: 202, loan: 152, dansin: true, memo: '住宅ローン（当初金利）＋管理費等' },
        { id: 3, year: 2037, amount: 221, loan: 171, dansin: true, memo: '住宅ローン（金利見直し後）＋管理費等' },
        { id: 4, year: 2062, amount: 50, memo: '完済後の管理費・固定資産税' }
      ],
      housingLump: [{ id: 1, year: 2027, amount: 500, memo: '頭金' }],
      insurance: [{ id: 1, year: 2026, amount: 20, memo: '' }],
      carCost: [{ id: 1, year: 2026, amount: 15, memo: '' }],
      carBuy: { fromYear: 2030, every: 10, amount: 300, untilAge: 75 },
      carBuyOverride: {},
      otherFlow: [],
      otherLump: [],
      invest: {
        2: {
          add: [{ id: 1, year: 2026, toYear: 2051, amount: 60, memo: '' }],
          out: [{ id: 2, year: 2061, toYear: 2081, amount: 150, memo: '' }]
        },
        3: {
          add: [{ id: 3, year: 2026, toYear: 2051, amount: 0, memo: '' }],
          out: [{ id: 4, year: 2061, toYear: 2081, amount: 0, memo: '' }]
        }
      },
      calc: { income: 600, spouse: 'なし', kids: 0 },
      // 住宅ローンの試算（入力シート T115:AH121 のサンプル。返済総額5,810万円）
      loanCalc: { start: 2027, amount: 4500, years: 35, phases: [{ rate: 1, years: 10 }, { rate: 2, years: '' }], upkeep: 50 },
      nextId: 500
    };
  }

  // かんたん入力の答えから、プランの入力一式を作る。答えていない項目は空（0円・行なし）にする。
  // 教育費の進路はサンプルと同じ（公立→私立文系の大学→大学院）。あとで支出セクションで選び直せる。
  function fromAnswers(d) {
    function n(v) { var x = parseFloat(v); return isFinite(x) ? x : 0; }
    var sy = n(d.startYear);
    var by = parseInt(String(d.birth1 || '').slice(0, 4), 10) || sy;
    var family = [{ id: 1, name: d.name1 || '', gender: '', relation: '家族１', birth: d.birth1, job: '会社員等' }];
    if (d.has2) family.push({ id: 2, name: d.name2 || '', gender: '', relation: '家族２', birth: d.birth2, job: '会社員等' });
    var edu = {};
    (d.kids || []).forEach(function (k, i) {
      var id = 10 + i;
      var age = sy - (parseInt(String(k.birth || '').slice(0, 4), 10) || sy);
      family.push({ id: id, name: k.name || '', gender: '', relation: '子供' + (i + 1), birth: k.birth, job: age < 6 ? '乳幼児' : '学生' });
      edu[id] = ['保育園0～3歳', '保育園4～6歳', '小学校（公）', '中学校（公）', '高校（公）', '大学（私文）', '大学院'];
    });
    var salaries = [{ id: 1, who: d.name1 || '家族１', memberId: 1, retireAge: n(d.retire1), rows: [{ id: 1, year: sy, amount: n(d.sal1), growth: n(d.growth) }] }];
    if (d.has2 && n(d.sal2) > 0) {
      salaries.push({ id: 2, who: d.name2 || '家族２', memberId: 2, retireAge: n(d.retire2), rows: [{ id: 2, year: sy, amount: n(d.sal2), growth: n(d.growth) }] });
    }
    return {
      version: 1,
      startYear: sy,
      endAge: n(d.endAge),
      depositRate: 0,
      assets: [
        { id: 1, name: '普通預金等', fixed: true, amount: n(d.deposit) },
        { id: 2, name: 'NISA', fixed: false, amount: n(d.nisa), rate: n(d.rate), tax: '0%' },
        { id: 3, name: 'iDeCo', fixed: false, amount: n(d.ideco), rate: n(d.rate), tax: '0%' }
      ],
      family: family,
      edu: edu, eduAmount: {}, eduSpan: {},
      salaries: salaries,
      lump: n(d.retireLump) > 0 && n(d.retire1) ? [{ id: 1, year: by + n(d.retire1), amount: n(d.retireLump), memo: '退職金' }] : [],
      corpPension: [],
      privPension: [],
      // 公的年金は、額を入れていなければ自動で見込む（給与から）
      pubPension: n(d.pension) > 0 ? [{ id: 1, year: by + n(d.pensionAge), amount: n(d.pension), memo: '' }] : [],
      penAuto: n(d.pension) > 0 ? undefined : true,
      penPlan: d.penPlan ? JSON.parse(JSON.stringify(d.penPlan)) : { adjust: 90, people: {} },
      living: [{ id: 1, year: sy, amount: n(d.living), memo: '' }],
      inflation: n(d.inflation),
      housing: [{ id: 1, year: sy, amount: n(d.housing), memo: '' }],
      housingLump: [],
      insurance: [{ id: 1, year: sy, amount: n(d.insurance), memo: '' }],
      carCost: [],
      carBuy: { fromYear: '', every: 10, amount: 0, untilAge: 75 },
      carBuyOverride: {},
      otherFlow: [],
      otherLump: [],
      invest: { 2: { add: [], out: [] }, 3: { add: [], out: [] } },
      calc: { income: 600, spouse: 'なし', kids: 0 },
      nextId: 500
    };
  }

  // ---- 表紙で選ぶ「家族のかたち」「住まい」と、その参考値 ----
  //
  // 参考値は、かんたん入力の欄にあらかじめ入れておく「書き換える前提の目安の例」。統計の平均ではない。
  // 金額は手取り・年額（万円）。生年月日は人それぞれなので空のまま（入力を求める）。

  var FAMILIES = [
    { key: 'single', label: 'ひとり暮らし', adults: 1, kids: 0 },
    { key: 'couple', label: 'ふたり暮らし', adults: 2, kids: 0 },
    { key: 'kid1', label: '3人家族（子供1人）', adults: 2, kids: 1 },
    { key: 'kid2', label: '4人家族（子供2人）', adults: 2, kids: 2 },
    { key: 'kid3', label: '5人家族（子供3人）', adults: 2, kids: 3 }
  ];
  var HOMES = [
    { key: 'rent', label: '賃貸' },
    { key: 'loan', label: '持ち家（ローン返済中）' },
    { key: 'owned', label: '持ち家（ローンなし）' },
    { key: 'parents', label: '実家・社宅など' }
  ];
  var NEEDS = [
    { key: 'house', label: '家を買うか考えたい' },
    { key: 'edu', label: '子供の教育費が心配' },
    { key: 'retire', label: '老後のお金が足りるか' },
    { key: 'invest', label: 'NISAなど積立投資を試したい' },
    { key: 'work', label: '働き方を考えたい' },
    { key: 'save', label: '節約したほうがいいか' }
  ];

  //                    single couple kid1 kid2 kid3
  var REF = {
    sal1:      [320, 400, 420, 450, 470],
    sal2:      [0,   300, 200, 180, 150],
    living:    [180, 250, 290, 330, 370],
    insurance: [10,  15,  20,  24,  28],
    deposit:   [200, 400, 350, 400, 450],
    rent:      [84,  120, 132, 144, 156],   // 家賃（月7〜13万円）
    loan:      [96,  132, 144, 156, 168],   // ローン返済＋管理費・固定資産税など
    owned:     [30,  40,  40,  45,  45],    // 管理費・修繕・固定資産税など
    parents:   [24,  36,  36,  40,  40]
  };

  // かんたん入力の答えのひな形（参考値入り）。_ref は「参考値のままの欄」の印
  function templateAnswers(familyKey, homeKey, startYear) {
    var fi = 0;
    FAMILIES.forEach(function (f, i) { if (f.key === familyKey) fi = i; });
    var f = FAMILIES[fi];
    var home = REF[homeKey] ? homeKey : 'rent';
    var d = {
      startYear: startYear, endAge: 95, name1: '', birth1: '',
      has2: f.adults > 1, name2: '', birth2: '', kids: [],
      deposit: REF.deposit[fi], nisa: 0, ideco: 0, rate: 3,
      sal1: REF.sal1[fi], retire1: 65, growth: 1, sal2: f.adults > 1 ? REF.sal2[fi] : '', retire2: 65, retireLump: 0,
      pension: '', pensionAge: 65,     // 公的年金は給与から自動で見込む
      living: REF.living[fi], housing: REF[home][fi], insurance: REF.insurance[fi], inflation: 1,
      _ref: {}
    };
    for (var k = 0; k < f.kids; k++) d.kids.push({ name: '', birth: '' });
    ['deposit', 'sal1', 'sal2', 'pension', 'living', 'housing', 'insurance'].forEach(function (key) { if (d[key] !== '') d._ref[key] = true; });
    return d;
  }

  // 気になることに合わせて、作ったプランに試算の参考値を入れておく
  function applyNeeds(state, needs) {
    var sy = state.startYear;
    var by = parseInt(String((state.family[0] || {}).birth || '').slice(0, 4), 10) || sy - 35;
    if (needs.indexOf('invest') >= 0) {
      state.invest[2].add = [{ id: 1, year: sy, toYear: Math.max(sy, by + 59), amount: 36, memo: '参考値：月3万円' }];
    }
    if (needs.indexOf('house') >= 0) {
      state.loanCalc = { start: sy + 2, amount: 4000, years: 35, phases: [{ rate: 1, years: 10 }, { rate: 2, years: '' }], upkeep: 40 };
    }
    return state;
  }

  return {
    sample: sample, fromAnswers: fromAnswers,
    FAMILIES: FAMILIES, HOMES: HOMES, NEEDS: NEEDS, templateAnswers: templateAnswers, applyNeeds: applyNeeds
  };
}));
