// Leitura e escrita da planilha (Google Sheets) e download de imagens do Drive.

import { google } from 'googleapis';
import { letraColuna, lerDataBR, verdadeiro, numeroBR, normalizar } from './util.js';

const ESCOPOS = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
];

// Nome do cabeçalho na aba Ofertas -> chave usada no código.
// O bot acha as colunas pelo nome, então dá pra mudar a ordem delas.
const COLUNAS = {
  'data cadastro': 'cadastro',
  'produto': 'produto',
  'marketplace': 'marketplace',
  'preco de (r$)': 'precoDe',
  'preco por (r$)': 'precoPor',
  'desconto': 'desconto',
  'cupom': 'cupom',
  'preco c/ cupom (r$)': 'precoCupom',
  'link afiliado': 'link',
  'imagem (url)': 'imagem',
  'destino': 'destino',
  'prioridade': 'prioridade',
  'ativo': 'ativo',
  'status': 'status',
  'ultimo envio': 'ultimoEnvio',
  'qtd envios': 'qtdEnvios',
  'cliques': 'cliques',
  'vendas': 'vendas',
  'comissao (r$)': 'comissao',
};

export function criarAuth() {
  const bruto = process.env.GOOGLE_SA_JSON;
  if (!bruto) throw new Error('Falta o secret GOOGLE_SA_JSON (JSON da conta de serviço do Google).');
  const credentials = JSON.parse(bruto);
  return new google.auth.GoogleAuth({ credentials, scopes: ESCOPOS });
}

export class Planilha {
  constructor(auth, id) {
    if (!id) throw new Error('Falta PLANILHA_ID.');
    this.id = id;
    this.sheets = google.sheets({ version: 'v4', auth });
    this.drive = google.drive({ version: 'v3', auth });
  }

