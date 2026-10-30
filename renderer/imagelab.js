// 받아온 사진을 블로그용 정사각형 이미지로 만드는 부분입니다.
// 1) 정사각형으로 가운데를 잘라 고품질로 축소·확대
// 2) 자동 레벨: 뿌옇게 뜬 사진의 가장 어두운 곳·밝은 곳을 제자리로 펴 선명하게
// 3) 밝고 화사하게: 중간 밝기를 들어 올리고 살짝 따뜻하게, 칙칙한 색만 조금 살림 (BLOG_IMAGE_TONE=natural 이면 건너뜀)
// 4) 언샤프 마스크: 윤곽을 또렷하게 (잡티는 키우지 않도록 약한 차이는 건너뜀)
// 본문 사진 위에는 글씨를 넣지 않습니다. 글 맨 위 썸네일에만 궁금증 문구(overlay)를 아래쪽에 크게 얹습니다.
// (2026-10-01 사진 위 글씨 제거 → 2026-10-08 썸네일만 문구, 사용자 요청)

const MAX_SIZE = 1200; // 결과 이미지 한 변의 최대 크기
const MIN_SIZE = 960; // 원본이 작아도 이 크기까지는 맞춥니다.

const PALETTES = [
  { from: 'rgba(255, 186, 120, 0.22)', to: 'rgba(90, 140, 190, 0.18)', bg: ['#f6e7d8', '#cfd9e6'] },
  { from: 'rgba(255, 214, 165, 0.20)', to: 'rgba(120, 160, 140, 0.16)', bg: ['#f3ece0', '#d8e3d6'] },
  { from: 'rgba(255, 170, 160, 0.20)', to: 'rgba(110, 130, 200, 0.16)', bg: ['#f7e4e2', '#dcdcf0'] },
  { from: 'rgba(255, 225, 180, 0.22)', to: 'rgba(150, 120, 180, 0.14)', bg: ['#f8efdc', '#e2d7ea'] },
];

const createRandom = (seed) => {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const seedOf = (text) => {
  let value = 7;
  [...String(text ?? '')].forEach((char) => {
    value = (Math.imul(value, 31) + char.codePointAt(0)) >>> 0;
  });
  return value || 7;
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('image load failed'));
  image.src = src;
});

// 원본의 짧은 쪽 길이에 맞춰 결과 크기를 정합니다. 필요 이상으로 키우면 흐려지기 때문입니다.
const sizeFor = (image) => {
  const short = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
  return Math.round(Math.min(Math.max(short, MIN_SIZE), MAX_SIZE));
};

// 가운데를 정사각형으로 잘라 고품질 보간으로 그립니다.
const drawCover = (ctx, image, size) => {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const side = Math.min(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  return size / side; // 1 보다 크면 확대된 것
};

// 자동 레벨: 밝기 분포의 아래·위 0.5% 를 잘라 0~255 로 펴 줍니다.
// 이미 대비가 충분한 사진은 거의 바뀌지 않고, 뿌연 사진만 또렷해집니다.
// 어두운 사진은 중간 밝기를 조금 들어 올립니다(감마). 색조는 바꾸지 않습니다.
const autoLevels = (data) => {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let index = 0; index < data.length; index += 16) {
    const luma = Math.round((data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114));
    histogram[luma] += 1;
    total += 1;
  }
  const cut = total * 0.005;
  let low = 0;
  let high = 255;
  for (let sum = 0; low < 255 && sum + histogram[low] <= cut; low += 1) {
    sum += histogram[low];
  }
  for (let sum = 0; high > 0 && sum + histogram[high] <= cut; high -= 1) {
    sum += histogram[high];
  }
  // 너무 세게 펴면 색이 뭉개지므로 한계를 둡니다.
  low = Math.min(low, 40);
  high = Math.max(high, 205);

  let mean = 0;
  for (let value = 0; value < 256; value += 1) {
    mean += value * histogram[value];
  }
  mean /= Math.max(total, 1);
  const normalized = (mean - low) / Math.max(high - low, 1);
  const gamma = normalized < 0.42 ? Math.max(0.78, normalized / 0.42) : 1;

  const table = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value += 1) {
    const stretched = Math.min(Math.max((value - low) / Math.max(high - low, 1), 0), 1);
    table[value] = Math.round((stretched ** gamma) * 255);
  }
  for (let index = 0; index < data.length; index += 4) {
    data[index] = table[data[index]];
    data[index + 1] = table[data[index + 1]];
    data[index + 2] = table[data[index + 2]];
  }
};

