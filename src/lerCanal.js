// Só LÊ as últimas postagens de um canal público (não segue, não envia nada).
// Uso: CANAL=<link> node src/lerCanal.js
import { proto } from 'baileys';
import { conectar, desconectar } from './whatsapp.js';

const codigo = String(process.env.CANAL || '').match(/channel\/([\w-]+)/)?.[1];
if (!codigo) throw new Error('Informe o link do canal');

function* nos(n) {
  if (!n || typeof n !== 'object') return;
  yield n;
  if (Array.isArray(n.content)) for (const c of n.content) yield* nos(c);
}

const { sock } = await conectar();
try {
  const m = await sock.newsletterMetadata('invite', codigo);
  console.log(`Canal: ${m?.thread_metadata?.name?.text || m?.name || '?'} | ${m?.id} | seguidores: ${m?.thread_metadata?.subscribers_count ?? '?'} | papel: ${m?.viewer_metadata?.role || 'nenhum (não segue)'}`);
  const r = await sock.newsletterFetchMessages(m.id, 10);
  let i = 0;
  for (const n of nos(r)) {
    if (n.tag !== 'message') continue;
    const pt = n.content?.find?.((c) => c.tag === 'plaintext');
    if (!pt?.content) continue;
    const msg = proto.Message.decode(pt.content);
    const texto = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
    const tipo = msg.imageMessage ? 'imagem' : msg.videoMessage ? 'vídeo' : 'texto';
    const quando = n.attrs?.t ? new Date(+n.attrs.t * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?';
    console.log(`\n===== #${++i} | ${quando} | ${tipo} =====\n${texto}`);
  }
  if (!i) console.log('Nenhuma mensagem retornada.');
} finally {
  await desconectar(sock);
}