  async carregar() {
    const res = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.id,
      ranges: ['Ofertas!A1:Z', 'Grupos!A1:E', 'Config!A1:B', 'Modelos!A1:C', 'Log!A1:F', 'Disponiveis!A1:C'],
    });
    const [ofertas, grupos, config, modelos, log, disponiveis = []] = res.data.valueRanges.map((v) => v.values || []);
    return {
      ...lerOfertas(ofertas),
      grupos: lerGrupos(grupos),
      config: lerConfig(config),
      modelos: lerModelos(modelos),
      log: lerLog(log),
      disponiveis: disponiveis.slice(1)
        .filter((l) => l[2])
        .map((l) => ({ nome: String(l[0] ?? ''), tipo: String(l[1] ?? 'GRUPO'), id: String(l[2]) })),
    };
  }

  async escreverCelulas(atualizacoes) {
    if (!atualizacoes.length) return;
    await this.sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: this.id,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: atualizacoes.map(({ range, valor }) => ({ range, values: [[valor]] })),
      },
    });
  }

  /** Guarda a lista de grupos/comunidades que o número participa (pro painel mostrar). */
  async gravarDisponiveis(lista, quando) {
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.id, range: 'Disponiveis!A2:D' });
    if (!lista.length) return;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.id,
      range: 'Disponiveis!A2',
      valueInputOption: 'RAW',
      requestBody: { values: lista.map((d) => [d.nome, d.tipo, d.id, quando]) },
    });
  }

  /** Substitui a aba Grupos pela seleção feita no painel. */
  async gravarGrupos(selecao) {
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.id, range: 'Grupos!A2:C' });
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.id, range: 'Grupos!E2:E' });
    const linhas = selecao.map((g) => [g.nome, ['COMUNIDADE', 'CANAL'].includes(g.tipo) ? g.tipo : 'GRUPO', g.id, true, 'escolhido no painel']);
    const vazias = Array.from({ length: Math.max(0, 30 - linhas.length) }, () => ['', '', '', false, '']);
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.id,
      range: 'Grupos!A2',
      valueInputOption: 'RAW',
      requestBody: { values: [...linhas, ...vazias] },
    });
  }

  /** Guarda o link de um canal na linha CANAIS da aba Config. */
  async adicionarCanal(link) {
    const r = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.id, range: 'Config!A1:B' });
    const linhas = r.data.values || [];
    const i = linhas.findIndex((l) => String(l[0] || '').trim().toUpperCase() === 'CANAIS');
    const atuais = i >= 0 ? String(linhas[i][1] || '').split(/[\s,;]+/).filter(Boolean) : [];
    if (atuais.includes(link)) return atuais;
    const novos = [...atuais, link];
    const linha = i >= 0 ? i + 1 : linhas.length + 1;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.id,
      range: `Config!A${linha}:C${linha}`,
      valueInputOption: 'RAW',
      requestBody: { values: [['CANAIS', novos.join(', '), 'Links dos canais do WhatsApp (o número precisa ser admin). Adicione pelo painel.']] },
    });
    return novos;
  }

  async anexarLog(linhas) {
    if (!linhas.length) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.id,
      range: 'Log!A:F',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: linhas },
    });
  }

  /** Baixa a imagem: link do Google Drive (via conta de serviço) ou URL pública. */
  async baixarImagem(url) {
    if (!url) return null;
    const idDrive = idDoDrive(url);
    if (idDrive) {
      const r = await this.drive.files.get(
        { fileId: idDrive, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      return Buffer.from(r.data);
    }
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar imagem`);
    const tipo = r.headers.get('content-type') || '';
    if (!tipo.startsWith('image/')) throw new Error(`o link não é uma imagem (${tipo || 'sem tipo'})`);
    return Buffer.from(await r.arrayBuffer());
  }
}

export function idDoDrive(url) {
  const s = String(url);
  if (!/drive\.google\.com|docs\.google\.com/.test(s)) return null;
  const m = s.match(/\/d\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : null;
}

export function lerOfertas(linhas) {
  const [cab = [], ...dados] = linhas;
  const mapa = {}; // chave -> índice da coluna
  cab.forEach((nome, i) => {
    const chave = COLUNAS[normalizar(nome)];
    if (chave) mapa[chave] = i;
  });
  for (const obrigatoria of ['produto', 'link', 'status', 'ativo']) {
    if (mapa[obrigatoria] === undefined) {
      throw new Error(`Aba Ofertas sem a coluna obrigatória "${obrigatoria}". Confira os cabeçalhos.`);
    }
  }
  const col = (k) => (mapa[k] === undefined ? null : letraColuna(mapa[k]));
  const ofertas = dados.map((l, i) => {
    const v = (k) => (mapa[k] === undefined ? '' : String(l[mapa[k]] ?? '').trim());
    return {
      linha: i + 2,
      cadastro: lerDataBR(v('cadastro')),
      produto: v('produto'),
      marketplace: v('marketplace'),
      precoDe: v('precoDe'),
      precoPor: v('precoPor'),
      desconto: v('desconto'),
      cupom: v('cupom'),
      precoCupom: v('precoCupom'),
      link: v('link'),
      imagem: v('imagem'),
      destino: v('destino'),
      prioridade: v('prioridade').toUpperCase() || 'NORMAL',
      ativo: verdadeiro(v('ativo')),
      status: v('status').toUpperCase(),
      ultimoEnvio: lerDataBR(v('ultimoEnvio')),
      qtdEnvios: parseInt(v('qtdEnvios'), 10) || 0,
      cliques: numeroBR(v('cliques')),
      vendas: numeroBR(v('vendas')),
    };
  }).filter((o) => o.produto && o.link);
  return {
    ofertas,
    colunas: {
      status: col('status'),
      ultimoEnvio: col('ultimoEnvio'),
      qtdEnvios: col('qtdEnvios'),
    },
  };
}

export function lerGrupos(linhas) {
  return linhas.slice(1)
    .map((l, i) => ({
      linha: i + 2,
      nome: String(l[0] ?? '').trim(),
      tipo: String(l[1] ?? 'GRUPO').trim().toUpperCase(),
      jid: String(l[2] ?? '').trim(),
      ativo: verdadeiro(l[3]),
    }))
    .filter((g) => g.nome);
}

export function lerConfig(linhas) {
  const c = {};
  for (const [k, v] of linhas.slice(1)) {
    if (k) c[String(k).trim().toUpperCase()] = String(v ?? '').trim();
  }
  const num = (k, padrao) => {
    const n = parseFloat(String(c[k] ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : padrao;
  };
  return {
    sistema: (c.SISTEMA || 'ATIVO').toUpperCase(),
    horaInicio: num('HORA_INICIO', 8),
    horaFim: num('HORA_FIM', 22),
    dias: (c.DIAS_SEMANA || 'SEG,TER,QUA,QUI,SEX,SAB,DOM')
      .toUpperCase().split(/[,;\s]+/).map((d) => normalizar(d).toUpperCase()).filter(Boolean),
    postsPorDia: num('POSTS_POR_DIA', 30),
    postsPorExecucao: num('POSTS_POR_EXECUCAO', 2),
    repostHoras: num('REPOST_HORAS', 48),
    repostValidadeDias: num('REPOST_VALIDADE_DIAS', 30),
    pausaMinSeg: num('PAUSA_MIN_SEG', 20),
    pausaMaxSeg: num('PAUSA_MAX_SEG', 60),
    atrasoInicialMaxSeg: num('ATRASO_INICIAL_MAX_SEG', 0),
    janelaMin: num('JANELA_MIN', 60),
    pausaDestinoMinSeg: num('PAUSA_DESTINO_MIN_SEG', 5),
    pausaDestinoMaxSeg: num('PAUSA_DESTINO_MAX_SEG', 15),
    canais: String(c.CANAIS || '').split(/[\s,;]+/).filter(Boolean),
    // Ex.: "TER=17,QUI=17" → nesses dias nada sai a partir das 17:00.
    fimPorDia: Object.fromEntries(String(c.FIM_POR_DIA || '').toUpperCase().split(/[,;\s]+/)
      .map((x) => x.split('=')).filter(([d, h]) => d && Number.isFinite(+h)).map(([d, h]) => [normalizar(d).toUpperCase(), +h])),
  };
}

export function lerModelos(linhas) {
  return linhas.slice(1)
    .filter((l) => verdadeiro(l[1]) && String(l[2] ?? '').trim())
    .map((l) => ({ nome: String(l[0]).trim(), texto: String(l[2]) }));
}

export function lerLog(linhas) {
  return linhas.slice(1).map((l) => ({
    dataHora: String(l[0] ?? ''),
    linha: parseInt(l[1], 10) || 0,
    produto: String(l[2] ?? ''),
    destino: String(l[3] ?? ''),
    resultado: String(l[4] ?? '').toUpperCase(),
    detalhe: String(l[5] ?? ''),
  }));
}
