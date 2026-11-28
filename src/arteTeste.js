// Teste: gera a arte das ofertas da aba "Hora do Cupom" (foto da loja + preço "Por") e manda SÓ no canal de teste.
import { conectar, desconectar, enviarPost } from './whatsapp.js';
import { criarAuth, Planilha } from './planilha.js';
import { gerarArte, fotoDaLoja, fundoBranco } from './arte.js';

const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
const dados = await planilha.carregar();
const destino = String(process.env.DESTINO || '').match(/channel\/([\w-]+)/)?.[1];
if (!destino) throw new Error('Informe o canal de teste');
const qtd = Number(process.env.QTD || 3);
// FONTE=ofertas: usa ofertas já enviadas da aba Ofertas
const itens = process.env.FONTE === 'ofertas'
  ? dados.ofertas.filter((o) => o.status === 'ENVIADO' && o.precoPor).slice(-qtd).map((o) => ({ produto: o.produto, por: o.precoPor, linkOriginal: o.link }))
  : dados.cupons.slice(0, qtd);
const { sock } = await conectar();
try {
  const t = await sock.newsletterMetadata('invite', destino);
  for (const c of itens) {
    const foto = await fotoDaLoja(c.linkOriginal);
    console.log(`${c.produto}: foto ${foto ? 'ok' : 'NÃO encontrada'}`);
    if (!foto) continue;
    console.log(`   fundo branco: ${(await fundoBranco(foto)) ? 'sim' : 'NÃO'}`);
    const arte = await gerarArte({ foto, preco: c.por });
    await enviarPost(sock, t.id, { imagem: arte, texto: `TESTE DE ARTE\n${c.produto} – ${c.por}` });
  }
} finally {
  await desconectar(sock);
}