// 언샤프 마스크: 살짝 흐린 사본과의 차이를 더해 윤곽을 선명하게 합니다.
// 확대된 사진일수록 조금 더 세게 겁니다. 차이가 아주 작은 곳(하늘, 피부의 잔결)은
// 건너뛰어 노이즈가 도드라지지 않게 합니다.
const sharpen = (canvas, ctx, size, upscale) => {
  const amount = Math.min(0.65 + Math.max(upscale - 1, 0) * 0.5, 1.05);
  const radius = upscale > 1.1 ? 1.4 : 1.1;
  const threshold = 4;

  const blurred = document.createElement('canvas');
  blurred.width = size;
  blurred.height = size;
  const blurCtx = blurred.getContext('2d', { willReadFrequently: true });
  blurCtx.filter = `blur(${radius}px)`;
  blurCtx.drawImage(canvas, 0, 0);
  const soft = blurCtx.getImageData(0, 0, size, size).data;

  const frame = ctx.getImageData(0, 0, size, size);
  const { data } = frame;
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const diff = data[index + channel] - soft[index + channel];
      if (diff > threshold || diff < -threshold) {
        data[index + channel] += diff * amount; // 0~255 밖으로 나가면 자동으로 잘립니다.
      }
    }
  }
  ctx.putImageData(frame, 0, 0);
};

// 밝고 화사하게(BLOG_IMAGE_TONE=bright, 사용자 요청 2026-10-10):
// 1) 중간 밝기를 들어 올립니다. 이미 밝은 사진은 덜, 흰 곳은 날아가지 않게 위쪽은 거의 그대로 둡니다.
// 2) 중간 밝기에만 아주 살짝 발그레한 빛을 더합니다. 흰 벽·검은 머리는 색이 끼지 않습니다.
//    (노란 쪽으로 데우면 사진이 누렇게 보여 화사함과 멀어집니다)
// 3) 칙칙한 색만 조금 살립니다(자연 채도). 피부색은 거의 올리지 않아 얼굴이 붉거나 누렇게 뜨지 않습니다.
// 4) 흐린 사본을 '스크린'으로 옅게 겹쳐 은은하게 빛나는 느낌을 줍니다(glow). 윤곽은 뒤의 언샤프가 되살립니다.
const BRIGHT = { maxLift: 0.34, minLift: 0.14, warmR: 3, warmG: 0, warmB: -1, vibrance: 0.12, skinVibrance: 0.3, glow: 0.14 };

