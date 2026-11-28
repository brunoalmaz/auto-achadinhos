// Teste: pega o post mais recente (com imagem) dos canais de cupom, monta a arte e manda SÓ no canal de teste.
import { proto } from 'baileys';
import { conectar, desconectar, enviarPost } from './whatsapp.js';
import { criarAuth, Planilha } from './planilha.js';
import { gerarArte, baixarFotoCanal } from './arte.js';
import { interpretar } from './cupom.js';

function* nos(n) { if (!n || typeof n !== 'object') return; yield n; if (Array.isArray(n.content)) for (const c of n.content) yield* nos(c); }
const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
const dados = await planilha.carregar();
const destino = String(process.env.DESTINO || '').match(/channel\/([\w-]+)/)?.[1];
if (!destino) throw new Error('Informe o canal de teste');
const { sock } = await conectar();
try {
  let enviados = 0;
  for (const link of dados.config.canaisCupom) {
    if (enviados >= 2) break;
    const m = await sock.newsletterMetadata('invite', link.match(/channel\/([\w-]+)/)[1]);
    const r = await sock.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' }, content: [{ tag: 'messages', attrs: { type: 'jid', jid: m.id, count: '10' } }] });
    for (const x of nos(r)) {
      if (x.tag !== 'message') continue;
      const pt = x.content?.find?.((y) => y.tag === 'plaintext');
      if (!pt?.content) continue;
      const msg = proto.Message.decode(pt.content);
      const o = interpretar(msg.imageMessage?.caption || '');
      if (!o || !msg.imageMessage || !o.por) continue;
      const foto = await baixarFotoCanal(msg.imageMessage);
      if (!foto) { console.log('sem foto'); continue; }
      const arte = await gerarArte({ foto, preco: o.por });
      const t = await sock.newsletterMetadata('invite', destino);
      await enviarPost(sock, t.id, { imagem: arte, texto: `TESTE DE ARTE AUTOMÁTICA\n\n🎮 ${o.produto} – ${o.por}${o.cupom ? `\n🎟️ ${o.cupom}` : ''}` });
      console.log(`✅ arte enviada: ${o.produto}`);
      enviados++;
      break;
    }
  }
  console.log(`Total: ${enviados}`);
} finally {
  await desconectar(sock);
}
