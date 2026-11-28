// Monta a arte do achadinho: moldura do Assopra + foto do produto + preço no selo roxo.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const AREA = { x: 180, y: 320, w: 640, h: 610 }; // espaço da foto
const SELO = { cx: 660, cy: 1056 };              // centro do selo de preço

let moldura = null;

export async function gerarArte({ foto, preco }) {
  if (!moldura) moldura = await readFile(new URL('../assets/moldura-achadinho.png', import.meta.url));
  const camadas = [];
  if (foto) {
    // leve assimetria: escala, giro e deslocamento aleatórios
    const esc = 0.86 + Math.random() * 0.1;
    const giro = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4);
    let img = await sharp(foto).resize(Math.round(AREA.w * esc), Math.round(AREA.h * esc), { fit: 'inside' })
      .flatten({ background: '#ffffff' }).rotate(giro, { background: '#ffffff' }).png().toBuffer();
    img = await sharp(img).resize(AREA.w, AREA.h, { fit: 'inside', withoutEnlargement: true }).toBuffer();
    const { width, height } = await sharp(img).metadata();
    const folgaX = AREA.w - width, folgaY = AREA.h - height;
    const left = AREA.x + Math.round(folgaX * (Math.random() < 0.5 ? 0.15 + Math.random() * 0.2 : 0.65 + Math.random() * 0.2));
    const top = AREA.y + Math.round(folgaY * (0.3 + Math.random() * 0.4));
    camadas.push({ input: img, left, top });
  }
  const valor = String(preco || '').replace(/^R\$\s*/i, '').trim();
  if (valor) {
    const tam = valor.length > 8 ? 46 : 54;
    const svg = `<svg width="1000" height="1162" xmlns="http://www.w3.org/2000/svg"><text x="${SELO.cx}" y="${SELO.cy}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="${tam}" fill="#ffffff">R$${valor}</text></svg>`;
    camadas.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }
  return sharp(moldura).composite(camadas).jpeg({ quality: 88 }).toBuffer();
}

/** Baixa a imagem de um post de canal (mídia de canal não é criptografada). */
export async function baixarFotoCanal(imageMessage) {
  const caminho = imageMessage?.directPath;
  if (!caminho) return null;
  const r = await fetch(`https://mmg.whatsapp.net${caminho}`);
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Foto limpa do produto, tirada da página da loja (og:image / imagem principal). */
export async function fotoDaLoja(link) {
  if (!link) return null;
  try {
    const r = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' } });
    const html = await r.text();
    const achar = (re) => html.match(re)?.[1]?.replace(/&amp;/g, '&');
    let url = achar(/"hiRes":"(https:[^"]+)"/) || achar(/id="landingImage"[^>]*data-old-hires="(https:[^"]+)"/)
      || achar(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || achar(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    if (!url) return null;
    url = url.replace(/-[A-Z]\.(jpg|webp)$/i, '-O.$1'); // Mercado Livre: versão grande
    const img = await fetch(url, { headers: { 'User-Agent': UA } });
    return img.ok ? Buffer.from(await img.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
