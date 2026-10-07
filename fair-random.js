'use strict';

const FAIR_RANDOM_WEIGHT_BANDS = Object.freeze({
  dangdut_koplo: Object.freeze({ min: 76, max: 100 }),
  indonesia: Object.freeze({ min: 51, max: 75 }),
  western: Object.freeze({ min: 26, max: 50 }),
  korean_kpop: Object.freeze({ min: 1, max: 25 })
});

const DEFAULT_FAIR_RANDOM_PROFILE = Object.freeze({
  category: 'unclassified',
  weight: 50,
  source: 'fallback'
});

function normalizeFairRandomCategory(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    dangdut: 'dangdut_koplo',
    koplo: 'dangdut_koplo',
    dangdut_koplo: 'dangdut_koplo',
    indonesia: 'indonesia',
    lagu_indonesia: 'indonesia',
    western: 'western',
    barat: 'western',
    lagu_barat: 'western',
    korea: 'korean_kpop',
    korean: 'korean_kpop',
    kpop: 'korean_kpop',
    k_pop: 'korean_kpop',
    korean_kpop: 'korean_kpop'
  };
  return aliases[normalized] || null;
}

function buildGeminiFairRandomProfile(category, weight) {
  const normalizedCategory = normalizeFairRandomCategory(category);
  if (weight === null || weight === undefined || weight === '') {
    return { ...DEFAULT_FAIR_RANDOM_PROFILE };
  }
  const numericWeight = Number(weight);
  const band = normalizedCategory ? FAIR_RANDOM_WEIGHT_BANDS[normalizedCategory] : null;
  if (!band || !Number.isFinite(numericWeight)) {
    return { ...DEFAULT_FAIR_RANDOM_PROFILE };
  }

  return {
    category: normalizedCategory,
    weight: Math.max(band.min, Math.min(band.max, Math.round(numericWeight))),
    source: 'gemini'
  };
}

function getRequestFairRandomProfile(request) {
  const category = normalizeFairRandomCategory(request?.fairRandomCategory);
  if (request?.fairRandomWeight === null || request?.fairRandomWeight === undefined || request?.fairRandomWeight === '') {
    return { ...DEFAULT_FAIR_RANDOM_PROFILE };
  }
  if (request?.fairRandomSource === 'gemini') {
    return buildGeminiFairRandomProfile(category, request.fairRandomWeight);
  }
  const numericWeight = Number(request?.fairRandomWeight);
  if (!category || !Number.isFinite(numericWeight)) {
    return { ...DEFAULT_FAIR_RANDOM_PROFILE };
  }

  return {
    category,
    weight: Math.max(1, Math.min(100, Math.round(numericWeight))),
    source: request?.fairRandomSource === 'gemini' ? 'gemini' : 'fallback'
  };
}

function buildFairRandomSelectionWeights(requests) {
  if (!Array.isArray(requests)) return [];
  return requests.map((request, index) => {
    const ageWeight = requests.length - index;
    return getRequestFairRandomProfile(request).weight * ageWeight;
  });
}

function pickWeightedIndex(weights, random = Math.random) {
  if (!Array.isArray(weights) || weights.length === 0) return -1;
  const safeWeights = weights.map((weight) => {
    const numericWeight = Number(weight);
    return Number.isFinite(numericWeight) && numericWeight > 0 ? numericWeight : 0;
  });
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return 0;

  const sampledValue = Number(random());
  const normalizedSample = Number.isFinite(sampledValue) ? sampledValue : 0;
  let target = Math.max(0, Math.min(0.999999999999, normalizedSample)) * totalWeight;
  for (let index = 0; index < safeWeights.length; index++) {
    target -= safeWeights[index];
    if (target < 0) return index;
  }
  return safeWeights.length - 1;
}

module.exports = {
  DEFAULT_FAIR_RANDOM_PROFILE,
  FAIR_RANDOM_WEIGHT_BANDS,
  buildFairRandomSelectionWeights,
  buildGeminiFairRandomProfile,
  getRequestFairRandomProfile,
  normalizeFairRandomCategory,
  pickWeightedIndex
};
