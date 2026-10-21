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
        { id: 2, year: 2027, amount: 202, memo: '住宅ローン（当初金利）＋管理費等' },
        { id: 3, year: 2037, amount: 221, memo: '住宅ローン（金利見直し後）＋管理費等' },
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
      pubPension: [{ id: 1, year: by + n(d.pensionAge), amount: n(d.pension), memo: '' }],
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

  return { sample: sample, fromAnswers: fromAnswers };
}));
