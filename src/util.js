// Utilidades de data (fuso de São Paulo), texto e números.

export const FUSO = 'America/Sao_Paulo';

const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];

/** Partes da data/hora atual em São Paulo. */
export function agoraSP(data = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: FUSO,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(data).map((x) => [x.type, x.value]));
  const diaSemana = DIAS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)];
  const hh = String(+p.hour % 24).padStart(2, '0');
  return {
    data,
    ano: +p.year, mes: +p.month, dia: +p.day,
    hora: +p.hour % 24, minuto: +p.minute, segundo: +p.second,
    diaSemana,
    hojeTexto: `${p.day}/${p.month}/${p.year}`,
    dataHoraTexto: `${p.day}/${p.month}/${p.year} ${hh}:${p.minute}`,
    dataHoraSegTexto: `${p.day}/${p.month}/${p.year} ${hh}:${p.minute}:${p.second}`,
  };
}

/**
 * Lê "dd/mm/aaaa" ou "dd/mm/aaaa hh:mm[:ss]" (hora de São Paulo) e devolve Date.
 * Brasil não tem mais horário de verão: São Paulo = UTC-3.
 */
export function lerDataBR(texto) {
  if (!texto) return null;
  const m = String(texto).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, d, mo, a, h = '0', mi = '0', s = '0'] = m;
  return new Date(Date.UTC(+a, +mo - 1, +d, +h + 3, +mi, +s));
}

export function verdadeiro(v) {
  return ['TRUE', 'VERDADEIRO', 'SIM', '1', 'X', '✅'].includes(String(v ?? '').trim().toUpperCase());
}

export function normalizar(t) {
  return String(t ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

/** "R$ 1.299,90" -> "1.299,90" (mantém o formato brasileiro para a mensagem). */
export function limparPreco(v) {
  return String(v ?? '').replace(/R\$\s*/i, '').trim();
}

/** "1.299,90" -> 1299.9 */
export function numeroBR(v) {
  const t = limparPreco(v).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

export function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function aleatorioEntre(min, max) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.random() * (b - a);
}

/** Índice de coluna (0 = A) para letra. */
export function letraColuna(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
