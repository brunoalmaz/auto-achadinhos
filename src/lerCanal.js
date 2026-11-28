// Teste de LEITURA de canais (não envia nada). CANAL = links separados por vírgula/espaço.
import { proto } from 'baileys';
import { conectar, desconectar } from './whatsapp.js';
import { esperar } from './util.js';

const codigos = [...String(process.env.CANAL || '').matchAll(/channel\/([\w-]+)/g)].map((m) => m[1]);
if (!codigos.length) throw new Error('Informe o(s) link(s)');

function* nos(n) { if (!n || typeof n !== 'object') return; yield n; if (Array.isArray(n.content)) for (const c of n.content) yield* nos(c); }
const resumoMsg = (msg) => {
  const texto = msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || msg?.videoMessage?.caption || '';
  return `${msg?.imageMessage ? 'imagem' : 'texto'} | ${texto.length} caracteres | cupom: ${/cupom/i.test(texto) ? 'sim' : 'não'} | início: ${texto.replace(/https?:\/\/\S+/g, '[link]').replace(/\s+/g, ' ').slice(0, 70)}`;
};

const { sock } = await conectar();
const jids = new Map();
let aoVivo = 0;
sock.ev.on('messages.upsert', ({ messages }) => {
  for (const m of messages) {
    if (!jids.has(m.key.remoteJid)) continue;
    aoVivo++;
    console.log(`[AO VIVO] ${jids.get(m.key.remoteJid)}: ${resumoMsg(m.message)}`);
  }
});
try {
  for (const c of codigos) {
    const m = await sock.newsletterMetadata('invite', c);
    const nome = m?.thread_metadata?.name?.text || m?.name || c;
    jids.set(m.id, nome);
    console.log(`\nCanal: ${nome} | ${m.id} | papel: ${m?.viewer_metadata?.role || '?'} | mute: ${m?.viewer_metadata?.mute || '?'}`);
    try { await sock.subscribeNewsletterUpdates(m.id); console.log('  inscrito em atualizações ao vivo'); } catch (e) { console.log('  subscribe falhou:', e.message); }
    const tentativas = [
      ['message_updates', { tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: m.id }, content: [{ tag: 'message_updates', attrs: { count: '10' } }] }],
      ['messages/invite', { tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' }, content: [{ tag: 'messages', attrs: { type: 'invite', key: c, count: '10' } }] }],
      ['messages/jid', { tag: 'iq', attrs: { id: sock.generateMessageTag(), type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' }, content: [{ tag: 'messages', attrs: { type: 'jid', jid: m.id, count: '10' } }] }],
    ];
    for (const [nomeT, no] of tentativas) {
      try {
        const r = await sock.query(no);
        let n = 0;
        for (const x of nos(r)) {
          if (x.tag !== 'message') continue;
          const pt = x.content?.find?.((y) => y.tag === 'plaintext');
          if (pt?.content) { n++; if (n <= 3) console.log('  [HISTÓRICO]', resumoMsg(proto.Message.decode(pt.content))); }
        }
        console.log(`  ${nomeT}: tag=${r?.tag} filhos=${Array.isArray(r?.content) ? r.content.map((y) => y.tag + '(' + (Array.isArray(y.content) ? y.content.length : 0) + ')').join(',') : '-'} mensagens=${n}`);
      } catch (e) { console.log(`  ${nomeT} erro: ${e.message}`); }
    }
  }
  console.log('\nOuvindo ao vivo por 20s...');
  await esperar(20_000);
  console.log(`Ao vivo recebidas: ${aoVivo}`);
} finally {
  await desconectar(sock);
}