const brighten = (data) => {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 16) {
    sum += (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
    count += 1;
  }
  const mean = sum / Math.max(count, 1) / 255;
  // 평균 밝기 0.52 이하면 가장 세게, 0.68 이상이면 가장 약하게 들어 올립니다.
  const lift = Math.min(Math.max((0.8 - mean) * 1.2, BRIGHT.minLift), BRIGHT.maxLift);

  const curve = new Uint8ClampedArray(256);
  const warmth = new Float32Array(256);
  for (let value = 0; value < 256; value += 1) {
    const x = value / 255;
    curve[value] = Math.round((x + lift * x * (1 - x)) * 255);
    warmth[value] = 4 * x * (1 - x); // 중간 밝기에서 1, 아주 어둡거나 밝으면 0
  }

  for (let index = 0; index < data.length; index += 4) {
    let red = curve[data[index]];
    let green = curve[data[index + 1]];
    let blue = curve[data[index + 2]];

    const weight = warmth[Math.round((red * 0.299) + (green * 0.587) + (blue * 0.114))];
    red += BRIGHT.warmR * weight;
    green += BRIGHT.warmG * weight;
    blue += BRIGHT.warmB * weight;

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    let amount = BRIGHT.vibrance * (1 - (max - min) / 255);
    // 빨강 > 초록 > 파랑이고 색상이 주황 쪽이면 피부색으로 보고 거의 건드리지 않습니다.
    if (red >= green && green >= blue && max - min > 0 && (60 * (green - blue)) / (max - min) < 50) {
      amount *= BRIGHT.skinVibrance;
    }
    const luma = (red * 0.299) + (green * 0.587) + (blue * 0.114);
    data[index] = luma + (red - luma) * (1 + amount); // 0~255 밖으로 나가면 자동으로 잘립니다.
    data[index + 1] = luma + (green - luma) * (1 + amount);
    data[index + 2] = luma + (blue - luma) * (1 + amount);
  }
};

const glow = (canvas, ctx, size) => {
  const soft = document.createElement('canvas');
  soft.width = size;
  soft.height = size;
  const softCtx = soft.getContext('2d');
  softCtx.filter = `blur(${Math.max(4, Math.round(size * 0.012))}px)`;
  softCtx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = BRIGHT.glow;
  ctx.drawImage(soft, 0, 0);
  ctx.restore();
};

// 사진을 화질 위주로 다듬습니다. tone 이 bright 면 밝고 화사하게도 만듭니다.
const drawCrispPhoto = (canvas, ctx, image, size, tone) => {
  ctx.filter = 'saturate(1.05)'; // 압축으로 빠진 채도를 아주 조금 되돌립니다.
  const upscale = drawCover(ctx, image, size);
  ctx.filter = 'none';

  const frame = ctx.getImageData(0, 0, size, size);
  autoLevels(frame.data);
  if (tone !== 'natural') {
    brighten(frame.data);
  }
  ctx.putImageData(frame, 0, 0);
  if (tone !== 'natural') {
    glow(canvas, ctx, size);
  }

  sharpen(canvas, ctx, size, upscale);
};

const drawGradientBackground = (ctx, palette, random, size) => {
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, palette.bg[0]);
  gradient.addColorStop(1, palette.bg[1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  // 부드러운 원을 몇 개 겹쳐 배경에 깊이를 줍니다.
  for (let index = 0; index < 5; index += 1) {
    const radius = (160 + random() * 260) * (size / 1200);
    const x = random() * size;
    const y = random() * size;
    const blob = ctx.createRadialGradient(x, y, 0, x, y, radius);
    blob.addColorStop(0, index % 2 === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255, 214, 170, 0.35)');
    blob.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, size, size);
  }
  const tone = ctx.createLinearGradient(0, 0, size, size);
  tone.addColorStop(0, palette.from);
  tone.addColorStop(1, palette.to);
  ctx.fillStyle = tone;
  ctx.fillRect(0, 0, size, size);
};

// 썸네일 문구 글꼴입니다. 윈도우 기본 굵은 고딕(맑은 고딕)을 씁니다.
const OVERLAY_FONT = '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const OVERLAY_LINE_CHARS = 13; // 한 줄로 온 긴 문구는 이 길이를 넘으면 가운데쯤 띄어쓰기에서 두 줄로 나눕니다.

// 긴 한 줄을 가운데에 가까운 띄어쓰기에서 두 줄로 나눕니다. 띄어쓰기가 없으면 그대로 둡니다.
const splitInTwo = (line) => {
  const spaces = [...line.matchAll(/\s/g)].map((match) => match.index);
  if (spaces.length === 0) {
    return [line];
  }
  const cut = spaces.reduce((best, index) => (Math.abs(index - line.length / 2) < Math.abs(best - line.length / 2) ? index : best));
  return [line.slice(0, cut).trim(), line.slice(cut + 1).trim()].filter(Boolean);
};

