import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

// 사진마다 어디서 왔는지와 GPT Image 2 그림 장수·금액을 기록합니다. (사용자 요청 2026-10-05)
// - data/logs/사진기록.csv : 사진 한 장마다 한 줄 (엑셀로 열립니다)
// - data/logs/사진사용량.json : 날짜별·누적 GPT 그림 장수와 금액
// 금액은 OpenAI 가 응답마다 알려 주는 사용량(토큰)으로 계산합니다. 그림 값만 세면(장당 약 8원)
// 글 내용까지 담은 긴 그림 지시문 값이 빠져 실제보다 훨씬 적게 나옵니다.

const CSV_NAME = '사진기록.csv';
const TOTALS_NAME = '사진사용량.json';
const CSV_HEAD = ['시각', '글 주제', '사진 설명', '종류', '출처', 'GPT 를 못 쓴 이유', '지시문 토큰', '그림 토큰', '금액($)', '금액(원)', '오늘 GPT 장수', '누적 GPT 장수', '누적 금액(원)'];

// 응답에 사용량이 없을 때만 쓰는 장당 그림 값(달러, 1024x1024 기준)입니다.
const PER_IMAGE_USD = { low: 0.006, medium: 0.053, high: 0.211 };

const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// 그림 한 장 값(달러). 사용량이 없으면 화질별 장당 값으로 어림합니다(estimated).
const gptCost = (usage) => {
  const input = Number(usage?.input_tokens);
  const output = Number(usage?.output_tokens);
  if (Number.isFinite(input) && Number.isFinite(output)) {
    const usd = (input * num('OPENAI_IMAGE_PRICE_TEXT_IN', 5) + output * num('OPENAI_IMAGE_PRICE_IMAGE_OUT', 30)) / 1e6;
    return { usd, input, output, estimated: false };
  }
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'low';
  return { usd: PER_IMAGE_USD[quality] ?? PER_IMAGE_USD.low, input: '', output: '', estimated: true };
};

const pad = (value) => String(value).padStart(2, '0');
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localTime = (date) => `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const readTotals = (file) => {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && saved.total) {
      return { days: {}, ...saved };
    }
  } catch (error) {
    // 처음이거나 파일이 깨졌으면 새로 셉니다.
  }
  return { since: localDay(new Date()), total: { gpt: 0, usd: 0, other: 0 }, days: {} };
};

// 엑셀로 열어 둔 동안에는 파일이 잠겨 줄을 덧붙일 수 없습니다. 못 쓴 줄은 모아 두었다가 다음 사진 때 함께 씁니다.
const pendingRows = [];

// 사진 한 장을 기록하고, 화면 기록에 쓸 요약을 돌려줍니다. 기록이 실패해도 사진 만들기는 멈추지 않습니다.
// entry: { topic, caption, kind, credit, reason, usage }  kind 가 'gpt' 일 때만 금액을 셉니다.
const recordPhoto = (entry, dir = PATHS.logs) => {
  const now = new Date();
  const day = localDay(now);
  const rate = num('OPENAI_USD_KRW', 1400);
  const isGpt = entry.kind === 'gpt';
  const cost = isGpt ? gptCost(entry.usage) : { usd: 0, input: '', output: '', estimated: false };
  const result = {
    kind: entry.kind,
    usd: cost.usd,
    won: Math.round(cost.usd * rate),
    todayGpt: 0,
    todayWon: 0,
    totalGpt: 0,
    totalWon: 0,
    since: '',
    file: path.join(dir, CSV_NAME),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const totalsFile = path.join(dir, TOTALS_NAME);
    const totals = readTotals(totalsFile);
    const today = totals.days[day] || { gpt: 0, usd: 0, other: 0 };
    if (isGpt) {
      today.gpt += 1;
      today.usd += cost.usd;
      totals.total.gpt += 1;
      totals.total.usd += cost.usd;
    } else {
      today.other += 1;
      totals.total.other += 1;
    }
    totals.days[day] = today;
    totals.updated = localTime(now);
    totals.note = '금액은 OpenAI 응답의 사용량(토큰)으로 계산한 값입니다. 정확한 청구 금액은 platform.openai.com 의 Usage 에서 확인하세요.';
    // 쓰는 도중 꺼져도 파일이 깨지지 않게 임시 파일에 쓴 뒤 바꿔 끼웁니다.
    fs.writeFileSync(`${totalsFile}.tmp`, JSON.stringify(totals, null, 2));
    fs.renameSync(`${totalsFile}.tmp`, totalsFile);
    Object.assign(result, {
      todayGpt: today.gpt,
      todayWon: Math.round(today.usd * rate),
      totalGpt: totals.total.gpt,
      totalWon: Math.round(totals.total.usd * rate),
      since: totals.since,
    });
  } catch (error) {
    result.warning = `사진 사용량 파일(${TOTALS_NAME})을 쓰지 못했습니다. (${error.message})`;
  }
  const kindName = { gpt: 'GPT 그림', pollinations: 'Pollinations 그림', stock: '무료 사진', none: '사진 못 받음' }[entry.kind] || entry.kind;
  const won = isGpt ? `${result.won}${cost.estimated ? '(추정)' : ''}` : '';
  pendingRows.push([
    localTime(now), entry.topic, entry.caption, kindName, entry.credit, entry.reason,
    cost.input, cost.output, isGpt ? cost.usd.toFixed(4) : '', won,
    result.todayGpt, result.totalGpt, result.totalWon,
  ].map(csvCell).join(','));
  try {
    const csvFile = result.file;
    // 엑셀이 한글을 깨뜨리지 않게 처음 만들 때 BOM 을 붙입니다.
    const head = fs.existsSync(csvFile) ? '' : `﻿${CSV_HEAD.join(',')}\r\n`;
    fs.appendFileSync(csvFile, `${head}${pendingRows.join('\r\n')}\r\n`);
    pendingRows.length = 0;
  } catch (error) {
    result.warning = error.code === 'EBUSY' || error.code === 'EPERM'
      ? `사진 기록 파일(${CSV_NAME})이 엑셀에 열려 있어 지금은 쓰지 못했습니다. 엑셀을 닫으면 다음 사진 때 함께 기록합니다.`
      : `사진 기록 파일(${CSV_NAME})을 쓰지 못했습니다. (${error.message})`;
  }
  return result;
};

export { recordPhoto, gptCost };
