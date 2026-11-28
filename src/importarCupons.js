// Lê as últimas postagens dos canais de cupom (CANAIS_CUPOM) e joga na aba "Hora do Cupom".
// Só lê; não envia nada. Filtra só tecnologia/games e não repete link já importado.
import { proto } from 'baileys';
import { conectar, desconectar } from './whatsapp.js';
import { criarAuth, Planilha } from './planilha.js';
import { agoraSP } from './util.js';

const TEMAS = /\b(ps[45]|playstation|xbox|nintendo|switch|dualsense|dualshock|joy-?con|controle|console|jogo|game|gamer|steam|pc gamer|monitor|teclado|mouse|headset|fone|placa de v[ií]deo|rtx|gtx|radeon|ryzen|intel|processador|ssd|hd externo|mem[oó]ria ram|notebook|tablet|ipad|iphone|celular|smartphone|galaxy|xiaomi|redmi|motorola|smartwatch|apple watch|airpods|caixa de som|soundbar|smart tv|\btv\b|projetor|roteador|webcam|microfone|cadeira gamer|mesa digitalizadora|kindle|echo|alexa|chromecast|fire tv|carregador|power ?bank|pendrive|cart[aã]o de mem[oó]ria|impressora|c[aâ]mera|gopro|drone|vr|meta quest|retr[oô]|mega drive|super nintendo|amiibo|funko|colecion[aá]vel|lego)\b/i;

const LOJAS = [['amazon', 'Amazon'], ['amzn', 'Amazon'], ['meli', 'Mercado Livre'], ['mercadolivre', 'Mercado Livre'], ['shopee', 'Shopee'], ['magalu', 'Magalu'], ['magazineluiza', 'Magalu'], ['kabum', 'KaBuM'], ['aliexpress', 'AliExpress'], ['casasbahia', 'Casas Bahia'], ['pontofrio', 'Ponto'], ['americanas', 'Americanas'], ['terabyte', 'Terabyte'], ['pichau', 'Pichau']];

function* nos(n) { if (!n || typeof n !== 'object') return; yield n; if (Array.isArray(n.content)) for (const c of n.content) yield* nos(c); }

export function interpretar(texto) {
  const link = texto.match(/https?:\/\/\S+/)?.[0] || '';
  if (!link) return null;
  const linhas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
  const limpa = (l) => l.replace(/[*_~]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const valor = (re) => texto.replace(/[*_~]/g, '').match(re)?.[1]?.trim() || '';
  const por = valor(/(?:por|agora|apenas|sai por|pre[çc]o)[:\s]*R\$\s*([\d.]+(?:,\d{2})?)/i) || valor(/R\$\s*([\d.]+(?:,\d{2})?)/);
  const de = valor(/de[:\s]*R\$\s*([\d.]+(?:,\d{2})?)/i);
  const cupom = valor(/cupo[mn]s?[^\n:]*?[:\-–]\s*([A-Z0-9]{4,})/i) || valor(/🎟️?\s*([A-Z0-9]{4,})/u);
  const produto = linhas.map(limpa).find((l) => l.length > 8 && !/^(oferta|promo|cupo|resgate|link|compre|por:|de:|r\$|frete|aproveite|corre|vendido|🛒)/i.test(l) && !/https?:\/\//.test(l) && !/^R\$/.test(l)) || '';
  const host = link.toLowerCase();
  const loja = (LOJAS.find(([k]) => host.includes(k)) || [])[1] || valor(/oferta n[ao] ([\p{L} ]+)/iu).replace(/\b\w/g, (c) => c.toUpperCase());
  if (!produto) return null;
  return { produto, loja, de: de ? `R$ ${de}` : '', por: por ? `R$ ${por}` : '', cupom, link };
}

const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
const dados = await planilha.carregar();
const links = String(process.env.CANAIS || dados.config.canaisCupom?.join(' ') || '');
const codigos = [...links.matchAll(/channel\/([\w-]+)/g)].map((m) => m[1]);
const ja = new Set((dados.cupons || []).map((c) => c.linkOriginal));
const qtd = Number(process.env.QTD || 30);

const { sock } = await conectar();
const novas = [];
try {
  for (const c of codigos) {
    const m = await sock.newsletterMetadata('invite', c);
    const nome = m?.thread_metadata?.name?.text || c;
    const r = await sock.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' }, content: [{ tag: 'messages', attrs: { type: 'jid', jid: m.id, count: String(qtd) } }] });
    let lidas = 0, aceitas = 0;
    for (const x of nos(r)) {
      if (x.tag !== 'message') continue;
      const pt = x.content?.find?.((y) => y.tag === 'plaintext');
      if (!pt?.content) continue;
      lidas++;
      const msg = proto.Message.decode(pt.content);
      const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
      const o = interpretar(texto);
      if (!o || ja.has(o.link) || !TEMAS.test(`${o.produto} ${texto}`)) continue;
      ja.add(o.link); aceitas++;
      const quando = x.attrs?.t ? new Date(+x.attrs.t * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '') : agoraSP().dataHoraTexto;
      novas.push([quando, nome, o.produto, o.loja, o.de, o.por, o.cupom, o.link, '', false, '', '']);
    }
    console.log(`${nome}: ${lidas} lidas, ${aceitas} novas de tecnologia/games`);
  }
} finally {
  await desconectar(sock);
}
if (novas.length) {
  novas.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  await planilha.sheets.spreadsheets.values.append({
    spreadsheetId: planilha.id, range: "'Hora do Cupom'!A:L", valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: novas },
  });
}
console.log(`Total importado: ${novas.length}`);
