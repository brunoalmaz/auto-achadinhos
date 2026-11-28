// Lê as últimas postagens dos canais de cupom (CANAIS_CUPOM) e joga na aba "Hora do Cupom".
// Só lê; não envia nada. Filtra só tecnologia/games e não repete link já importado.
import { proto } from 'baileys';
import { conectar, desconectar } from './whatsapp.js';
import { criarAuth, Planilha } from './planilha.js';
import { agoraSP, ajustarDe } from './util.js';
import { interpretar, TEMAS } from './cupom.js';
import { fotoDaLoja, fundoBranco } from './arte.js';

function* nos(n) { if (!n || typeof n !== 'object') return; yield n; if (Array.isArray(n.content)) for (const c of n.content) yield* nos(c); }

export async function importarCupons(sock, planilha, dados, { links, limite = 5, porCanal = 15 } = {}) {
  const codigos = [...String(links || dados.config.canaisCupom.join(' ')).matchAll(/channel\/([\w-]+)/g)].map((m) => m[1]);
  const ja = new Set((dados.cupons || []).map((c) => c.linkOriginal));
  const achadas = [];
  for (const c of codigos) {
    const m = await sock.newsletterMetadata('invite', c);
    const nome = m?.thread_metadata?.name?.text || c;
    const r = await sock.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' }, content: [{ tag: 'messages', attrs: { type: 'jid', jid: m.id, count: String(porCanal) } }] });
    for (const x of nos(r)) {
      if (x.tag !== 'message') continue;
      const pt = x.content?.find?.((y) => y.tag === 'plaintext');
      if (!pt?.content) continue;
      const msg = proto.Message.decode(pt.content);
      const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
      const o = interpretar(texto);
      if (!o || !o.cupom || ja.has(o.link) || !TEMAS.test(`${o.produto} ${texto}`)) continue;
      ja.add(o.link);
      const t = Number(x.attrs?.t || 0) * 1000;
      const quando = t ? new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '') : agoraSP().dataHoraTexto;
      achadas.push({ t, linha: [quando, nome, o.produto, o.loja, o.de, o.por, o.cupom, o.link, '', false, '', ''] });
    }
  }
  const novas = achadas.sort((a, b) => b.t - a.t).slice(0, limite).map((a) => a.linha);
  if (novas.length) {
    await planilha.sheets.spreadsheets.values.append({
      spreadsheetId: planilha.id, range: "'Hora do Cupom'!A:L", valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: novas },
    });
  }
  console.log(`🎟️ Importadas ${novas.length} oferta(s) com cupom (de ${achadas.length} encontradas).`);
  return novas.length;
}

/**
 * Achadinhos do dia: lê os canais de referência e joga na aba Ofertas com Ativo = FALSE.
 * Coluna "Referencia" leva o link original; "Link afiliado" fica vazio pro Gus colocar o dele.
 */
export async function importarAchadinhos(sock, planilha, dados, { limite = 40, porCanal = 60 } = {}) {
  const codigos = [...dados.config.canaisCupom.join(' ').matchAll(/channel\/([\w-]+)/g)].map((m) => m[1]);
  const atual = await planilha.sheets.spreadsheets.values.get({ spreadsheetId: planilha.id, range: 'Ofertas!B:C' });
  const ja = new Set((atual.data.values || []).flat().map((v) => String(v).trim().toLowerCase()));
  const achadas = [];
  for (const c of codigos) {
    const m = await sock.newsletterMetadata('invite', c);
    const r = await sock.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' }, content: [{ tag: 'messages', attrs: { type: 'jid', jid: m.id, count: String(porCanal) } }] });
    for (const x of nos(r)) {
      if (x.tag !== 'message') continue;
      const pt = x.content?.find?.((y) => y.tag === 'plaintext');
      if (!pt?.content) continue;
      const msg = proto.Message.decode(pt.content);
      const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
      const o = interpretar(texto);
      if (!o?.produto || !o.link || !o.por || !TEMAS.test(`${o.produto} ${texto}`)) continue;
      const chave = o.link.toLowerCase(), chaveP = o.produto.toLowerCase();
      if (ja.has(chave) || ja.has(chaveP)) continue;
      ja.add(chave); ja.add(chaveP);
      const num = (v) => Number(String(v || '').replace(/[^\d,]/g, '').replace(',', '.')) || 0;
      const desc = num(o.de) > num(o.por) ? `${Math.round((1 - num(o.por) / num(o.de)) * 100)}%` : '';
      const aj = ajustarDe(o.de, o.por);
      achadas.push({ t: Number(x.attrs?.t || 0), linha: [agoraSP().hojeTexto, o.link, o.produto, o.loja || '', aj ? aj.de : (o.de || ''), o.por, aj ? aj.desconto : desc, o.cupom || '', '', '', '', '', '', false, '', '', ''] });
    }
  }
  const novas = achadas.sort((a, b) => b.t - a.t).slice(0, limite).map((a) => a.linha);
  for (const l of novas) {
    // confere se a loja tem foto de fundo branco; se não, já sinaliza
    let ok = false;
    try { const f = await fotoDaLoja(l[1]); ok = !!f && await fundoBranco(f); } catch { /* sem foto */ }
    if (!ok) l[14] = 'ATENÇÃO: SEM FOTO';
  }
  if (novas.length) {
    await planilha.sheets.spreadsheets.values.append({
      spreadsheetId: planilha.id, range: 'Ofertas!A:Q', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: novas },
    });
  }
  console.log(`🛍️ Importados ${novas.length} achadinho(s) (inativos, aguardando o link do Gus).`);
  return novas.length;
}

// Rodando direto (workflow "Importar cupons").
if (process.argv[1]?.endsWith('importarCupons.js')) {
  const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
  const dados = await planilha.carregar();
  const { sock } = await conectar();
  try {
    await importarCupons(sock, planilha, dados, { links: process.env.CANAIS, limite: Number(process.env.QTD || dados.config.cupomQtd || 5) });
  } finally {
    await desconectar(sock);
  }
}
