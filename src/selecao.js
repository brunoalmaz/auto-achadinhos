// Regras de quais ofertas saem em cada rodada.

const HORA = 3600 * 1000;
const DIA = 24 * HORA;

/** Linhas de oferta enviadas com sucesso hoje (pelo Log). */
export function enviadasHoje(log, hojeTexto, lerData) {
  const s = new Set();
  const [d, m, a] = hojeTexto.split('/').map(Number);
  for (const l of log) {
    const dt = lerData ? lerData(l.dataHora) : null;
    // Compara o dia em horário de SP (UTC-3).
    const sp = dt && new Date(dt.getTime() - 3 * 3600000);
    const ehHoje = sp ? (sp.getUTCDate() === d && sp.getUTCMonth() + 1 === m && sp.getUTCFullYear() === a) : l.dataHora.startsWith(hojeTexto);
    if (l.resultado === 'OK' && ehHoje && l.linha) s.add(l.linha);
  }
  return s;
}

/** Ofertas enviadas com sucesso nos últimos 60 minutos (pelo Log). */
export function enviadasUltimaHora(log, agora, lerData) {
  const s = new Set();
  for (const l of log) {
    const d = lerData(l.dataHora);
    if (l.resultado === 'OK' && l.linha && d && agora.getTime() - d.getTime() < HORA) s.add(l.linha);
  }
  return s.size;
}

/** Quantos achadinhos esta rodada deve mandar. */
export function quantidadeDaRodada(config, jaEnviadosHoje) {
  const faltam = Math.max(0, config.postsPorDia - jaEnviadosHoje);
  return Math.max(0, Math.min(config.postsPorExecucao, faltam));
}

export function filaNovas(ofertas) {
  return ofertas
    .filter((o) => o.ativo && (o.status === 'FILA' || o.status === ''))
    .sort((a, b) => (b.prioridade === 'ALTA') - (a.prioridade === 'ALTA') || a.linha - b.linha);
}

export function repostaveis(ofertas, { agora, repostHoras, repostValidadeDias, hoje }) {
  const t = agora.getTime();
  return ofertas.filter((o) => {
    if (!o.ativo || o.status !== 'ENVIADO' || !o.ultimoEnvio) return false;
    if (hoje.has(o.linha)) return false;
    if (t - o.ultimoEnvio.getTime() < repostHoras * HORA) return false;
    if (o.cadastro && repostValidadeDias > 0 && t - o.cadastro.getTime() > repostValidadeDias * DIA) return false;
    return true;
  });
}

/**
 * Sorteio com peso: ofertas com mais vendas/cliques têm mais chance,
 * mas todas podem sair (amostragem ponderada A-Res).
 */
export function sortearComPeso(lista, n, aleatorio = Math.random) {
  return lista
    .map((o) => {
      const peso = 1 + o.vendas * 3 + o.cliques / 10;
      return { o, chave: aleatorio() ** (1 / peso) };
    })
    .sort((a, b) => b.chave - a.chave)
    .slice(0, n)
    .map((x) => x.o);
}

/** Novas primeiro (ALTA furando a fila); se faltar, completa com repostagens. */
export function escolherOfertas(ofertas, { n, agora, config, hoje, aleatorio }) {
  if (n <= 0) return [];
  const novas = filaNovas(ofertas).slice(0, n).map((o) => ({ ...o, repost: false }));
  const faltam = n - novas.length;
  if (faltam <= 0) return novas;
  const candidatos = repostaveis(ofertas, {
    agora,
    repostHoras: config.repostHoras,
    repostValidadeDias: config.repostValidadeDias,
    hoje,
  });
  const repost = sortearComPeso(candidatos, faltam, aleatorio).map((o) => ({ ...o, repost: true }));
  return [...novas, ...repost];
}

/** Resolve a coluna Destino em grupos da aba Grupos. */
export function resolverDestinos(destinoTexto, grupos) {
  const ativos = grupos.filter((g) => g.ativo);
  const t = String(destinoTexto || '').trim();
  if (!t || t.toUpperCase() === 'TODOS') return { destinos: ativos, desconhecidos: [] };
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const nomes = t.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  const destinos = [];
  const desconhecidos = [];
  for (const nome of nomes) {
    const g = ativos.find((x) => norm(x.nome) === norm(nome));
    if (g) { if (!destinos.includes(g)) destinos.push(g); } else desconhecidos.push(nome);
  }
  return { destinos, desconhecidos };
}
