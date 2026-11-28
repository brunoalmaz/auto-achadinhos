// Envia agora um post da Hora do Cupom com as ofertas aprovadas.
// DESTINO = link de canal (teste, não marca como enviado) ou vazio (destinos ativos, marca ENVIADO).
import { readFile } from 'node:fs/promises';
import { conectar, desconectar, enviarPost } from './whatsapp.js';
import { criarAuth, Planilha } from './planilha.js';
import { montarCupom, ABA_CUPOM, filaCupom } from './cupom.js';
import { agoraSP } from './util.js';

const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
const dados = await planilha.carregar();
const fila = filaCupom(dados);
if (!fila.length) { console.log('Nenhuma oferta aprovada (coluna Aprovado) e ainda não enviada.'); process.exit(0); }
const texto = montarCupom(fila, Number(process.env.MODELO || 0));
console.log(texto.replace(/https?:\/\/\S+/g, '[link]'));
const imagem = await readFile(new URL('../assets/hora-do-cupom.png', import.meta.url));
const codigo = String(process.env.DESTINO || '').match(/channel\/([\w-]+)/)?.[1];
const { sock } = await conectar();
try {
  let destinos;
  if (codigo) {
    const m = await sock.newsletterMetadata('invite', codigo);
    destinos = [{ nome: m?.thread_metadata?.name?.text || 'teste', jid: m.id }];
  } else destinos = dados.grupos.filter((g) => g.ativo && g.jid);
  for (const g of destinos) {
    await enviarPost(sock, g.jid, { texto, imagem });
    console.log(`✅ ${g.nome}`);
  }
  if (!codigo) {
    const quando = agoraSP().dataHoraTexto;
    await planilha.escreverCelulas(fila.flatMap((c) => [{ range: `'${ABA_CUPOM}'!K${c.linha}`, valor: 'ENVIADO' }, { range: `'${ABA_CUPOM}'!L${c.linha}`, valor: quando }]));
  }
} finally {
  await desconectar(sock);
}
