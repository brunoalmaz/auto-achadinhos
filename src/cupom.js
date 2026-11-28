// Hora do Cupom: nos horários HORA_CUPOM, junta até 5 ofertas aprovadas da aba "Hora do Cupom"
// num único post (imagem fixa + texto) e manda para os destinos ativos.
import { readFile } from 'node:fs/promises';
import { agoraSP, esperar, aleatorioEntre, verdadeiro, lerDataBR } from './util.js';
import { enviarPost } from './whatsapp.js';
import { importarCupons } from './importarCupons.js';

export const ABA_CUPOM = 'Hora do Cupom';

export const TEMAS = /\b(ps[45]|playstation|xbox|nintendo|switch|dualsense|dualshock|joy-?con|controle|console|jogo|game|gamer|steam|pc gamer|monitor|teclado|mouse|headset|fone|placa de v[ií]deo|rtx|gtx|radeon|ryzen|intel|processador|ssd|hd externo|mem[oó]ria ram|notebook|tablet|ipad|iphone|celular|smartphone|galaxy|xiaomi|redmi|motorola|smartwatch|apple watch|airpods|caixa de som|soundbar|smart tv|\btv\b|projetor|roteador|webcam|microfone|cadeira gamer|mesa digitalizadora|kindle|echo|alexa|chromecast|fire tv|carregador|power ?bank|pendrive|cart[aã]o de mem[oó]ria|impressora|c[aâ]mera|gopro|drone|vr|meta quest|retr[oô]|mega drive|super nintendo|amiibo|funko|colecion[aá]vel|lego)\b/i;

export const LOJAS = [['amazon', 'Amazon'], ['amzn', 'Amazon'], ['meli', 'Mercado Livre'], ['mercadolivre', 'Mercado Livre'], ['shopee', 'Shopee'], ['magalu', 'Magalu'], ['magazineluiza', 'Magalu'], ['kabum', 'KaBuM'], ['aliexpress', 'AliExpress'], ['casasbahia', 'Casas Bahia'], ['pontofrio', 'Ponto'], ['americanas', 'Americanas'], ['terabyte', 'Terabyte'], ['pichau', 'Pichau']];

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


/** Capturado em | Canal | Produto | Loja | De | Por | Cupom | Link original | Seu link | Aprovado | Status | Enviado em */
export function lerCupons(linhas) {
  return linhas.slice(1).map((l, i) => ({
    linha: i + 2,
    capturado: String(l[0] ?? ''),
    canal: String(l[1] ?? ''),
    produto: String(l[2] ?? '').trim(),
    loja: String(l[3] ?? '').trim(),
    de: String(l[4] ?? '').trim(),
    por: String(l[5] ?? '').trim(),
    cupom: String(l[6] ?? '').trim(),
    linkOriginal: String(l[7] ?? '').trim(),
    seuLink: String(l[8] ?? '').trim(),
    aprovado: verdadeiro(l[9]),
    status: String(l[10] ?? '').toUpperCase(),
  })).filter((c) => c.produto && (c.seuLink || c.linkOriginal));
}

const MODELOS = [
  { abre: 'Fala, rapaziada! 🎮 Assopra a fita que a HORA DO CUPOM chegou! 💨📼', fecha: '💾 Corre antes do game over, cupom acaba rápido! 🏃‍♂️' },
  { abre: 'Fala, rapaziada!\n\n🎮 Pausa no game que tem HORA DO CUPOM rodando! ⏸️🔥', fecha: '🕹️ Corre antes de dar GAME OVER no estoque! 🏃‍♂️' },
  { abre: 'Próxima rodada do dia, rapaziada! 🌙🎮 HORA DO CUPOM no talo!', fecha: 'Amanhã já pode ter acabado, e aí não adianta assoprar a fita não, hein! 💨' },
];

const preco = (v) => {
  const t = String(v).replace(/^R\$\s*/i, '').trim();
  return t ? `R$ ${t.replace(/,00$/, '')}` : '';
};

export function montarCupom(itens, indiceHorario) {
  const m = MODELOS[indiceHorario % MODELOS.length];
  const blocos = itens.map((c) => [
    `🎮 ${c.produto}${c.por ? ` – ${preco(c.por)}` : ''}`,
    c.cupom ? `🎟️ ${c.cupom}` : '',
    `🛒 ${c.seuLink || c.linkOriginal}`,
  ].filter(Boolean).join('\n'));
  return [m.abre, '', blocos.join('\n\n'), '', m.fecha].join('\n');
}