// 썸네일 문구: 아래쪽을 어둡게 깔고 흰 글씨(마지막 줄은 노란 글씨)로 크게 씁니다.
// 네이버 목록에서 작게 보여도 읽히도록 사진 너비의 86% 안에서 최대한 크게 맞춥니다.
const drawOverlay = (ctx, size, overlay) => {
  let lines = (Array.isArray(overlay) ? overlay : [overlay]).map((line) => String(line ?? '').trim()).filter(Boolean).slice(0, 2);
  if (lines.length === 0) {
    return;
  }
  if (lines.length === 1 && [...lines[0]].length > OVERLAY_LINE_CHARS) {
    lines = splitInTwo(lines[0]);
  }
  const maxWidth = size * 0.86;
  let fontSize = Math.round(size * 0.1);
  ctx.font = `800 ${fontSize}px ${OVERLAY_FONT}`;
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
  if (widest > maxWidth) {
    fontSize = Math.max(Math.round(size * 0.05), Math.floor((fontSize * maxWidth) / widest));
    ctx.font = `800 ${fontSize}px ${OVERLAY_FONT}`;
  }
  const lineHeight = Math.round(fontSize * 1.28);
  const bottom = size - Math.round(size * 0.075);
  const top = bottom - lineHeight * lines.length;

  // 글씨 뒤 어두운 그라데이션 (사진 아래쪽 절반쯤부터 서서히)
  const shadeTop = Math.max(0, top - Math.round(size * 0.18));
  const shade = ctx.createLinearGradient(0, shadeTop, 0, size);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  shade.addColorStop(0.45, 'rgba(0, 0, 0, 0.55)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.82)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, shadeTop, size, size - shadeTop);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  lines.forEach((line, index) => {
    const y = top + lineHeight * (index + 1) - Math.round(lineHeight * 0.22);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = Math.round(fontSize * 0.25);
    ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.1));
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeText(line, size / 2, y, maxWidth);
    ctx.restore();
    ctx.fillStyle = index === lines.length - 1 && lines.length > 1 ? '#ffe14d' : '#ffffff';
    ctx.fillText(line, size / 2, y, maxWidth);
  });
};

// 정사각형 블로그 이미지를 만듭니다. 사진이 없으면 은은한 그라데이션 배경으로 만듭니다.
// caption·label 은 예전 호출과 맞추려고 받기만 하며, 배경 무늬를 고르는 데만 씁니다.
// overlay(문구 줄 배열)가 있으면 썸네일로 보고 아래쪽에 문구를 얹습니다.
// tone: 'bright'(기본, 밝고 화사하게) | 'natural'(색은 그대로, 대비·윤곽만)
const makeImage = async ({ dataUrl, caption = '', label = '', seed = '', overlay = [], tone = 'bright' }) => {
  const random = createRandom(seedOf(`${seed}${caption}`));
  const palette = PALETTES[seedOf(`${seed}${label}`) % PALETTES.length];

  let image = null;
  if (dataUrl) {
    image = await loadImage(dataUrl).catch(() => null);
  }
  const size = image ? sizeFor(image) : MAX_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let photo = false;
  if (image) {
    try {
      drawCrispPhoto(canvas, ctx, image, size, tone);
      photo = true;
    } catch (error) {
      ctx.filter = 'none';
    }
  }
  if (!photo) {
    drawGradientBackground(ctx, palette, random, size);
  }
  // 화질 보정(자동 레벨·언샤프)이 끝난 뒤에 문구를 얹어, 글씨 테두리가 보정으로 거칠어지지 않게 합니다.
  if (overlay && overlay.length) {
    try {
      drawOverlay(ctx, size, overlay);
    } catch (error) {
      // 문구를 못 얹어도 사진은 그대로 씁니다.
    }
  }

  // 화질을 위해 높은 품질로 저장합니다.
  return canvas.toDataURL('image/jpeg', 0.95);
};

export { makeImage };
