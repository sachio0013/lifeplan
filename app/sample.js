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

  return { sample: sample };
}));
