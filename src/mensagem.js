// Monta o texto do post a partir de um modelo da aba Modelos.

import { limparPreco } from './util.js';

export const MODELO_PADRAO = [
  '🔥 ACHADINHO {marketplace} 🔥',
  '',
  '{produto}',
  '',
  'De ~R$ {preco_de}~ ({desconto} OFF)',
  '💰 *Por R$ {preco_por}*',
  '🎟️ Cupom: {cupom}',
  '',
  '👉 {link}',
].join('\n');

export function camposDaOferta(o) {
  return {
    produto: o.produto,
    marketplace: (o.marketplace || '').toUpperCase(),
    preco_de: limparPreco(o.precoDe),
    preco_por: limparPreco(o.precoPor),
    desconto: o.desconto && o.desconto !== '0%' ? o.desconto : '',
    cupom: o.cupom,
    link: o.link,
  };
}

/**
 * Troca {campo} pelos valores. Linha que tem um campo vazio é removida inteira
 * (ex.: oferta sem cupom não mostra a linha do cupom).
 */
export function montarMensagem(modelo, oferta) {
  const campos = camposDaOferta(oferta);
  const linhas = String(modelo || MODELO_PADRAO).replace(/\r\n/g, '\n').split('\n');
  const saida = [];
  for (const linha of linhas) {
    const usados = [...linha.matchAll(/\{(\w+)\}/g)].map((m) => m[1].toLowerCase());
    const conhecidos = usados.filter((k) => k in campos);
    if (conhecidos.some((k) => !String(campos[k] ?? '').trim())) continue;
    saida.push(linha.replace(/\{(\w+)\}/g, (m, k) => (k.toLowerCase() in campos ? campos[k.toLowerCase()] : m)));
  }
  return saida.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function sortearModelo(modelos, aleatorio = Math.random) {
  if (!modelos.length) return MODELO_PADRAO;
  return modelos[Math.floor(aleatorio() * modelos.length)].texto;
}
