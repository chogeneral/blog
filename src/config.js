import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');

const PATHS = {
  root: ROOT,
  data: path.join(ROOT, 'data'),
  images: path.join(ROOT, 'data', 'images'),
  drafts: path.join(ROOT, 'data', 'drafts'),
  profile: path.join(ROOT, 'data', 'naver-profile'),
  logs: path.join(ROOT, 'data', 'logs'),
  env: path.join(ROOT, '.env'),
};

const ensureDirs = () => {
  [PATHS.data, PATHS.images, PATHS.drafts, PATHS.logs].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
};

// .env 파일을 읽어 process.env 에 넣습니다. 이미 있는 값은 덮어쓰지 않습니다.
const loadEnv = () => {
  if (!fs.existsSync(PATHS.env)) {
    return;
  }
  fs.readFileSync(PATHS.env, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const at = trimmed.indexOf('=');
    if (at === -1) {
      return;
    }
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
};

const envStatus = () => ({
  deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
  gemini: Boolean(process.env.GEMINI_API_KEY),
  pixabay: Boolean(process.env.PIXABAY_API_KEY),
  pexels: Boolean(process.env.PEXELS_API_KEY),
  unsplash: Boolean(process.env.UNSPLASH_ACCESS_KEY),
  naverSearch: Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET),
  // 사진 보정: bright(기본, 밝고 화사하게) | natural(색은 그대로, 대비·윤곽만). renderer/imagelab.js 가 씁니다.
  imageTone: /^(natural|off)$/i.test((process.env.BLOG_IMAGE_TONE || '').trim()) ? 'natural' : 'bright',
});

export { PATHS, ensureDirs, loadEnv, envStatus };
