'use strict';

/**
 * ContextPocket shared ranking core
 *
 * quan 的 per-pocket 索引与 yuan 的 workspace 索引各有自己的索引布局，
 * 但 BM25 的公式、词频统计与 IDF 语义必须只有一份——否则两个版本对同一句
 * 查询会给出不同的相关度，调参也会各改各的。
 *
 * 这个模块只做纯计算：
 *   - termStats: 把若干段已分词的文本折成 { counts, length }
 *   - bm25Score: 用统一的 K1/B 与 IDF 公式打分
 *
 * 索引布局、候选筛选、排序平局规则仍留在各自版本：quan 按字段权重累加，
 * yuan 额外有短语加成与时间平局规则，这些是产品差异，不是公式差异。
 */

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * 统计词频与文档长度。
 * @param {string[][]} tokenLists 每段文本的分词结果（已去重或未去重都可以）
 * @param {Set<string>} [wanted] 只统计这些查询词；长度仍按全文算
 * @returns {{counts: Object<string, number>, length: number}}
 */
function termStats(tokenLists, wanted) {
  const counts = {};
  let length = 0;
  for (const terms of tokenLists || []) {
    if (!Array.isArray(terms) || terms.length === 0) continue;
    length += terms.length;
    for (const term of terms) {
      if (wanted && !wanted.has(term)) continue;
      counts[term] = (counts[term] || 0) + 1;
    }
  }
  return { counts, length };
}

/**
 * 统一 BM25 打分。
 *
 * @param {object} input
 * @param {Object<string, number>} input.tf 文档内查询词频
 * @param {number} input.length 文档长度（全文字词数）
 * @param {number} input.avgLength 语料平均文档长度
 * @param {string[]} input.terms 查询词
 * @param {Object<string, number>} input.df 每个查询词的文档频率
 * @param {number} input.totalDocs 语料文档数
 * @param {Object<string, number>} [input.weights] 可选的词项权重（yuan 的字段权重）
 * @returns {number}
 */
function bm25Score(input) {
  const {
    tf,
    length,
    avgLength,
    terms,
    df,
    totalDocs,
    weights,
  } = input;

  let score = 0;
  for (const term of terms || []) {
    const freq = df[term] || 0;
    if (freq === 0) continue;
    const count = tf[term] || 0;
    if (count === 0) continue;

    const idf = Math.log(1 + (totalDocs - freq + 0.5) / (freq + 0.5));
    const denom = count + BM25_K1 * (1 - BM25_B + BM25_B * (length / (avgLength || 1)));
    const weight = weights ? (weights[term] || 1) : 1;
    score += idf * ((count * (BM25_K1 + 1)) / denom) * weight;
  }
  return score;
}

module.exports = {
  BM25_K1,
  BM25_B,
  termStats,
  bm25Score,
};