/** Horários do dia que já chegaram (até 90 min atrás) e ainda não rodaram hoje. */
export function horariosPendentes(config, log, agora = agoraSP()) {
  const feitos = new Set(log.filter((l) => l.resultado === 'CUPOM' && l.dataHora.startsWith(agora.hojeTexto)).map((l) => l.produto));
  const minAgora = agora.hora * 60 + agora.data.getUTCMinutes();
  return (config.horaCupom || []).map((h, i) => ({ h, i })).filter(({ h }) => {
    const [hh, mm] = h.split(':').map(Number);
    const alvo = hh * 60 + (mm || 0);
    return minAgora >= alvo && minAgora - alvo <= 90 && !feitos.has(`HORA DO CUPOM ${h}`);
  });
}

let imagemCache = null;
async function imagemCupom() {
  if (!imagemCache) imagemCache = await readFile(new URL('../assets/hora-do-cupom.png', import.meta.url));
  return imagemCache;
}

export async function rodarHoraDoCupom(sock, planilha, dados) {
  // 30 min antes de cada horário: traz as 5 ofertas com cupom mais recentes pra aprovar.
  const agora = agoraSP();
  const minAgora = agora.hora * 60 + agora.data.getUTCMinutes();
  for (const h of dados.config.horaCupom || []) {
    const [hh, mm] = h.split(':').map(Number);
    const alvo = hh * 60 + (mm || 0) - 30;
    const marcaImp = `IMPORTAR CUPOM ${h}`;
    if (minAgora < alvo || minAgora - alvo > 25) continue;
    if (dados.log.some((l) => l.produto === marcaImp && l.dataHora.startsWith(agora.hojeTexto))) continue;
    const n = await importarCupons(sock, planilha, dados, { limite: dados.config.cupomQtd || 5 });
    const linha = [agoraSP().dataHoraSegTexto, '', marcaImp, '', 'CUPOM', `${n} importada(s)`];
    await planilha.anexarLog([linha]);
    dados.log.push({ dataHora: linha[0], produto: marcaImp, resultado: 'CUPOM', linha: 0 });
    Object.assign(dados, { cupons: (await planilha.carregar()).cupons });
  }
  for (const { h, i } of horariosPendentes(dados.config, dados.log)) {
    const fila = filaCupom(dados);
    const marca = [agoraSP().dataHoraSegTexto, '', `HORA DO CUPOM ${h}`, '', 'CUPOM', fila.length ? `${fila.length} oferta(s)` : 'nada aprovado'];
    if (!fila.length) {
      console.log(`🎟️ Hora do cupom ${h}: nenhuma oferta aprovada.`);
      await planilha.anexarLog([marca]);
      dados.log.push({ dataHora: marca[0], produto: marca[2], resultado: 'CUPOM', linha: 0 });
      continue;
    }
    const texto = montarCupom(fila, i);
    const imagem = await imagemCupom();
    const destinos = dados.grupos.filter((g) => g.ativo && g.jid);
    console.log(`\n🎟️ Hora do cupom ${h}: ${fila.length} oferta(s) -> ${destinos.length} destino(s)`);
    const log = [marca];
    let ok = 0;
    for (const [j, g] of destinos.entries()) {
      if (j > 0) await esperar(aleatorioEntre(dados.config.pausaDestinoMinSeg, dados.config.pausaDestinoMaxSeg) * 1000);
      try {
        await enviarPost(sock, g.jid, { texto, imagem });
        ok++;
        log.push([agoraSP().dataHoraSegTexto, '', `Hora do cupom ${h}`, g.nome, 'OK', 'cupom']);
        console.log(`   ✅ ${g.nome}`);
      } catch (e) {
        log.push([agoraSP().dataHoraSegTexto, '', `Hora do cupom ${h}`, g.nome, 'ERRO', e.message]);
        console.log(`   ❌ ${g.nome}: ${e.message}`);
      }
    }
    await planilha.anexarLog(log);
    dados.log.push({ dataHora: marca[0], produto: marca[2], resultado: 'CUPOM', linha: 0 });
    if (ok) {
      const quando = agoraSP().dataHoraTexto;
      await planilha.escreverCelulas(fila.flatMap((c) => [
        { range: `'${ABA_CUPOM}'!K${c.linha}`, valor: 'ENVIADO' },
        { range: `'${ABA_CUPOM}'!L${c.linha}`, valor: quando },
      ]));
      for (const c of fila) c.status = 'ENVIADO';
    }
  }
}

/** Aprovadas e ainda não enviadas, mais recentes primeiro. */
export function filaCupom(dados) {
  const t = (c) => lerDataBR(c.capturado)?.getTime() || 0;
  return (dados.cupons || []).filter((c) => c.aprovado && !c.status).sort((a, b) => t(b) - t(a)).slice(0, dados.config.cupomQtd || 5);
}
